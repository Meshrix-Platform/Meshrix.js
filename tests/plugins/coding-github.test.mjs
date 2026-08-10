import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  activatePlugin,
  validateCodingGithubConfiguration
} from "../../plugins/coding/github/runtime.mjs";
import {
  GITHUB_CODESPACE_OPERATION_IDS,
  GITHUB_MCP_OPERATION_IDS,
  GITHUB_REST_OPERATION_IDS,
  GITHUB_SKILL_INSTALLER_OPERATION_IDS
} from "../../plugins/coding/github/src/operation-definitions.mjs";

const manifest = JSON.parse(await readFile(
  new URL("../../plugins/coding/github/plugin.json", import.meta.url),
  "utf8"
));
const installLifecycle = JSON.parse(await readFile(
  new URL("../../plugins/coding/github/state-machines/skill-install.lifecycle.json", import.meta.url),
  "utf8"
));
const enabledConfiguration = Object.freeze({
  enabled: true,
  modules: Object.freeze({ rest: true, mcp: true, codespaces: true, skillInstaller: true }),
  services: Object.freeze({
    rest: Object.freeze({ serviceRef: "fixture-rest-service", timeoutMs: 100 }),
    mcp: Object.freeze({ serviceRef: "fixture-mcp-service", timeoutMs: 100 })
  })
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function memoryPluginData() {
  const files = new Map();
  let writes = 0;
  return Object.freeze({
    async readFile(resource, encoding = "utf8") {
      if (!files.has(resource)) {
        throw Object.assign(new Error("Synthetic plugin data is absent."), { code: "PLUGIN_DATA_NOT_FOUND" });
      }
      const bytes = files.get(resource);
      return encoding ? bytes.toString(encoding) : Buffer.from(bytes);
    },
    async writeFile(resource, value, encoding = "utf8") {
      writes += 1;
      files.set(resource, Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value), encoding));
    },
    inspect() {
      return Object.freeze({
        writes,
        entries: Object.freeze([...files].map(([resource, bytes]) => Object.freeze({
          resource,
          value: bytes.toString("utf8")
        })))
      });
    }
  });
}

function externalServiceHost(handler = async (request) => ({
  ok: true,
  status: 200,
  data: { forwardedOperation: request.operationRef },
  receiptRef: `receipt:${request.operationRef}`
})) {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  return Object.freeze({
    calls,
    externalService: Object.freeze({
      async request(request, options) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        calls.push(Object.freeze({ request: structuredClone(request), signal: options.signal }));
        try {
          return await handler(request, options);
        } finally {
          active -= 1;
        }
      }
    }),
    stats() {
      return Object.freeze({ active, maximumActive, calls: calls.length });
    }
  });
}

function authorizedCall({ authorized = true, current = true, authenticated = true } = {}) {
  return Object.freeze({
    transport: "internal",
    auth: Object.freeze({
      authenticated,
      actorType: "tool-grant",
      subjectRef: "fixture-subject",
      tenantRef: "fixture-tenant",
      scopes: Object.freeze(["repo:read", "repo:write", "repo:review", "skill:install", "workspace:maintain"])
    }),
    governance: Object.freeze({ authorized, current })
  });
}

async function activate({ pluginData = memoryPluginData() } = {}) {
  return activatePlugin({
    manifest,
    context: Object.freeze({ configuration: enabledConfiguration, pluginData })
  });
}

test("Coding GitHub skill install lifecycle declares a unique total state-event matrix", () => {
  const expectedCells = installLifecycle.states.length * installLifecycle.events.length;
  const keys = installLifecycle.totalMatrix.map((cell) => `${cell.from}:${cell.event}`);
  assert.equal(installLifecycle.machineId, "github-skill-install.lifecycle");
  assert.equal(installLifecycle.totalMatrix.length, expectedCells);
  assert.equal(new Set(keys).size, expectedCells);
  assert.equal(installLifecycle.states.some((state) => state.id === installLifecycle.initialState), true);
  assert.equal(installLifecycle.states.find((state) => state.id === "rolled_back")?.terminal, true);
});

function invoke(runtime, operationId, input = {}, {
  host = externalServiceHost(),
  call = authorizedCall(),
  signal = null
} = {}) {
  const operation = runtime.contributions.operations[operationId];
  assert.ok(operation, `Missing operation ${operationId}`);
  return operation.execute({ input, call, signal, host });
}

const repository = Object.freeze({ owner: "fixture-owner", repo: "fixture-repo" });

function inputFor(operationId, suffix = operationId.replace(/[^A-Za-z0-9]/gu, "-")) {
  const idempotencyKey = `fixture-idem-${suffix}`.slice(0, 120);
  switch (operationId) {
    case "github.repository.get": return { ...repository };
    case "github.repository.contents.get": return { ...repository, path: "skills/example/SKILL.md", ref: "main" };
    case "github.repository.compare": return { ...repository, base: "main", head: "feature" };
    case "github.pullRequests.list": return { ...repository, state: "open", page: 1, perPage: 20 };
    case "github.pullRequests.createDraft": return { ...repository, title: "Synthetic change", head: "feature", base: "main", idempotencyKey };
    case "github.pullRequests.review.create": return { ...repository, pullNumber: 7, event: "COMMENT", body: "Synthetic review", comments: [], idempotencyKey };
    case "github.issues.comment.create": return { ...repository, issueNumber: 7, body: "Synthetic comment", idempotencyKey };
    case "github.actions.workflowRuns.list": return { ...repository, branch: "main", status: "completed", page: 1, perPage: 10 };
    case "github.mcp.tools.list": return { toolsets: ["repos"], page: 1, perPage: 10 };
    case "github.mcp.tools.call": return { toolName: "get_repository", arguments: { owner: repository.owner, repo: repository.repo } };
    case "codespace.providers.manifest": return {};
    case "codespace.repository.status": return { ...repository, ref: "main" };
    case "codespace.tree.list": return { ...repository, treeRef: "main", recursive: true };
    case "codespace.file.read": return { ...repository, path: "README.md", ref: "main" };
    case "codespace.diff.read": return { ...repository, base: "main", head: "feature" };
    case "codespace.change.prepare": return { ...repository, base: "main", changes: [{}] };
    case "codespace.change.upload": return { ...repository, preparedChangeRef: "commit-fixture", head: "feature", idempotencyKey };
    case "codespace.review.comment": return { ...repository, pullNumber: 7, body: "Synthetic comment", idempotencyKey };
    case "codespace.review.requestChanges": return { ...repository, pullNumber: 7, body: "Synthetic request", idempotencyKey };
    case "codespace.review.approve": return { ...repository, pullNumber: 7, body: "Synthetic approval", idempotencyKey };
    case "codespace.review.status.sync": return { ...repository, pullNumber: 7 };
    case "github.skills.install.plan": return { ...repository, ref: "main", path: "skills/example" };
    default: throw new Error(`No fixture input for ${operationId}`);
  }
}

test("Coding GitHub import is network-side-effect free and empty configuration publishes nothing", async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("Synthetic network access is forbidden.");
  };
  try {
    const runtimeUrl = pathToFileURL(path.resolve("plugins/coding/github/runtime.mjs")).href;
    const consoleUrl = pathToFileURL(path.resolve("plugins/coding/github/console/index.mjs")).href;
    const runtimeModule = await import(`${runtimeUrl}?side-effect=${Date.now()}`);
    const consoleModule = await import(`${consoleUrl}?side-effect=${Date.now()}`);
    assert.equal(typeof runtimeModule.activatePlugin, "function");
    assert.equal(typeof consoleModule.mountPluginConsole, "function");
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const inactive = await activatePlugin({ manifest, context: { configuration: {} } });
  for (const contribution of Object.values(inactive.contributions)) assert.deepEqual(contribution, {});
  assert.deepEqual(await inactive.close(), { ok: true, alreadyClosed: false });
  assert.deepEqual(await inactive.close(), { ok: true, alreadyClosed: true });
});

test("Coding GitHub configuration is closed and rejects partial activation", async () => {
  assert.deepEqual(validateCodingGithubConfiguration({}), { enabled: false });
  assert.deepEqual(validateCodingGithubConfiguration({ enabled: false }), { enabled: false });
  assert.throws(
    () => validateCodingGithubConfiguration({ enabled: false, modules: {} }),
    { code: "coding_github_partial_configuration" }
  );
  assert.throws(
    () => validateCodingGithubConfiguration({ enabled: true, modules: { rest: true } }),
    { code: "coding_github_partial_configuration" }
  );
  assert.throws(
    () => validateCodingGithubConfiguration({
      ...enabledConfiguration,
      services: { ...enabledConfiguration.services, extra: { serviceRef: "fixture", timeoutMs: 100 } }
    }),
    /unsupported field/u
  );
  await assert.rejects(
    activatePlugin({ manifest, context: { configuration: enabledConfiguration } }),
    /opaque plugin data capability/u
  );
});

test("Coding GitHub publishes the complete selected contribution surface", async () => {
  const runtime = await activate();
  assert.equal(Object.keys(runtime.contributions.operations).length, 24);
  assert.equal(Object.keys(runtime.contributions.routes).length, 24);
  assert.equal(Object.keys(runtime.contributions.mcpTools).length, 24);
  assert.deepEqual(Object.keys(runtime.contributions.consoleEntries), ["admin.coding-github"]);
  assert.deepEqual(Object.keys(runtime.contributions.stateMachines), ["github-skill-install.lifecycle"]);
  assert.deepEqual(runtime.contributions.operations["codespace.providers.manifest"].requiredHostPorts, []);
  for (const operationId of manifest.operations.filter((id) => id !== "codespace.providers.manifest")) {
    assert.deepEqual(runtime.contributions.operations[operationId].requiredHostPorts, ["externalService"]);
  }
  assert.equal(GITHUB_REST_OPERATION_IDS.length, 8);
  assert.equal(GITHUB_MCP_OPERATION_IDS.length, 2);
  assert.equal(GITHUB_CODESPACE_OPERATION_IDS.length, 11);
  assert.equal(GITHUB_SKILL_INSTALLER_OPERATION_IDS.length, 3);
  await runtime.close();
});

test("Operation Permission denial reaches no Host boundary", async () => {
  const runtime = await activate();
  const host = externalServiceHost();
  for (const call of [
    authorizedCall({ authorized: false }),
    authorizedCall({ current: false }),
    authorizedCall({ authenticated: false })
  ]) {
    const response = await invoke(runtime, "github.repository.get", inputFor("github.repository.get"), { host, call });
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.error.code, "coding_github_operation_denied");
  }
  assert.equal(host.calls.length, 0);
  await runtime.close();
});

test("all eight REST operations forward with exact service and operation bindings", async () => {
  const runtime = await activate();
  const host = externalServiceHost(async (request) => ({
    ok: true,
    status: request.operationRef.includes("create") ? 201 : 200,
    data: { kind: "synthetic-rest", operation: request.operationRef }
  }));
  for (const operationId of GITHUB_REST_OPERATION_IDS) {
    const response = await invoke(runtime, operationId, inputFor(operationId), { host });
    assert.equal(response.body.ok, true);
  }
  assert.equal(host.calls.length, 8);
  assert.deepEqual(host.calls.map((call) => call.request.operationRef), GITHUB_REST_OPERATION_IDS);
  for (const { request } of host.calls) {
    assert.equal(request.serviceRef, "fixture-rest-service");
    assert.equal(Object.hasOwn(request, "url"), false);
    assert.equal(Object.hasOwn(request, "headers"), false);
    assert.equal(Object.hasOwn(request, "secretRef"), false);
  }
  await runtime.close();
});

test("GitHub MCP discovery and call use fixed protocol methods and no direct transport details", async () => {
  const runtime = await activate();
  const host = externalServiceHost(async (request) => ({
    ok: true,
    status: 200,
    data: request.input.protocolMethod === "tools/list"
      ? { tools: [{ name: "get_repository" }] }
      : { content: [{ type: "text", text: "synthetic result" }] }
  }));
  for (const operationId of GITHUB_MCP_OPERATION_IDS) {
    const response = await invoke(runtime, operationId, inputFor(operationId), { host });
    assert.equal(response.statusCode, 200);
  }
  assert.equal(host.calls[0].request.input.protocolMethod, "tools/list");
  assert.equal(host.calls[1].request.input.protocolMethod, "tools/call");
  assert.equal(host.calls[1].request.input.toolName, "get_repository");
  for (const { request } of host.calls) {
    assert.equal(request.serviceRef, "fixture-mcp-service");
    assert.equal(request.operationRef.startsWith("github.mcp."), true);
    assert.equal(Object.hasOwn(request.input, "endpoint"), false);
  }
  await runtime.close();
});

test("all Codespace operations execute, while provider discovery remains local and credential-free", async () => {
  const runtime = await activate();
  const host = externalServiceHost();
  for (const operationId of GITHUB_CODESPACE_OPERATION_IDS) {
    const response = await invoke(runtime, operationId, inputFor(operationId), { host });
    assert.equal(response.statusCode, 200, operationId);
    if (operationId === "codespace.providers.manifest") {
      assert.equal(response.body.data.pluginId, "coding-github");
      assert.equal(JSON.stringify(response.body).includes("secret://"), false);
    }
  }
  assert.equal(host.calls.length, 10);
  assert.deepEqual(host.calls.map((call) => call.request.operationRef), GITHUB_CODESPACE_OPERATION_IDS.slice(1));
  await runtime.close();
});

test("skill installer plan, apply, and rollback use digest-bound pluginData state", async () => {
  const pluginData = memoryPluginData();
  const runtime = await activate({ pluginData });
  const host = externalServiceHost(async (request) => ({
    ok: true,
    status: 200,
    data: { contentDigest: `digest:${request.operationRef}` },
    receiptRef: `receipt:${request.operationRef}`
  }));
  const source = inputFor("github.skills.install.plan");
  const plan = await invoke(runtime, "github.skills.install.plan", source, { host });
  assert.match(plan.body.install.planRef, /^sha256:[a-f0-9]{64}$/u);
  const applyInput = {
    ...source,
    planRef: plan.body.install.planRef,
    idempotencyKey: "fixture-idem-skill-apply"
  };
  const applied = await invoke(runtime, "github.skills.install.apply", applyInput, { host });
  assert.equal(applied.body.install.status, "installed");
  assert.match(applied.body.install.installRef, /^sha256:[a-f0-9]{64}$/u);
  const rolledBack = await invoke(runtime, "github.skills.install.rollback", {
    ...source,
    installRef: applied.body.install.installRef,
    idempotencyKey: "fixture-idem-skill-rollback"
  }, { host });
  assert.equal(rolledBack.body.install.status, "rolled_back");
  assert.deepEqual(host.calls.map((call) => call.request.operationRef), GITHUB_SKILL_INSTALLER_OPERATION_IDS);

  const stored = pluginData.inspect();
  assert.equal(stored.writes, 2);
  assert.deepEqual(stored.entries.map((entry) => entry.resource), ["coding-github/skill-installs.json"]);
  assert.equal(stored.entries[0].value.includes(repository.owner), false);
  assert.equal(stored.entries[0].value.includes(repository.repo), false);
  assert.equal(stored.entries[0].value.includes("fixture-idem"), false);
  await runtime.close();
});

test("skill installer rejects stale plans and unknown rollback refs before Host access", async () => {
  const runtime = await activate();
  const host = externalServiceHost();
  const source = inputFor("github.skills.install.plan");
  const stale = await invoke(runtime, "github.skills.install.apply", {
    ...source,
    planRef: `sha256:${"0".repeat(64)}`,
    idempotencyKey: "fixture-idem-stale-plan"
  }, { host });
  assert.equal(stale.statusCode, 409);
  const missing = await invoke(runtime, "github.skills.install.rollback", {
    ...source,
    installRef: `sha256:${"1".repeat(64)}`,
    idempotencyKey: "fixture-idem-missing-install"
  }, { host });
  assert.equal(missing.statusCode, 404);
  assert.equal(host.calls.length, 0);
  await runtime.close();
});

test("pagination, rate-limit, and response data are bounded public projections", async () => {
  const runtime = await activate();
  const host = externalServiceHost(async () => ({
    ok: true,
    status: 200,
    data: { name: "fixture-repo", authorization: "not-public" },
    pagination: { nextCursor: "cursor-next", page: 1, perPage: 20 },
    rateLimit: { remaining: 4, retryAfterMs: 1000, resetAt: "2030-01-01T00:00:00.000Z" }
  }));
  const response = await invoke(runtime, "github.pullRequests.list", inputFor("github.pullRequests.list"), { host });
  assert.deepEqual(response.body.pagination, { nextCursor: "cursor-next", page: 1, perPage: 20 });
  assert.equal(response.body.rateLimit.remaining, 4);
  assert.deepEqual(response.body.data, { name: "fixture-repo" });
  const invalid = await invoke(runtime, "github.pullRequests.list", {
    ...repository,
    perPage: 101
  }, { host });
  assert.equal(invalid.statusCode, 400);
  assert.equal(host.calls.length, 1);
  await runtime.close();
});

test("idempotency joins duplicate work, caches completion, and rejects key reuse with changed input", async () => {
  const gate = deferred();
  const host = externalServiceHost(async () => gate.promise);
  const runtime = await activate();
  const input = inputFor("github.pullRequests.createDraft", "shared-key");
  const first = invoke(runtime, "github.pullRequests.createDraft", input, { host });
  const second = invoke(runtime, "github.pullRequests.createDraft", input, { host });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.calls.length, 1);
  gate.resolve({ ok: true, status: 201, data: { pullNumber: 7 } });
  assert.equal((await first).statusCode, 201);
  assert.equal((await second).statusCode, 201);
  const cached = await invoke(runtime, "github.pullRequests.createDraft", input, { host });
  assert.equal(cached.statusCode, 201);
  assert.equal(host.calls.length, 1);
  const conflict = await invoke(runtime, "github.pullRequests.createDraft", { ...input, title: "Changed title" }, { host });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.error.code, "coding_github_idempotency_conflict");
  assert.equal(host.calls.length, 1);
  await runtime.close();
});

test("Host failures, missing ports, and sensitive inputs fail with sanitized codes", async () => {
  const runtime = await activate();
  const fault = Object.assign(new Error("internal provider details must not surface"), { status: 502 });
  const host = externalServiceHost(async () => { throw fault; });
  const failed = await invoke(runtime, "github.repository.get", inputFor("github.repository.get"), { host });
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.body.error.code, "coding_github_external_service_failed");
  assert.equal(JSON.stringify(failed).includes("internal provider"), false);
  const unavailable = await invoke(runtime, "github.repository.get", inputFor("github.repository.get"), { host: {} });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.body.error.code, "coding_github_external_service_unavailable");
  const sensitive = await invoke(runtime, "github.mcp.tools.call", {
    toolName: "get_repository",
    arguments: { authorization: "not-public" }
  }, { host });
  assert.equal(sensitive.statusCode, 400);
  assert.equal(sensitive.body.error.code, "coding_github_sensitive_input_rejected");
  assert.equal(host.calls.length, 1);
  await runtime.close();
});

test("trusted Host timeout and caller cancellation settle without dangling calls", async () => {
  const timeoutHost = externalServiceHost(async (request) => new Promise((resolve, reject) => {
    setTimeout(() => reject(Object.assign(new Error("Synthetic timeout."), { status: 504 })), request.timeoutMs);
  }));
  const timeoutRuntime = await activate();
  const timeoutResponse = await invoke(
    timeoutRuntime,
    "github.repository.get",
    inputFor("github.repository.get"),
    { host: timeoutHost }
  );
  assert.equal(timeoutResponse.statusCode, 504);
  assert.equal(timeoutResponse.body.error.code, "coding_github_external_service_timeout");
  assert.equal(timeoutHost.stats().active, 0);
  await timeoutRuntime.close();

  const cancellationHost = externalServiceHost(async (request, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("Synthetic cancellation."), { status: 499 })), { once: true });
  }));
  const cancellationRuntime = await activate();
  const controller = new AbortController();
  const pending = invoke(
    cancellationRuntime,
    "github.repository.get",
    inputFor("github.repository.get"),
    { host: cancellationHost, signal: controller.signal }
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.statusCode, 499);
  assert.equal(cancelled.body.error.code, "coding_github_external_service_cancelled");
  assert.equal(cancellationHost.stats().active, 0);
  await cancellationRuntime.close();
});

test("close stops admission and waits until every Host request really settles", async () => {
  const gate = deferred();
  const host = externalServiceHost(async () => gate.promise);
  const runtime = await activate();
  const operation = invoke(runtime, "github.repository.get", inputFor("github.repository.get"), { host });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.stats().active, 1);
  let closeSettled = false;
  const closing = runtime.close().then((value) => {
    closeSettled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);
  gate.resolve({ ok: true, status: 200, data: { settled: true } });
  assert.equal((await operation).statusCode, 200);
  assert.deepEqual(await closing, { ok: true, alreadyClosed: false });
  assert.equal(host.stats().active, 0);
  const rejected = await invoke(runtime, "github.repository.get", inputFor("github.repository.get"), { host });
  assert.equal(rejected.statusCode, 503);
  assert.equal(rejected.body.error.code, "coding_github_runtime_closed");
  assert.deepEqual(await runtime.close(), { ok: true, alreadyClosed: true });
});
