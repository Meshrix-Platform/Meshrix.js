import http from "node:http";

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

export function startDownstreamMcpProductFixtureServer(fixtureState = { echoCount: 0 }) {
  return new Promise((resolve) => {
    const upstream = http.createServer(async (request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      await new Promise((done) => request.on("end", done));
      if (url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (url.pathname === "/echo") {
        fixtureState.echoCount += 1;
        const body = Buffer.concat(chunks).toString("utf8");
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
    upstream.listen(0, "127.0.0.1", () => {
      const address = upstream.address();
      resolve({
        server: upstream,
        url: `http://127.0.0.1:${address.port}`
      });
    });
  });
}
