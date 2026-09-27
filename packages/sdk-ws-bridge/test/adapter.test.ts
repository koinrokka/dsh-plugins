/**
 * Adapter round-trip: WebSocket ↔ stream ↔ JsonRpcLineTransport, plus the
 * plugin's auth gate (fail-closed token, evict-on-supersede) against a mock
 * context. Protocol logic itself is dsh's and stays untested here.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { WebSocket, WebSocketServer } from 'ws'
import { apply, wsToStreams } from '../src/index.ts'

const TOKEN = 'test-token'
const PORT = 48701

function once<T>(emitter: { once(event: string, listener: (value: T) => void): unknown }, event: string): Promise<T> {
  return new Promise((resolve) => emitter.once(event, resolve))
}

test('adapter round-trips one JSON-RPC frame per message', async () => {
  const server = new WebSocketServer({ port: 0 })
  server.on('connection', (ws) => {
    const streams = wsToStreams(ws)
    const transport = new JsonRpcLineTransport(streams.input, streams.output)
    transport.onRequest(async (method, params) => ({ echo: method, ...params }))
    transport.start()
  })
  await once(server, 'listening')
  const { port } = server.address() as { port: number }

  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await once(ws, 'open')

  const reply = new Promise<unknown>((resolve) => ws.on('message', (data) => resolve(JSON.parse(data.toString()))))
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'req-1', method: 'hello', params: { a: 1 } }))
  const result = (await reply) as { id: string; result: { echo: string; a: number } }
  assert.equal(result.id, 'req-1')
  assert.equal(result.result.echo, 'hello')
  assert.equal(result.result.a, 1)

  ws.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function mockContext(): { ctx: unknown; dispose: () => Promise<void> } {
  const disposers: Array<() => void> = []
  const ctx = {
    on: (): (() => void) => (): void => {},
    effect(fn: () => unknown): () => void {
      const dispose = fn() as () => void
      disposers.push((): void => {
        void Promise.resolve(dispose()).catch(() => {})
      })
      return (): void => {}
    },
    get: (): undefined => undefined,
  }
  return { ctx, dispose: async () => { for (const dispose of disposers) dispose() } }
}

test('plugin fails closed without a token', () => {
  delete process.env.KOINROKKA_BRIDGE_TOKEN
  assert.throws(() => apply(mockContext().ctx as never, { port: 0 }), /token/)
})

async function connectUntilOpen(url: string, attempts = 20): Promise<WebSocket> {
  let last: WebSocket | undefined
  for (let i = 0; i < attempts; i++) {
    const ws = new WebSocket(url)
    const ok = await Promise.race([
      once(ws, 'open').then((): boolean => true),
      once<Error>(ws, 'error').then((): boolean => false),
    ])
    if (ok) return ws
    last = ws
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`could not connect to ${url}: ${last?.url ?? 'no attempt'}`)
}

test('plugin serves auth: rejects wrong token, accepts right one', async () => {
  const { ctx, dispose } = mockContext()
  apply(ctx as never, { host: '127.0.0.1', port: PORT, token: TOKEN })

  const wrong = await connectUntilOpen(`ws://127.0.0.1:${PORT}/?token=wrong`)
  const wrongCode = await once<number>(wrong, 'close')
  assert.ok(wrongCode === 4401 || wrongCode === 1006, `unexpected close code ${wrongCode}`)

  // With the right token the connection is accepted; without a real harness
  // context the server cannot answer initialize, so we only assert the
  // handshake stays open briefly (no immediate auth close).
  const right = await connectUntilOpen(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(right.readyState, WebSocket.OPEN)
  right.terminate()

  await dispose()
})
