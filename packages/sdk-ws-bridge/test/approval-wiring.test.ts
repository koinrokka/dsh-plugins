/**
 * 审批桥接线(R2/ADR 0022):ctx 的 approval/request 瀑布 → WS 通知
 * approval/request{id,toolName,level,...} → 浏览器回 RPC approval/decide →
 * 瀑布以人决结算;无连接时立即 unavailable(fail-closed)。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { WebSocket } from 'ws'
import { apply } from '../src/index.ts'

const TOKEN = 'test-token'
const PORT = 48705

type ApprovalReq = {
  toolName: string
  reason?: string
  signal?: AbortSignal
}
type Outcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

function once<T>(e: { once(event: string, l: (v: T) => void): unknown }, ev: string): Promise<T> {
  return new Promise((r) => e.once(ev, r))
}

function approvalCapturingContext(): {
  ctx: unknown
  fire: (req: ApprovalReq) => Promise<Outcome>
  dispose: () => Promise<void>
} {
  const disposers: Array<() => void> = []
  const listeners: Array<(req: ApprovalReq, next: () => Promise<Outcome>) => Promise<Outcome>> = []
  const ctx = {
    on: (name: string, fn: (req: ApprovalReq, next: () => Promise<Outcome>) => Promise<Outcome>): (() => void) => {
      if (name === 'approval/request') listeners.push(fn)
      return (): void => {}
    },
    effect(fn: () => unknown): () => void {
      const dispose = fn() as () => void
      disposers.push((): void => { void Promise.resolve(dispose()).catch(() => {}) })
      return (): void => {}
    },
    get: (): undefined => undefined,
  }
  return {
    ctx,
    fire: (req) => {
      assert.ok(listeners.length > 0, 'approval/request 监听器已注册')
      return listeners[0](req, async () => 'unavailable')
    },
    dispose: async () => { for (const d of disposers) d() },
  }
}

async function connectUntilOpen(url: string, attempts = 20): Promise<WebSocket> {
  for (let i = 0; i < attempts; i++) {
    const ws = new WebSocket(url)
    const ok = await Promise.race([
      once(ws, 'open').then((): boolean => true),
      once<Error>(ws, 'error').then((): boolean => false),
    ])
    if (ok) return ws
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`could not connect to ${url}`)
}

test('approval round-trips to the browser and back (allowed-once)', async () => {
  const { ctx, fire, dispose } = approvalCapturingContext()
  apply(ctx as never, { host: '127.0.0.1', port: PORT, token: TOKEN })

  const ws = await connectUntilOpen(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`)

  // 触发瀑布;浏览器侧应收到 approval/request 通知
  const outcomeP = fire({ toolName: 'bash', reason: 'rm -rf build' })
  const noteP = new Promise<any>((r) => ws.on('message', (d) => {
    const m = JSON.parse(d.toString())
    if (m.method === 'approval/request') r(m)
  }))
  const note = await noteP
  assert.equal(note.params.toolName, 'bash')
  assert.equal(note.params.level, 'EXECUTE')
  assert.equal(note.params.reason, 'rm -rf build')
  assert.ok(note.params.id)
  assert.ok(note.params.expiresAt > Date.now())

  // 浏览器决定 → RPC 回执 ok → 瀑布结算
  const ackP = new Promise<any>((r) => ws.on('message', (d) => {
    const m = JSON.parse(d.toString())
    if (m.id === 'dec-1') r(m)
  }))
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'dec-1', method: 'approval/decide', params: { id: note.params.id, outcome: 'allowed-once' } }))
  const ack = await ackP
  assert.equal(ack.result.ok, true)
  assert.equal(await outcomeP, 'allowed-once')

  ws.terminate()
  await dispose()
})

test('no browser connection settles unavailable immediately (fail-closed)', async () => {
  const { ctx, fire, dispose } = approvalCapturingContext()
  apply(ctx as never, { host: '127.0.0.1', port: PORT + 1, token: TOKEN })
  assert.equal(await fire({ toolName: 'write' }), 'unavailable')
  await dispose()
})
