import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createModelGatewayApplication } from "../internal/application.mjs";
import { ADMIN_CLIENTS, provision, startService } from "./helpers.mjs";
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

test("provider failures settle the ledger as in_doubt with bounded attempts", async (t) => {
  const service = await startService({ maxAttempts: 3 });
  t.after(() => service.close());
  await provision(service);
  const response = await openAiCall(service, {
    model: "model-1",
    messages: [{ role: "user", content: "fail me" }]
  }, { "x-fixture-fail": "1", "idempotency-key": "ik-fail-1" });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "provider_unavailable");
  assert.equal(service.fixture.openAiCalls(), 3, "attempts are bounded by maxAttempts");
  const state = JSON.parse(await readFile(path.join(service.dataRoot, "state.json"), "utf8"));
  const failed = Object.values(state.ledger).find((entry) => entry.idempotencyKey === "ik-fail-1");
  assert.ok(failed);
  assert.equal(failed.state, "in_doubt");
  assert.equal(failed.attempts, 3);
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
  const persisted = JSON.parse(await readFile(path.join(dataRoot, "state.json"), "utf8"));
  assert.equal(persisted.ledger.call_crashed.state, "in_doubt");
});

test("cancellation of a pending call leaves an in_doubt ledger without settlement", async (t) => {
  const service = await startService({ bounds: { maxConcurrentCalls: 2 } });
  t.after(() => service.close());
  await provision(service);
  const held = openAiCall(
    service,
    { model: "model-1", messages: [{ role: "user", content: "hold for cancel" }] },
    { "x-hold": "1", "idempotency-key": "ik-cancel-1" }
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const state = JSON.parse(await readFile(path.join(service.dataRoot, "state.json"), "utf8"));
  const callId = Object.keys(state.ledger).find((id) => state.ledger[id].idempotencyKey === "ik-cancel-1");
  assert.ok(callId, "the held call must have a ledger entry");
  const cancel = await fetch(`${service.baseUrl}/v1/model-gateway/calls/${callId}/cancel`, {
    method: "POST",
    headers: { authorization: `Bearer ${service.clientSecret}` }
  });
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json()).state, "requested");
  const updated = JSON.parse(await readFile(path.join(service.dataRoot, "state.json"), "utf8"));
  assert.equal(updated.ledger[callId].state, "in_doubt");
  service.fixture.release("model-1");
  await held.catch(() => {});
});
