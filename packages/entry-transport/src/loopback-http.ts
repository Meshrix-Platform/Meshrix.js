import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Loopback HTTP face for the local MCP adapter.
 *
 * Binds literal loopback only and enforces an explicit Origin allowlist on
 * browser-bound requests: a request carrying an Origin header that is not on
 * the list is refused before the body is read, so a browser page on the same
 * machine cannot drive the private channel. Requests with no Origin header
 * (native MCP clients, curl) proceed normally.
 */

export const ENTRY_LOOPBACK_MAX_BODY_BYTES = 1024 * 1024;
const MAX_ORIGIN_BYTES = 2048;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]"]);

function normalizeOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_ORIGIN_BYTES || Buffer.byteLength(value, "utf8") > MAX_ORIGIN_BYTES || !/^https?:\/\/[^/?#]+$/iu.test(value)) return undefined;
  try {
    const origin = new URL(value);
    if (value.includes("@") || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return undefined;
    return origin.origin;
  } catch {
    return undefined;
  }
}

function requestOrigin(request: IncomingMessage): string | "absent" | "invalid" {
  let found = false;
  let value: string | undefined;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() !== "origin") continue;
    if (found) return "invalid";
    found = true;
    value = request.rawHeaders[index + 1];
  }
  if (!found) return "absent";
  return normalizeOrigin(value) ?? "invalid";
}

export interface EntryLoopbackHttpOptions {
  readonly handle: (body: unknown) => Promise<Record<string, unknown> | undefined>;
  /** Literal loopback host only; default 127.0.0.1. */
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  /** Explicit browser origins allowed to reach the adapter; empty denies all Origin-bearing requests. */
  readonly allowedOrigins?: readonly string[];
  readonly maxBodyBytes?: number;
  readonly healthPath?: string;
}

export interface EntryLoopbackHttp {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function createEntryMcpLoopbackHttp(options: EntryLoopbackHttpOptions): Promise<EntryLoopbackHttp> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw Object.assign(new Error("The entry MCP adapter only binds literal loopback hosts."), { code: "entry_loopback_host_invalid" });
  }
  const mcpPath = options.path ?? "/mcp";
  const healthPath = options.healthPath ?? "/health";
  const maxBodyBytes = Math.max(256, options.maxBodyBytes ?? ENTRY_LOOPBACK_MAX_BODY_BYTES);
  const allowedOrigins = new Set<string>(options.allowedOrigins ?? []);

  const replyJson = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
  };

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (request.method === "GET" && request.url === healthPath) {
        replyJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method !== "POST" || request.url !== mcpPath) {
        replyJson(response, 404, { jsonrpc: "2.0", id: null, error: { code: -32601, message: "Not found." } });
        return;
      }
      const origin = requestOrigin(request);
      if (origin === "invalid" || (origin !== "absent" && !allowedOrigins.has(origin))) {
        replyJson(response, 403, { jsonrpc: "2.0", id: null, error: { code: -32003, message: "MCP request origin is not allowed." } });
        return;
      }
      const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        replyJson(response, 415, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "MCP entry requires application/json." } });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > maxBodyBytes) {
          replyJson(response, 413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "The request exceeds the byte budget." } });
          return;
        }
        chunks.push(chunk as Buffer);
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        replyJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
        return;
      }
      let reply: Record<string, unknown> | undefined;
      try {
        reply = await options.handle(body);
      } catch {
        replyJson(response, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "The request failed internally." } });
        return;
      }
      if (reply === undefined) {
        // Notification: acknowledged with an empty accepted response.
        response.writeHead(202);
        response.end();
        return;
      }
      replyJson(response, 200, reply);
    } catch {
      if (response.headersSent) {
        response.end();
        return;
      }
      replyJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "MCP entry request was rejected." } });
    }
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host === "[::1]" ? "::1" : host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw Object.assign(new Error("The entry loopback listener has no TCP address."), { code: "entry_loopback_bind_failed" });
  }

  return {
    url: `http://${host === "::1" ? "[::1]" : host}:${address.port}${mcpPath}`,
    port: address.port,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
    }
  };
}
