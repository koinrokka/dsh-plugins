import { WebSocket } from "ws";
import { Readable, Writable } from "node:stream";
import { Context } from "@deepseek-ai/cordis";

//#region src/ws-stream.d.ts

/** Streams plus a settled-on-close promise for one WebSocket connection. */
interface WsStreams {
  /** Readable side: one `\n`-terminated line per received message. */
  input: Readable;
  /** Writable side: accepts `\n`-terminated JSON lines, sends one message each. */
  output: Writable;
  /** Resolves once the socket has closed (clean or errored). */
  closed: Promise<void>;
}
/**
 * Adapt one WebSocket connection into the stream pair `JsonRpcLineTransport`
 * consumes. The caller owns the socket; this adapter only attaches listeners.
 */
declare function wsToStreams(ws: WebSocket): WsStreams;
//#endregion
//#region src/index.d.ts

declare const name = "sdk-ws-bridge";
declare const inject: string[];
/** Bridge deployment config. All fields optional; defaults applied by hand. */
interface BridgeConfig {
  /** Listen port. @default 7800 */
  port?: number;
  /** Listen host. Containers need `0.0.0.0`; loopback is the safe default. @default '127.0.0.1' */
  host?: string;
  /** Shared secret. Falls back to `KOINROKKA_BRIDGE_TOKEN`. Required, fail closed. */
  token?: string;
  /** Mirror of the stdio server option. @default false */
  maxTokensAsSuccess?: boolean;
}
declare function apply(ctx: Context, config?: BridgeConfig): void;
//#endregion
export { BridgeConfig, WsStreams, apply, inject, name, wsToStreams };