import { spawn, type ChildProcess } from "node:child_process";
import { fetchWithPinnedDns } from "@meshrix/foundation/security/outbound-egress-policy";

export const MAX_UPSTREAM_MESSAGE_BYTES = 1024 * 1024;

type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function configError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export interface UpstreamTransportService {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface RemoteUpstreamPolicy {
  readonly allowLoopbackUpstreams: boolean;
}

export async function fetchRpc(
  endpoint: string,
  request: Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string>>,
  signal?: AbortSignal,
  remote?: RemoteUpstreamPolicy
) {
  const init = { method: "POST", body: JSON.stringify(request), headers, redirect: "manual" as const, signal };
  const literalLoopback = ["127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname);
  const pinned = remote ? await fetchWithPinnedDns({ url: endpoint, init, maxRedirects: 0,
    policies: remote.allowLoopbackUpstreams && literalLoopback ? { egress: { allowLocalForDevelopment: true } } : {}, label: "gateway.remote.upstream" }) : undefined;
  const response = pinned?.response ?? await fetch(endpoint, init);
  const chunks: Buffer[] = [];
  let size = 0;
  try { if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > MAX_UPSTREAM_MESSAGE_BYTES) throw configError("gateway_response_oversize", "Peer response exceeds the configured budget.");
        chunks.push(chunk);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } } finally { await pinned?.close(); }
  const text = Buffer.concat(chunks).toString("utf8");
  return { status: response.status, headers: Object.fromEntries(response.headers), body: text ? JSON.parse(text) as unknown : null };
}

export class StdioPeerTransport {
  readonly #child: ChildProcess;
  readonly #pending = new Map<string, { resolve: (value: { status: number; body: unknown }) => void; reject: (error: unknown) => void; abort: () => void; signal?: AbortSignal }>();
  #partial = "";
  #closed = false;

  #hasExited(): boolean {
    return this.#child.exitCode !== null || this.#child.signalCode !== null;
  }

  constructor(service: UpstreamTransportService) {
    if (!service.command) throw configError("gateway_stdio_invalid", "Stdio peer command is unavailable.");
    this.#child = spawn(service.command, [...(service.args ?? [])], { stdio: ["pipe", "pipe", "pipe"], shell: false,
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...service.env } });
    this.#child.stderr?.on("data", () => {});
    this.#child.stdin?.on("error", () => this.#fail(configError("gateway_stdio_lost", "Stdio peer input closed unexpectedly.")));
    this.#child.stdout?.setEncoding("utf8");
    this.#child.stdout?.on("data", (chunk: string) => {
      if (this.#closed) return;
      this.#partial += chunk;
      if (Buffer.byteLength(this.#partial) > MAX_UPSTREAM_MESSAGE_BYTES) { this.#fail(configError("gateway_response_oversize", "Stdio peer response exceeded the budget.")); return; }
      let boundary: number;
      while ((boundary = this.#partial.indexOf("\n")) >= 0) {
        const line = this.#partial.slice(0, boundary).trim();
        this.#partial = this.#partial.slice(boundary + 1);
        if (!line) continue;
        let body: RecordValue;
        try { const parsed: unknown = JSON.parse(line); if (!record(parsed)) throw new Error("bad response"); body = parsed; }
        catch { this.#fail(configError("gateway_stdio_invalid", "Stdio peer sent invalid JSON-RPC.")); return; }
        const id = String(body.id ?? "");
        const waiting = this.#pending.get(id);
        if (!waiting) continue;
        this.#pending.delete(id);
        waiting.signal?.removeEventListener("abort", waiting.abort);
        waiting.resolve({ status: 200, body });
      }
    });
    this.#child.once("error", () => this.#fail(configError("gateway_stdio_lost", "Stdio peer failed to start.")));
    this.#child.once("exit", () => this.#fail(configError("gateway_stdio_lost", "Stdio peer exited.")));
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#partial = "";
    for (const [id, pending] of this.#pending) {
      pending.signal?.removeEventListener("abort", pending.abort);
      pending.reject(error);
      this.#pending.delete(id);
    }
    if (!this.#hasExited()) this.#child.kill("SIGTERM");
  }

  send({ request, signal }: { readonly request: Readonly<Record<string, unknown>>; readonly signal?: AbortSignal }): Promise<{ status: number; body: unknown }> {
    if (this.#closed || !this.#child.stdin?.writable) return Promise.reject(configError("gateway_stdio_lost", "Stdio peer is unavailable."));
    const wire = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(wire) > MAX_UPSTREAM_MESSAGE_BYTES) return Promise.reject(configError("gateway_request_oversize", "Stdio request exceeds the budget."));
    const id = request.id;
    if (id === undefined) { this.#child.stdin.write(wire); return Promise.resolve({ status: 202, body: null }); }
    const key = String(id);
    if (this.#pending.has(key)) return Promise.reject(configError("gateway_stdio_duplicate_id", "Stdio request identity is already active."));
    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = this.#pending.get(key);
        if (!pending) return;
        this.#pending.delete(key);
        pending.signal?.removeEventListener("abort", pending.abort);
        reject(configError("gateway_stdio_cancelled", "Stdio request was cancelled."));
      };
      this.#pending.set(key, { resolve, reject, abort, signal });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      this.#child.stdin!.write(wire);
    });
  }

  async close(): Promise<void> {
    if (!this.#hasExited()) {
      const exited = new Promise<void>((resolve) => this.#child.once("exit", () => resolve()));
      this.#fail(configError("gateway_stdio_closed", "Stdio peer was closed."));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); })]); }
      finally { if (timer) clearTimeout(timer); }
      if (!this.#hasExited()) { this.#child.kill("SIGKILL"); await exited; }
    }
  }
}
