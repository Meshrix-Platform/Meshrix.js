import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * Standard newline-framed MCP over stdio — installer conventions:
 * JSON-RPC requests arrive one per line on stdin, responses go one per line
 * on stdout, and nothing else is ever written to stdout (operational text
 * belongs to stderr, owned by the embedding process). Stdout backpressure is
 * honored by waiting for `drain`; a line over the byte budget or unparseable
 * JSON is refused with a JSON-RPC error, not a stream failure.
 */

export const ENTRY_STDIO_MAX_LINE_BYTES = 1024 * 1024;

type DrainResult = "drained" | "closed" | "error" | "cancelled";

function waitForDrain(output: Writable, signal: AbortSignal): Promise<DrainResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DrainResult) => {
      if (settled) return;
      settled = true;
      output.off("drain", onDrain);
      output.off("close", onClosed);
      output.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onDrain = () => finish("drained");
    const onClosed = () => finish("closed");
    const onError = () => finish("error");
    const onAbort = () => finish("cancelled");
    output.once("drain", onDrain);
    output.once("close", onClosed);
    output.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) finish("cancelled");
    else if (output.destroyed || output.writableEnded || !output.writable) finish("closed");
  });
}

export interface ServeEntryMcpStdioOptions {
  /** Decoded JSON-RPC body → response (or undefined for a notification). */
  readonly handle: (body: unknown) => Promise<Record<string, unknown> | undefined>;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly signal?: AbortSignal;
  readonly maxLineBytes?: number;
  /** When true, SIGTERM/SIGINT stop the loop (the owning process keeps them). */
  readonly registerProcessSignals?: boolean;
}

export interface StdioServeResult {
  readonly cancelled: boolean;
}

export async function serveEntryMcpStdio(options: ServeEntryMcpStdioOptions): Promise<StdioServeResult> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const maxLineBytes = Math.max(256, options.maxLineBytes ?? ENTRY_STDIO_MAX_LINE_BYTES);
  const lifetime = new AbortController();
  const stop = () => lifetime.abort();
  const forwardAbort = () => stop();
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const registerProcessSignals = options.registerProcessSignals === true && input === process.stdin;
  if (registerProcessSignals) {
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }
  const lines = createInterface({ input, crlfDelay: Infinity });
  const abortListener = () => lines.close();
  lifetime.signal.addEventListener("abort", abortListener, { once: true });
  let cancelled = false;
  try {
    for await (const line of lines) {
      if (lifetime.signal.aborted) break;
      if (!line.trim()) continue;
      let reply: Record<string, unknown> | undefined;
      if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
        reply = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "The request exceeds the byte budget." } };
      } else {
        let body: unknown;
        try {
          body = JSON.parse(line) as unknown;
        } catch {
          reply = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } };
        }
        if (reply === undefined) {
          try {
            reply = await options.handle(body);
          } catch {
            reply = { jsonrpc: "2.0", id: null, error: { code: -32603, message: "The request failed internally." } };
          }
        }
      }
      if (reply === undefined) continue;
      if (!output.write(`${JSON.stringify(reply)}\n`)) {
        const drained = await waitForDrain(output, lifetime.signal);
        if (drained !== "drained") {
          cancelled = drained === "cancelled";
          break;
        }
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", forwardAbort);
    lifetime.signal.removeEventListener("abort", abortListener);
    if (registerProcessSignals) {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    }
    lines.close();
  }
  return Object.freeze({ cancelled });
}
