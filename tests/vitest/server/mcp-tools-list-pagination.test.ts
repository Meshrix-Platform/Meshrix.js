import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";

import { createUpstreamMcpSessionManager } from "../../../packages/protocols/mcp/upstream-mcp-gateway-transport.ts";

const managers: any = new Set<any>();

afterEach(async () : Promise<any> => {
  await Promise.all([...managers].map((manager?: any) : any => manager.close()));
  managers.clear();
});

function scriptForCursors(pages: any = []) : any {
  const encoded: any = JSON.stringify(pages);
  return `
let buffer = "";
const pages = ${encoded};
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
function handle(message) {
  if (!message || message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cursor-fixture", version: "1" } } });
    return;
  }
  if (message.method !== "tools/list") return;
  const cursor = message.params && Object.prototype.hasOwnProperty.call(message.params, "cursor")
    ? message.params.cursor
    : undefined;
  const page = pages.find((entry) => Object.is(entry.cursor, cursor));
  if (!page) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "unexpected cursor" } });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, result: { tools: page.tools, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) } });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || "";
  for (const line of lines) if (line.trim()) handle(JSON.parse(line));
});
`;
}

function stdioManager() : any {
  const manager: any = createUpstreamMcpSessionManager();
  managers.add(manager);
  return manager;
}

describe("Upstream MCP tools/list pagination", () : any => {
  it("preserves whitespace-containing opaque cursors on the shared stdio path", async () : Promise<any> => {
    const manager: any = stdioManager();
    const listed: any = await manager.listTools({
      transport: "stdio",
      command: process.execPath,
      args: ["-e", scriptForCursors([
        { cursor: undefined, tools: [{ name: "one" }], nextCursor: "  page-two  " },
        { cursor: "  page-two  ", tools: [{ name: "two" }] }
      ])],
      sessionKey: "cursor-whitespace",
      sessionScope: "cursor-whitespace"
    });
    expect(listed.tools.map((tool?: any) : any => tool.name)).toEqual(["one", "two"]);
  });

  it("rejects an explicit null nextCursor instead of treating it as completion", async () : Promise<any> => {
    const manager: any = createUpstreamMcpSessionManager({
      async fetchTransport(_url?: any, init?: any) : Promise<any> {
        const message: any = JSON.parse(String(init?.body || "{}"));
        if (message.method === "initialize") {
          return {
            response: new Response(JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "synthetic", version: "1" }
              }
            }), {
              status: 200,
              headers: {
                "content-type": "application/json",
                "mcp-session-id": "null-cursor"
              }
            })
          };
        }
        if (message.method === "tools/list") {
          return {
            response: new Response(JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { tools: [{ name: "synthetic" }], nextCursor: null }
            }), { status: 200, headers: { "content-type": "application/json" } })
          };
        }
        return { response: new Response(null, { status: 202 }) };
      }
    });
    managers.add(manager);
    await expect(manager.listTools({
      transport: "streamable-http",
      url: "http://127.0.0.1:9/mcp",
      timeoutMs: 1000,
      sessionKey: "null-cursor",
      sessionScope: "null-cursor"
    })).rejects.toMatchObject({
      code: "upstream_mcp_tools_list_cursor_invalid"
    });
  });

  it("fails closed on an invalid typed cursor instead of returning a partial catalog", async () : Promise<any> => {
    const manager: any = stdioManager();
    await expect(manager.listTools({
      transport: "stdio",
      command: process.execPath,
      args: ["-e", scriptForCursors([
        { cursor: undefined, tools: [{ name: "one" }], nextCursor: 12 }
      ])],
      sessionKey: "cursor-invalid",
      sessionScope: "cursor-invalid"
    })).rejects.toMatchObject({
      code: "upstream_mcp_tools_list_cursor_invalid"
    });
  });

  it("fails closed on a repeated opaque cursor", async () : Promise<any> => {
    const manager: any = stdioManager();
    await expect(manager.listTools({
      transport: "stdio",
      command: process.execPath,
      args: ["-e", scriptForCursors([
        { cursor: undefined, tools: [{ name: "one" }], nextCursor: "loop" },
        { cursor: "loop", tools: [{ name: "two" }], nextCursor: "loop" }
      ])],
      sessionKey: "cursor-repeat",
      sessionScope: "cursor-repeat"
    })).rejects.toMatchObject({
      code: "upstream_mcp_tools_list_cursor_repeated"
    });
  });

  it("preserves whitespace-containing opaque cursors on the shared HTTP path", async () : Promise<any> => {
    const pages: any = new Map<any, any>([
      ["__first__", { tools: [{ name: "one" }], nextCursor: "  page-two  " }],
      ["  page-two  ", { tools: [{ name: "two" }] }]
    ]);
    const sessions: any = new Set<any>();
    const server: any = http.createServer(async (request?: any, response?: any) : Promise<any> => {
      const chunks: any[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const message: any = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (message.method === "initialize") {
        sessions.add("http-cursor");
        response.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "http-cursor"
        });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "http-cursor", version: "1" }
          }
        }));
        return;
      }
      if (message.method === "notifications/initialized") {
        response.writeHead(202);
        response.end();
        return;
      }
      if (message.method === "tools/list") {
        const key: any = message.params && Object.prototype.hasOwnProperty.call(message.params, "cursor")
          ? message.params.cursor
          : "__first__";
        const page: any = pages.get(key);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: page
            ? {
                tools: page.tools,
                ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor })
              }
            : { error: "unexpected cursor", cursor: key }
        }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise((resolve?: any) : any => server.listen(0, "127.0.0.1", resolve));
    const address: any = server.address();
    const manager: any = createUpstreamMcpSessionManager({
      async fetchTransport(url?: any, init?: any) : Promise<any> {
        return {
          response: await fetch(url, init),
          async close() : Promise<any> {}
        };
      }
    });
    managers.add(manager);
    try {
      const listed: any = await manager.listTools({
        transport: "streamable-http",
        url: `http://127.0.0.1:${address.port}/mcp`,
        timeoutMs: 2000,
        sessionKey: "http-cursor-whitespace",
        sessionScope: "http-cursor-whitespace"
      });
      expect(listed.tools.map((tool?: any) : any => tool.name)).toEqual(["one", "two"]);
    } finally {
      await new Promise((resolve?: any) : any => server.close(resolve));
    }
  });
});
