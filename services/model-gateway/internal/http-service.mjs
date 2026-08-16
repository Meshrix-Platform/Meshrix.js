import crypto from "node:crypto";

import { createModelGatewayApplication } from "./application.mjs";
import { anthropicError, openAiError, stableError } from "./stable-errors.mjs";

function writeJson(response, status, payload) {
  const bytes = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
    "x-content-type-options": "nosniff"
  });
  response.end(bytes);
}

function writeSse(response, lines) {
  response.writeHead(200, {
    "cache-control": "no-store, no-transform",
    "content-type": "text/event-stream; charset=utf-8",
    connection: "keep-alive",
    "x-content-type-options": "nosniff"
  });
  response.flushHeaders?.();
  for (const line of lines) {
    response.write(`${line}\n`);
  }
  response.end();
}

async function readJson(request, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > maxBytes) throw Object.assign(new Error("Request body is too large."), { code: "invalid_request" });
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body is invalid JSON."), { code: "invalid_request" });
  }
}

function openAiChunks(body) {
  const lines = [
    `data: ${JSON.stringify({
      id: body.id,
      object: "chat.completion.chunk",
      model: body.model,
      choices: [{ index: 0, delta: body.choices?.[0]?.message || { role: "assistant" }, finish_reason: "stop" }],
      usage: body.usage
    })}`,
    "",
    "data: [DONE]",
    ""
  ];
  return lines;
}

function anthropicChunks(body) {
  const text = body.content?.[0]?.text || "";
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: body.id, type: "message", model: body.model, content: [], usage: body.usage } })}`,
    "",
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
    "",
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}`,
    "",
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    "",
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: body.stop_reason }, usage: body.usage })}`,
    "",
    "event: message_stop\ndata: {\"type\":\"message_stop\"}",
    ""
  ];
}

export async function createModelGatewayHttpHandler(options = {}) {
  const {
    dataRoot,
    maxRequestBytes = 2 * 1024 * 1024,
    clients = {},
    requestTimeoutMs,
    maxAttempts,
    bounds,
    fetchImpl,
    windowMs,
    now
  } = options;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1024 || maxRequestBytes > 4 * 1024 * 1024) {
    throw new TypeError("maxRequestBytes must be between 1024 and 4194304.");
  }
  const application = await createModelGatewayApplication({
    dataRoot,
    clients,
    requestTimeoutMs,
    maxAttempts,
    bounds,
    fetchImpl,
    windowMs,
    now
  });

  function authenticated(request) {
    return application.authenticate(request.headers);
  }

  function nativeEnvelope(protocol, error) {
    return protocol === "anthropic" ? anthropicError(error) : openAiError(error);
  }

  async function handleNativeCall(request, response, protocol) {
    const requestId = crypto.randomUUID();
    const client = authenticated(request);
    if (!client) {
      writeJson(response, 401, nativeEnvelope(protocol, stableError("unauthorized", "client authentication required", requestId)));
      return;
    }
    const body = await readJson(request, maxRequestBytes);
    const idempotencyKey = String(request.headers["idempotency-key"] || "").trim() || null;
    const result = protocol === "anthropic"
      ? await application.callAnthropic({
          client,
          body,
          idempotencyKey,
          requestId,
          headers: request.headers
        })
      : await application.callOpenAi({
          client,
          body,
          idempotencyKey,
          requestId,
          headers: request.headers
        });
    if (result.error) {
      writeJson(response, result.error.status, nativeEnvelope(protocol, result.error));
      return;
    }
    if (body.stream === true) {
      const lines = protocol === "anthropic" ? anthropicChunks(result.body) : openAiChunks(result.body);
      writeSse(response, lines);
      return;
    }
    writeJson(response, result.status || 200, result.body);
  }

  async function handleManaged(request, response, method, pathname, searchParams) {
    const requestId = crypto.randomUUID();
    const client = authenticated(request);
    if (!client) {
      writeJson(response, 401, stableError("unauthorized", "client authentication required", requestId));
      return;
    }
    const body = method === "POST" ? await readJson(request, maxRequestBytes) : {};
    let result;
    if (pathname === "/v1/model-gateway/providers") {
      result = method === "POST"
        ? await application.createProvider(client, body, requestId)
        : { body: application.listProviders() };
    } else if (pathname === "/v1/model-gateway/models") {
      result = method === "POST"
        ? await application.createModel(client, body, requestId)
        : { body: application.listModels() };
    } else if (pathname === "/v1/model-gateway/pricing-revisions" || pathname === "/v1/model-gateway/pricing") {
      result = method === "POST"
        ? await application.createPricingRevision(client, body, requestId)
        : { body: application.listPricingRevisions() };
    } else if (pathname === "/v1/models") {
      const models = application.listModels();
      result = { body: { object: "list", data: models.map((model) => application.modelDetail(model.modelId)).filter(Boolean) } };
    } else {
      const modelId = searchParams.get("model_id") || decodeURIComponent(pathname.split("/").pop() || "");
      const detail = application.modelDetail(modelId);
      if (!detail) {
        writeJson(response, 404, nativeEnvelope("openai", stableError("model_not_found", `model ${modelId} is unavailable`, requestId)));
        return;
      }
      result = { body: detail };
    }
    if (result.error) {
      writeJson(response, result.error.status, result.error);
      return;
    }
    writeJson(response, 200, result.body);
  }

  const handler = async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://model-gateway.invalid");
      const pathname = url.pathname;
      const method = request.method || "GET";
      if (method === "GET" && pathname === "/health") {
        writeJson(response, 200, application.health());
        return;
      }
      if (method === "GET" && pathname === "/ready") {
        const readiness = application.readiness();
        writeJson(response, readiness.status === "ready" ? 200 : 503, readiness);
        return;
      }
      if (method === "POST" && pathname === "/v1/chat/completions") {
        await handleNativeCall(request, response, "openai");
        return;
      }
      if (method === "POST" && pathname === "/v1/messages") {
        await handleNativeCall(request, response, "anthropic");
        return;
      }
      if (method === "GET" && (pathname === "/v1/models" || /^\/v1\/models\/[^/]+$/u.test(pathname))) {
        await handleManaged(request, response, method, pathname, url.searchParams);
        return;
      }
      if (method === "GET" || method === "POST") {
        if (pathname === "/v1/model-gateway/providers" ||
            pathname === "/v1/model-gateway/models" ||
            pathname === "/v1/model-gateway/pricing-revisions" ||
            pathname === "/v1/model-gateway/pricing") {
          await handleManaged(request, response, method, pathname, url.searchParams);
          return;
        }
      }
      const cancelMatch = /^\/v1\/model-gateway\/calls\/([^/]+)\/cancel$/u.exec(pathname);
      if (method === "POST" && cancelMatch) {
        const requestId = crypto.randomUUID();
        const client = authenticated(request);
        if (!client) {
          writeJson(response, 401, stableError("unauthorized", "client authentication required", requestId));
          return;
        }
        const result = await application.cancelCall(client, decodeURIComponent(cancelMatch[1]), requestId);
        writeJson(response, result.error ? result.error.status : 200, result.error || result.body);
        return;
      }
      const ledgerMatch = /^\/v1\/model-gateway\/ledger\/([^/]+)$/u.exec(pathname);
      if (method === "GET" && ledgerMatch) {
        const requestId = crypto.randomUUID();
        const client = authenticated(request);
        if (!client) {
          writeJson(response, 401, stableError("unauthorized", "client authentication required", requestId));
          return;
        }
        const result = await application.readLedger(client, decodeURIComponent(ledgerMatch[1]), requestId);
        writeJson(response, result.error ? result.error.status : 200, result.error || result.body);
        return;
      }
      writeJson(response, 404, stableError("invalid_request", "route not found", crypto.randomUUID()));
    } catch {
      writeJson(response, 500, stableError("internal_error", "internal service error", crypto.randomUUID()));
    }
  };

  handler.close = async () => {
    await application.close();
  };
  return handler;
}
