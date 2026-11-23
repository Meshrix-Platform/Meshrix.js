import { renderConsoleHtml } from "./console-html.ts";
import { MeshrixGatewayDO, type GatewayEnv } from "./gateway-do.ts";

export { MeshrixGatewayDO, type GatewayEnv };

const MCP_CORS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Meshrix.js-Api-Key, X-Meshrix-Approval-Id, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
});

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function withCorsHeaders(response: Response, headers: Readonly<Record<string, string>>): Response {
  const merged = new Headers(response.headers);
  for (const [k, v] of Object.entries(headers)) {
    merged.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

function getGatewayStub(env: GatewayEnv): DurableObjectStub<MeshrixGatewayDO> {
  const id = env.GATEWAY.idFromName("default");
  return env.GATEWAY.get(id);
}

const worker: ExportedHandler<GatewayEnv> = {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    const url = new URL(request.url);
    const demoMode = String(env.DEMO_MODE ?? "false").toLowerCase() === "true";

    if (url.pathname === "/health" && (request.method === "GET" || request.method === "HEAD")) {
      return new Response(
        request.method === "HEAD"
          ? null
          : JSON.stringify({
              ok: true,
              service: "meshrix-cloudflare-gateway",
              mode: demoMode ? "demo" : "self-hosted",
              timestamp: new Date().toISOString(),
            }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    }

    if ((url.pathname === "/" || url.pathname === "/index.html") && request.method === "GET") {
      const nonce = randomNonce();
      const html = renderConsoleHtml({ demoMode, nonce });
      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": [
            "default-src 'none'",
            `script-src 'nonce-${nonce}'`,
            `style-src 'nonce-${nonce}'`,
            "connect-src 'self'",
            "img-src 'self' data:",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
          ].join("; "),
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "no-store",
        },
      });
    }

    if (url.pathname === "/mcp") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: MCP_CORS_HEADERS,
        });
      }
      const stub = getGatewayStub(env);
      const response = await stub.fetch(request);
      return withCorsHeaders(response, MCP_CORS_HEADERS);
    }

    if (url.pathname.startsWith("/admin/")) {
      const stub = getGatewayStub(env);
      return stub.fetch(request);
    }

    return new Response(JSON.stringify({ error: "not_found", message: "Route not found." }), {
      status: 404,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
};

export default worker;
