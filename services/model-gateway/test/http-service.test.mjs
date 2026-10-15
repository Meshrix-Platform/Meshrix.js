import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { provision, startService } from "./helpers.mjs";

async function openAiCall(service, body, headers = {}) {
  return fetch(`${service.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${service.clientSecret}`,
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

test("health and readiness report liveness and admission state", async (t) => {
  const service = await startService();
  t.after(() => service.close());
  const health = await fetch(`${service.baseUrl}/health`).then((response) => response.json());
  assert.deepEqual(health, { status: "ok" });
  const ready = await fetch(`${service.baseUrl}/ready`).then((response) => response.json());
  assert.deepEqual(ready, { status: "ready" });
});

test("unauthenticated native calls return the standard error envelopes", async (t) => {
  const service = await startService();
  t.after(() => service.close());
  const openAi = await fetch(`${service.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "model-1", messages: [{ role: "user", content: "hi" }] })
  });
  assert.equal(openAi.status, 401);
  const openAiBody = await openAi.json();
  assert.equal(openAiBody.error.code, "unauthorized");
  assert.equal(typeof openAiBody.error.message, "string");

  const anthropic = await fetch(`${service.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "model-1", max_tokens: 16, messages: [{ role: "user", content: "hi" }] })
  });
  assert.equal(anthropic.status, 401);
  const anthropicBody = await anthropic.json();
  assert.equal(anthropicBody.type, "error");
  assert.equal(typeof anthropicBody.request_id, "string");
});

test("ambiguous duplicate or mixed client credentials are rejected", async (t) => {
  const service = await startService();
  t.after(() => service.close());
  const send = (headers) => new Promise((resolve, reject) => {
    const request = httpRequest(`${service.baseUrl}/v1/models`, { headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(await send({ authorization: [`Bearer ${service.clientSecret}`, `Bearer ${service.clientSecret}`] }), 401);
  assert.equal(await send({ authorization: `Bearer ${service.clientSecret}`, "x-api-key": service.clientSecret }), 401);
});

test("native OpenAI chat completions settle exactly once against an immutable price revision", async (t) => {
  const service = await startService();
  t.after(() => service.close());
  await provision(service);

  const first = await openAiCall(service, {
    model: "model-1",
    messages: [{ role: "user", content: "hello fixture" }]
  }, { "idempotency-key": "ik-openai-1" });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.object, "chat.completion");
  assert.equal(firstBody.choices[0].message.content, "fixture reply");
  assert.equal(firstBody.usage.total_tokens, 19);
  assert.ok(firstBody.service_call_id);
  assert.equal(service.fixture.openAiCalls(), 1);

  const ledgerResponse = await fetch(
    `${service.baseUrl}/v1/model-gateway/ledger/${firstBody.service_call_id}`,
    { headers: { authorization: `Bearer ${service.clientSecret}` } }
  );
  assert.equal(ledgerResponse.status, 200);
  const ledger = await ledgerResponse.json();
  assert.equal(ledger.state, "settled");
  assert.equal(ledger.attempts, 1);
  assert.equal(ledger.currency, "USD");
  assert.equal(ledger.inputTokens, 12);
  assert.equal(ledger.outputTokens, 7);
  assert.deepEqual(ledger.amount, { currency: "USD", units: 0, nanos: 26_000_000 });

  const replay = await openAiCall(service, {
    model: "model-1",
    messages: [{ role: "user", content: "hello fixture" }]
  }, { "idempotency-key": "ik-openai-1" });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), firstBody);
  assert.equal(service.fixture.openAiCalls(), 1, "idempotent replay must not cause a second egress");
});

test("native Anthropic messages call returns the standard message shape", async (t) => {
  const service = await startService();
  t.after(() => service.close());
  await provision(service);
  const headers = {
    authorization: `Bearer ${service.clientSecret}`,
    "content-type": "application/json"
  };
  await fetch(`${service.baseUrl}/v1/model-gateway/providers`, {
    method: "POST",
    headers,
    body: JSON.stringify({ providerId: "prov2", protocol: "anthropic", enabled: true })
  });
  await fetch(`${service.baseUrl}/v1/model-gateway/pricing-revisions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      revisionRef: "price-2",
      modelRef: "model-2",
      currency: "USD",
      inputTokenRate: { currency: "USD", units: 0, nanos: 1_000_000 },
      outputTokenRate: { currency: "USD", units: 0, nanos: 2_000_000 },
      immutable: true
    })
  });
  await fetch(`${service.baseUrl}/v1/model-gateway/models`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      modelId: "model-2",
      providerRef: "prov2",
      pricingRevisionRef: "price-2",
      enabled: true
    })
  });
  const response = await fetch(`${service.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": service.clientSecret,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "model-2",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }]
    })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.type, "message");
  assert.equal(body.content[0].text, "fixture reply");
  assert.equal(body.usage.input_tokens, 9);
  assert.equal(body.usage.output_tokens, 5);
  assert.equal(service.fixture.anthropicCalls(), 1);
});

test("streaming native calls emit standard server-sent events", async (t) => {
  const service = await startService();
  t.after(() => service.close());
  await provision(service);
  const response = await openAiCall(service, {
    model: "model-1",
    messages: [{ role: "user", content: "stream please" }],
    stream: true
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/u);
  const text = await response.text();
  assert.ok(text.includes("data: [DONE]"));
  assert.ok(text.includes("chat.completion.chunk"));
  assert.equal(service.fixture.openAiRequestBodies()[0].stream, false, "the synthetic SSE wrapper uses one bounded JSON provider response");
});

test("default OpenAI output cap is sent upstream and billed choice count is reserved", async (t) => {
  const service = await startService({ bounds: { maxRequestedOutputTokenBudget: 2048 } });
  t.after(() => service.close());
  await provision(service);
  const response = await openAiCall(service, {
    model: "model-1",
    messages: [{ role: "user", content: "bounded output" }],
    n: 2
  });
  assert.equal(response.status, 200);
  const forwarded = service.fixture.openAiRequestBodies()[0];
  assert.equal(forwarded.max_completion_tokens, 1024);
  assert.equal(forwarded.n, 2);
  const conflict = await openAiCall(service, {
    model: "model-1",
    messages: [{ role: "user", content: "ambiguous output cap" }],
    max_tokens: 32,
    max_completion_tokens: 32
  });
  assert.equal(conflict.status, 400);
  assert.equal((await conflict.json()).error.code, "invalid_request");
  assert.equal(service.fixture.openAiCalls(), 1, "ambiguous token caps are rejected before provider egress");
});

test("management operations validate model, provider, and immutable pricing bindings", async (t) => {
  const service = await startService();
  t.after(() => service.close());
  const headers = {
    authorization: `Bearer ${service.clientSecret}`,
    "content-type": "application/json"
  };
  const missingProvider = await fetch(`${service.baseUrl}/v1/model-gateway/models`, {
    method: "POST",
    headers,
    body: JSON.stringify({ modelId: "m", providerRef: "missing", pricingRevisionRef: "p", enabled: true })
  });
  assert.equal(missingProvider.status, 400);
  assert.equal((await missingProvider.json()).error.code, "invalid_request");

  await provision(service);
  const mismatchedRateCurrency = await fetch(`${service.baseUrl}/v1/model-gateway/pricing-revisions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      revisionRef: "price-mismatched-currency",
      modelRef: "model-1",
      currency: "USD",
      inputTokenRate: { currency: "CAD", units: 1, nanos: 0 },
      outputTokenRate: { currency: "USD", units: 1, nanos: 0 },
      immutable: true
    })
  });
  assert.equal(mismatchedRateCurrency.status, 400);

  const subScaleRate = await fetch(`${service.baseUrl}/v1/model-gateway/pricing-revisions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      revisionRef: "price-subscale-rate",
      modelRef: "model-1",
      currency: "USD",
      inputTokenRate: { currency: "USD", units: 0, nanos: 999 },
      outputTokenRate: { currency: "USD", units: 1, nanos: 0 },
      immutable: true
    })
  });
  assert.equal(subScaleRate.status, 200, "nanounit token rates remain exact and are rounded only after token aggregation");

  const mismatchedPolicyCurrency = await fetch(`${service.baseUrl}/v1/model-gateway/pricing-revisions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      revisionRef: "price-mismatched-policy-currency",
      modelRef: "model-1",
      currency: "CAD",
      inputTokenRate: { currency: "CAD", units: 1, nanos: 0 },
      outputTokenRate: { currency: "CAD", units: 1, nanos: 0 },
      immutable: true
    })
  });
  assert.equal(mismatchedPolicyCurrency.status, 400);

  const replaced = await fetch(`${service.baseUrl}/v1/model-gateway/pricing-revisions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      revisionRef: "price-1",
      modelRef: "model-1",
      currency: "USD",
      inputTokenRate: { currency: "USD", units: 9, nanos: 0 },
      outputTokenRate: { currency: "USD", units: 9, nanos: 0 },
      immutable: true
    })
  });
  assert.equal(replaced.status, 400);
  assert.match((await replaced.json()).error.message, /immutable/u);

  const models = await fetch(`${service.baseUrl}/v1/models`, {
    headers: { authorization: `Bearer ${service.clientSecret}` }
  });
  assert.equal(models.status, 200);
  const modelList = await models.json();
  assert.equal(modelList.object, "list");
  assert.equal(modelList.data.length, 1);
  assert.equal(modelList.data[0].id, "model-1");
});

test("management reads require a management scope while discovery stays an authorized projection", async (t) => {
  const clients = {
    "service-admin": {
      subject: "direct-client",
      secret: "model-gateway-test-admin-secret-0000000000000000000000",
      scopes: ["model:call", "model:manage", "ledger:read"]
    },
    reader: {
      subject: "reader-subject",
      secret: "model-gateway-test-reader-secret-00000000000000000000",
      scopes: ["model:read"]
    },
    caller: {
      subject: "caller-subject",
      secret: "model-gateway-test-caller-secret-00000000000000000000",
      scopes: ["model:call"]
    },
    empty: {
      subject: "empty-subject",
      secret: "model-gateway-test-empty-secret-000000000000000000000",
      scopes: []
    }
  };
  const service = await startService({ clients });
  t.after(() => service.close());
  await provision(service);
  const get = (pathname, secret) => fetch(`${service.baseUrl}${pathname}`, {
    headers: { authorization: `Bearer ${secret}` }
  });
  const managedPaths = [
    "/v1/model-gateway/providers",
    "/v1/model-gateway/models",
    "/v1/model-gateway/pricing",
    "/v1/model-gateway/pricing-revisions"
  ];
  for (const pathname of managedPaths) {
    const unscoped = await get(pathname, clients.empty.secret);
    assert.equal(unscoped.status, 401, `${pathname} must deny an authenticated client without a management scope`);
    assert.equal((await unscoped.json()).error.code, "unauthorized");
    const callOnly = await get(pathname, clients.caller.secret);
    assert.equal(callOnly.status, 401, `${pathname} must deny a model:call-only client`);
  }
  const readable = await get("/v1/model-gateway/models", clients.reader.secret);
  assert.equal(readable.status, 200, "model:read grants read-only management visibility");
  const writeDenied = await fetch(`${service.baseUrl}/v1/model-gateway/providers`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${clients.reader.secret}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ providerId: "prov9", protocol: "openai", enabled: true })
  });
  assert.equal(writeDenied.status, 401, "model:read must not grant management writes");
  const discovery = await get("/v1/models", clients.empty.secret);
  assert.equal(discovery.status, 200, "model discovery remains available to any authenticated client");
  const list = await discovery.json();
  assert.equal(list.object, "list");
  assert.equal(list.data.length, 1);
  assert.deepEqual(Object.keys(list.data[0]).sort(), ["id", "object", "owned_by"],
    "ordinary discovery must expose only the authorized projection");
  const detail = await get("/v1/models/model-1", clients.empty.secret);
  assert.equal(detail.status, 200);
  assert.deepEqual(Object.keys(await detail.json()).sort(), ["id", "object", "owned_by"]);
});

test("route_not_found returns the stable error envelope", async (t) => {
  const service = await startService();
  t.after(() => service.close());
  const response = await fetch(`${service.baseUrl}/v1/nope`, {
    headers: { authorization: `Bearer ${service.clientSecret}` }
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "invalid_request");
});

test("unknown model is rejected before any egress", async (t) => {
  const service = await startService();
  t.after(() => service.close());
  const response = await openAiCall(service, {
    model: "missing-model",
    messages: [{ role: "user", content: "hi" }]
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "model_not_found");
  assert.equal(service.fixture.openAiCalls(), 0);
});

test("native and managed admission reject chunked bodies before reading bytes", async (t) => {
  const { EventEmitter } = await import("node:events");
  const service = await startService({ bounds: { maxSubjectConcurrentCalls: 1 } });
  t.after(() => service.close());
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const bodyStarted = new Promise((resolve) => { started = resolve; });
  function request(pathname, held = false) {
    const request = new EventEmitter();
    request.url = pathname;
    request.method = "POST";
    request.headers = { authorization: `Bearer ${service.clientSecret}` };
    request.rawHeaders = ["Authorization", request.headers.authorization];
    request.reads = 0;
    request[Symbol.asyncIterator] = async function* () {
      this.reads++;
      if (held) { started(); await gate; }
      yield Buffer.from("{}");
    };
    return request;
  }
  function response() {
    const response = new EventEmitter();
    response.writeHead = (status) => { response.status = status; };
    response.end = (bytes) => { response.body = JSON.parse(String(bytes)); response.writableEnded = true; };
    return response;
  }
  const heldRequest = request("/v1/model-gateway/providers", true);
  const pending = service.handler(heldRequest, response());
  await bodyStarted;
  try {
    for (const pathname of ["/v1/model-gateway/models", "/v1/model-gateway/pricing", "/v1/chat/completions", "/v1/messages"]) {
      const denied = request(pathname);
      const result = response();
      await service.handler(denied, result);
      assert.equal(result.status, 429);
      assert.equal(denied.reads, 0, "capacity denial must precede body consumption");
    }
  } finally { release(); await pending; }
  assert.equal(service.fixture.openAiCalls(), 0);
  const available = request("/v1/model-gateway/models");
  const accepted = response();
  await service.handler(available, accepted);
  assert.equal(available.reads, 1, "completion releases aggregate request capacity");
});

test("malformed managed requests consume a bounded pre-body request rate", async (t) => {
  const { EventEmitter } = await import("node:events");
  const service = await startService({ bounds: { maxSubjectRequestRatePerSecond: 1 } });
  t.after(() => service.close());
  function request() {
    const value = new EventEmitter();
    value.method = "POST";
    value.url = "/v1/model-gateway/providers";
    value.headers = { authorization: `Bearer ${service.clientSecret}` };
    value.rawHeaders = ["Authorization", value.headers.authorization];
    value.reads = 0;
    value[Symbol.asyncIterator] = async function* () { this.reads++; yield Buffer.from("{}"); };
    return value;
  }
  function response() {
    const value = new EventEmitter();
    value.writeHead = (status) => { value.status = status; };
    value.end = () => { value.writableEnded = true; };
    return value;
  }
  const first = request();
  await service.handler(first, response());
  assert.equal(first.reads, 1);
  const second = request();
  const denied = response();
  await service.handler(second, denied);
  assert.equal(denied.status, 429);
  assert.equal(second.reads, 0, "invalid domain input cannot reset its pre-body traffic budget");
  assert.equal(service.fixture.openAiCalls(), 0);
});
