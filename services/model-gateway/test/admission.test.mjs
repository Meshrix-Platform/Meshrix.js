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

const CALL = { model: "model-1", messages: [{ role: "user", content: "hello admission fixture" }] };

test("input token budget denial resolves no credential and performs no egress", async (t) => {
  const service = await startService({ bounds: { maxInputTokenBudget: 1 } });
  t.after(() => service.close());
  await provision(service);
  const response = await openAiCall(service, CALL);
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.error.code, "budget_exceeded");
  assert.equal(service.fixture.openAiCalls(), 0, "denial must not reach the provider");
});

test("requested output token budget denial causes no egress", async (t) => {
  const service = await startService({ bounds: { maxRequestedOutputTokenBudget: 1 } });
  t.after(() => service.close());
  await provision(service);
  const response = await openAiCall(service, { ...CALL, max_tokens: 32 });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "budget_exceeded");
  assert.equal(service.fixture.openAiCalls(), 0);
});

test("total token quota denial causes no egress", async (t) => {
  const service = await startService({ bounds: { maxTotalTokenQuota: 1 } });
  t.after(() => service.close());
  await provision(service);
  const response = await openAiCall(service, CALL);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "budget_exceeded");
  assert.equal(service.fixture.openAiCalls(), 0);
});

test("cost quota denial causes no egress", async (t) => {
  const service = await startService({ bounds: { maxCostQuotaMicros: 1 } });
  t.after(() => service.close());
  await provision(service);
  const response = await openAiCall(service, CALL);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "quota_exceeded");
  assert.equal(service.fixture.openAiCalls(), 0);
});

test("request rate limiting rejects a second call without egress", async (t) => {
  const service = await startService({ bounds: { maxRatePerSecond: 1 } });
  t.after(() => service.close());
  await provision(service);
  const first = await openAiCall(service, CALL);
  assert.equal(first.status, 200);
  const second = await openAiCall(service, CALL);
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, "rate_limited");
  assert.equal(service.fixture.openAiCalls(), 1);
});

test("concurrent call bound rejects parallel admission without egress", async (t) => {
  const service = await startService({ bounds: { maxConcurrentCalls: 1 } });
  t.after(() => service.close());
  await provision(service);
  const held = openAiCall(service, CALL, { "x-hold": "1" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = await openAiCall(service, CALL);
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, "rate_limited");
  assert.equal(service.fixture.openAiCalls(), 1, "the second call must not reach the provider");
  service.fixture.release("model-1");
  const first = await held;
  assert.equal(first.status, 200);
  assert.equal(service.fixture.openAiCalls(), 1, "the released call is the only provider request");
});

test("unconfigured provider egress leaves the ledger in_doubt without leaking credentials", async (t) => {
  const service = await startService({ configureEgress: false });
  t.after(() => service.close());
  await provision(service);
  const response = await openAiCall(service, CALL);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, "provider_unavailable");
  assert.ok(!JSON.stringify(body).includes("fixture-provider-secret"), "credentials must never leak");
  assert.equal(service.fixture.openAiCalls(), 0);
});
