import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { HarnessSdkJsonRpcServer } from "@deepseek-ai/dsh-sdk-jsonrpc-server";
import { WebSocketServer } from "ws";
import { Readable, Writable } from "node:stream";

//#region src/ws-stream.ts
/**
* Adapt one WebSocket connection into the stream pair `JsonRpcLineTransport`
* consumes. The caller owns the socket; this adapter only attaches listeners.
*/
function wsToStreams(ws) {
	const input = new Readable({ read() {} });
	const output = new Writable({ write(chunk, _encoding, callback) {
		try {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			for (const line of text.split("\n")) {
				const frame = line.trim();
				if (frame) ws.send(frame);
			}
			callback();
		} catch (error) {
			callback(error instanceof Error ? error : new Error(String(error)));
		}
	} });
	ws.on("message", (data) => {
		input.push(`${data.toString("utf8")}\n`);
	});
	ws.on("close", () => {
		input.push(null);
		output.end();
	});
	ws.on("error", () => {
		input.destroy();
		output.destroy();
	});
	return {
		input,
		output,
		closed: new Promise((resolve) => {
			ws.on("close", () => resolve());
		})
	};
}

//#endregion
//#region src/index.ts
const name = "sdk-ws-bridge";
const inject = ["agents"];
function bearerTokenOf(request) {
	const header = request.headers.authorization;
	const text = Array.isArray(header) ? header[0] : header;
	if (text?.startsWith("Bearer ")) return text.slice(7);
	try {
		return new URL(request.url ?? "/", "http://bridge.invalid").searchParams.get("token") ?? void 0;
	} catch {
		return;
	}
}
function apply(ctx, config = {}) {
	const port = config.port ?? 7800;
	const host = config.host ?? "127.0.0.1";
	const token = config.token ?? process.env.KOINROKKA_BRIDGE_TOKEN;
	if (!token) throw new Error("[sdk-ws-bridge] refusing to start without a token: set config token or KOINROKKA_BRIDGE_TOKEN");
	let active;
	const settleOf = (record) => {
		let settled = false;
		return () => {
			if (settled) return;
			settled = true;
			record.transport.close();
			record.server.shutdown().catch(() => {});
			if (active === record) active = void 0;
		};
	};
	const evict = (record, reason) => {
		record.ws.close(1e3, reason);
		record.settle();
	};
	ctx.effect(() => {
		const wss = new WebSocketServer({
			host,
			port
		});
		wss.on("connection", (ws, request) => {
			if (bearerTokenOf(request) !== token) {
				ws.close(4401, "unauthorized");
				setTimeout(() => {
					if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.terminate();
				}, 1e3).unref();
				return;
			}
			if (active) evict(active, "superseded by a newer connection");
			const streams = wsToStreams(ws);
			const transport = new JsonRpcLineTransport(streams.input, streams.output);
			const server = new HarnessSdkJsonRpcServer(ctx, transport, { maxTokensAsSuccess: config.maxTokensAsSuccess ?? false });
			const record = {
				ws,
				transport,
				server,
				streams,
				settle: () => {}
			};
			record.settle = settleOf(record);
			active = record;
			transport.onRequest(async (method, params) => {
				if (method === "initialize") await ctx.get("loader")?.await();
				const result = await server.handleRequest(method, params);
				if (method === "shutdown") setImmediate(() => {
					record.ws.close(1e3, "shutdown");
					record.settle();
				});
				return result;
			});
			transport.start();
			streams.closed.then(record.settle);
		});
		const pingTimer = setInterval(() => {
			for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.ping();
		}, 3e4);
		return () => new Promise((resolve) => {
			clearInterval(pingTimer);
			if (active) evict(active, "plugin unloaded");
			wss.close(() => resolve());
		});
	}, "sdk-ws-bridge.serve");
}

//#endregion
export { apply, inject, name, wsToStreams };