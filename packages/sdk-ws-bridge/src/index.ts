/**
 * koinrokka SDK WebSocket bridge: serves the dsh SDK JSON-RPC protocol over
 * WebSocket with token auth, replacing the stdio server inside the sdk
 * profile. One authenticated connection is active at a time; a newer
 * connection evicts the older one. The `shutdown` request disposes that
 * connection's SDK agents and closes the socket, but never exits the
 * process: container lifecycle belongs to the platform, not the peer.
 *
 * Config is validated by hand (no schemastery dependency) and fails closed:
 * without a token the plugin refuses to activate.
 *
 * @module @koinrokka/dsh-sdk-ws-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import { WebSocket, WebSocketServer } from 'ws'
import { resolve } from 'node:path'
import { ApprovalBroker } from './approval.ts'
import { handleWorkspaceRequest } from './workspace.ts'
import { wsToStreams, type WsStreams } from './ws-stream.ts'

export * from './ws-stream.ts'
export * from './approval.ts'

export const name = 'sdk-ws-bridge'
// The agent factory is required; `initialize` reads the optional loader seam.
export const inject = ['agents']

/** Bridge deployment config. All fields optional; defaults applied by hand. */
export interface BridgeConfig {
  /** Listen port. @default 7800 */
  port?: number
  /** Listen host. Containers need `0.0.0.0`; loopback is the safe default. @default '127.0.0.1' */
  host?: string
  /** Shared secret. Falls back to `KOINROKKA_BRIDGE_TOKEN`. Required, fail closed. */
  token?: string
  /** Mirror of the stdio server option. @default false */
  maxTokensAsSuccess?: boolean
}

/** One live bridge connection: socket, transport, and its server instance. */
interface ActiveConnection {
  ws: WebSocket
  transport: JsonRpcLineTransport
  server: HarnessSdkJsonRpcServer
  streams: WsStreams
  settle: () => void
}

function bearerTokenOf(request: { headers: { authorization?: string | string[] }; url?: string }): string | undefined {
  const header = request.headers.authorization
  const text = Array.isArray(header) ? header[0] : header
  if (text?.startsWith('Bearer ')) return text.slice('Bearer '.length)
  try {
    const url = new URL(request.url ?? '/', 'http://bridge.invalid')
    return url.searchParams.get('token') ?? undefined
  } catch {
    return undefined
  }
}

export function apply(ctx: Context, config: BridgeConfig = {}): void {
  const port = config.port ?? 7800
  const host = config.host ?? '127.0.0.1'
  const token = config.token ?? process.env.KOINROKKA_BRIDGE_TOKEN
  if (!token) {
    throw new Error(
      '[sdk-ws-bridge] refusing to start without a token: set config token or KOINROKKA_BRIDGE_TOKEN',
    )
  }

  let active: ActiveConnection | undefined
  // 工作区根:默认进程 cwd(容器内 /workspace);initialize 可改写
  let workspaceRoot = process.cwd()

  // 审批桥(R2/ADR 0022):把 dsh 的 approval/request 瀑布引到浏览器审批卡。
  // 超时(默认 120s,env 可配)= unavailable,维持上游 fail-closed 语义。
  const broker = new ApprovalBroker(Number(process.env.KOINROKKA_APPROVAL_TIMEOUT_MS ?? 120_000))
  // approval/request 是 dsh-user-approval 对 cordis Events 的 augmentation,
  // 不在 cordis 核心类型里;与 git-auto 的 session/event 同款守卫式注册
  const onEvent = (ctx as unknown as {
    on: (name: 'approval/request', fn: (req: {
      toolName: string
      reason?: string
      signal?: AbortSignal
    }, next: () => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>)
      => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>) => unknown
  }).on
  onEvent.call(ctx, 'approval/request', async (req) => {
    const rec = active
    if (!rec) return 'unavailable' // 无浏览器在看不问人:直接 fail-closed
    const { pending, outcome } = broker.ask({ toolName: req.toolName, reason: req.reason, signal: req.signal })
    rec.streams.output.write(JSON.stringify({ jsonrpc: '2.0', method: 'approval/request', params: pending }) + '\n')
    return outcome
  })

  const settleOf = (record: ActiveConnection): (() => void) => {
    let settled = false
    return (): void => {
      if (settled) return
      settled = true
      record.transport.close()
      void record.server.shutdown().catch(() => {})
      if (active === record) active = undefined
    }
  }

  const evict = (record: ActiveConnection, reason: string): void => {
    record.ws.close(1000, reason)
    record.settle()
  }

  ctx.effect((): (() => Promise<void>) => {
    const wss = new WebSocketServer({ host, port })

    wss.on('connection', (ws, request) => {
      const provided = bearerTokenOf(request)
      if (provided !== token) {
        ws.close(4401, 'unauthorized')
        setTimeout((): void => {
          if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.terminate()
        }, 1000).unref()
        return
      }

      if (active) evict(active, 'superseded by a newer connection')

      const streams = wsToStreams(ws)
      const transport = new JsonRpcLineTransport(streams.input, streams.output)
      const server = new HarnessSdkJsonRpcServer(ctx, transport, {
        maxTokensAsSuccess: config.maxTokensAsSuccess ?? false,
      })
      const record: ActiveConnection = { ws, transport, server, streams, settle: (): void => {} }
      record.settle = settleOf(record)
      active = record

      transport.onRequest(async (method, params) => {
        // Mirror the stdio server: readiness is the whole plugin tree settling.
        if (method === 'initialize') {
          if (typeof params?.cwd === 'string' && params.cwd.length > 0) workspaceRoot = resolve(params.cwd)
          await ctx.get('loader')?.await()
        }
        // koinrokka workspace surface(Phase 3,ADR 0010):文件树/读页/回合 diff
        if (method.startsWith('workspace/')) {
          return handleWorkspaceRequest(workspaceRoot, method, params)
        }
        // 审批卡回执(R2):{id, outcome: allowed-once | rejected};别的值当未送达
        if (method === 'approval/decide') {
          const outcome = (params as { outcome?: unknown } | undefined)?.outcome
          const ok = outcome === 'allowed-once' || outcome === 'rejected'
            ? broker.decide(String(params?.id), outcome)
            : false
          return { ok }
        }
        const result = await server.handleRequest(method, params)
        if (method === 'shutdown') {
          setImmediate((): void => {
            record.ws.close(1000, 'shutdown')
            record.settle()
          })
        }
        return result
      })

      transport.start()
      streams.closed.then(record.settle)
    })

    // Keep long-lived VPC connections alive and half-open sockets detectable.
    const pingTimer = setInterval((): void => {
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.ping()
      }
    }, 30_000)

    return (): Promise<void> => new Promise((resolve) => {
      clearInterval(pingTimer)
      if (active) evict(active, 'plugin unloaded')
      wss.close(() => resolve())
    })
  }, 'sdk-ws-bridge.serve')
}
