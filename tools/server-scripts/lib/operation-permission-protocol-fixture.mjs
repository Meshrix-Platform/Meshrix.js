import http from "node:http";

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

export function startOperationPermissionProtocolFixtureServer() {
  return new Promise((resolve) => {
    const upstream = http.createServer(async (request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }
      sendJson(response, 404, { ok: false, error: "not_found" });
    });
    upstream.listen(0, "127.0.0.1", () => {
      const address = upstream.address();
      resolve({
        server: upstream,
        url: `http://127.0.0.1:${address.port}`
      });
    });
  });
}
