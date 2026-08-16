import assert from "node:assert/strict";
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
