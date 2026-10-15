import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createModelGatewayApplication } from "../internal/application.mjs";
import { readLedgerState, ADMIN_CLIENTS, DEFAULT_PRICES, provision, provisionModel, startService } from "./helpers.mjs";
import { startFixtureProvider } from "./fixture-provider.mjs";

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

test("configuration and settled ledger state survive a clean restart", async (t) => {
  const first = await startService();
  t.after(() => first.close({ keepDataRoot: true }));
  await provision(first);
  const response = await openAiCall(first, {
    model: "model-1",
    messages: [{ role: "user", content: "persist me" }]
  }, { "idempotency-key": "ik-persist-1" });
  assert.equal(response.status, 200);
  const callId = (await response.json()).service_call_id;
  await first.close({ keepDataRoot: true });

  const second = await startService({ dataRoot: first.dataRoot, fixture: first.fixture });
  t.after(() => second.close());
  const models = await fetch(`${second.baseUrl}/v1/model-gateway/models`, {
    headers: { authorization: `Bearer ${second.clientSecret}` }
  }).then((r) => r.json());
  assert.equal(models.length, 1);
  assert.equal(models[0].modelId, "model-1");
  const pricing = await fetch(`${second.baseUrl}/v1/model-gateway/pricing`, {
    headers: { authorization: `Bearer ${second.clientSecret}` }
  }).then((r) => r.json());
  assert.equal(pricing.length, 1);
  assert.equal(pricing[0].revisionRef, "price-1");
  const ledger = await fetch(`${second.baseUrl}/v1/model-gateway/ledger/${callId}`, {
    headers: { authorization: `Bearer ${second.clientSecret}` }
  }).then((r) => r.json());
  assert.equal(ledger.state, "settled");
  assert.equal(ledger.attempts, 1);
});

test("orderly close retains data-root ownership until provider work and settlement persist", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "model-gateway-close-drain-"));
  let providerStarted;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  let releaseProvider;
  const pendingProviderResponse = new Promise((resolve) => { releaseProvider = resolve; });
  const release = () => releaseProvider(new Response(JSON.stringify({
    id: "close-drain",
    object: "chat.completion",
    model: "model-1",
    choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const app = await createModelGatewayApplication({
    dataRoot,
    clients: ADMIN_CLIENTS,
    fetchImpl: async () => {
      providerStarted();
      return pendingProviderResponse;
    }
  });
  let call;
  t.after(async () => {
    release();
    if (call) await Promise.allSettled([call]);
    await Promise.allSettled([app.close()]);
    await rm(dataRoot, { recursive: true, force: true });
  });
  await writeFile(path.join(dataRoot, "provider-egress.json"), JSON.stringify({ prov1: { baseUrl: "https://provider.invalid" } }));
  await writeFile(path.join(dataRoot, "secrets.json"), JSON.stringify({ prov1: "synthetic-provider-secret" }));
  const client = app.authenticate({ authorization: `Bearer ${ADMIN_CLIENTS["service-admin"].secret}` });
  await app.createProvider(client, { providerId: "prov1", protocol: "openai", enabled: true }, "setup");
  await app.createPricingRevision(client, {
    revisionRef: "price-1", modelRef: "model-1", currency: "USD", ...DEFAULT_PRICES, immutable: true
  }, "setup");
  await app.createModel(client, {
    modelId: "model-1", providerRef: "prov1", pricingRevisionRef: "price-1", enabled: true
  }, "setup");

  call = app.callOpenAi({
    client,
    body: { model: "model-1", messages: [{ role: "user", content: "x" }], max_completion_tokens: 1 },
    idempotencyKey: "close-drain",
    requestId: "close-drain-request"
  });
  await started;
  let closed = false;
  const closing = app.close().then(() => { closed = true; });
  await assert.rejects(
    createModelGatewayApplication({ dataRoot, clients: ADMIN_CLIENTS }),
    /model_gateway_data_root_in_use/u
  );
  await Promise.resolve();
  assert.equal(closed, false, "close must retain ownership while the provider request is unresolved");
  release();
  const result = await call;
  assert.equal(result.error?.error.code, "cancelled");
  await closing;
  assert.equal(closed, true);

  const reopened = await createModelGatewayApplication({ dataRoot, clients: ADMIN_CLIENTS });
  assert.equal(Object.values(readLedgerState(dataRoot).ledger)[0].state, "settled", "late usage must survive cancellation and restart");
  await reopened.close();
});

for (const protocol of ["openai", "anthropic"]) {
  test(`${protocol} cancellation retains a late receipt without returning late success or replaying egress`, async (t) => {
    let providerStarted;
    const started = new Promise((resolve) => { providerStarted = resolve; });
    let releaseProvider;
    const pending = new Promise((resolve) => { releaseProvider = resolve; });
    let providerCalls = 0;
    const service = await startService({ fetchImpl: async () => {
      providerCalls += 1;
      providerStarted();
      return pending;
    } });
    const providerBody = protocol === "openai"
      ? { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } }
      : { content: [], usage: { input_tokens: 1, output_tokens: 2 } };
    const release = () => releaseProvider(new Response(JSON.stringify(providerBody), {
      headers: { "content-type": "application/json" }
    }));
    t.after(async () => { release(); await service.close(); });
    await provision(service);
    const headers = { authorization: `Bearer ${service.clientSecret}`, "content-type": "application/json" };
    if (protocol === "anthropic") {
      await fetch(`${service.baseUrl}/v1/model-gateway/providers`, {
        method: "POST", headers,
        body: JSON.stringify({ providerId: "prov1", protocol, enabled: true })
      });
    }
    const send = () => fetch(`${service.baseUrl}${protocol === "openai" ? "/v1/chat/completions" : "/v1/messages"}`, {
      method: "POST", headers: { ...headers, "idempotency-key": `late-${protocol}` },
      body: JSON.stringify({ model: "model-1", max_tokens: 2, messages: [{ role: "user", content: "synthetic" }] })
    });
    const call = send();
    await started;
    const state = readLedgerState(service.dataRoot);
    const callId = Object.keys(state.ledger)[0];
    const cancel = await fetch(`${service.baseUrl}/v1/model-gateway/calls/${callId}/cancel`, { method: "POST", headers });
    assert.equal(cancel.status, 200);
    release();
    const response = await call;
    assert.equal(response.status, 499);
    await response.json();
    const replay = await send();
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).service_call_id, callId);
    assert.equal(providerCalls, 1);
    const ledger = await fetch(`${service.baseUrl}/v1/model-gateway/ledger/${callId}`, { headers }).then((result) => result.json());
    assert.equal(ledger.state, "settled");
    assert.equal(ledger.outputTokens, 2);
  });
}

test("idempotent replay after restart performs no second egress", async (t) => {
  const first = await startService();
  await provision(first);
  const call = { model: "model-1", messages: [{ role: "user", content: "restart replay" }] };
  const firstResponse = await openAiCall(first, call, { "idempotency-key": "ik-restart-1" });
  const firstBody = await firstResponse.json();
  await first.close({ keepDataRoot: true });

  const second = await startService({ dataRoot: first.dataRoot, fixture: first.fixture });
  t.after(() => second.close());
  const countBefore = second.fixture.openAiCalls();
  const replay = await openAiCall(second, call, { "idempotency-key": "ik-restart-1" });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), firstBody);
  assert.equal(second.fixture.openAiCalls(), countBefore, "replay must not reach the provider again");
});

test("provider failures make one paid POST and remain in_doubt without a retry", async (t) => {
  const service = await startService();
  t.after(() => service.close());
  const modelId = "fixture-openai-fault";
  await provision(service, { modelId });
  const response = await openAiCall(service, {
    model: modelId,
    messages: [{ role: "user", content: "fail me" }]
  }, { "idempotency-key": "ik-fail-1" });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "provider_unavailable");
  assert.equal(service.fixture.openAiCalls(), 1, "a failed paid POST is never replayed automatically");
  const state = readLedgerState(service.dataRoot);
  const failed = Object.values(state.ledger).find((entry) => entry.idempotencyKey === "ik-fail-1");
  assert.ok(failed);
  assert.equal(failed.state, "in_doubt");
  assert.equal(failed.attempts, 1);
});

test("missing provider usage remains in_doubt instead of settling as zero cost", async (t) => {
  let providerCalls = 0;
  const service = await startService({
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({
        id: "completion-without-usage",
        object: "chat.completion",
        model: "model-1",
        choices: [{ index: 0, message: { role: "assistant", content: "synthetic" }, finish_reason: "stop" }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  t.after(() => service.close());
  await provision(service);
  const response = await openAiCall(service, {
    model: "model-1",
    messages: [{ role: "user", content: "synthetic missing-usage response" }]
  }, { "idempotency-key": "ik-missing-usage" });
  assert.equal(response.status, 200);
  const callId = (await response.json()).service_call_id;
  const ledger = await fetch(`${service.baseUrl}/v1/model-gateway/ledger/${callId}`, {
    headers: { authorization: `Bearer ${service.clientSecret}` }
  }).then((result) => result.json());
  assert.equal(ledger.state, "in_doubt");
  assert.equal(ledger.attempts, 1);
  assert.equal(providerCalls, 1, "the provider request is sent once, then retained as uncertain");
});

test("invalid provider usage is not rounded or settled as a zero-cost call", async (t) => {
  let providerCalls = 0;
  const service = await startService({
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({
        id: "completion-with-invalid-usage",
        object: "chat.completion",
        model: "model-1",
        choices: [{ index: 0, message: { role: "assistant", content: "synthetic" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 7.5 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  t.after(() => service.close());
  await provision(service);
  const response = await openAiCall(service, {
    model: "model-1",
    messages: [{ role: "user", content: "synthetic invalid-usage response" }]
  }, { "idempotency-key": "ik-invalid-usage" });
  assert.equal(response.status, 200);
  const callId = (await response.json()).service_call_id;
  const ledger = await fetch(`${service.baseUrl}/v1/model-gateway/ledger/${callId}`, {
    headers: { authorization: `Bearer ${service.clientSecret}` }
  }).then((result) => result.json());
  assert.equal(ledger.state, "in_doubt");
  assert.equal(ledger.attempts, 1);
  assert.equal(providerCalls, 1);
});

test("same idempotency key with a different request is rejected before provider egress", async (t) => {
  const service = await startService();
  t.after(() => service.close());
  await provision(service);
  const first = await openAiCall(service, {
    model: "model-1",
    messages: [{ role: "user", content: "first request" }]
  }, { "idempotency-key": "ik-bound-request" });
  assert.equal(first.status, 200);
  const second = await openAiCall(service, {
    model: "model-1",
    messages: [{ role: "user", content: "different request" }]
  }, { "idempotency-key": "ik-bound-request" });
  assert.equal(second.status, 400);
  assert.equal((await second.json()).error.code, "invalid_request");
  assert.equal(service.fixture.openAiCalls(), 1);
});

test("idempotency replay and ledger operations are isolated by configured principal", async (t) => {
  const clients = {
    ...ADMIN_CLIENTS,
    "other-client": {
      subject: "other-subject",
      secret: "model-gateway-test-other-secret-0000000000000000000000",
      scopes: ["model:call", "ledger:read"]
    }
  };
  const service = await startService({ clients });
  t.after(() => service.close());
  await provision(service);
  const body = { model: "model-1", messages: [{ role: "user", content: "isolation" }] };
  const first = await openAiCall(service, body, { "idempotency-key": "ik-principal-bound" });
  const firstBody = await first.json();
  const second = await openAiCall(service, body, {
    authorization: `Bearer ${clients["other-client"].secret}`,
    "idempotency-key": "ik-principal-bound"
  });
  const secondBody = await second.json();
  assert.equal(second.status, 200);
  assert.notEqual(secondBody.service_call_id, firstBody.service_call_id);
  assert.equal(service.fixture.openAiCalls(), 2);

  const read = await fetch(`${service.baseUrl}/v1/model-gateway/ledger/${firstBody.service_call_id}`, {
    headers: { authorization: `Bearer ${clients["other-client"].secret}` }
  });
  assert.equal(read.status, 400);
  const readBody = await read.json();
  assert.equal(readBody.error.code, "invalid_request");
  assert.equal(JSON.stringify(readBody).includes("fixture reply"), false);
  const cancel = await fetch(`${service.baseUrl}/v1/model-gateway/calls/${firstBody.service_call_id}/cancel`, {
    method: "POST",
    headers: { authorization: `Bearer ${clients["other-client"].secret}` }
  });
  assert.equal(cancel.status, 400);
});

test("another principal cannot cancel a pending provider call", async (t) => {
  const clients = {
    ...ADMIN_CLIENTS,
    "other-client": {
      subject: "other-subject",
      secret: "model-gateway-test-other-secret-0000000000000000000000",
      scopes: ["model:call", "ledger:read"]
    }
  };
  const service = await startService({ clients });
  t.after(() => service.close());
  const modelId = "fixture-openai-hold";
  await provision(service, { modelId });
  const held = openAiCall(service, {
    model: modelId,
    messages: [{ role: "user", content: "hold for cross-principal cancel" }]
  }, { "idempotency-key": "ik-pending-owner" });
  let state;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    state = readLedgerState(service.dataRoot);
    if (Object.values(state.ledger).some((entry) => entry.idempotencyKey === "ik-pending-owner")) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const callId = Object.keys(state.ledger).find((id) => state.ledger[id].idempotencyKey === "ik-pending-owner");
  assert.ok(callId, "the held call must have a persisted ledger entry");
  const cancel = await fetch(`${service.baseUrl}/v1/model-gateway/calls/${callId}/cancel`, {
    method: "POST",
    headers: { authorization: `Bearer ${clients["other-client"].secret}` }
  });
  assert.equal(cancel.status, 400);
  service.fixture.release(modelId);
  const completed = await held;
  assert.equal(completed.status, 200);
  assert.equal(service.fixture.openAiCalls(), 1);
});

test("RAM response capacity preserves complete durable results and completed idempotency facts", async (t) => {
  const service = await startService({ bounds: { maxLedgerSettledEntries: 2, maxLedgerResponseBytes: 16 } });
  t.after(() => service.close());
  await provision(service);
  const callIds = [];
  const results = [];
  for (let index = 0; index < 3; index += 1) {
    const response = await openAiCall(service, {
      model: "model-1",
      messages: [{ role: "user", content: `retained-replay-${index}` }]
    }, { "idempotency-key": `ik-retained-${index}` });
    assert.equal(response.status, 200);
    const result = await response.json();
    results.push(result);
    callIds.push(result.service_call_id);
  }
  const state = readLedgerState(service.dataRoot);
  const persistedIds = Object.keys(state.ledger);
  assert.equal(persistedIds.length, 3, "accounting history must not be evicted");
  assert.equal(Object.values(state.ledger).filter((entry) => entry.response !== null).length, 3, "RAM pressure must not remove persistent results");
  assert.ok(persistedIds.includes(callIds[0]), "the oldest accounting fact remains available");
  const evictedReplay = await openAiCall(service, {
    model: "model-1",
    messages: [{ role: "user", content: "retained-replay-0" }]
  }, { "idempotency-key": "ik-retained-0" });
  assert.equal(evictedReplay.status, 200);
  assert.deepEqual(await evictedReplay.json(), results[0], "RAM cache misses recover the same full paid result");
  assert.equal(service.fixture.openAiCalls(), 3, "an evicted response must never cause paid reexecution");
  const retainedReplay = await openAiCall(service, {
    model: "model-1",
    messages: [{ role: "user", content: "retained-replay-2" }]
  }, { "idempotency-key": "ik-retained-2" });
  assert.equal(retainedReplay.status, 200);
  assert.deepEqual(await retainedReplay.json(), results[2], "retained replays keep the complete original result");
  assert.equal(service.fixture.openAiCalls(), 3, "a retained replay must not egress");
});

test("RAM response cache eviction preserves complete paid results across a clean restart", async (t) => {
  const first = await startService({ bounds: { maxLedgerSettledEntries: 1 } });
  t.after(() => first.close({ keepDataRoot: true }));
  const dataRoot = first.dataRoot;
  await provision(first);
  const calls = [];
  for (let index = 0; index < 2; index += 1) {
    const response = await openAiCall(first, {
      model: "model-1",
      messages: [{ role: "user", content: `restart-retention-${index}` }]
    }, { "idempotency-key": `ik-restart-${index}` });
    assert.equal(response.status, 200);
    calls.push(await response.json());
  }
  await first.close({ keepDataRoot: true });
  const persisted = readLedgerState(dataRoot);
  assert.deepEqual(Object.keys(persisted.ledger), calls.map((call) => call.service_call_id), "all accounting facts persist");
  assert.deepEqual(persisted.ledger[calls[0].service_call_id].response, calls[0]);
  const second = await startService({ dataRoot, fixture: first.fixture, bounds: { maxLedgerSettledEntries: 1 } });
  t.after(() => second.close());
  const replayed = await openAiCall(second, {
    model: "model-1",
    messages: [{ role: "user", content: "restart-retention-1" }]
  }, { "idempotency-key": "ik-restart-1" });
  assert.equal(replayed.status, 200);
  assert.deepEqual(await replayed.json(), calls[1], "the complete retained result survives restart");
  assert.equal(second.fixture.openAiCalls(), 2, "restart retains the original completed call binding");
  const oldReplay = await openAiCall(second, { model: "model-1", messages: [{ role: "user", content: "restart-retention-0" }] }, { "idempotency-key": "ik-restart-0" });
  assert.equal(oldReplay.status, 200);
  assert.deepEqual(await oldReplay.json(), calls[0], "the oldest complete result survives RAM eviction and restart");
  assert.equal(second.fixture.openAiCalls(), 2, "restart cannot turn a completed key into a new request");
});

test("pending ledger entries and complete settled results survive RAM cache pressure", async (t) => {
  const service = await startService({ bounds: { maxLedgerSettledEntries: 1 } });
  t.after(() => service.close());
  await provision(service, { modelId: "fixture-openai-fault" });
  await provisionModel(service, { modelId: "model-2", revisionRef: "price-2" });
  const inDoubt = await openAiCall(service, {
    model: "fixture-openai-fault",
    messages: [{ role: "user", content: "must stay in_doubt" }]
  }, { "idempotency-key": "ik-in-doubt" });
  assert.equal(inDoubt.status, 503);
  await inDoubt.json();
  for (let index = 0; index < 2; index += 1) {
    const settled = await openAiCall(service, {
      model: "model-2",
      messages: [{ role: "user", content: `settled-${index}` }]
    }, { "idempotency-key": `ik-settled-${index}` });
    assert.equal(settled.status, 200);
  }
  const state = readLedgerState(service.dataRoot);
  const entries = Object.entries(state.ledger);
  const settledEntries = entries.filter(([, entry]) => entry.state === "settled");
  assert.equal(settledEntries.length, 2, "all settled accounting facts remain");
  assert.equal(settledEntries.filter(([, entry]) => entry.response !== null).length, 2);
  const inDoubtPair = entries.find(([, entry]) => entry.idempotencyKey === "ik-in-doubt");
  assert.ok(inDoubtPair, "an unsettled entry must never be evicted");
  assert.equal(inDoubtPair[1].state, "in_doubt");
  const ledger = await fetch(`${service.baseUrl}/v1/model-gateway/ledger/${inDoubtPair[0]}`, {
    headers: { authorization: `Bearer ${service.clientSecret}` }
  });
  assert.equal(ledger.status, 200, "the retained pending entry remains readable");
});

test("removed clients lose authorization and secrets are not persisted in state", async (t) => {
  const clients = {
    ...ADMIN_CLIENTS,
    removed: {
      subject: "removed-subject",
      secret: "model-gateway-test-removed-secret-0000000000000000000000",
      scopes: ["model:call"]
    }
  };
  const first = await startService({ clients });
  const dataRoot = first.dataRoot;
  await first.close({ keepDataRoot: true });

  const second = await startService({ dataRoot, clients: ADMIN_CLIENTS });
  t.after(() => second.close());
  const revoked = await fetch(`${second.baseUrl}/v1/models`, {
    headers: { authorization: `Bearer ${clients.removed.secret}` }
  });
  assert.equal(revoked.status, 401);
  const persisted = await readFile(path.join(dataRoot, "state.json"), "utf8");
  assert.equal(persisted.includes(clients.removed.secret), false);
  assert.equal(persisted.includes(ADMIN_CLIENTS["service-admin"].secret), false);
});

test("released ledger entries left by a crash become in_doubt on reopen", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "model-gateway-crash-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const fixture = await startFixtureProvider();
  t.after(() => fixture.close());
  await writeFile(
    path.join(dataRoot, "state.json"),
    JSON.stringify({
      schemaVersion: "v0.0.1:model-gateway:state-1",
      clients: ADMIN_CLIENTS,
      admissionPolicy: null,
      providers: {},
      models: {},
      pricingRevisions: {},
      ledger: {
        call_crashed: {
          callId: "call_crashed",
          principalRef: "direct-client",
          idempotencyKey: null,
          modelRef: "model-1",
          pricingRevisionRef: "price-1",
          currency: "USD",
          reservationRef: "res_crashed",
          state: "released",
          attempts: 1,
          amount: { currency: "USD", units: 0, nanos: 0 },
          inputTokens: 0,
          outputTokens: 0,
          response: null
        }
      }
    })
  );
  const application = await createModelGatewayApplication({ dataRoot, clients: ADMIN_CLIENTS });
  const ledger = await application.readLedger(application.authenticate({ authorization: `Bearer ${ADMIN_CLIENTS["service-admin"].secret}` }), "call_crashed", "req-crash");
  assert.equal(ledger.body.state, "in_doubt");
  await application.close();
  const persisted = readLedgerState(dataRoot);
  assert.equal(persisted.ledger.call_crashed.state, "in_doubt");
});

test("cancellation of a pending call leaves an in_doubt ledger without settlement", async (t) => {
  const service = await startService({ bounds: { maxConcurrentCalls: 2 } });
  t.after(() => service.close());
  const modelId = "fixture-openai-hold";
  await provision(service, { modelId });
  const held = openAiCall(
    service,
    { model: modelId, messages: [{ role: "user", content: "hold for cancel" }] },
    { "idempotency-key": "ik-cancel-1" }
  );
  let state;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    state = readLedgerState(service.dataRoot);
    if (Object.values(state.ledger).some((entry) => entry.idempotencyKey === "ik-cancel-1")) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const callId = Object.keys(state.ledger).find((id) => state.ledger[id].idempotencyKey === "ik-cancel-1");
  assert.ok(callId, "the held call must have a ledger entry");
  const cancel = await fetch(`${service.baseUrl}/v1/model-gateway/calls/${callId}/cancel`, {
    method: "POST",
    headers: { authorization: `Bearer ${service.clientSecret}` }
  });
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json()).state, "requested");
  const updated = readLedgerState(service.dataRoot);
  assert.equal(updated.ledger[callId].state, "in_doubt");
  service.fixture.release(modelId);
  await held.catch(() => {});
});

test("cancelling a call after an uncertain provider outcome preserves in_doubt", async (t) => {
  const service = await startService();
  t.after(() => service.close());
  const modelId = "fixture-openai-fault";
  await provision(service, { modelId });
  const response = await openAiCall(service, {
    model: modelId,
    messages: [{ role: "user", content: "provider outcome is uncertain" }]
  }, { "idempotency-key": "ik-in-doubt-cancel" });
  assert.equal(response.status, 503);
  assert.equal(service.fixture.openAiCalls(), 1);

  const state = readLedgerState(service.dataRoot);
  const callId = Object.keys(state.ledger).find((id) => state.ledger[id].idempotencyKey === "ik-in-doubt-cancel");
  assert.ok(callId);
  assert.equal(state.ledger[callId].state, "in_doubt");

  const cancel = await fetch(`${service.baseUrl}/v1/model-gateway/calls/${callId}/cancel`, {
    method: "POST",
    headers: { authorization: `Bearer ${service.clientSecret}` }
  });
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json()).state, "in_doubt");
  assert.equal(service.fixture.openAiCalls(), 1);
});

test("unresolved capacity survives restart and never deletes prior uncertain effects", async (t) => {
  const bounds = { maxLedgerPendingEntries: 1 };
  const first = await startService({ bounds });
  await provision(first, { modelId: "fixture-openai-fault" });
  await provisionModel(first, { modelId: "model-2", revisionRef: "price-2" });
  const request = { model: "fixture-openai-fault", messages: [{ role: "user", content: "uncertain capacity" }] };
  const uncertain = await openAiCall(first, request, { "idempotency-key": "uncertain-capacity" });
  assert.equal(uncertain.status, 503);
  assert.equal(first.fixture.openAiCalls(), 1);
  const saved = readLedgerState(first.dataRoot);
  const uncertainId = Object.keys(saved.ledger)[0];
  const denied = await openAiCall(first, { ...request, model: "model-2" });
  assert.equal(denied.status, 429);
  assert.equal(first.fixture.openAiCalls(), 1);
  const dataRoot = first.dataRoot;
  await first.close({ keepDataRoot: true });
  const second = await startService({ dataRoot, bounds });
  t.after(() => second.close());
  const stillDenied = await openAiCall(second, { ...request, model: "model-2" });
  assert.equal(stillDenied.status, 429);
  assert.equal(second.fixture.openAiCalls(), 0);
  const retry = await openAiCall(second, request, { "idempotency-key": "uncertain-capacity" });
  assert.equal(retry.status, 409);
  assert.equal(second.fixture.openAiCalls(), 0);
  assert.deepEqual(readLedgerState(dataRoot).ledger[uncertainId], saved.ledger[uncertainId]);
});

test("JSON ledger transfer preserves completed paid facts and removes the superseded field", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "model-ledger-transfer-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const entry = { callId: "synthetic_completed", principalRef: "direct-client", idempotencyKey: "synthetic-key",
    requestFingerprint: "synthetic-fingerprint", modelRef: "model-1", pricingRevisionRef: "price-1", currency: "USD",
    reservationRef: "synthetic-reservation", state: "settled", attempts: 1, amount: { currency: "USD", units: 1, nanos: 0 },
    inputTokens: 12, outputTokens: 7, response: { service_call_id: "synthetic_completed", content: "synthetic result" } };
  await writeFile(path.join(dataRoot, "state.json"), JSON.stringify({ schemaVersion: "v0.0.1:model-gateway:state-1",
    clients: {}, admissionPolicy: null, providers: {}, models: {}, pricingRevisions: {}, ledger: { synthetic_completed: entry } }));
  const responseBounds = { maxLedgerSettledEntries: 1, maxLedgerResponseBytes: 1 };
  const application = await createModelGatewayApplication({ dataRoot, clients: ADMIN_CLIENTS, bounds: responseBounds });
  await application.close();
  assert.deepEqual(readLedgerState(dataRoot).ledger.synthetic_completed, entry);
  const config = JSON.parse(await readFile(path.join(dataRoot, "state.json"), "utf8"));
  assert.equal(Object.hasOwn(config, "ledger"), false);
  const reopened = await createModelGatewayApplication({ dataRoot, clients: ADMIN_CLIENTS, bounds: responseBounds });
  await reopened.close();
  assert.deepEqual(readLedgerState(dataRoot).ledger.synthetic_completed, entry);
});

test("settlement store failure never retries the paid request and does not poison later work", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const service = await startService();
  t.after(() => service.close());
  await provision(service);
  const db = new DatabaseSync(path.join(service.dataRoot, "ledger.sqlite"));
  t.after(() => db.close());
  db.exec("CREATE TRIGGER synthetic_settlement_failure BEFORE UPDATE OF state ON calls WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  const body = { model: "model-1", messages: [{ role: "user", content: "synthetic settlement storage failure" }] };
  const failed = await openAiCall(service, body, { "idempotency-key": "storage-failure" });
  assert.equal(failed.status, 500);
  assert.equal(service.fixture.openAiCalls(), 1);
  db.exec("DROP TRIGGER synthetic_settlement_failure");
  const uncertainRetry = await openAiCall(service, body, { "idempotency-key": "storage-failure" });
  assert.equal(uncertainRetry.status, 409);
  assert.equal(service.fixture.openAiCalls(), 1, "repairing storage must not repeat an uncertain paid request");
  const newRequest = await openAiCall(service, body, { "idempotency-key": "new-work-after-repair" });
  assert.equal(newRequest.status, 200);
  assert.equal(service.fixture.openAiCalls(), 2);
});
