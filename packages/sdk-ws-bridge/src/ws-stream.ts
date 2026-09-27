/**
 * WebSocket ↔ Node stream adapter for the SDK JSON-RPC protocol.
 *
 * Wire convention: one JSON-RPC frame per WebSocket text message. Incoming
 * messages are pushed into a Readable with the trailing newline the line
 * transport expects; outbound lines from the Writable are sent as one
 * message each. The adapter owns no protocol logic.
 *
 * @module @koinrokka/dsh-sdk-ws-bridge/ws-stream
 */

import { Readable, Writable } from 'node:stream'
import type { WebSocket } from 'ws'

/** Streams plus a settled-on-close promise for one WebSocket connection. */
export interface WsStreams {
  /** Readable side: one `\n`-terminated line per received message. */
  input: Readable
  /** Writable side: accepts `\n`-terminated JSON lines, sends one message each. */
  output: Writable
  /** Resolves once the socket has closed (clean or errored). */
  closed: Promise<void>
}

/**
 * Adapt one WebSocket connection into the stream pair `JsonRpcLineTransport`
 * consumes. The caller owns the socket; this adapter only attaches listeners.
 */
export function wsToStreams(ws: WebSocket): WsStreams {
  const input = new Readable({
    read(): void {},
  })

  const output = new Writable({
    write(chunk, _encoding, callback): void {
      try {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        for (const line of text.split('\n')) {
          const frame = line.trim()
          if (frame) ws.send(frame)
        }
        callback()
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)))
      }
    },
  })

  ws.on('message', (data) => {
    input.push(`${data.toString('utf8')}\n`)
  })
  ws.on('close', () => {
    input.push(null)
    output.end()
  })
  ws.on('error', () => {
    input.destroy()
    output.destroy()
  })

  const closed = new Promise<void>((resolve) => {
    ws.on('close', () => resolve())
  })

  return { input, output, closed }
}
