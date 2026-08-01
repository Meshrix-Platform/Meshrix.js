import http from "node:http";

function sendJson(response?: any, status?: any, payload?: any) : any {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

export function startOperationPermissionProtocolFixtureServer() : any {
  return new Promise((resolve?: any) : any => {
    const upstream: any = http.createServer(async (request?: any, response?: any) : Promise<any> => {
      const url: any = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }
      sendJson(response, 404, { ok: false, error: "not_found" });
    });
    upstream.listen(0, "127.0.0.1", () : any => {
      const address: any = upstream.address();
      resolve({
        server: upstream,
        url: `http://127.0.0.1:${address.port}`
      });
    });
  });
}
