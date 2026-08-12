import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activatePlugin,
  validateSkillHubConfiguration
} from "../../plugins/skill-hub/runtime.mjs";
import { createSkillHubHttpHandler } from "../../services/skill-hub/internal/http-service.mjs";

const manifest = JSON.parse(await readFile(
  new URL("../../plugins/skill-hub/plugin.json", import.meta.url),
  "utf8"
));
const enabledConfiguration = Object.freeze({
  enabled: true,
  service: Object.freeze({ serviceRef: "svc_skill_hub", timeoutMs: 30_000 })
});
const serviceAuthToken = "synthetic-skill-hub-test-token-000000000000";

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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
    packageBundleBase64: Buffer.from(`synthetic-package:${skillId}`, "utf8").toString("base64")
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

function sandboxHost() {
  const receipts = new Map();
  const calls = [];
  return Object.freeze({
    calls,
    sandboxExecution: Object.freeze({
      async executeConfigured(request, resolveInput) {
        const resolved = await resolveInput(request.inputs[0]);
        assert.equal(resolved.digest, request.inputs[0].digest);
        assert.equal(resolved.files.length, 1);
        assert.ok(Buffer.isBuffer(resolved.files[0].content));
        assert.equal(sha(resolved.files[0].content), resolved.files[0].digest);
        calls.push(Object.freeze({ workloadKind: request.workloadKind, inputDigest: resolved.digest }));
        const base = {
          receiptId: `receipt-${request.idempotencyKey}`,
          runId: `run-${request.idempotencyKey}`,
          workloadKind: request.workloadKind,
          artifactDigest: sha(`artifact:${request.idempotencyKey}`),
          inputDigests: [resolved.digest],
          policyDigest: sha(`policy:${request.idempotencyKey}`),
          cleanupState: "destroyed",
          createdAt: new Date().toISOString()
        };
        const receipt = request.workloadKind === "skill_scan"
          ? { ...base, status: "output_quarantined", outputDisposition: "quarantined", outputHandle: `output-${request.idempotencyKey}` }
          : { ...base, status: "succeeded", outputDisposition: "committed" };
        receipts.set(receipt.runId, receipt);
        return receipt;
      },
      async resolveQuarantinedOutput(outputHandle) {
        const bytes = Buffer.from(JSON.stringify({ scan: "passed" }), "utf8");
        return Object.freeze({
          outputHandle,
          output: Object.freeze({ files: Object.freeze([Object.freeze({
            path: "scan.json",
            bytes: bytes.byteLength,
            digest: sha(bytes)
          })]) }),
          async readFile(resource) {
            assert.equal(resource, "scan.json");
            return Buffer.from(bytes);
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

async function fixture(t) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "meshrix-skill-hub-test-"));
  const handler = await createSkillHubHttpHandler({ dataRoot, authToken: serviceAuthToken });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const externalService = Object.freeze({
    async request(request) {
      assert.equal(request.serviceRef, "svc_skill_hub");
      assert.equal(request.operationRef.startsWith("skill_hub."), true);
      const response = await fetch(`${baseUrl}/v1/operations/${request.operationRef}`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${serviceAuthToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(request.input)
      });
      return Object.freeze({ ok: response.ok, status: response.status, data: await response.json() });
    }
  });
  const runtime = await activatePlugin({ manifest, context: { configuration: enabledConfiguration } });
  t.after(async () => {
    await runtime.close();
    await new Promise((resolve) => server.close(resolve));
    await handler.close();
    await rm(dataRoot, { recursive: true, force: true });
  });
  return { baseUrl, externalService, runtime };
}

async function invoke(runtime, operationId, input = {}, {
  actor = "actor-synthetic",
  externalService,
  host = {},
  governance = { authorized: true, current: true }
} = {}) {
  const operation = runtime.contributions.operations[operationId];
  assert.ok(operation, `Missing operation ${operationId}`);
  return operation.execute({
    operation: operation.definition,
    input,
    call: callFor(actor, governance),
    host: Object.freeze({ externalService, ...host })
  });
}

test("Skill Hub is default-off and requires one explicit remote service binding", async () => {
  assert.deepEqual(validateSkillHubConfiguration({}), { enabled: false });
  assert.throws(
    () => validateSkillHubConfiguration({ enabled: true, service: { serviceRef: "x", timeoutMs: 30_000 } }),
    /serviceRef/u
  );
  assert.throws(
    () => validateSkillHubConfiguration({ enabled: true, modules: {} }),
    /unsupported field/u
  );
  const runtime = await activatePlugin({ manifest, context: { configuration: {} } });
  for (const contributions of Object.values(runtime.contributions)) assert.deepEqual(contributions, {});
  await runtime.close();
});

test("Skill Hub service exposes health and the plugin contributes only remote adapters", async (t) => {
  const { baseUrl, runtime } = await fixture(t);
  const health = await fetch(`${baseUrl}/readyz`).then((response) => response.json());
  assert.deepEqual(health, {
    ok: true,
    service: "skill-hub",
    protocolVersion: "v0.0.1:skill-hub:service-1"
  });
  assert.equal(Object.keys(runtime.contributions.operations).length, 20);
  assert.ok(Object.values(runtime.contributions.operations).every((operation) =>
    operation.requiredHostPorts.includes("externalService") ||
    operation.definition.id.startsWith("skill_hub.execution.")
  ));
  assert.ok(Object.values(runtime.contributions.operations).every((operation) =>
    !operation.requiredHostPorts.includes("pluginData") &&
    !operation.requiredHostPorts.includes("opaqueArtifactCustody")
  ));
});

test("Skill Hub remote lifecycle preserves sandbox execution, review separation, grants, adoption, and revocation", async (t) => {
  const { externalService, runtime } = await fixture(t);
  const sandbox = sandboxHost();
  const skillId = "skill-remote-lifecycle";
  const sourceWorkspace = "workspace-source";
  const adoptedWorkspace = "workspace-adopted";

  const submitted = await invoke(runtime, "skill_hub.submit", submission(skillId, sourceWorkspace), {
    actor: "contributor-one", externalService
  });
  assert.equal(submitted.statusCode, 201);
  assert.equal(submitted.body.skill.status, "submitted");
  assert.equal(JSON.stringify(submitted.body).includes("packageBundleBase64"), false);

  const scanned = await invoke(runtime, "skill_hub.scan", sandboxInput(skillId, sourceWorkspace, "scan"), {
    actor: "scanner-one", externalService, host: { sandboxExecution: sandbox.sandboxExecution }
  });
  assert.equal(scanned.statusCode, 200);
  assert.equal(scanned.body.scan.contribution.status, "scanned");
  assert.equal(scanned.body.receipt.cleanupStatus, "destroyed");

  const built = await invoke(runtime, "skill_hub.build", sandboxInput(skillId, sourceWorkspace, "build"), {
    actor: "builder-one", externalService, host: { sandboxExecution: sandbox.sandboxExecution }
  });
  assert.equal(built.statusCode, 200);
  assert.equal(built.body.receipt.workloadKind, "skill_build");

  const selfReview = await invoke(runtime, "skill_hub.review", { skillId, decision: "approved" }, {
    actor: "contributor-one", externalService
  });
  assert.equal(selfReview.statusCode, 400);
  assert.equal(selfReview.body.error.code, "contribution_review_separation_required");

  const reviewed = await invoke(runtime, "skill_hub.review", { skillId, decision: "approved" }, {
    actor: "reviewer-one", externalService
  });
  assert.equal(reviewed.body.skill.status, "reviewed");
  const published = await invoke(runtime, "skill_hub.publish", { skillId }, {
    actor: "publisher-one", externalService
  });
  assert.equal(published.body.skill.status, "published");

  const installed = await invoke(runtime, "skill_hub.install", { skillId, targetWorkspaceId: adoptedWorkspace }, {
    actor: "consumer-one", externalService
  });
  assert.equal(installed.body.skill.status, "adopted");

  const request = await invoke(runtime, "skill_hub.permission.request", {
    skillId,
    targetWorkspaceId: adoptedWorkspace,
    actions: ["use"],
    purpose: "synthetic governed use"
  }, { actor: "consumer-one", externalService });
  assert.equal(request.statusCode, 201);

  let recordedLoan;
  const granted = await invoke(runtime, "skill_hub.permission.grant", {
    skillId,
    targetWorkspaceId: adoptedWorkspace,
    actions: ["use"]
  }, {
    actor: "consumer-one",
    externalService,
    host: {
      operationPermissionGrant: Object.freeze({
        async recordPluginGrant({ loanRecord }) {
          recordedLoan = structuredClone(loanRecord);
          return Object.freeze({ ok: true, receiptId: "grant-receipt-one" });
        }
      })
    }
  });
  assert.equal(granted.statusCode, 200);
  assert.equal(granted.body.operationPermissionReceipt.receiptId, "grant-receipt-one");
  assert.equal(recordedLoan.granteeId, "consumer-one");

  const usage = await invoke(runtime, "skill_hub.usage.record", {
    skillId,
    workspaceId: adoptedWorkspace,
    action: "skill.used"
  }, { actor: "consumer-one", externalService });
  assert.equal(usage.statusCode, 201);
  assert.equal(usage.body.metrics.usageCount, 1);

  const executed = await invoke(runtime, "skill_hub.execute", sandboxInput(skillId, adoptedWorkspace, "execute"), {
    actor: "consumer-one", externalService, host: { sandboxExecution: sandbox.sandboxExecution }
  });
  assert.equal(executed.statusCode, 200);
  assert.equal(executed.body.receipt.workloadKind, "skill_execute");
  assert.deepEqual(sandbox.calls.map((call) => call.workloadKind), ["skill_scan", "skill_build", "skill_execute"]);

  const stats = await invoke(runtime, "skill_hub.stats", {}, { externalService });
  assert.equal(stats.body.skillCount, 1);
  assert.equal(stats.body.usageCount, 1);
  assert.equal(stats.body.permissionGrantCount, 1);

  const revoked = await invoke(runtime, "skill_hub.revoke", { skillId }, {
    actor: "maintainer-one", externalService
  });
  assert.equal(revoked.body.skill.status, "revoked");
  const download = await invoke(runtime, "skill_hub.download", { skillId }, { externalService });
  assert.equal(download.statusCode, 410);
});

test("Skill Hub adapter fails closed when the service or current governance is absent", async (t) => {
  const { externalService, runtime } = await fixture(t);
  const denied = await invoke(runtime, "skill_hub.list", {}, {
    externalService,
    governance: { authorized: true, current: false }
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.error.code, "skill_hub_operation_denied");
  const unavailable = await invoke(runtime, "skill_hub.list", {}, { externalService: null });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.body.error.code, "skill_hub_external_service_unavailable");
});
