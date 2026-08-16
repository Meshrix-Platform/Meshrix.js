import { createServer } from "node:http";

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on("data", (chunk) => {
      total += chunk.byteLength;
      if (total > 2 * 1024 * 1024) {
        reject(new Error("fixture request too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks, total).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

export async function startFixtureProvider() {
  let openAiCalls = 0;
  let anthropicCalls = 0;
  const held = new Map();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://fixture.invalid");
    const respond = (status, payload) => {
      try {
        const bytes = Buffer.from(JSON.stringify(payload));
        response.writeHead(status, { "content-type": "application/json", "content-length": bytes.byteLength });
        response.end(bytes);
      } catch {
        // The client may have aborted; the fixture only serves tests.
      }
    };
    try {
      const body = await readJson(request);
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        openAiCalls += 1;
        if (request.headers["x-fixture-fail"] === "1") {
          respond(503, { error: { message: "fixture unavailable", type: "provider_error" } });
          return;
        }
        if (request.headers["x-hold"] === "1") {
          await new Promise((resolve) => held.set(body.model, resolve));
        }
        respond(200, {
          id: "chatcmpl-fixture",
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "fixture reply" } }],
          usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 }
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        anthropicCalls += 1;
        if (request.headers["x-fixture-fail"] === "1") {
          respond(503, { error: { type: "provider_error", message: "fixture unavailable" } });
          return;
        }
        respond(200, {
          id: "msg_fixture",
          type: "message",
          model: body.model,
          content: [{ type: "text", text: "fixture reply" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 9, output_tokens: 5 }
        });
        return;
      }
      respond(404, { error: "fixture route not found" });
    } catch {
      respond(400, { error: "fixture invalid request" });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    openAiCalls: () => openAiCalls,
    anthropicCalls: () => anthropicCalls,
    release: (model) => {
      const releaseCall = held.get(model);
      if (releaseCall) releaseCall();
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
