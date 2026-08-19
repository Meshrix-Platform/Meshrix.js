import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertLocalConfig } from "../internal/config-schema.mjs";
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

test("missing configuration is inert and opens no outbound request", async (t) => {
  const local = await fixture();
  t.after(() => removeTempDir(local.root));
  let calls = 0;
  const runtime = new SelfMaintenanceRuntime({ ...local, pollIntervalMs: 20, fetchImpl: async () => { calls += 1; return response({}); } });
  await runtime.start();
  await waitFor(async () => (await journal(local.storageRoot)).some((entry) => entry.state === "missing"));
  await runtime.close();
  assert.equal(calls, 0);
  assert.equal((await journal(local.storageRoot)).at(-1).state, "missing");
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
  await waitFor(() => requests.length === 2);
  await runtime.close();
  assert.deepEqual(requests.map((entry) => new URL(entry.url).pathname), [
    "/v1/chat/completions",
    "/api/operation-permission/v1/execute"
  ]);
  assert.equal(requests[0].init.headers.authorization, "Bearer model-token");
  assert.equal(requests[1].init.headers.authorization, "Bearer meshrix-token");
  const meshrixBody = JSON.parse(requests[1].init.body);
  assert.equal(meshrixBody.toolId, "system.health");
  assert.equal((await journal(local.storageRoot)).at(-1).state, "completed");
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
  assert.deepEqual(paths, ["/v1/chat/completions"]);
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
