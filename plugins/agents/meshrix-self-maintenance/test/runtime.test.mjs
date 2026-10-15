import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertLocalConfig } from "../internal/config-schema.mjs";
import { MAX_RESPONSE_BYTES } from "../internal/constants.mjs";
import { DirectModelGatewayClient } from "../internal/http-clients.mjs";
import { PrivateStateStore } from "../internal/private-state.mjs";
import { SelfMaintenanceRuntime } from "../internal/runtime.mjs";
import { buildPinnedRun } from "../internal/schedule.mjs";

function config(revision = "rev-1", overrides = {}) {
  return {
    schemaVersion: "v0.0.1:meshrix-self-maintenance:local-config-1",
    enabledRevision: revision,
    targets: [
      { id: "schedule-1", kind: "agent-runtime" },
      { id: "https://model-gateway.invalid", kind: "model-gateway" },
      { id: "https://meshrix.invalid", kind: "meshrix" }
    ],
    strategies: [{ id: "schedule-1", kind: "maintenance-model" }],
    schedules: [{ id: "schedule-1", cron: "* * * * *" }],
    runbooks: [{ id: "schedule-1", steps: [{ operationId: "system.health" }] }],
    budgets: { maxConcurrentCalls: 1, maxCallsPerDay: 24, maxCostUnitsPerDay: 24 },
    operationAllowlist: ["system.health"],
    resourceAllowlist: ["meshrix://system"],
    workspaceSelectors: ["workspace-maintenance"],
    credentialRefs: [
      { id: "model-gateway-client", ref: "credential:model-gateway" },
      { id: "meshrix-client", ref: "credential:meshrix" }
    ],
    ...overrides
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "self-maintenance-test-"));
  const configPath = path.join(root, "config.json");
  const storageRoot = path.join(root, "state");
  const credentialRoot = path.join(root, "credentials");
  await fs.mkdir(credentialRoot, { recursive: true, mode: 0o700 });
  for (const [name, token] of [
    ["model-gateway", "model-token"],
    ["meshrix", "meshrix-token"]
  ]) {
    await fs.writeFile(path.join(credentialRoot, `${name}.json`), JSON.stringify({ token }), { mode: 0o600 });
  }
  return { root, configPath, storageRoot, credentialRoot };
}

async function replaceConfig(file, value) {
  const temporary = `${file}.replacement`;
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(temporary, file);
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function journal(storageRoot) {
  return JSON.parse(await fs.readFile(path.join(storageRoot, "journal.json"), "utf8"));
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("test_wait_timeout");
}

function assertRepeatedSequence(actual, expected) {
  assert.ok(actual.length >= expected.length, "at least one scheduled occurrence must complete");
  assert.equal(actual.length % expected.length, 0, "every scheduled occurrence must complete its full request sequence");
  for (let offset = 0; offset < actual.length; offset += expected.length) {
    assert.deepEqual(actual.slice(offset, offset + expected.length), expected);
  }
}

async function removeTempDir(dirPath) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rm(dirPath, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100
      });
      return;
    } catch (error) {
      if (attempt === 7 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

test("HTTP clients preserve caller cancellation and dispose rejected response bodies", async () => {
  const request = {
    runId: "00000000000000000000000000000001",
    strategyKind: "maintenance-model",
    targetRef: "schedule-1",
    runbookId: "schedule-1",
    operationIds: ["system.health"]
  };
  const credentialStore = { resolve: async () => ({ token: "synthetic-model-token" }) };
  const controller = new AbortController();
  let capturedSignal;
  const signalClient = new DirectModelGatewayClient({
    endpoint: "https://model-gateway.invalid",
    credentialStore,
    credentialRef: "credential:model-gateway",
    fetchImpl: async (_url, init) => {
      capturedSignal = init.signal;
      return response({ choices: [{ message: { content: "{}" } }] });
    }
  });
  await signalClient.propose(request, controller.signal);
  assert.equal(capturedSignal, controller.signal);

  let oversizedCancelled = false;
  const oversizedResponse = new Response(new ReadableStream({
    start(stream) { stream.enqueue(new Uint8Array([123])); },
    cancel() { oversizedCancelled = true; }
  }), { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } });
  const oversizedClient = new DirectModelGatewayClient({
    endpoint: "https://model-gateway.invalid",
    credentialStore,
    credentialRef: "credential:model-gateway",
    fetchImpl: async () => oversizedResponse
  });
  await assert.rejects(oversizedClient.propose(request), (error) => error.message === "response_too_large");
  assert.equal(oversizedCancelled, true);
  assert.equal(oversizedResponse.body.locked, false);

  const malformedResponse = new Response("PRIVATE_SYNTHETIC_RESPONSE_CANARY", {
    headers: { "content-type": "application/json" }
  });
  const malformedClient = new DirectModelGatewayClient({
    endpoint: "https://model-gateway.invalid",
    credentialStore,
    credentialRef: "credential:model-gateway",
    fetchImpl: async () => malformedResponse
  });
  await assert.rejects(malformedClient.propose(request), (error) => error.message === "external_response_invalid");
  assert.equal(malformedResponse.body.locked, false);
});

test("HTTP rejection cancels the unused body without reading or replaying it", async () => {
  let requests = 0;
  let cancellations = 0;
  const client = new DirectModelGatewayClient({
    endpoint: "https://model-gateway.invalid",
    credentialStore: { resolve: async () => ({ token: "synthetic-model-token" }) },
    credentialRef: "credential:model-gateway",
    fetchImpl: async () => {
      requests += 1;
      return {
        ok: false,
        status: 503,
        body: {
          cancel: async () => { cancellations += 1; },
          getReader: () => { assert.fail("Rejected response body must not be read"); }
        }
      };
    }
  });
  await assert.rejects(client.propose({ runId: "synthetic-rejected-run" }),
    (error) => error.message === "external_request_rejected" && error.status === 503);
  assert.equal(requests, 1);
  assert.equal(cancellations, 1);
});

test("concurrent durable budget reservations admit only the first unique request", async (t) => {
  const local = await fixture();
  t.after(() => removeTempDir(local.root));
  const state = new PrivateStateStore(local.storageRoot);
  await state.acquireOwnership();
  t.after(() => state.close());
  const day = "2026-02-28";
  const reservations = await Promise.all([
    state.reserveDailyBudget({
      day,
      reservationKey: "00000000000000000000000000000001:operation:0",
      maxCalls: 1,
      maxCostUnits: 1,
      costUnits: 1
    }),
    state.reserveDailyBudget({
      day,
      reservationKey: "00000000000000000000000000000002:operation:0",
      maxCalls: 1,
      maxCostUnits: 1,
      costUnits: 1
    })
  ]);
  assert.equal(reservations.filter((entry) => entry.reserved).length, 1);
  assert.equal(reservations.filter((entry) => !entry.reserved).length, 1);
  const budget = await state.loadDailyBudget(day);
  assert.equal(budget.calls, 1);
  assert.equal(budget.cost, 1);
  assert.equal(Object.keys(budget.reservations).length, 1);
});

test("a second private-state owner is rejected before journal recovery reads", async (t) => {
  const local = await fixture();
  const first = new PrivateStateStore(local.storageRoot);
  const second = new SelfMaintenanceRuntime({ ...local, pollIntervalMs: 60_000 });
  await first.acquireOwnership();
  t.after(async () => {
    await second.close();
    await first.close();
    await removeTempDir(local.root);
  });
  await fs.writeFile(path.join(local.storageRoot, "journal.json"), "{", { mode: 0o600 });
  await assert.rejects(second.start(), /self_maintenance_data_root_in_use/u);
});

test("failed startup releases storage ownership so corrected journal state can recover", async (t) => {
  const local = await fixture();
  const runtime = new SelfMaintenanceRuntime({ ...local, pollIntervalMs: 60_000 });
  t.after(async () => {
    await runtime.close();
    await removeTempDir(local.root);
  });
  await fs.mkdir(local.storageRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(local.storageRoot, "journal.json"), "{", { mode: 0o600 });
  await assert.rejects(runtime.start());
  await fs.writeFile(path.join(local.storageRoot, "journal.json"), "[]", { mode: 0o600 });
  await runtime.start();
  await runtime.close();
});

test("close waits for owner acquisition during startup and prevents later scheduling", async (t) => {
  const local = await fixture();
  const runtime = new SelfMaintenanceRuntime({ ...local, pollIntervalMs: 60_000 });
  t.after(async () => {
    await runtime.close();
    await removeTempDir(local.root);
  });
  const starting = runtime.start();
  const closing = runtime.close();
  await Promise.all([starting, closing]);
  assert.equal((await journal(local.storageRoot)).some((entry) => entry.state === "completed"), false);

  await runtime.start();
  await runtime.close();
});

test("shutdown waits for an active request and retains data-root ownership until it settles", async (t) => {
  const local = await fixture();
  await replaceConfig(local.configPath, config());
  let releaseModelResponse;
  let enteredModelRequest;
  let dispatcherOptions;
  let dispatcherCloseCount = 0;
  const requestDispatchers = [];
  const entered = new Promise((resolve) => { enteredModelRequest = resolve; });
  const modelResponse = new Promise((resolve) => { releaseModelResponse = resolve; });
  const fetchImpl = async (url, init) => {
    requestDispatchers.push(init.dispatcher);
    if (url.startsWith("https://model-gateway.invalid")) {
      enteredModelRequest();
      return modelResponse;
    }
    return response({ result: { ok: true } });
  };
  const first = new SelfMaintenanceRuntime({
    ...local,
    pollIntervalMs: 60_000,
    fetchImpl,
    agentFactory: (options) => {
      dispatcherOptions = options;
      return { close: async () => { dispatcherCloseCount += 1; } };
    }
  });
  const second = new SelfMaintenanceRuntime({ ...local, pollIntervalMs: 60_000, fetchImpl: async () => response({}) });
  let released = false;
  function release() {
    if (released) return;
    released = true;
    releaseModelResponse(response({ choices: [{ message: { content: JSON.stringify({ operations: [] }) } }] }));
  }
  t.after(async () => {
    release();
    await Promise.allSettled([first.close(), second.close()]);
    await removeTempDir(local.root);
  });
  await first.start();
  await entered;

  let closed = false;
  const closing = first.close().then(() => { closed = true; });
  await assert.rejects(second.start(), /self_maintenance_data_root_in_use/u);
  await Promise.resolve();
  assert.equal(closed, false, "shutdown must wait for the caller's actual request to finish");
  assert.deepEqual(dispatcherOptions, { connectTimeout: 0, headersTimeout: 0, bodyTimeout: 0 });
  assert.equal(dispatcherCloseCount, 0);

  releaseModelResponse(response({ choices: [{ message: { content: JSON.stringify({ operations: [{
    operationId: "system.health",
    resourceRef: "meshrix://system",
    workspaceId: "workspace-maintenance",
    input: {}
  }] }) } }] }));
  released = true;
  await closing;
  assert.equal((await journal(local.storageRoot)).some((entry) => entry.state === "completed"), true);
  assert.equal(requestDispatchers.length, 2);
  assert.equal(requestDispatchers[0], requestDispatchers[1]);
  assert.equal(dispatcherCloseCount, 1);

  await second.start();
  await second.close();
});

test("default undici transport completes both local governed requests and closes on shutdown", async (t) => {
  const local = await fixture();
  const requests = [];
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      for await (const _chunk of incoming) {
        // Drain the small synthetic request before responding.
      }
      requests.push(incoming.url);
      outgoing.setHeader("content-type", "application/json");
      if (incoming.url.endsWith("/v1/chat/completions")) {
        outgoing.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ operations: [{
          operationId: "system.health",
          resourceRef: "meshrix://system",
          workspaceId: "workspace-maintenance",
          input: {}
        }] }) } }] }));
      } else {
        outgoing.end(JSON.stringify({ result: { ok: true } }));
      }
    })().catch(() => outgoing.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const active = config("rev-local-transport", {
    targets: config().targets.map((target) => target.kind === "model-gateway"
      ? { ...target, id: `${endpoint}/model` }
      : target.kind === "meshrix" ? { ...target, id: `${endpoint}/meshrix` } : target)
  });
  await replaceConfig(local.configPath, active);
  const runtime = new SelfMaintenanceRuntime({ ...local, pollIntervalMs: 60_000 });
  t.after(async () => {
    await runtime.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await removeTempDir(local.root);
  });

  await runtime.start();
  try {
    await waitFor(async () => (await journal(local.storageRoot)).some((entry) =>
      ["completed", "failed", "worker_error", "rejected"].includes(entry.state)
    ));
  } catch {
    const records = await journal(local.storageRoot);
    throw new Error(`local_transport_did_not_settle:${JSON.stringify({ states: records.map(({ state, code }) => ({ state, code })), requests })}`);
  }
  assert.equal((await journal(local.storageRoot)).some((entry) => entry.state === "completed"), true);
  await runtime.close();
  assert.deepEqual(requests, ["/model/v1/chat/completions", "/meshrix/api/operation-permission/v1/execute"]);
});

test("closed schema rejects missing, extra, and secret-bearing configuration", () => {
  assert.throws(() => assertLocalConfig({ ...config(), listener: 7228 }), /closed_schema/);
  const missing = config();
  delete missing.budgets;
  assert.throws(() => assertLocalConfig(missing), /closed_schema/);
  assert.throws(() => assertLocalConfig({
    ...config(),
    credentialRefs: [{ id: "meshrix-client", ref: "credential:meshrix", token: "forbidden" }]
  }), /credential_refs/);
});

test("credentialed service targets require HTTPS except for literal loopback development endpoints", () => {
  const active = config();
  const schedule = active.schedules[0];
  const date = new Date("2026-08-16T03:00:00.000Z");
  assert.equal(buildPinnedRun(active, schedule, date).modelGatewayEndpoint, "https://model-gateway.invalid");

  for (const endpoint of ["http://model-gateway.invalid", "http://localhost:8080", "http://10.0.0.4:8080"]) {
    const unsafe = config("rev-unsafe", {
      targets: active.targets.map((target) => target.kind === "model-gateway" ? { ...target, id: endpoint } : target)
    });
    assert.throws(() => buildPinnedRun(unsafe, unsafe.schedules[0], date), /schedule_service_endpoint_invalid/u);
  }

  for (const endpoint of ["http://127.0.0.1:8080", "http://[::1]:8080"]) {
    const local = config("rev-local", {
      targets: active.targets.map((target) => target.kind === "model-gateway" ? { ...target, id: endpoint } : target)
    });
    assert.equal(buildPinnedRun(local, local.schedules[0], date).modelGatewayEndpoint, endpoint);
  }
});

test("missing configuration is inert and opens no outbound request", async (t) => {
  const local = await fixture();
  t.after(() => removeTempDir(local.root));
  let calls = 0;
  const runtime = new SelfMaintenanceRuntime({ ...local, pollIntervalMs: 20, fetchImpl: async () => { calls += 1; return response({}); } });
  await runtime.start();
  await waitFor(async () => (await journal(local.storageRoot)).some((entry) => entry.state === "missing"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  await runtime.close();
  assert.equal(calls, 0);
  assert.equal((await journal(local.storageRoot)).filter((entry) => entry.state === "missing").length, 1);
  assert.equal((await journal(local.storageRoot)).at(-1).state, "missing");
});

test("private journal omits malformed local configuration details", async (t) => {
  const local = await fixture();
  t.after(async () => {
    await removeTempDir(local.root);
  });
  const privateProbe = "PRIVATE_SYNTHETIC_CONFIGURATION_CANARY";
  await fs.writeFile(local.configPath, `{"private":"${privateProbe}"`, { mode: 0o600 });
  const runtime = new SelfMaintenanceRuntime({ ...local, pollIntervalMs: 60_000, fetchImpl: async () => response({}) });
  await runtime.start();
  await runtime.close();
  const records = await journal(local.storageRoot);
  assert.equal(records.some((entry) => entry.state === "invalid" && entry.code === "config_invalid"), true);
  assert.equal(JSON.stringify(records).includes(privateProbe), false);
});

test("private journal omits rejected target values and malformed model proposals", async (t) => {
  const local = await fixture();
  t.after(async () => {
    await removeTempDir(local.root);
  });
  const privateTarget = "PRIVATE_SYNTHETIC_TARGET_CANARY";
  const invalidTargetConfig = config("rev-private-target", {
    targets: config().targets.map((target) => target.kind === "meshrix" ? { ...target, id: privateTarget } : target)
  });
  await replaceConfig(local.configPath, invalidTargetConfig);
  const targetRuntime = new SelfMaintenanceRuntime({ ...local, pollIntervalMs: 60_000, fetchImpl: async () => response({}) });
  await targetRuntime.start();
  await targetRuntime.close();
  const targetRecords = await journal(local.storageRoot);
  assert.equal(targetRecords.some((entry) => entry.state === "rejected" && entry.code === "schedule_service_endpoint_invalid"), true);
  assert.equal(JSON.stringify(targetRecords).includes(privateTarget), false);

  const privateModelText = "PRIVATE_SYNTHETIC_MODEL_CONTENT_CANARY";
  await replaceConfig(local.configPath, config("rev-private-model"));
  const modelRuntime = new SelfMaintenanceRuntime({
    ...local,
    pollIntervalMs: 60_000,
    fetchImpl: async () => response({ choices: [{ message: { content: privateModelText } }] })
  });
  await modelRuntime.start();
  await waitFor(async () => (await journal(local.storageRoot)).some((entry) => entry.state === "failed"));
  await modelRuntime.close();
  const allRecords = await journal(local.storageRoot);
  assert.equal(allRecords.some((entry) => entry.state === "failed" && entry.code === "model_proposal_invalid"), true);
  assert.equal(JSON.stringify(allRecords).includes(privateModelText), false);
});

test("valid atomic revision calls Model Gateway directly before ordinary governed Meshrix execution", async (t) => {
  const local = await fixture();
  t.after(() => removeTempDir(local.root));
  await replaceConfig(local.configPath, config());
  const requests = [];
  const runtime = new SelfMaintenanceRuntime({ ...local, pollIntervalMs: 20, fetchImpl: async (url, init) => {
    requests.push({ url, init });
    if (url.startsWith("https://model-gateway.invalid")) {
      return response({ choices: [{ message: { content: JSON.stringify({ operations: [{
        operationId: "system.health",
        resourceRef: "meshrix://system",
        workspaceId: "workspace-maintenance",
        input: {}
      }] }) } }] });
    }
    return response({ schemaVersion: "v0.0.1:schema:definition-1", result: { ok: true } });
  } });
  await runtime.start();
  await waitFor(() => requests.length >= 2);
  await runtime.close();
  assertRepeatedSequence(requests.map((entry) => new URL(entry.url).pathname), [
    "/v1/chat/completions",
    "/api/operation-permission/v1/execute"
  ]);
  assert.equal(requests[0].init.signal, undefined);
  assert.equal(requests[1].init.signal, undefined);
  assert.equal(requests[0].init.headers.authorization, "Bearer model-token");
  assert.equal(requests[1].init.headers.authorization, "Bearer meshrix-token");
  assert.equal(requests[0].init.signal, undefined);
  assert.equal(requests[1].init.signal, undefined);
  const meshrixBody = JSON.parse(requests[1].init.body);
  assert.equal(meshrixBody.toolId, "system.health");
  assert.equal((await journal(local.storageRoot)).at(-1).state, "completed");
  const budget = (await journal(local.storageRoot)).find((entry) => entry.state === "daily_budget_snapshot");
  assert.equal(budget.calls, 2);
  assert.equal(budget.cost, 1);
  assert.equal(Object.keys(budget.reservations).length, 2);
});

test("daily reservations survive restart, suppress completed schedules, and hold across revisions", async (t) => {
  const local = await fixture();
  t.after(() => removeTempDir(local.root));
  await replaceConfig(local.configPath, config("rev-1", {
    budgets: { maxConcurrentCalls: 1, maxCallsPerDay: 2, maxCostUnitsPerDay: 1 }
  }));
  const now = new Date();
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (new URL(url).pathname === "/v1/chat/completions") {
      return response({ choices: [{ message: { content: JSON.stringify({ operations: [{
        operationId: "system.health", resourceRef: "meshrix://system", workspaceId: "workspace-maintenance", input: {}
      }] }) } }] });
    }
    return response({ result: { ok: true } });
  };

  const first = new SelfMaintenanceRuntime({ ...local, now: () => new Date(now), pollIntervalMs: 60_000, fetchImpl });
  await first.start();
  await waitFor(async () => (await journal(local.storageRoot)).some((entry) => entry.state === "completed"));
  await first.close();
  assert.equal(requests.length, 2);

  const recovered = new SelfMaintenanceRuntime({ ...local, now: () => new Date(now), pollIntervalMs: 60_000, fetchImpl });
  await recovered.start();
  await recovered.close();
  assert.equal(requests.length, 2, "a completed scheduled occurrence causes no replay after restart");

  await replaceConfig(local.configPath, config("rev-2", {
    budgets: { maxConcurrentCalls: 1, maxCallsPerDay: 2, maxCostUnitsPerDay: 1 }
  }));
  const changedRevision = new SelfMaintenanceRuntime({ ...local, now: () => new Date(now), pollIntervalMs: 60_000, fetchImpl });
  await changedRevision.start();
  await waitFor(async () => (await journal(local.storageRoot)).some((entry) => entry.state === "failed" && entry.code === "daily_budget_exhausted"));
  await changedRevision.close();
  assert.equal(requests.length, 2, "changing the configuration revision does not reset the daily budget");
  const budget = (await journal(local.storageRoot)).find((entry) => entry.state === "daily_budget_snapshot");
  assert.equal(budget.calls, 2);
  assert.equal(budget.cost, 1);
});

test("an uncertain Model Gateway outcome keeps one durable reservation across restart", async (t) => {
  const local = await fixture();
  t.after(() => removeTempDir(local.root));
  await replaceConfig(local.configPath, config("rev-uncertain", {
    budgets: { maxConcurrentCalls: 1, maxCallsPerDay: 2, maxCostUnitsPerDay: 1 }
  }));
  const now = new Date();
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return response({ error: { code: "settlement_uncertain", retryable: false } }, 409);
  };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const runtime = new SelfMaintenanceRuntime({ ...local, now: () => new Date(now), pollIntervalMs: 60_000, fetchImpl });
    await runtime.start();
    await waitFor(async () => (await journal(local.storageRoot)).filter((entry) => entry.state === "failed").length >= attempt);
    await runtime.close();
  }
  assert.equal(requests.length, 2);
  assert.ok(requests.every((entry) => new URL(entry.url).pathname === "/v1/chat/completions"));
  assert.ok(requests.every((entry) => entry.init.headers["idempotency-key"]));
  assert.equal(requests[0].init.headers["idempotency-key"], requests[1].init.headers["idempotency-key"]);
  const budget = (await journal(local.storageRoot)).find((entry) => entry.state === "daily_budget_snapshot");
  assert.equal(budget.calls, 1, "the uncertain idempotent request retains one quota reservation");
  assert.equal(budget.cost, 0);
  assert.equal(Object.keys(budget.reservations).length, 1);
});

test("repeated operation steps receive separate durable idempotency keys", async (t) => {
  const local = await fixture();
  t.after(() => removeTempDir(local.root));
  const active = config("rev-repeated", {
    runbooks: [{ id: "schedule-1", steps: [{ operationId: "system.health" }, { operationId: "system.health" }] }],
    budgets: { maxConcurrentCalls: 1, maxCallsPerDay: 3, maxCostUnitsPerDay: 2 }
  });
  await replaceConfig(local.configPath, active);
  const now = new Date();
  const expectedRunId = buildPinnedRun(active, active.schedules[0], now).runId;
  const requests = [];
  const runtime = new SelfMaintenanceRuntime({
    ...local,
    now: () => new Date(now),
    pollIntervalMs: 60_000,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (new URL(url).pathname === "/v1/chat/completions") {
        const operation = {
          operationId: "system.health",
          resourceRef: "meshrix://system",
          workspaceId: "workspace-maintenance",
          input: {}
        };
        return response({ choices: [{ message: { content: JSON.stringify({ operations: [operation, operation] }) } }] });
      }
      return response({ result: { ok: true } });
    }
  });
  await runtime.start();
  await waitFor(async () => (await journal(local.storageRoot)).some((entry) => entry.runId === expectedRunId && entry.state === "completed"));
  await runtime.close();

  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((entry) => entry.init.headers["idempotency-key"]), [
    expectedRunId,
    `${expectedRunId}:0`,
    `${expectedRunId}:1`
  ]);
  const budget = (await journal(local.storageRoot)).find((entry) => entry.state === "daily_budget_snapshot");
  assert.equal(budget.calls, 3);
  assert.equal(budget.cost, 2);
});

test("one operation per day budget denies additional new work before Model Gateway egress", async (t) => {
  const local = await fixture();
  t.after(() => removeTempDir(local.root));
  await replaceConfig(local.configPath, config("rev-no-budget", {
    budgets: { maxConcurrentCalls: 1, maxCallsPerDay: 1, maxCostUnitsPerDay: 1 }
  }));
  let requests = 0;
  const runtime = new SelfMaintenanceRuntime({
    ...local,
    pollIntervalMs: 60_000,
    fetchImpl: async () => {
      requests += 1;
      return response({ choices: [{ message: { content: "{}" } }] });
    }
  });
  await runtime.start();
  await waitFor(async () => (await journal(local.storageRoot)).some((entry) => entry.state === "failed" && entry.code === "daily_budget_exhausted"));
  await runtime.close();
  assert.equal(requests, 0);
  assert.equal((await journal(local.storageRoot)).some((entry) => entry.state === "daily_budget_snapshot"), false);
});

test("forged or out-of-policy model proposal causes zero Meshrix effect call", async (t) => {
  const local = await fixture();
  t.after(() => removeTempDir(local.root));
  await replaceConfig(local.configPath, config());
  const paths = [];
  const runtime = new SelfMaintenanceRuntime({ ...local, pollIntervalMs: 20, fetchImpl: async (url) => {
    paths.push(new URL(url).pathname);
    return response({ choices: [{ message: { content: JSON.stringify({ operations: [{
      operationId: "runtime.destroy",
      resourceRef: "meshrix://system",
      workspaceId: "workspace-maintenance",
      input: {}
    }] }) } }] });
  } });
  await runtime.start();
  await waitFor(async () => (await journal(local.storageRoot)).some((entry) => entry.code === "proposal_operation_denied"));
  await runtime.close();
  assertRepeatedSequence(paths, ["/v1/chat/completions"]);
  assert.equal((await journal(local.storageRoot)).at(-1).code, "proposal_operation_denied");
});

test("in-place mutation fails closed for new admission", async (t) => {
  const local = await fixture();
  t.after(() => removeTempDir(local.root));
  await replaceConfig(local.configPath, config());
  let calls = 0;
  const runtime = new SelfMaintenanceRuntime({ ...local, pollIntervalMs: 20, fetchImpl: async () => {
    calls += 1;
    return response({ choices: [{ message: { content: JSON.stringify({ operations: [{
      operationId: "system.health", resourceRef: "meshrix://system", workspaceId: "workspace-maintenance", input: {}
    }] }) } }] });
  } });
  await runtime.start();
  await waitFor(() => calls === 2);
  await fs.writeFile(local.configPath, JSON.stringify(config("rev-in-place")));
  await waitFor(async () => (await journal(local.storageRoot)).some((entry) => entry.code === "config_in_place_mutation"));
  await runtime.close();
  assert.equal(calls, 2, "only the first run's model and Meshrix calls are permitted");
  assert.equal((await journal(local.storageRoot)).at(-1).code, "config_in_place_mutation");
});

test("a running old-revision run remains pinned and drains after replacement", async (t) => {
  const local = await fixture();
  t.after(() => removeTempDir(local.root));
  await replaceConfig(local.configPath, config("rev-old"));
  let releaseModel;
  const modelResult = new Promise((resolve) => { releaseModel = resolve; });
  const paths = [];
  const runtime = new SelfMaintenanceRuntime({ ...local, pollIntervalMs: 20, fetchImpl: async (url) => {
    const pathname = new URL(url).pathname;
    paths.push(pathname);
    if (pathname === "/v1/chat/completions") return modelResult;
    return response({ result: { ok: true } });
  } });
  await runtime.start();
  while (paths.length === 0) await new Promise((resolve) => setTimeout(resolve, 2));
  await replaceConfig(local.configPath, config("rev-new", { schedules: [] }));
  await waitFor(async () => (await journal(local.storageRoot)).some((entry) => entry.revision === "rev-new" && entry.state === "configuration_active"));
  releaseModel(response({ choices: [{ message: { content: JSON.stringify({ operations: [{
    operationId: "system.health", resourceRef: "meshrix://system", workspaceId: "workspace-maintenance", input: {}
  }] }) } }] }));
  await waitFor(async () => (await journal(local.storageRoot)).some((entry) => entry.revision === "rev-old" && entry.state === "completed"));
  await runtime.close();
  assert.deepEqual(paths, ["/v1/chat/completions", "/api/operation-permission/v1/execute"]);
  assert.equal((await journal(local.storageRoot)).some((entry) => entry.revision === "rev-old" && entry.state === "completed"), true);
});

test("private journal is bounded metadata and omits credentials, prompts, inputs, and results", async (t) => {
  const local = await fixture();
  t.after(() => removeTempDir(local.root));
  await replaceConfig(local.configPath, config());
  const runtime = new SelfMaintenanceRuntime({ ...local, pollIntervalMs: 20, fetchImpl: async (url) =>
    new URL(url).pathname === "/v1/chat/completions"
      ? response({ choices: [{ message: { content: JSON.stringify({ operations: [{
          operationId: "system.health", resourceRef: "meshrix://system", workspaceId: "workspace-maintenance", input: { private: "input" }
        }] }) } }] })
      : response({ result: { private: "result" } })
  });
  await runtime.start();
  await waitFor(async () => (await journal(local.storageRoot)).some((entry) => entry.state === "completed"));
  await runtime.close();
  const serialized = JSON.stringify(await journal(local.storageRoot));
  for (const forbidden of ["model-token", "meshrix-token", "private", "maintenance-model"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("a removed schedule cancels queued work while the running revision drains", async (t) => {
  const local = await fixture();
  t.after(() => removeTempDir(local.root));
  await replaceConfig(local.configPath, config("rev-old"));
  await fs.mkdir(local.storageRoot, { recursive: true, mode: 0o700 });
  const oldConfig = config("rev-old");
  const firstItem = buildPinnedRun(oldConfig, oldConfig.schedules[0], new Date("2026-08-16T03:00:00.000Z"));
  const secondItem = buildPinnedRun(oldConfig, oldConfig.schedules[0], new Date("2026-08-16T03:01:00.000Z"));
  await fs.writeFile(path.join(local.storageRoot, "queue.json"), JSON.stringify([
    { ...firstItem, state: "running" }, { ...secondItem, state: "queued" }
  ]), { mode: 0o600 });
  let releaseModel;
  const modelResult = new Promise((resolve) => { releaseModel = resolve; });
  let modelCalls = 0;
  const runtime = new SelfMaintenanceRuntime({ ...local, pollIntervalMs: 20, fetchImpl: async (url) => {
    if (new URL(url).pathname === "/v1/chat/completions") {
      modelCalls += 1;
      return modelCalls === 1 ? modelResult : response({ choices: [{ message: { content: "{}" } }] });
    }
    return response({ result: { ok: true } });
  } });
  await runtime.start();
  while (modelCalls === 0) await new Promise((resolve) => setTimeout(resolve, 2));
  await replaceConfig(local.configPath, config("rev-new", { schedules: [] }));
  await waitFor(async () => (await journal(local.storageRoot)).some((entry) => entry.state === "cancelled"));
  releaseModel(response({ choices: [{ message: { content: JSON.stringify({ operations: [{
    operationId: "system.health", resourceRef: "meshrix://system", workspaceId: "workspace-maintenance", input: {}
  }] }) } }] }));
  await waitFor(async () => (await journal(local.storageRoot)).some((entry) => entry.runId === firstItem.runId && entry.state === "completed"));
  await runtime.close();
  const records = await journal(local.storageRoot);
  assert.equal(records.some((entry) => entry.state === "cancelled" && entry.code === "configuration_replaced"), true);
  assert.equal(modelCalls, 1);
});

test("durable queued work recovers with its pinned policy and completes", async (t) => {
  const local = await fixture();
  t.after(() => removeTempDir(local.root));
  const active = config("rev-recovery", { schedules: [{ id: "schedule-1", cron: "0 0 31 2 *" }] });
  await replaceConfig(local.configPath, active);
  await fs.mkdir(local.storageRoot, { recursive: true, mode: 0o700 });
  const item = buildPinnedRun(active, active.schedules[0], new Date("2026-02-28T00:00:00.000Z"));
  await fs.writeFile(path.join(local.storageRoot, "queue.json"), JSON.stringify([{ ...item, state: "running" }]), { mode: 0o600 });
  const paths = [];
  const runtime = new SelfMaintenanceRuntime({ ...local, pollIntervalMs: 60_000, fetchImpl: async (url) => {
    const pathname = new URL(url).pathname;
    paths.push(pathname);
    return pathname === "/v1/chat/completions"
      ? response({ choices: [{ message: { content: JSON.stringify({ operations: [{
          operationId: "system.health", resourceRef: "meshrix://system", workspaceId: "workspace-maintenance", input: {}
        }] }) } }] })
      : response({ result: { ok: true } });
  } });
  await runtime.start();
  await waitFor(async () => (await journal(local.storageRoot)).some((entry) => entry.runId === item.runId && entry.state === "completed"));
  await runtime.close();
  assert.deepEqual(paths, ["/v1/chat/completions", "/api/operation-permission/v1/execute"]);
  assert.equal((await journal(local.storageRoot)).some((entry) => entry.runId === item.runId && entry.state === "completed"), true);
});

test("recovery skips completed operations and resumes at the first uncertain step", async (t) => {
  const local = await fixture();
  t.after(() => removeTempDir(local.root));
  const active = config("rev-partial-recovery", {
    runbooks: [{ id: "schedule-1", steps: [
      { operationId: "system.health" },
      { operationId: "system.health" }
    ] }],
    budgets: { maxConcurrentCalls: 1, maxCallsPerDay: 3, maxCostUnitsPerDay: 2 }
  });
  await replaceConfig(local.configPath, active);
  await fs.mkdir(local.storageRoot, { recursive: true, mode: 0o700 });
  const item = buildPinnedRun(active, active.schedules[0], new Date("2026-02-28T00:00:00.000Z"));
  const budget = {
    at: "2026-02-28T00:00:00.000Z",
    state: "daily_budget_snapshot",
    day: "2026-02-28",
    calls: 2,
    cost: 1,
    reservations: {
      [`${item.runId}:model`]: 0,
      [`${item.runId}:operation:0`]: 1
    }
  };
  await fs.writeFile(path.join(local.storageRoot, "journal.json"), JSON.stringify([
    budget,
    { at: budget.at, runId: item.runId, revision: item.revision, scheduleId: item.scheduleId,
      state: "operation_completed", code: null, operationId: "system.health", operationIndex: 0 }
  ]), { mode: 0o600 });
  await fs.writeFile(path.join(local.storageRoot, "queue.json"), JSON.stringify([{ ...item, state: "running" }]), { mode: 0o600 });

  const requests = [];
  const runtime = new SelfMaintenanceRuntime({
    ...local,
    now: () => new Date("2026-02-28T00:00:00.000Z"),
    pollIntervalMs: 60_000,
    fetchImpl: async (url, init) => {
      const pathname = new URL(url).pathname;
      requests.push({ pathname, key: init.headers["idempotency-key"] });
      return pathname === "/v1/chat/completions"
        ? response({ choices: [{ message: { content: JSON.stringify({ operations: [0, 1].map(() => ({
            operationId: "system.health", resourceRef: "meshrix://system", workspaceId: "workspace-maintenance", input: {}
          })) }) } }] })
        : response({ result: { ok: true } });
    }
  });
  await runtime.start();
  await waitFor(async () => (await journal(local.storageRoot)).some((entry) => entry.runId === item.runId && entry.state === "completed"));
  await runtime.close();

  assert.deepEqual(requests, [
    { pathname: "/v1/chat/completions", key: item.runId },
    { pathname: "/api/operation-permission/v1/execute", key: `${item.runId}:1` }
  ]);
  const completed = (await journal(local.storageRoot)).find((entry) => entry.runId === item.runId &&
    entry.state === "operation_completed" && entry.operationIndex === 1);
  assert.equal(completed.operationId, "system.health");
});
