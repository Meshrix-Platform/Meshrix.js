import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  activatePlugin,
  validateSharedSpaceConfiguration
} from "../../plugins/shared-space/runtime.mjs";
import {
  custodyPromotionSetDigest,
  sandboxDigest
} from "../../plugins/shared-space/runtime/sandbox-contracts.mjs";
import { contentDigest } from "../../plugins/shared-space/runtime/sandbox-state-store.mjs";

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const enabledConfiguration = Object.freeze({
  enabled: true,
  modules: Object.freeze({ localDirectory: true, controlledSandbox: true })
});
const manifest = JSON.parse(await readFile(
  new URL("../../plugins/shared-space/plugin.json", import.meta.url),
  "utf8"
));

function memoryPluginData() {
  const files = new Map();
  return Object.freeze({
    async readFile(resource, encoding = "utf8") {
      if (!files.has(resource)) {
        throw Object.assign(new Error("fixture record is absent"), { code: "PLUGIN_DATA_NOT_FOUND" });
      }
      const value = files.get(resource);
      return encoding ? value.toString(encoding) : Buffer.from(value);
    },
    async writeFile(resource, value, encoding = "utf8") {
      files.set(resource, Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value), encoding));
    },
    inspect() {
      return Object.freeze([...files.keys()]);
    }
  });
}

function authorizedCall(approval = null, authorization = {}) {
  const {
    authenticated = true,
    authorized = true,
    current = true,
    revoked = false,
    includeCurrent = true
  } = authorization;
  return Object.freeze({
    auth: Object.freeze({
      authenticated,
      subjectRef: "subject-1",
      tenantRef: "tenant-1",
      scopes: Object.freeze(["workspace:read", "workspace:maintain", "storage:read", "storage:write"])
    }),
    governance: Object.freeze({
      authorized,
      ...(includeCurrent ? { current } : {}),
      revoked,
      scopes: Object.freeze(["workspace:read"])
    }),
    workspaceAuthority: Object.freeze({ authorized: true, workspaceRef: "workspace-1" }),
    ...(approval ? { approval } : {})
  });
}

async function activate(context = {}) {
  return activatePlugin({
    manifest,
    context: Object.freeze({
      pluginData: memoryPluginData(),
      configuration: enabledConfiguration,
      ...context
    })
  });
}

async function invoke(runtime, operationId, input, host = {}, approval = null) {
  const operation = runtime.contributions.operations[operationId];
  assert.ok(operation, `missing operation ${operationId}`);
  return operation.execute({
    operation: operation.definition,
    input,
    call: authorizedCall(approval),
    host
  });
}

function runInput(snapshot, overrides = {}) {
  return {
    workspaceId: "workspace-1",
    snapshotHandle: snapshot.snapshotHandle,
    snapshotDigest: snapshot.snapshotDigest,
    workloadKind: "shared_space_transform",
    workloadDigest: sha("synthetic-workload"),
    runtimeKind: "wasi",
    entryPoint: "bin/main.wasm",
    arguments: ["--bounded"],
    workingDirectory: "work",
    capabilities: {
      filesystem: ["input:read", "output:write"],
      network: [],
      tools: [],
      secretRefs: [],
      clock: false,
      randomness: false,
      subprocesses: 0
    },
    resources: {
      wallTimeMs: 1000,
      cpuMillis: 500,
      memoryBytes: 16 * 1024 * 1024,
      processes: 1,
      fileDescriptors: 16,
      diskBytes: 4096,
      inodes: 16,
      fileCount: 10,
      outputBytes: 1024,
      logBytes: 1024,
      networkBytes: 1,
      toolCalls: 1
    },
    outputs: { schema: "shared-space-files", maxFiles: 2, maxBytes: 1024, allowedTypes: ["txt"] },
    idempotencyKey: "synthetic-run-1",
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides
  };
}

function approvalRecord(operationId, proposal, approvalRef) {
  return Object.freeze({
    approvalRef,
    actorRef: `hmac-sha256:${sha("synthetic-approver")}`,
    operationId,
    status: "approved",
    current: true,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    binding: Object.freeze({
      workspaceId: proposal.workspaceId,
      proposalRef: proposal.proposalRef,
      previewDigest: proposal.previewDigest,
      outputDigest: proposal.outputDigest,
      policyDigest: proposal.policyDigest,
      policyRevision: Object.freeze({ grant: 1, governance: 1 }),
      bindingDigest: sha(`${operationId}:${approvalRef}:${proposal.proposalRef}`)
    })
  });
}

function createHostFixture({ compensateCommit = false } = {}) {
  const input = Buffer.from("synthetic immutable input", "utf8");
  const output = Buffer.from("synthetic quarantined output", "utf8");
  const outputFile = Object.freeze({
    path: "result.txt",
    digest: contentDigest(output),
    bytes: output.byteLength
  });
  const receipt = Object.freeze({
    runId: "run-1",
    artifactDigest: sha("synthetic-artifact"),
    policyDigest: sha("synthetic-policy"),
    inputDigest: sha("synthetic-input-set"),
    outputDigest: sandboxDigest([{ path: outputFile.path, digest: outputFile.digest }]),
    outputHandle: "output-1",
    status: "output_quarantined",
    runtimeState: "succeeded",
    cleanupState: "destroyed",
    outputDisposition: "quarantined"
  });
  const calls = {
    cancel: [],
    connect: [],
    dispose: [],
    execute: [],
    executeOpaque: [],
    restore: [],
    sync: []
  };
  const mounts = [];
  const mutationReceipt = Object.freeze({
    schemaVersion: "v0.0.1:workspace:sandbox-mutation-receipt-1",
    stateCommitId: "commit-1",
    checkpointNodeId: "checkpoint-1",
    receiptDigest: sha("synthetic-mutation-receipt")
  });
  const agentWorkspace = {
    async connectLocalDirectory(request) {
      calls.connect.push(structuredClone(request));
      assert.equal(request.sourcePath, undefined);
      const mount = Object.freeze({ mountRef: "mount-1", targetPath: request.targetPath || "" });
      mounts.push(mount);
      return { ok: true, mount };
    },
    async listLocalDirectoryMounts() {
      return { ok: true, mounts: [...mounts] };
    },
    async applyLocalDirectorySync(request) {
      calls.sync.push(structuredClone(request));
      return {
        ok: true,
        syncReceipt: { syncReceiptId: "sync-1" },
        checkpoint: { checkpointId: "checkpoint-sync-1" }
      };
    },
    async downloadWorkspaceFile(request) {
      assert.equal(request.sourcePath, undefined);
      return {
        ok: true,
        file: { relativePath: request.path, contentSha256: contentDigest(input) },
        contentBase64: input.toString("base64")
      };
    },
    async restoreWorkspaceFiles(request) {
      calls.restore.push(structuredClone(request));
      if (request.dryRun === true) {
        return {
          ok: true,
          dryRun: true,
          actions: [{ action: "create", path: "generated/result.txt" }],
          summary: { create: 1, applied: 0 }
        };
      }
      if (compensateCommit) {
        return {
          ok: false,
          status: 409,
          compensated: true,
          compensationReceipt: { receiptRef: "compensation-1" }
        };
      }
      return {
        ok: true,
        stateCommit: { commitId: "commit-1" },
        checkpoint: { nodeId: "checkpoint-1" },
        mutationReceipt
      };
    },
    async getWorkspaceSandboxMutationReceipt(request) {
      assert.deepEqual(request, { workspaceId: "workspace-1", commitId: "commit-1" });
      return { ok: true, mutationReceipt };
    }
  };
  const sandboxExecution = {
    async execute(request, resolveInput) {
      calls.execute.push(structuredClone(request));
      const resolved = await resolveInput(request.inputs[0]);
      assert.equal(resolved.digest, request.inputs[0].digest);
      assert.equal(JSON.stringify(resolved).includes("sourcePath"), false);
      return { runId: "run-1", status: "accepted" };
    },
    async executeOpaque(request, promoted) {
      calls.executeOpaque.push({ request: structuredClone(request), promoted: structuredClone(promoted) });
      return { runId: "opaque-run-1", status: "accepted" };
    },
    async cancel(runRef) {
      calls.cancel.push(runRef);
      return { runRef, status: "cancel_requested" };
    },
    async getStatus(runRef) {
      return { runRef, status: "running" };
    },
    async getReceipt() {
      return receipt;
    },
    async resolveQuarantinedOutput(outputHandle) {
      assert.equal(outputHandle, "output-1");
      return {
        output: { digest: receipt.outputDigest, files: [outputFile] },
        async readFile(filePath) {
          assert.equal(filePath, outputFile.path);
          return output;
        }
      };
    },
    async disposeOutput(outputHandle, disposition) {
      calls.dispose.push({ outputHandle, disposition });
      return true;
    }
  };
  return Object.freeze({ agentWorkspace, calls, receipt, sandboxExecution });
}

async function snapshotAndRun(runtime, fixture) {
  const host = { agentWorkspace: fixture.agentWorkspace, sandboxExecution: fixture.sandboxExecution };
  const snapshotResponse = await invoke(runtime, "sharedspace.snapshot.create", {
    workspaceId: "workspace-1",
    entries: [{ path: "input.txt" }]
  }, host);
  assert.equal(snapshotResponse.statusCode, 201);
  const snapshot = snapshotResponse.body.snapshot;
  const runResponse = await invoke(runtime, "sharedspace.sandbox.run", runInput(snapshot), host);
  assert.equal(runResponse.statusCode, 202);
  assert.equal(runResponse.body.run.runRef, "run-1");
  return { host, snapshot };
}

test("Shared Space import is side-effect free and empty configuration publishes zero contributions", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network is forbidden during import");
  };
  try {
    const entrypoint = path.resolve("plugins/shared-space/runtime.mjs");
    const imported = await import(`${pathToFileURL(entrypoint).href}?side-effect-test=1`);
    const consoleEntrypoint = path.resolve("plugins/shared-space/console/index.mjs");
    const consoleModule = await import(`${pathToFileURL(consoleEntrypoint).href}?side-effect-test=1`);
    assert.equal(typeof imported.activatePlugin, "function");
    assert.equal(typeof consoleModule.mountPluginConsole, "function");
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const inactive = await activatePlugin({ manifest, context: { configuration: {} } });
  for (const contributions of Object.values(inactive.contributions)) {
    assert.deepEqual(Object.keys(contributions), []);
  }
  assert.deepEqual(await inactive.close(), { ok: true, alreadyClosed: false });
  assert.deepEqual(await inactive.close(), { ok: true, alreadyClosed: true });
});

test("Shared Space configuration is closed and rejects partial activation before publication", async () => {
  assert.deepEqual(validateSharedSpaceConfiguration({}), { enabled: false });
  assert.deepEqual(validateSharedSpaceConfiguration({ enabled: false }), { enabled: false });
  assert.throws(() => validateSharedSpaceConfiguration({ unknown: true }), /unsupported field/u);
  assert.throws(
    () => validateSharedSpaceConfiguration({ enabled: true }),
    (error) => error?.code === "shared_space_partial_configuration" || error instanceof TypeError
  );
  assert.throws(
    () => validateSharedSpaceConfiguration({ enabled: true, modules: { localDirectory: true } }),
    { code: "shared_space_partial_configuration" }
  );
  await assert.rejects(
    activatePlugin({ manifest, context: { configuration: enabledConfiguration } }),
    /opaque plugin data capability/u
  );
});

test("Shared Space activates the complete operation, route, MCP, console, state-machine, and verifier surface", async () => {
  const runtime = await activate();
  assert.equal(Object.keys(runtime.contributions.operations).length, 21);
  assert.equal(Object.keys(runtime.contributions.routes).length, 21);
  assert.equal(Object.keys(runtime.contributions.mcpTools).length, 21);
  assert.deepEqual(Object.keys(runtime.contributions.consoleEntries), ["workspaces.local-directory"]);
  assert.deepEqual(Object.keys(runtime.contributions.stateMachines), ["checkpoint.restore"]);
  assert.equal(
    runtime.contributions.consoleEntries["workspaces.local-directory"].assetPath,
    "console/index.mjs"
  );
  assert.deepEqual(
    runtime.contributions.consoleEntries["workspaces.local-directory"].toolIds,
    ["sharedspace.localDir.list", "sharedspace.localDir.connect", "sharedspace.sync.apply"]
  );
  assert.deepEqual(
    runtime.contributions.operations["sharedspace.sandbox.input.seal"].requiredHostPorts,
    ["opaqueArtifactCustody"]
  );
  assert.deepEqual(
    runtime.contributions.operations["sharedspace.sandbox.run"].requiredHostPorts,
    ["agentWorkspace", "sandboxExecution"]
  );
  assert.deepEqual(
    runtime.contributions.operations["sharedspace.localDir.connect"].hostPathInputPreprocessing,
    manifest.hostPathInputPreprocessing["sharedspace.localDir.connect"]
  );
  assert.deepEqual(
    runtime.contributions.operations["sharedspace.sandbox.input.seal"].opaqueInputPreprocessing,
    manifest.opaqueInputPreprocessing["sharedspace.sandbox.input.seal"]
  );
  assert.equal(manifest.verifierHooks[0].source, "verifiers/artifact-contract.mjs");
  assert.deepEqual(await runtime.close(), { ok: true, alreadyClosed: false });
});

test("Shared Space connects and synchronizes a local directory only through the workspace Host port", async () => {
  const runtime = await activate();
  const fixture = createHostFixture();
  const host = { agentWorkspace: fixture.agentWorkspace };
  const connected = await invoke(runtime, "sharedspace.localDir.connect", {
    workspaceId: "workspace-1",
    mountSelectionRef: "selection-1",
    targetPath: "mirror",
    deleteExtraneous: true,
    maxFiles: 20
  }, host);
  assert.equal(connected.statusCode, 201);
  assert.equal(connected.body.mount.mountRef, "mount-1");
  assert.equal(fixture.calls.connect[0].mountSelectionRef, "selection-1");
  assert.equal(JSON.stringify(fixture.calls.connect[0]).includes("sourcePath"), false);

  const synced = await invoke(runtime, "sharedspace.sync.apply", {
    workspaceId: "workspace-1",
    mountRef: "mount-1",
    targetPath: "mirror",
    deleteExtraneous: true
  }, host);
  assert.equal(synced.statusCode, 200);
  assert.equal(synced.body.syncReceipt.syncReceiptId, "sync-1");
  assert.equal(fixture.calls.sync.length, 1);
  await runtime.close();
});

test("Shared Space requires authenticated current governance before any Host side effect", async () => {
  const runtime = await activate();
  const fixture = createHostFixture();
  const operation = runtime.contributions.operations["sharedspace.localDir.connect"];
  const input = Object.freeze({
    workspaceId: "workspace-1",
    mountSelectionRef: "selection-1"
  });
  const deniedAuthorizations = [
    { authenticated: false },
    { authorized: false },
    { current: false },
    { includeCurrent: false },
    { revoked: true }
  ];

  for (const authorization of deniedAuthorizations) {
    const denied = await operation.execute({
      operation: operation.definition,
      input,
      call: authorizedCall(null, authorization),
      host: { agentWorkspace: fixture.agentWorkspace }
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.error.code, "shared_space_operation_denied");
  }
  assert.equal(fixture.calls.connect.length, 0);
  await runtime.close();
});

test("Shared Space requires an explicit workspace and protects Host-owned request fields", async () => {
  const runtime = await activate();
  const fixture = createHostFixture();
  const host = {
    agentWorkspace: fixture.agentWorkspace,
    sandboxExecution: fixture.sandboxExecution,
    opaqueArtifactCustody: Object.freeze({})
  };
  for (const operationId of Object.keys(runtime.contributions.operations)) {
    const denied = await invoke(runtime, operationId, {}, host);
    assert.equal(denied.statusCode, 400);
    assert.equal(denied.body.error.code, "shared_space_invalid_workspace");
  }
  const invalidInputs = [
    { workspaceId: "" },
    { workspaceId: "   " },
    { workspaceId: 1 },
    { workspace: "workspace-1" },
    null,
    []
  ];

  for (const input of invalidInputs) {
    const denied = await invoke(runtime, "sharedspace.localDir.connect", input, host);
    assert.equal(denied.statusCode, 400);
    assert.ok([
      "shared_space_invalid_request",
      "shared_space_invalid_workspace"
    ].includes(denied.body.error.code));
  }
  assert.equal(fixture.calls.connect.length, 0);

  const connected = await invoke(runtime, "sharedspace.localDir.connect", {
    workspaceId: "  workspace-1  ",
    mountSelectionRef: "selection-1",
    operationId: "forged-operation",
    createdBy: "forged-actor",
    actorUserId: "forged-actor",
    allowedWorkspaceIds: ["forged-workspace"],
    canAccessAll: true,
    sharingMode: "admin"
  }, host);
  assert.equal(connected.statusCode, 201);
  assert.equal(fixture.calls.connect.length, 1);
  assert.equal(fixture.calls.connect[0].workspaceId, "workspace-1");
  assert.equal(fixture.calls.connect[0].operationId, "sharedspace.localDir.connect");
  assert.equal(fixture.calls.connect[0].createdBy, "subject-1");
  assert.equal(fixture.calls.connect[0].actorUserId, "subject-1");
  assert.deepEqual(fixture.calls.connect[0].allowedWorkspaceIds, ["workspace-1"]);
  assert.equal(fixture.calls.connect[0].canAccessAll, false);
  assert.equal(fixture.calls.connect[0].sharingMode, "owner-bound");
  await runtime.close();
});

test("Shared Space snapshots immutable input and delegates run, status, cancellation, and shutdown to the sandbox Host port", async () => {
  const pluginData = memoryPluginData();
  const runtime = await activate({ pluginData });
  const fixture = createHostFixture();
  const { host, snapshot } = await snapshotAndRun(runtime, fixture);
  assert.equal(snapshot.immutable, true);
  assert.equal(snapshot.access, "read_only");
  assert.equal(fixture.calls.execute.length, 1);
  assert.deepEqual(fixture.calls.execute[0].capabilities.network, []);
  assert.equal(JSON.stringify(fixture.calls.execute[0]).includes("sourcePath"), false);
  assert.deepEqual(pluginData.inspect(), ["sandbox-state.json"]);

  const status = await invoke(runtime, "sharedspace.sandbox.status", {
    workspaceId: "workspace-1",
    runRef: "run-1"
  }, host);
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.run.status, "running");

  const cancelled = await invoke(runtime, "sharedspace.sandbox.cancel", {
    workspaceId: "workspace-1",
    runRef: "run-1",
    reason: "test_requested"
  }, host);
  assert.equal(cancelled.body.cancellation.status, "cancel_requested");
  assert.deepEqual(fixture.calls.cancel, ["run-1"]);
  assert.deepEqual(await runtime.close(), { ok: true, alreadyClosed: false });
  assert.deepEqual(fixture.calls.cancel, ["run-1"]);
});

test("Shared Space keeps unavailable bytes opaque and promotes only a digest-bound handle set", async () => {
  const runtime = await activate();
  const fixture = createHostFixture();
  const host = { sandboxExecution: fixture.sandboxExecution };
  const rejectedRaw = await invoke(runtime, "sharedspace.sandbox.input.seal", {
    workspaceId: "workspace-1",
    contentBase64: Buffer.from("synthetic").toString("base64")
  }, host);
  assert.equal(rejectedRaw.statusCode, 400);
  assert.equal(rejectedRaw.body.error.code, "shared_space_closed_contract_violation");

  const opaqueInput = Object.freeze({
    schemaVersion: "v0.0.1:plugin:opaque-input-handle-1",
    custodyRef: "custody:opaque-1",
    contentDigest: sha("synthetic-opaque-content"),
    envelopeDigest: sha("synthetic-opaque-envelope"),
    byteCount: 9
  });
  const sealed = await invoke(runtime, "sharedspace.sandbox.input.seal", {
    workspaceId: "workspace-1",
    opaqueInput
  }, { opaqueArtifactCustody: Object.freeze({}) });
  assert.equal(sealed.statusCode, 201);
  assert.equal(sealed.body.artifact.plaintextAvailable, false);

  const opaqueFile = Object.freeze({
    path: "input.bin",
    custodyRef: opaqueInput.custodyRef,
    digest: opaqueInput.contentDigest,
    envelopeDigest: opaqueInput.envelopeDigest
  });
  const inputDigest = sandboxDigest([{ path: opaqueFile.path, digest: opaqueFile.digest }]);
  const promotionDigest = custodyPromotionSetDigest({
    files: [{
      ...opaqueFile,
      contentDigest: opaqueFile.digest,
      promotionSchemaVersion: "v0.0.1:execution-sandbox:opaque-custody-promotion-1"
    }]
  });
  const baseRun = runInput({ snapshotHandle: "unused", snapshotDigest: inputDigest });
  const { snapshotHandle: _snapshotHandle, snapshotDigest: _snapshotDigest, ...opaqueRunFields } = baseRun;
  const run = await invoke(runtime, "sharedspace.sandbox.runOpaque", {
    ...opaqueRunFields,
    inputDigest,
    promotionDigest,
    opaqueInputs: [opaqueFile]
  }, host);
  assert.equal(run.statusCode, 202);
  assert.equal(run.body.promotion.explicit, true);
  assert.equal(fixture.calls.executeOpaque.length, 1);
  assert.equal(JSON.stringify(fixture.calls.executeOpaque[0]).includes("contentBase64"), false);
  await runtime.close();
});

test("Shared Space previews, separately approves, and atomically commits quarantined output", async () => {
  const runtime = await activate();
  const fixture = createHostFixture();
  const { host } = await snapshotAndRun(runtime, fixture);
  const preview = await invoke(runtime, "sharedspace.output.preview", {
    workspaceId: "workspace-1",
    runRef: "run-1",
    targetPath: "generated"
  }, host);
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.body.proposal.status, "previewed");

  const proposal = preview.body.proposal;
  const proposalInput = {
    workspaceId: proposal.workspaceId,
    proposalRef: proposal.proposalRef,
    previewDigest: proposal.previewDigest,
    outputDigest: proposal.outputDigest,
    policyDigest: proposal.policyDigest
  };
  const premature = await invoke(runtime, "sharedspace.output.commit", proposalInput, host);
  assert.equal(premature.statusCode, 403);
  assert.equal(premature.body.error.code, "shared_space_output_approval_required");

  const approved = await invoke(
    runtime,
    "sharedspace.output.approve",
    proposalInput,
    host,
    approvalRecord("sharedspace.output.approve", proposal, "approval-1")
  );
  assert.equal(approved.body.proposal.status, "approved");
  const committed = await invoke(
    runtime,
    "sharedspace.output.commit",
    proposalInput,
    host,
    approvalRecord("sharedspace.output.commit", proposal, "approval-2")
  );
  assert.equal(committed.statusCode, 200);
  assert.equal(committed.body.proposal.status, "committed");
  assert.equal(committed.body.commit.mutationReceipt.stateCommitId, "commit-1");
  assert.deepEqual(fixture.calls.dispose, [{ outputHandle: "output-1", disposition: "committed" }]);
  assert.equal(fixture.calls.restore.length, 2);
  await runtime.close();
});

test("Shared Space records compensation when a reversible output mutation fails", async () => {
  const runtime = await activate();
  const fixture = createHostFixture({ compensateCommit: true });
  const { host } = await snapshotAndRun(runtime, fixture);
  const preview = await invoke(runtime, "sharedspace.output.preview", {
    workspaceId: "workspace-1",
    runRef: "run-1"
  }, host);
  const proposal = preview.body.proposal;
  const proposalInput = {
    workspaceId: proposal.workspaceId,
    proposalRef: proposal.proposalRef,
    previewDigest: proposal.previewDigest,
    outputDigest: proposal.outputDigest,
    policyDigest: proposal.policyDigest
  };
  await invoke(
    runtime,
    "sharedspace.output.approve",
    proposalInput,
    host,
    approvalRecord("sharedspace.output.approve", proposal, "approval-1")
  );
  const compensated = await invoke(
    runtime,
    "sharedspace.output.commit",
    proposalInput,
    host,
    approvalRecord("sharedspace.output.commit", proposal, "approval-2")
  );
  assert.equal(compensated.statusCode, 409);
  assert.equal(compensated.body.proposal.status, "compensated");
  assert.equal(compensated.body.proposal.disposition, "compensated");
  assert.deepEqual(fixture.calls.dispose, [{ outputHandle: "output-1", disposition: "compensated" }]);
  await runtime.close();
});

test("Shared Space checkpoint restore definition enforces preview, approval, marker, and terminal ordering", async () => {
  const runtime = await activate();
  const definition = runtime.contributions.stateMachines["checkpoint.restore"].definition;
  assert.equal(definition.machineId, "checkpoint.restore");
  assert.equal(definition.initialState, "restore_requested");
  assert.equal(definition.states.length, 9);
  assert.equal(definition.events.length, 9);
  assert.equal(definition.totalMatrix.length, 81);

  function transition(state, event) {
    const cell = definition.totalMatrix.find((entry) => entry.from === state && entry.event === event);
    assert.ok(cell);
    if (cell.result === "legal_transition") return cell.to;
    if (cell.result === "ignored_idempotent_event") return state;
    throw Object.assign(new Error("transition rejected"), { code: cell.errorCode });
  }

  let state = definition.initialState;
  state = transition(state, "restore.generate_preview");
  state = transition(state, "restore.approval_request");
  state = transition(state, "restore.approve");
  state = transition(state, "restore.record_marker");
  state = transition(state, "restore.complete");
  assert.equal(state, "completed");
  assert.throws(
    () => transition("restore_requested", "restore.record_marker"),
    { code: "RESTORE_PREVIEW_NOT_GENERATED" }
  );
  const markerCell = definition.totalMatrix.find(
    (entry) => entry.from === "approved" && entry.event === "restore.record_marker"
  );
  assert.ok(markerCell.guards.includes("appendOnly"));
  assert.ok(markerCell.guards.includes("approvalApproved"));
  await runtime.close();
});

test("Shared Space rejects traversal and excessive sandbox capabilities before calling Host ports", async () => {
  const runtime = await activate();
  const fixture = createHostFixture();
  const host = { agentWorkspace: fixture.agentWorkspace, sandboxExecution: fixture.sandboxExecution };
  const escaped = await invoke(runtime, "sharedspace.snapshot.create", {
    workspaceId: "workspace-1",
    entries: [{ path: "../escape.txt" }]
  }, host);
  assert.equal(escaped.statusCode, 400);
  assert.equal(escaped.body.error.code, "shared_space_invalid_path");
  assert.equal(fixture.calls.execute.length, 0);

  const snapshotResponse = await invoke(runtime, "sharedspace.snapshot.create", {
    workspaceId: "workspace-1",
    entries: [{ path: "input.txt" }]
  }, host);
  const denied = await invoke(runtime, "sharedspace.sandbox.run", runInput(snapshotResponse.body.snapshot, {
    capabilities: {
      filesystem: ["input:read", "output:write", "host:read"],
      network: ["raw"],
      tools: [],
      secretRefs: [],
      clock: false,
      randomness: false,
      subprocesses: 1
    }
  }), host);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.error.code, "shared_space_capability_denied");
  assert.equal(fixture.calls.execute.length, 0);
  await runtime.close();
});

test("Shared Space fails closed on unavailable or faulting Host capabilities without exposing Host messages", async () => {
  const runtime = await activate();
  const missing = await invoke(runtime, "sharedspace.localDir.connect", {
    workspaceId: "workspace-1",
    mountSelectionRef: "selection-1"
  });
  assert.equal(missing.statusCode, 503);

  const faultingHost = {
    agentWorkspace: {
      async connectLocalDirectory() {
        throw Object.assign(new Error("synthetic private location must remain hidden"), {
          code: "workspace_host_failed",
          status: 409
        });
      }
    }
  };
  const failed = await invoke(runtime, "sharedspace.localDir.connect", {
    workspaceId: "workspace-1",
    mountSelectionRef: "selection-1"
  }, faultingHost);
  assert.equal(failed.statusCode, 409);
  assert.equal(failed.body.error.code, "workspace_host_failed");
  assert.equal(JSON.stringify(failed).includes("synthetic private location"), false);
  await runtime.close();
});
