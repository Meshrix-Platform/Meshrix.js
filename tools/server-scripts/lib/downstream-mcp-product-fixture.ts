import http from "node:http";

function sendJson(response?: any, status?: any, payload?: any) : any {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

export function startDownstreamMcpProductFixtureServer(fixtureState: Record<string, any> = { echoCount: 0 }) : any {
  return new Promise((resolve?: any) : any => {
    const upstream: any = http.createServer(async (request?: any, response?: any) : Promise<any> => {
      const url: any = new URL(request.url || "/", "http://127.0.0.1");
      const chunks: any[] = [];
      request.on("data", (chunk?: any) : any => chunks.push(chunk));
      await new Promise((done?: any) : any => request.on("end", done));
      if (url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (url.pathname === "/echo") {
        fixtureState.echoCount += 1;
        const body: any = Buffer.concat(chunks).toString("utf8");
        sendJson(response, 200, {
          ok: true,
          method: request.method,
          echoed: body ? JSON.parse(body) : {}
        });
        return;
      }
      if (url.pathname === "/fail") {
        sendJson(response, 500, { ok: false, error: "fixture_failure" });
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
