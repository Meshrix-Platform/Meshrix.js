import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  activatePlugin,
  validateSkillHubConfiguration
} from "../../plugins/skill-hub/runtime.mjs";

const manifest = JSON.parse(await readFile(
  new URL("../../plugins/skill-hub/plugin.json", import.meta.url),
  "utf8"
));
const lifecycleDefinition = JSON.parse(await readFile(
  new URL("../../plugins/skill-hub/state-machines/contribution.lifecycle.json", import.meta.url),
  "utf8"
));
const enabledConfiguration = Object.freeze({
  enabled: true,
  modules: Object.freeze({
    registry: true,
    opaqueCustody: true,
    controlledSandbox: true,
    operationPermission: true
  })
});

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function memoryPluginData({ writeDelayMs = 0 } = {}) {
  const files = new Map();
  const executable = new Set();
  let failNextWrite = null;
  let activeWrites = 0;
  let maximumActiveWrites = 0;
  const checked = (resource) => {
    const normalized = String(resource || "").replace(/\\/gu, "/");
    if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").some((segment) => segment === "..")) {
      throw Object.assign(new Error("Synthetic plugin data boundary rejection."), {
        code: "PLUGIN_DATA_BOUNDARY_REJECTED"
      });
    }
    return normalized;
  };
  return Object.freeze({
    async readFile(resource, encoding = "utf8") {
      const normalized = checked(resource);
      if (!files.has(normalized)) {
        throw Object.assign(new Error("Synthetic plugin data record is absent."), {
          code: "PLUGIN_DATA_NOT_FOUND"
        });
      }
      const bytes = files.get(normalized);
      return encoding ? bytes.toString(encoding) : Buffer.from(bytes);
    },
    async writeFile(resource, value, encoding = "utf8") {
      const normalized = checked(resource);
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      try {
        if (writeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
        if (failNextWrite) {
          const error = failNextWrite;
          failNextWrite = null;
          throw error;
        }
        files.set(normalized, Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value), encoding));
      } finally {
        activeWrites -= 1;
      }
    },
    async stat(resource) {
      const normalized = checked(resource);
      if (!files.has(normalized)) {
        throw Object.assign(new Error("Synthetic plugin data record is absent."), {
          code: "PLUGIN_DATA_NOT_FOUND"
        });
      }
      return Object.freeze({ type: "file", executable: executable.has(normalized) });
    },
    failOneWrite(error = Object.assign(new Error("secret-material must stay private"), {
      code: "skill_hub_storage_write_failed"
    })) {
      failNextWrite = error;
    },
    markExecutable(resource) {
      executable.add(checked(resource));
    },
    paths() {
      return Object.freeze([...files.keys()].sort());
    },
    maximumActiveWrites() {
      return maximumActiveWrites;
    },
    registryStates() {
      return [...files]
        .filter(([resource]) => /^SkillHub\/registries\/[a-f0-9]{64}\.json$/u.test(resource))
        .map(([, bytes]) => JSON.parse(bytes.toString("utf8")));
    }
  });
}

function opaquePackage(seed) {
  const bytes = Buffer.from(`synthetic-package:${seed}`, "utf8");
  return Object.freeze({
    schemaVersion: "v0.0.1:plugin:opaque-input-handle-1",
    custodyRef: `custody:${seed}`,
    contentDigest: sha(bytes),
    envelopeDigest: sha(`synthetic-envelope:${seed}`),
    byteCount: bytes.byteLength
  });
}

function submission(skillId, workspaceId = "workspace-source") {
  return Object.freeze({
    contributionId: skillId,
    workspaceId,
    title: `Synthetic ${skillId}`,
    license: "Apache-2.0",
    declaredPermissions: Object.freeze(["read", "use"]),
    requestedActions: Object.freeze(["read", "use"]),
    skillManifestRef: `${skillId}/SKILL.md`,
    payloadRefs: Object.freeze([`${skillId}/SKILL.md`]),
    packageBundle: opaquePackage(skillId)
  });
}

function sandboxInput(skillId, workspaceId = "workspace-source", suffix = "default") {
  return Object.freeze({
    skillId,
    workspaceId,
    outputs: Object.freeze({
      schema: "synthetic-skill-output",
      maxFiles: 4,
      maxBytes: 4096,
      allowedTypes: Object.freeze(["application/json"])
    }),
    capabilities: Object.freeze({
      filesystem: Object.freeze(["input:read", "output:write"]),
      network: Object.freeze([]),
      tools: Object.freeze([]),
      secretRefs: Object.freeze([]),
      clock: false,
      randomness: false,
      subprocesses: 0
    }),
    resources: Object.freeze({
      wallTimeMs: 5000,
      cpuMillis: 1000,
      memoryBytes: 16 * 1024 * 1024,
      processes: 1,
      fileDescriptors: 16,
      diskBytes: 1024 * 1024,
      inodes: 32,
      fileCount: 16,
      outputBytes: 4096,
      logBytes: 4096,
      networkBytes: 1,
      toolCalls: 1
    }),
    idempotencyKey: `synthetic-${skillId}-${suffix}`,
    deadlineAt: new Date(Date.now() + 60_000).toISOString()
  });
}

function sandboxHost({ fault = null, scanResult = "passed" } = {}) {
  const receipts = new Map();
  const calls = [];
  const scanBytes = Buffer.from(JSON.stringify({ scan: scanResult }), "utf8");
  return Object.freeze({
    calls,
    sandboxExecution: Object.freeze({
      async executeConfiguredOpaque(request, opaqueInputs) {
        calls.push(Object.freeze({ request: structuredClone(request), opaqueInputs: structuredClone(opaqueInputs) }));
        if (fault) throw fault;
        assert.equal(request.schemaVersion, "v0.0.1:execution-sandbox:configured-workload-request-1");
        assert.equal(opaqueInputs.length, 1);
        assert.equal(opaqueInputs[0].files.length, 1);
        assert.equal(opaqueInputs[0].files[0].path, ".meshrix/skill-package.bundle");
        const base = {
          receiptId: `receipt-${request.idempotencyKey}`,
          runId: `run-${request.idempotencyKey}`,
          workloadKind: request.workloadKind,
          artifactDigest: sha(`artifact:${request.idempotencyKey}`),
          inputDigests: request.inputs.map((input) => input.digest),
          policyDigest: sha(`policy:${request.idempotencyKey}`),
          cleanupState: "destroyed",
          createdAt: new Date().toISOString()
        };
        const receipt = request.workloadKind === "skill_scan"
          ? {
              ...base,
              status: "output_quarantined",
              outputDisposition: "quarantined",
              outputHandle: `output-${request.idempotencyKey}`
            }
          : { ...base, status: "succeeded", outputDisposition: "committed" };
        receipts.set(receipt.runId, receipt);
        return receipt;
      },
      async resolveQuarantinedOutput(outputHandle) {
        return Object.freeze({
          outputHandle,
          output: Object.freeze({
            files: Object.freeze([Object.freeze({
              path: "scan.json",
              bytes: scanBytes.byteLength,
              digest: sha(scanBytes)
            })])
          }),
          async readFile(resource) {
            assert.equal(resource, "scan.json");
            return Buffer.from(scanBytes);
          }
        });
      },
      async disposeOutput(outputHandle, disposition) {
        const current = [...receipts.values()].find((entry) => entry.outputHandle === outputHandle);
        if (!current) return false;
        receipts.set(current.runId, {
          ...current,
          status: disposition === "committed" ? "succeeded" : disposition,
          outputDisposition: disposition,
          outputHandle: ""
        });
        return true;
      },
      async getReceipt(runId) {
        return receipts.get(runId) || null;
      },
      async cancel(executionRef) {
        return Object.freeze({ runId: executionRef, status: "cancelled", cleanupState: "destroyed" });
      },
      async getStatus(executionRef) {
        return Object.freeze({ runId: executionRef, status: "running" });
      }
    })
  });
}

function baseHost(overrides = {}) {
  return Object.freeze({
    opaqueArtifactCustody: Object.freeze({
      async delete() {
        return Object.freeze({ ok: true });
      }
    }),
    securityAlertStore: Object.freeze({ appendAlert() {} }),
    ...overrides
  });
}

function callFor(actor = "actor-synthetic", { authorized = true, current = true } = {}) {
  return Object.freeze({
    transport: "internal",
    auth: Object.freeze({
      authenticated: true,
      actorType: "console-user",
      subjectRef: actor,
      tenantRef: "tenant-synthetic",
      scopes: Object.freeze(["workspace:read", "workspace:write", "workspace:maintain"])
    }),
    governance: Object.freeze({ authorized, current })
  });
}

async function activate(pluginData = memoryPluginData()) {
  return activatePlugin({
    manifest,
    context: Object.freeze({ configuration: enabledConfiguration, pluginData })
  });
}

async function invoke(runtime, operationId, input = {}, {
  actor = "actor-synthetic",
  host = baseHost(),
  governance = { authorized: true, current: true }
} = {}) {
  const operation = runtime.contributions.operations[operationId];
  assert.ok(operation, `Missing operation ${operationId}`);
  return operation.execute({
    operation: operation.definition,
    input,
    call: callFor(actor, governance),
    host
  });
}

test("Skill Hub imports without network activity and empty configuration contributes nothing", async () => {
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("Synthetic network access is forbidden.");
  };
  try {
    await import(`../../plugins/skill-hub/runtime.mjs?side-effect-check=${Date.now()}`);
    await import(`../../plugins/skill-hub/console/index.mjs?side-effect-check=${Date.now()}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(networkCalls, 0);
  assert.deepEqual(validateSkillHubConfiguration({}), { enabled: false });
  const runtime = await activatePlugin({ manifest, context: { configuration: {} } });
  for (const contributions of Object.values(runtime.contributions)) assert.deepEqual(contributions, {});
  assert.deepEqual(await runtime.close(), { ok: true, alreadyClosed: false });
  assert.deepEqual(await runtime.close(), { ok: true, alreadyClosed: true });
});

test("Skill Hub rejects unknown and partial configuration before activation", async () => {
  assert.throws(
    () => validateSkillHubConfiguration({ enabled: true, modules: { registry: true } }),
    { code: "skill_hub_partial_configuration" }
  );
  assert.throws(
    () => validateSkillHubConfiguration({ enabled: false, modules: {} }),
    { code: "skill_hub_partial_configuration" }
  );
  assert.throws(
    () => validateSkillHubConfiguration({ enabled: true, modules: {
      registry: true,
      opaqueCustody: true,
      controlledSandbox: true,
      operationPermission: true,
      unsupported: true
    } }),
    /unsupported field/u
  );
  await assert.rejects(
    activatePlugin({ manifest, context: { configuration: enabledConfiguration } }),
    /opaque plugin data capability/u
  );
});

test("Skill Hub discovers the complete contribution surface and neutral Host ports", async () => {
  const runtime = await activate();
  assert.equal(Object.keys(runtime.contributions.operations).length, 20);
  assert.equal(Object.keys(runtime.contributions.routes).length, 20);
  assert.equal(Object.keys(runtime.contributions.mcpTools).length, 20);
  assert.deepEqual(Object.keys(runtime.contributions.consoleEntries), ["admin.skill-hub"]);
  assert.deepEqual(Object.keys(runtime.contributions.stateMachines), ["contribution.lifecycle"]);
  assert.equal(runtime.contributions.consoleEntries["admin.skill-hub"].assetPath, "console/index.mjs");
  assert.equal(runtime.contributions.consoleEntries["admin.skill-hub"].assetExport, "mountPluginConsole");
  assert.deepEqual(
    runtime.contributions.operations["skill_hub.permission.grant"].requiredHostPorts,
    ["operationPermissionGrant"]
  );
  assert.ok(Object.values(runtime.contributions.operations).every((operation) =>
    !operation.requiredHostPorts.includes("securityPermissions") &&
    !operation.requiredHostPorts.includes("operationPermissionPlatform")
  ));
  assert.equal(
    runtime.contributions.stateMachines["contribution.lifecycle"].definition.totalMatrix.length,
    lifecycleDefinition.states.length * lifecycleDefinition.events.length
  );
  await runtime.close();
});

test("Skill Hub lifecycle performs opaque submit, scan, build, review, publish, adoption, permission, use, revoke, and rollback", async () => {
  const pluginData = memoryPluginData();
  const runtime = await activate(pluginData);
  const skillId = "skill-lifecycle";
  const sourceWorkspace = "workspace-source";
  const adoptedWorkspace = "workspace-adopted";
  const sandbox = sandboxHost();
  const host = baseHost({ sandboxExecution: sandbox.sandboxExecution });

  const submitted = await invoke(runtime, "skill_hub.submit", submission(skillId, sourceWorkspace), {
    actor: "contributor-one",
    host
  });
  assert.equal(submitted.statusCode, 201);
  assert.equal(submitted.body.skill.status, "submitted");
  assert.equal(JSON.stringify(submitted.body).includes("custody:"), false);
  assert.equal((await invoke(runtime, "skill_hub.list", {}, { host })).body.count, 0);
  assert.equal((await invoke(runtime, "skill_hub.download", { skillId }, { host })).body.error.code,
    "contribution_download_not_published");

  const unavailableScan = await invoke(runtime, "skill_hub.scan", sandboxInput(skillId), {
    actor: "scanner-one",
    host: baseHost()
  });
  assert.equal(unavailableScan.statusCode, 400);
  assert.equal(unavailableScan.body.error.code, "skill_hub_sandbox_operation_failed");

  const scanned = await invoke(runtime, "skill_hub.scan", sandboxInput(skillId, sourceWorkspace, "scan"), {
    actor: "scanner-one",
    host
  });
  assert.equal(scanned.statusCode, 200);
  assert.equal(scanned.body.scan.contribution.status, "scanned");
  assert.equal(scanned.body.receipt.status, "succeeded");
  assert.equal(scanned.body.receipt.cleanupStatus, "destroyed");

  const built = await invoke(runtime, "skill_hub.build", sandboxInput(skillId, sourceWorkspace, "build"), {
    actor: "builder-one",
    host
  });
  assert.equal(built.statusCode, 200);
  assert.equal(built.body.receipt.workloadKind, "skill_build");

  const selfReview = await invoke(runtime, "skill_hub.review", { skillId, decision: "approved" }, {
    actor: "contributor-one",
    host
  });
  assert.equal(selfReview.statusCode, 400);
  assert.equal(selfReview.body.error.code, "contribution_review_separation_required");

  const reviewed = await invoke(runtime, "skill_hub.review", { skillId, decision: "approved" }, {
    actor: "reviewer-one",
    host
  });
  assert.equal(reviewed.statusCode, 200);
  assert.equal(reviewed.body.skill.status, "reviewed");
  const published = await invoke(runtime, "skill_hub.publish", { skillId }, {
    actor: "publisher-one",
    host
  });
  assert.equal(published.statusCode, 200);
  assert.equal(published.body.skill.status, "published");
  assert.equal((await invoke(runtime, "skill_hub.search", { query: "lifecycle" }, { host })).body.count, 1);

  const downloaded = await invoke(runtime, "skill_hub.download", { skillId, workspaceId: sourceWorkspace }, {
    actor: "consumer-one",
    host
  });
  assert.equal(downloaded.statusCode, 200);
  assert.equal(downloaded.body.download.packageRef.integrityVerified, true);
  assert.equal(JSON.stringify(downloaded.body).includes("custody:"), false);

  const installed = await invoke(runtime, "skill_hub.install", {
    skillId,
    targetWorkspaceId: adoptedWorkspace
  }, { actor: "consumer-one", host });
  assert.equal(installed.statusCode, 200);
  assert.equal(installed.body.skill.status, "adopted");
  assert.equal(installed.body.adoption.status, "adopted");

  const deniedUsage = await invoke(runtime, "skill_hub.usage.record", {
    skillId,
    workspaceId: adoptedWorkspace,
    action: "skill.used"
  }, { actor: "consumer-one", host });
  assert.equal(deniedUsage.statusCode, 400);
  assert.equal(deniedUsage.body.error.code, "contribution_use_grant_required");

  const requested = await invoke(runtime, "skill_hub.permission.request", {
    skillId,
    targetWorkspaceId: adoptedWorkspace,
    actions: ["use"],
    purpose: "synthetic governed use"
  }, { actor: "consumer-one", host });
  assert.equal(requested.statusCode, 201);

  let grantWrites = 0;
  const grantDeniedByGovernance = await invoke(runtime, "skill_hub.permission.grant", {
    skillId,
    targetWorkspaceId: adoptedWorkspace,
    actions: ["use"]
  }, {
    actor: "consumer-one",
    host: baseHost({
      operationPermissionGrant: Object.freeze({
        async recordPluginGrant() {
          grantWrites += 1;
          return { ok: true, receiptId: "unexpected" };
        }
      })
    }),
    governance: { authorized: true, current: false }
  });
  assert.equal(grantDeniedByGovernance.statusCode, 400);
  assert.equal(grantWrites, 0);

  const rejectedGrant = await invoke(runtime, "skill_hub.permission.grant", {
    skillId,
    targetWorkspaceId: adoptedWorkspace,
    actions: ["use"]
  }, {
    actor: "consumer-one",
    host: baseHost({
      operationPermissionGrant: Object.freeze({
        async recordPluginGrant() {
          grantWrites += 1;
          throw Object.assign(new Error("secret-material from Host"), { code: "operation_permission_denied" });
        }
      })
    })
  });
  assert.equal(rejectedGrant.statusCode, 400);
  assert.equal(rejectedGrant.body.error.code, "operation_permission_denied");
  assert.equal(JSON.stringify(rejectedGrant.body).includes("secret-material"), false);

  let recordedLoan = null;
  const granted = await invoke(runtime, "skill_hub.permission.grant", {
    skillId,
    targetWorkspaceId: adoptedWorkspace,
    actions: ["use"]
  }, {
    actor: "consumer-one",
    host: baseHost({
      operationPermissionGrant: Object.freeze({
        async recordPluginGrant({ loanRecord }) {
          grantWrites += 1;
          recordedLoan = structuredClone(loanRecord);
          return { ok: true, receiptId: "grant-receipt-one" };
        }
      })
    })
  });
  assert.equal(granted.statusCode, 200);
  assert.equal(granted.body.operationPermissionReceipt.receiptId, "grant-receipt-one");
  assert.equal(Object.hasOwn(granted.body, "loanRecord"), false);
  assert.equal(recordedLoan.granteeId, "consumer-one");

  const usage = await invoke(runtime, "skill_hub.usage.record", {
    skillId,
    workspaceId: adoptedWorkspace,
    action: "skill.used"
  }, { actor: "consumer-one", host });
  assert.equal(usage.statusCode, 201);
  assert.equal(usage.body.metrics.usageCount, 1);

  const executed = await invoke(runtime, "skill_hub.execute", sandboxInput(
    skillId,
    adoptedWorkspace,
    "execute"
  ), { actor: "consumer-one", host });
  assert.equal(executed.statusCode, 200);
  assert.equal(executed.body.receipt.workloadKind, "skill_execute");
  assert.equal(sandbox.calls.length, 3);

  const stats = await invoke(runtime, "skill_hub.stats", { workspaceId: sourceWorkspace }, { host });
  assert.equal(stats.statusCode, 200);
  assert.equal(stats.body.skillCount, 1);
  assert.equal(stats.body.usageCount, 1);
  assert.equal(stats.body.downloadCount, 1);
  assert.equal(stats.body.permissionGrantCount, 1);
  const leaderboard = await invoke(runtime, "skill_hub.leaderboard", {}, { host });
  assert.equal(leaderboard.body.items[0].contributionId, skillId);

  const rollback = await invoke(runtime, "skill_hub.rollback.record", {
    skillId,
    reason: "synthetic adoption compensation"
  }, { actor: "consumer-one", host });
  assert.equal(rollback.statusCode, 201);
  assert.equal(rollback.body.metrics.rollbackCount, 1);

  const revoked = await invoke(runtime, "skill_hub.revoke", {
    skillId,
    reason: "synthetic policy revocation"
  }, { actor: "maintainer-one", host });
  assert.equal(revoked.statusCode, 200);
  assert.equal(revoked.body.skill.status, "revoked");
  assert.equal((await invoke(runtime, "skill_hub.download", { skillId }, { host })).statusCode, 410);
  assert.equal((await invoke(runtime, "skill_hub.install", { skillId }, { host })).statusCode, 410);

  assert.ok(pluginData.paths().length > 0);
  assert.ok(pluginData.paths().every((resource) => resource.startsWith("SkillHub/")));
  assert.ok(pluginData.registryStates().every((state) =>
    Object.values(state.contributions).every((contribution) =>
      !String(contribution.currentAssetRef?.assetPath || "").startsWith("/")
    )
  ));
  await runtime.close();
});

test("Skill Hub holds reads behind an in-flight grant and exposes no partial local grant", async () => {
  const runtime = await activate();
  const skillId = "skill-linear-grant";
  const sandbox = sandboxHost();
  const host = baseHost({ sandboxExecution: sandbox.sandboxExecution });
  await invoke(runtime, "skill_hub.submit", submission(skillId), { actor: "contributor", host });
  await invoke(runtime, "skill_hub.scan", sandboxInput(skillId, "workspace-source", "linear-scan"), {
    actor: "scanner",
    host
  });
  await invoke(runtime, "skill_hub.review", { skillId, decision: "approved" }, { actor: "reviewer", host });
  await invoke(runtime, "skill_hub.publish", { skillId }, { actor: "publisher", host });
  await invoke(runtime, "skill_hub.permission.request", {
    skillId,
    targetWorkspaceId: "workspace-source",
    actions: ["use"]
  }, { actor: "consumer", host });

  const hostStarted = deferred();
  const hostRelease = deferred();
  const pendingGrant = invoke(runtime, "skill_hub.permission.grant", {
    skillId,
    targetWorkspaceId: "workspace-source",
    actions: ["use"]
  }, {
    actor: "consumer",
    host: baseHost({
      operationPermissionGrant: Object.freeze({
        async recordPluginGrant() {
          hostStarted.resolve();
          return hostRelease.promise;
        }
      })
    })
  });
  await hostStarted.promise;
  let readSettled = false;
  const pendingRead = invoke(runtime, "skill_hub.stats").then((value) => {
    readSettled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(readSettled, false);
  hostRelease.resolve({ ok: true, receiptId: "linear-grant-receipt" });
  assert.equal((await pendingGrant).statusCode, 200);
  const stats = await pendingRead;
  assert.equal(stats.body.permissionGrantCount, 1);
  await runtime.close();
});

test("Skill Hub rolls back plugin state and opaque custody when persistence fails", async () => {
  const pluginData = memoryPluginData();
  pluginData.failOneWrite();
  const runtime = await activate(pluginData);
  const deleted = [];
  const host = baseHost({
    opaqueArtifactCustody: Object.freeze({
      async delete(request) {
        deleted.push(structuredClone(request));
        return { ok: true };
      }
    })
  });
  const skillId = "skill-persistence-rollback";
  const failed = await invoke(runtime, "skill_hub.submit", submission(skillId), {
    actor: "contributor",
    host
  });
  assert.equal(failed.statusCode, 400);
  assert.equal(failed.body.error.code, "skill_hub_storage_write_failed");
  assert.equal(JSON.stringify(failed.body).includes("secret-material"), false);
  assert.equal(deleted.length, 1);

  const retried = await invoke(runtime, "skill_hub.submit", submission(skillId), {
    actor: "contributor",
    host
  });
  assert.equal(retried.statusCode, 201);
  assert.equal(retried.body.skill.contributionId, skillId);
  await runtime.close();
});

test("Skill Hub serializes mutations, drains close, and fences later operations", async () => {
  const pluginData = memoryPluginData({ writeDelayMs: 4 });
  const runtime = await activate(pluginData);
  const host = baseHost();
  const first = invoke(runtime, "skill_hub.submit", submission("skill-serial-one"), {
    actor: "contributor-one",
    host
  });
  const second = invoke(runtime, "skill_hub.submit", submission("skill-serial-two"), {
    actor: "contributor-two",
    host
  });
  const closing = runtime.close();
  assert.deepEqual((await Promise.all([first, second])).map((result) => result.statusCode), [201, 201]);
  const closeReceipt = await closing;
  assert.equal(closeReceipt.ok, true);
  assert.equal(pluginData.maximumActiveWrites(), 1);
  const fenced = await invoke(runtime, "skill_hub.stats", {});
  assert.equal(fenced.statusCode, 503);
  assert.equal(fenced.body.error.code, "skill_hub_runtime_closed");
  assert.equal((await runtime.close()).alreadyClosed, true);
});

test("Skill Hub sanitizes Host faults and never falls back to local execution", async () => {
  const runtime = await activate();
  const skillId = "skill-host-fault";
  await invoke(runtime, "skill_hub.submit", submission(skillId), {
    actor: "contributor",
    host: baseHost()
  });
  const fault = new Error("secret-material from an unavailable Host backend");
  const denied = await invoke(runtime, "skill_hub.scan", sandboxInput(skillId), {
    actor: "scanner",
    host: baseHost({ sandboxExecution: sandboxHost({ fault }).sandboxExecution })
  });
  assert.equal(denied.statusCode, 400);
  assert.equal(denied.body.error.code, "skill_hub_sandbox_operation_failed");
  assert.equal(JSON.stringify(denied.body).includes("secret-material"), false);
  const state = (await invoke(runtime, "skill_hub.stats")).body;
  assert.deepEqual(state.statusBreakdown, { submitted: 1 });
  await runtime.close();
});

test("Skill Hub contribution lifecycle declares a unique total state-event matrix", () => {
  assert.equal(lifecycleDefinition.machineId, "contribution.lifecycle");
  assert.equal(lifecycleDefinition.initialState, "submitted");
  const stateIds = lifecycleDefinition.states.map((state) => state.id);
  const eventIds = lifecycleDefinition.events.map((event) => event.id);
  const pairs = lifecycleDefinition.totalMatrix.map((entry) => `${entry.from}::${entry.event}`);
  assert.equal(lifecycleDefinition.totalMatrix.length, stateIds.length * eventIds.length);
  assert.equal(new Set(pairs).size, pairs.length);
  assert.deepEqual(new Set(lifecycleDefinition.totalMatrix.map((entry) => entry.result)), new Set([
    "legal_transition",
    "illegal_transition",
    "ignored_idempotent_event"
  ]));
  for (const stateId of stateIds) {
    for (const eventId of eventIds) assert.ok(pairs.includes(`${stateId}::${eventId}`));
  }
  for (const terminal of ["rejected", "revoked"]) {
    assert.ok(lifecycleDefinition.states.find((state) => state.id === terminal)?.terminal);
    assert.ok(lifecycleDefinition.totalMatrix
      .filter((entry) => entry.from === terminal)
      .every((entry) => entry.result !== "legal_transition"));
  }
});
