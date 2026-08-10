import crypto from "node:crypto";
import path from "node:path";

import { custodyPromotionSetDigest, sandboxDigest } from "./sandbox-contracts.mjs";

import {
  canonicalDigest,
  contentDigest,
  createSandboxStateStore
} from "./sandbox-state-store.mjs";

const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const IRREVERSIBLE_ACTOR_REF = /^hmac-sha256:[a-f0-9]{64}$/u;
const PROPOSAL_TRANSITIONS = Object.freeze({
  preview_required: new Set(["previewed"]),
  previewed: new Set(["approved", "rejected"]),
  approved: new Set(["committing", "rejected"]),
  commit_failed: new Set(["previewed"]),
  committing: new Set(["committed", "commit_failed", "compensated", "output_cleanup_failed"]),
  committed: new Set(),
  compensated: new Set(["output_cleanup_failed"]),
  output_cleanup_failed: new Set(),
  rejected: new Set()
});

function result(status, payload) {
  return { status, payload };
}

function fail(status, code, message) {
  return result(status, { ok: false, error: { code, message } });
}

function requireMethod(source, name, unavailableCode) {
  if (!source || typeof source[name] !== "function") {
    const error = new Error(`${name} is unavailable.`);
    error.code = unavailableCode;
    error.status = 503;
    throw error;
  }
  return source[name].bind(source);
}

function assertClosedObject(value, allowedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error(`${label} must be an object.`), { code: "shared_space_invalid_request", status: 400 });
  }
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw Object.assign(new Error(`${label} contains unsupported fields.`), { code: "shared_space_closed_contract_violation", status: 400 });
  }
  return value;
}

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw Object.assign(new Error(`${label} is required.`), { code: "shared_space_invalid_request", status: 400 });
  return normalized;
}

function requiredDigest(value, label) {
  const digest = requiredString(value, label).toLowerCase();
  if (!HEX_DIGEST.test(digest)) {
    throw Object.assign(new Error(`${label} must be a SHA-256 digest.`), { code: "shared_space_invalid_digest", status: 400 });
  }
  return digest;
}

function boundedInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw Object.assign(new Error(`${label} is outside the supported range.`), { code: "shared_space_invalid_budget", status: 400 });
  }
  return parsed;
}

function normalizeLogicalPath(value) {
  const normalized = path.posix.normalize(requiredString(value, "path").replace(/\\/gu, "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized.startsWith("/") || normalized.includes("/../")) {
    throw Object.assign(new Error("path must remain inside the logical snapshot root."), { code: "shared_space_invalid_path", status: 400 });
  }
  return normalized;
}

function contentFromRead(read) {
  const encoded = requiredString(read?.contentBase64, "snapshot file content");
  return Buffer.from(encoded, "base64");
}

function publicSnapshot(snapshot) {
  return {
    snapshotHandle: snapshot.snapshotHandle,
    snapshotDigest: snapshot.snapshotDigest,
    workspaceId: snapshot.workspaceId,
    entryCount: snapshot.entries.length,
    totalBytes: snapshot.totalBytes,
    immutable: true,
    access: "read_only"
  };
}

function publicProposal(proposal) {
  return {
    proposalRef: proposal.proposalRef,
    runRef: proposal.runRef,
    workspaceId: proposal.workspaceId,
    targetPath: proposal.targetPath,
    status: proposal.status,
    previewDigest: proposal.previewDigest || "",
    outputDigest: proposal.outputDigest,
    policyDigest: proposal.sandboxBindings?.policyDigest || "",
    approvalRef: proposal.approvalRef || "",
    commitApprovalRef: proposal.commitApprovalRef || "",
    mutationReceiptDigest: proposal.mutationReceiptDigest || "",
    disposition: proposal.disposition || "pending"
  };
}

function currentBoundApproval(context, expected) {
  const approval = context.approvalRecord;
  const binding = approval?.binding;
  const expiresAtMs = Date.parse(String(approval?.expiresAt || ""));
  if (
    approval?.status !== "approved" ||
    approval?.current !== true ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= Date.now()
  ) {
    return { ok: false, response: fail(403, "shared_space_current_approval_required", "A current bound approval is required.") };
  }
  if (
    String(approval.operationId || "") !== expected.operationId ||
    String(binding?.workspaceId || "") !== expected.workspaceId ||
    String(binding?.proposalRef || "") !== expected.proposalRef ||
    String(binding?.previewDigest || "") !== expected.previewDigest ||
    String(binding?.outputDigest || "") !== expected.outputDigest ||
    String(binding?.policyDigest || "") !== expected.policyDigest ||
    !HEX_DIGEST.test(String(binding?.bindingDigest || ""))
  ) {
    return { ok: false, response: fail(409, "shared_space_approval_binding_stale", "The approval does not match the current output proposal binding.") };
  }
  const approvalRef = String(approval.approvalRef || "").trim();
  const actorRef = String(approval.actorRef || "").trim();
  if (!approvalRef || !IRREVERSIBLE_ACTOR_REF.test(actorRef)) {
    return { ok: false, response: fail(403, "shared_space_current_approval_required", "A current bound approval is required.") };
  }
  const policyRevision = binding.policyRevision && typeof binding.policyRevision === "object"
    ? binding.policyRevision
    : {};
  return {
    ok: true,
    approvalRef,
    actorRef,
    bindingDigest: binding.bindingDigest,
    policyRevisionDigest: canonicalDigest(policyRevision),
    evidenceDigest: canonicalDigest({
      approvalRef,
      actorRef,
      operationId: approval.operationId,
      expiresAt: approval.expiresAt,
      bindingDigest: binding.bindingDigest,
      policyRevision
    })
  };
}

function publicRun(run = {}, fallbackRunRef = "") {
  return {
    runRef: firstSafeString(run.runId, run.runRef, fallbackRunRef),
    status: firstSafeString(run.status, "unknown"),
    receiptRef: firstSafeString(run.receiptRef)
  };
}

async function quarantinedOutputFiles(sandboxExecution, receipt, proposal) {
  const resolveOutput = requireMethod(sandboxExecution, "resolveQuarantinedOutput", "shared_space_output_unavailable");
  const resolved = await resolveOutput(requiredString(receipt.outputHandle, "sandbox outputHandle"));
  if (!resolved?.output || !Array.isArray(resolved.output.files) || typeof resolved.readFile !== "function") {
    throw Object.assign(new Error("Quarantined sandbox output is unavailable."), { code: "shared_space_output_unavailable", status: 409 });
  }
  const manifest = resolved.output.files.map((file) => ({
    path: normalizeLogicalPath(file.path),
    digest: requiredDigest(file.digest, "output file digest")
  })).sort((left, right) => left.path.localeCompare(right.path));
  if (sandboxDigest(manifest) !== proposal.outputDigest || resolved.output.digest !== proposal.outputDigest) {
    throw Object.assign(new Error("Sandbox output manifest changed after preview."), { code: "shared_space_output_digest_mismatch", status: 409 });
  }
  const files = [];
  for (const file of manifest) {
    const content = await resolved.readFile(file.path);
    if (contentDigest(content) !== file.digest) {
      throw Object.assign(new Error("Sandbox output content changed after quarantine."), { code: "shared_space_output_digest_mismatch", status: 409 });
    }
    files.push({ path: file.path, contentBase64: Buffer.from(content).toString("base64"), contentSha256: file.digest, encoding: "base64" });
  }
  return files;
}

function firstSafeString(...values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized.slice(0, 256);
  }
  return "";
}

function normalizeReadEntries(input) {
  assertClosedObject(input, new Set(["workspaceId", "entries"]), "snapshot request");
  const workspaceId = requiredString(input.workspaceId, "workspaceId");
  if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > 100) {
    throw Object.assign(new Error("entries must contain between 1 and 100 files."), { code: "shared_space_invalid_snapshot", status: 400 });
  }
  const entries = input.entries.map((entry) => {
    assertClosedObject(entry, new Set(["path", "mountRef"]), "snapshot entry");
    return {
      logicalPath: normalizeLogicalPath(entry.path),
      mountRef: String(entry.mountRef || "").trim()
    };
  });
  if (new Set(entries.map((entry) => entry.logicalPath)).size !== entries.length) {
    throw Object.assign(new Error("snapshot entry paths must be unique."), { code: "shared_space_invalid_snapshot", status: 400 });
  }
  return { workspaceId, entries };
}

async function readSnapshotEntry(agentWorkspace, workspaceId, entry, operationId) {
  const methodName = entry.mountRef ? "readLocalDirectoryFile" : "downloadWorkspaceFile";
  const readFile = requireMethod(agentWorkspace, methodName, "shared_space_snapshot_reader_unavailable");
  const read = await readFile({
    workspaceId,
    ...(entry.mountRef ? { mountRef: entry.mountRef } : {}),
    path: entry.logicalPath,
    includeText: false,
    includeHash: true,
    operationId
  });
  if (!read?.ok) {
    throw Object.assign(new Error("Snapshot input could not be read."), {
      code: "shared_space_snapshot_read_failed",
      status: Number(read?.status || 409)
    });
  }
  const content = contentFromRead(read);
  return {
    logicalPath: entry.logicalPath,
    mountRef: entry.mountRef,
    contentSha256: contentDigest(content),
    sizeBytes: content.byteLength,
    content
  };
}

function snapshotIdentity(entries) {
  return sandboxDigest(entries
    .map(({ logicalPath, contentSha256 }) => ({ path: logicalPath, digest: contentSha256 }))
    .sort((left, right) => left.path.localeCompare(right.path)));
}

function normalizeRunRequest(input) {
  assertClosedObject(input, new Set([
    "workspaceId", "snapshotHandle", "snapshotDigest", "workloadKind", "workloadDigest", "runtimeKind", "entryPoint",
    "arguments", "workingDirectory", "outputs", "capabilities", "resources", "idempotencyKey", "deadlineAt"
  ]), "sandbox run request");
  const capabilities = assertClosedObject(input.capabilities, new Set([
    "filesystem", "network", "tools", "secretRefs", "clock", "randomness", "subprocesses"
  ]), "capabilities");
  const filesystem = Array.isArray(capabilities.filesystem) ? capabilities.filesystem.map(String) : [];
  const network = Array.isArray(capabilities.network) ? capabilities.network.map(String) : [];
  const tools = Array.isArray(capabilities.tools) ? capabilities.tools.map(String) : [];
  const secretRefs = Array.isArray(capabilities.secretRefs) ? capabilities.secretRefs.map(String) : [];
  if (!filesystem.includes("input:read") || !filesystem.includes("output:write") || network.length > 0 || tools.length > 0 || secretRefs.length > 0 || Number(capabilities.subprocesses || 0) !== 0) {
    throw Object.assign(new Error("Requested capabilities exceed the Shared Space execution profile."), {
      code: "shared_space_capability_denied",
      status: 403
    });
  }
  if (typeof capabilities.clock !== "boolean" || typeof capabilities.randomness !== "boolean") {
    throw Object.assign(new Error("clock and randomness capabilities must be explicit booleans."), {
      code: "shared_space_invalid_request",
      status: 400
    });
  }
  const resources = assertClosedObject(input.resources, new Set([
    "wallTimeMs", "cpuMillis", "memoryBytes", "processes", "fileDescriptors", "diskBytes", "inodes",
    "fileCount", "outputBytes", "logBytes", "networkBytes", "toolCalls"
  ]), "budget");
  const outputs = assertClosedObject(input.outputs, new Set(["schema", "maxFiles", "maxBytes", "allowedTypes"]), "outputs");
  const allowedTypes = Array.isArray(outputs.allowedTypes)
    ? outputs.allowedTypes.map((value) => String(value || "").trim().toLowerCase())
    : [];
  if (allowedTypes.length < 1 || allowedTypes.length > 32 || allowedTypes.some((value) => !/^[a-z0-9_-]{1,16}$/u.test(value))) {
    throw Object.assign(new Error("allowedTypes must be a bounded explicit type list without dots."), { code: "shared_space_invalid_output_policy", status: 400 });
  }
  const args = Array.isArray(input.arguments) ? input.arguments.map((value) => String(value)) : [];
  if (args.length > 64 || args.some((value) => value.length > 4096 || value.includes("\0"))) {
    throw Object.assign(new Error("arguments exceed the closed invocation limits."), { code: "shared_space_invalid_request", status: 400 });
  }
  const deadlineAt = requiredString(input.deadlineAt, "deadlineAt");
  if (!Number.isFinite(Date.parse(deadlineAt)) || Date.parse(deadlineAt) <= Date.now()) {
    throw Object.assign(new Error("deadlineAt must be a future timestamp."), { code: "shared_space_invalid_deadline", status: 400 });
  }
  return {
    workspaceId: requiredString(input.workspaceId, "workspaceId"),
    snapshotHandle: requiredString(input.snapshotHandle, "snapshotHandle"),
    snapshotDigest: requiredDigest(input.snapshotDigest, "snapshotDigest"),
    workloadKind: requiredString(input.workloadKind, "workloadKind"),
    workloadDigest: requiredDigest(input.workloadDigest, "workloadDigest"),
    runtimeKind: requiredString(input.runtimeKind, "runtimeKind"),
    entryPoint: normalizeLogicalPath(input.entryPoint),
    arguments: args,
    workingDirectory: normalizeLogicalPath(input.workingDirectory || "work"),
    capabilities: { filesystem, network, tools, secretRefs, clock: capabilities.clock === true, randomness: capabilities.randomness === true, subprocesses: 0 },
    resources: {
      wallTimeMs: boundedInteger(resources.wallTimeMs, "wallTimeMs", 1, 3_600_000),
      cpuMillis: boundedInteger(resources.cpuMillis, "cpuMillis", 1, 3_600_000),
      memoryBytes: boundedInteger(resources.memoryBytes, "memoryBytes", 1, 16 * 1024 * 1024 * 1024),
      processes: boundedInteger(resources.processes, "processes", 1, 256),
      fileDescriptors: boundedInteger(resources.fileDescriptors, "fileDescriptors", 1, 65_536),
      diskBytes: boundedInteger(resources.diskBytes, "diskBytes", 1, 1024 * 1024 * 1024),
      inodes: boundedInteger(resources.inodes, "inodes", 1, 100_000),
      fileCount: boundedInteger(resources.fileCount, "fileCount", 1, 100_000),
      outputBytes: boundedInteger(resources.outputBytes, "outputBytes", 1, 1024 * 1024 * 1024),
      logBytes: boundedInteger(resources.logBytes, "logBytes", 1, 16 * 1024 * 1024),
      networkBytes: boundedInteger(resources.networkBytes, "networkBytes", 1, 1024 * 1024 * 1024),
      toolCalls: boundedInteger(resources.toolCalls, "toolCalls", 1, 100_000)
    },
    outputs: {
      schema: requiredString(outputs.schema, "outputs.schema"),
      maxFiles: boundedInteger(outputs.maxFiles, "maxFiles", 1, 10_000),
      maxBytes: boundedInteger(outputs.maxBytes, "maxBytes", 1, 1024 * 1024 * 1024),
      allowedTypes
    },
    idempotencyKey: requiredString(input.idempotencyKey, "idempotencyKey"),
    deadlineAt: new Date(Date.parse(deadlineAt)).toISOString()
  };
}

function assertTerminalReceipt(receipt) {
  if (!receipt || receipt.status !== "output_quarantined" || receipt.runtimeState !== "succeeded" || receipt.cleanupState !== "destroyed" || receipt.outputDisposition !== "quarantined") {
    throw Object.assign(new Error("Sandbox output is unavailable until successful execution and cleanup are final."), {
      code: "shared_space_sandbox_not_clean",
      status: 409
    });
  }
  const outputDigest = requiredDigest(receipt.outputDigest, "sandbox outputDigest");
  return outputDigest;
}

function sandboxReceiptBindings(receipt, runRef, outputDigest) {
  const artifactDigest = requiredDigest(receipt.artifactDigest, "sandbox artifactDigest");
  const policyDigest = requiredDigest(receipt.policyDigest, "sandbox policyDigest");
  const inputDigest = receipt.inputDigest
    ? requiredDigest(receipt.inputDigest, "sandbox inputDigest")
    : sandboxDigest((receipt.inputDigests || []).map((digest) => requiredDigest(digest, "sandbox input digest")));
  return Object.freeze({
    runRef: requiredString(runRef, "sandbox runRef"),
    artifactDigest,
    policyDigest,
    inputDigest,
    outputDigest,
    terminalDigest: canonicalDigest({ status: receipt.status, runtimeState: receipt.runtimeState, finishedAt: receipt.finishedAt || "" }),
    destructionDigest: canonicalDigest({ cleanupState: receipt.cleanupState, runRef }),
    cleanupDigest: canonicalDigest({ cleanupState: receipt.cleanupState, outputDisposition: receipt.outputDisposition }),
    dispositionDigest: canonicalDigest({ outputDigest, outputDisposition: receipt.outputDisposition })
  });
}

export function createSharedSpaceSandboxExecution({ pluginData } = {}) {
  const store = createSandboxStateStore({ pluginData });
  const activeRuns = new Map();

  async function createSnapshot(input, context) {
    const normalized = normalizeReadEntries(input);
    const files = [];
    for (const entry of normalized.entries) {
      files.push(await readSnapshotEntry(context.agentWorkspace, normalized.workspaceId, entry, "sharedspace.snapshot.create"));
    }
    const snapshotDigest = snapshotIdentity(files);
    const snapshot = {
      snapshotHandle: `snapshot_${crypto.randomUUID()}`,
      snapshotDigest,
      workspaceId: normalized.workspaceId,
      entries: files.map(({ content, ...entry }) => entry),
      totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
      createdAt: new Date().toISOString()
    };
    await store.insertSnapshot(snapshot);
    return result(201, { ok: true, snapshot: publicSnapshot(snapshot) });
  }

  async function sealOpaqueInput(input, context) {
    assertClosedObject(input, new Set(["workspaceId", "opaqueInput"]), "opaque input seal request");
    requiredString(input.workspaceId, "workspaceId");
    const stored = input.opaqueInput;
    assertClosedObject(stored, new Set([
      "schemaVersion", "custodyRef", "contentDigest", "envelopeDigest", "byteCount"
    ]), "opaque input receipt");
    if (stored.schemaVersion !== "v0.0.1:plugin:opaque-input-handle-1") {
      throw new Error("Opaque input receipt schema is invalid.");
    }
    return result(201, {
      ok: true,
      artifact: {
        custodyRef: requiredString(stored.custodyRef, "custody handle"),
        contentDigest: requiredDigest(stored.contentDigest, "custody contentDigest"),
        envelopeDigest: requiredDigest(stored.envelopeDigest, "custody envelopeDigest"),
        byteCount: boundedInteger(stored.byteCount, "custody byteCount", 1, 256 * 1024 * 1024),
        state: "blocked_no_run",
        plaintextAvailable: false,
        automaticPromotion: false
      }
    });
  }

  async function runOpaque(input, context) {
    assertClosedObject(input, new Set([
      "workspaceId", "inputDigest", "promotionDigest", "opaqueInputs", "workloadKind", "workloadDigest", "runtimeKind", "entryPoint",
      "arguments", "workingDirectory", "outputs", "capabilities", "resources", "idempotencyKey", "deadlineAt"
    ]), "opaque sandbox run request");
    const opaqueInputs = Array.isArray(input.opaqueInputs) ? input.opaqueInputs.map((entry) => {
      assertClosedObject(entry, new Set(["path", "custodyRef", "digest", "envelopeDigest"]), "opaque sandbox input");
      return {
        path: normalizeLogicalPath(entry.path),
        custodyRef: requiredString(entry.custodyRef, "custodyRef"),
        digest: requiredDigest(entry.digest, "opaque input digest"),
        envelopeDigest: requiredDigest(entry.envelopeDigest, "opaque envelope digest"),
        promotionSchemaVersion: "v0.0.1:execution-sandbox:opaque-custody-promotion-1"
      };
    }) : [];
    if (opaqueInputs.length < 1 || opaqueInputs.length > 100) {
      return fail(400, "shared_space_invalid_request", "opaqueInputs must contain between one and one hundred entries.");
    }
    const { opaqueInputs: _opaqueInputs, inputDigest: _inputDigest, promotionDigest: _promotionDigest, ...runFields } = input;
    const inputDigest = requiredDigest(input.inputDigest, "inputDigest");
    const calculatedInputDigest = sandboxDigest(opaqueInputs.map(({ path: inputPath, digest }) => ({ path: inputPath, digest }))
      .sort((left, right) => left.path.localeCompare(right.path)));
    if (inputDigest !== calculatedInputDigest) {
      return fail(409, "shared_space_opaque_input_digest_mismatch", "Opaque input content set does not match inputDigest.");
    }
    const request = normalizeRunRequest({
      ...runFields,
      snapshotHandle: `opaque:${inputDigest}`,
      snapshotDigest: inputDigest
    });
    const principal = context.authSession?.user || {};
    const ownerBinding = {
      subjectRef: requiredString(principal.subjectId || principal.userId, "principal.subjectRef"),
      tenantRef: requiredString(principal.tenantId || context.authSession?.tenantRef, "principal.tenantRef"),
      workspaceRef: request.workspaceId
    };
    const promotionDigest = custodyPromotionSetDigest({
      files: opaqueInputs.map((file) => ({
        path: file.path,
        custodyRef: file.custodyRef,
        contentDigest: file.digest,
        envelopeDigest: file.envelopeDigest,
        promotionSchemaVersion: file.promotionSchemaVersion
      }))
    });
    if (promotionDigest !== requiredDigest(input.promotionDigest, "promotionDigest")) {
      return fail(409, "shared_space_opaque_promotion_digest_mismatch", "Opaque input promotion set does not match promotionDigest.");
    }
    const executeOpaque = requireMethod(context.sandboxExecution, "executeOpaque", "shared_space_sandbox_unavailable");
    const execution = await executeOpaque({
      schemaVersion: "v0.0.1:execution-sandbox:request-1",
      workloadKind: request.workloadKind,
      principal: {
        ...ownerBinding,
        operationRef: "sharedspace.sandbox.runOpaque"
      },
      artifact: { digest: request.workloadDigest, runtimeKind: request.runtimeKind, entryPoint: request.entryPoint },
      invocation: { args: request.arguments, workingDirectory: request.workingDirectory },
      inputs: [{ handle: request.snapshotHandle, digest: inputDigest, readOnly: true }],
      outputs: request.outputs,
      capabilities: request.capabilities,
      resources: request.resources,
      idempotencyKey: request.idempotencyKey,
      deadlineAt: request.deadlineAt
    }, [{ handle: request.snapshotHandle, promotionDigest, files: opaqueInputs }]);
    const projected = publicRun(execution);
    if (projected.runRef) activeRuns.set(projected.runRef, { sandboxExecution: context.sandboxExecution, workspaceId: request.workspaceId });
    return result(202, { ok: true, run: projected, promotion: { explicit: true, inputDigest, promotionDigest } });
  }

  async function run(input, context) {
    const request = normalizeRunRequest(input);
    const snapshot = await store.getSnapshot(request.snapshotHandle);
    if (!snapshot || snapshot.workspaceId !== request.workspaceId || snapshot.snapshotDigest !== request.snapshotDigest) {
      return fail(409, "shared_space_snapshot_identity_mismatch", "Snapshot identity is missing or stale.");
    }
    const execute = requireMethod(context.sandboxExecution, "execute", "shared_space_sandbox_unavailable");
    const principal = context.authSession?.user || {};
    const execution = await execute({
      schemaVersion: "v0.0.1:execution-sandbox:request-1",
      workloadKind: request.workloadKind,
      principal: {
        subjectRef: requiredString(principal.subjectId || principal.userId, "principal.subjectRef"),
        tenantRef: requiredString(principal.tenantId || context.authSession?.tenantRef, "principal.tenantRef"),
        workspaceRef: request.workspaceId,
        operationRef: "sharedspace.sandbox.run"
      },
      artifact: { digest: request.workloadDigest, runtimeKind: request.runtimeKind, entryPoint: request.entryPoint },
      invocation: { args: request.arguments, workingDirectory: request.workingDirectory },
      inputs: [{ handle: request.snapshotHandle, digest: request.snapshotDigest, readOnly: true }],
      outputs: request.outputs,
      capabilities: request.capabilities,
      resources: request.resources,
      idempotencyKey: request.idempotencyKey,
      deadlineAt: request.deadlineAt
    }, async ({ handle, digest } = {}) => {
      if (handle !== request.snapshotHandle || digest !== request.snapshotDigest) {
        throw Object.assign(new Error("Snapshot handle or digest changed after admission."), { code: "shared_space_snapshot_identity_mismatch" });
      }
      const current = await store.getSnapshot(request.snapshotHandle);
      if (!current || current.snapshotDigest !== request.snapshotDigest) {
        throw Object.assign(new Error("Snapshot identity changed before input resolution."), { code: "shared_space_snapshot_identity_mismatch" });
      }
      const files = [];
      for (const entry of current.entries) {
        const read = await readSnapshotEntry(context.agentWorkspace, current.workspaceId, entry, "sharedspace.sandbox.run.resolve_input");
        if (read.contentSha256 !== entry.contentSha256 || read.sizeBytes !== entry.sizeBytes) {
          throw Object.assign(new Error("Snapshot content changed before sandbox staging."), { code: "shared_space_snapshot_content_changed" });
        }
        files.push({ path: entry.logicalPath, content: read.content, digest: read.contentSha256 });
      }
      if (sandboxDigest(files.map(({ path: filePath, digest: fileDigest }) => ({ path: filePath, digest: fileDigest }))) !== request.snapshotDigest) {
        throw Object.assign(new Error("Snapshot digest could not be revalidated."), { code: "shared_space_snapshot_digest_mismatch" });
      }
      return { digest: request.snapshotDigest, files };
    });
    const projected = publicRun(execution);
    if (projected.runRef) activeRuns.set(projected.runRef, { sandboxExecution: context.sandboxExecution, workspaceId: request.workspaceId });
    return result(202, { ok: true, run: projected });
  }

  async function cancel(input, context) {
    assertClosedObject(input, new Set(["workspaceId", "runRef", "reason"]), "sandbox cancel request");
    const cancelRun = requireMethod(context.sandboxExecution, "cancel", "shared_space_sandbox_unavailable");
    const cancellation = await cancelRun(requiredString(input.runRef, "runRef"), {
      workspaceId: requiredString(input.workspaceId, "workspaceId"),
      reason: String(input.reason || "user_requested").slice(0, 128)
    });
    activeRuns.delete(String(input.runRef || ""));
    return result(200, { ok: true, cancellation: publicRun(cancellation, input.runRef) });
  }

  async function status(input, context) {
    assertClosedObject(input, new Set(["workspaceId", "runRef"]), "sandbox status request");
    const getStatus = requireMethod(context.sandboxExecution, "getStatus", "shared_space_sandbox_unavailable");
    const runStatus = await getStatus(requiredString(input.runRef, "runRef"), {
      workspaceId: requiredString(input.workspaceId, "workspaceId")
    });
    if (["output_quarantined", "succeeded", "failed", "timed_out", "cancelled", "rejected", "compensated"].includes(String(runStatus?.status || ""))) {
      activeRuns.delete(String(input.runRef || ""));
    }
    return result(200, { ok: true, run: publicRun(runStatus, input.runRef) });
  }

  async function transitionProposal(proposal, nextStatus, update = {}) {
    if (!PROPOSAL_TRANSITIONS[proposal.status]?.has(nextStatus)) {
      throw Object.assign(new Error("Output proposal lifecycle transition is not allowed."), { code: "shared_space_proposal_transition_denied", status: 409 });
    }
    return store.updateProposal(
      proposal.proposalRef,
      { ...update, status: nextStatus },
      { expectedStatus: proposal.status }
    );
  }

  async function preview(input, context) {
    assertClosedObject(input, new Set(["workspaceId", "runRef", "targetPath", "proposalRef"]), "output preview request");
    const workspaceId = requiredString(input.workspaceId, "workspaceId");
    const runRef = requiredString(input.runRef, "runRef");
    const getReceipt = requireMethod(context.sandboxExecution, "getReceipt", "shared_space_sandbox_unavailable");
    const receipt = await getReceipt(runRef, { workspaceId });
    const outputDigest = assertTerminalReceipt(receipt);
    const sandboxBindings = sandboxReceiptBindings(receipt, runRef, outputDigest);
    activeRuns.delete(runRef);
    let proposal = input.proposalRef ? await store.getProposal(input.proposalRef) : null;
    if (!proposal) {
      proposal = await store.insertProposal({
        proposalRef: `proposal_${crypto.randomUUID()}`,
        runRef,
        workspaceId,
        targetPath: input.targetPath ? normalizeLogicalPath(input.targetPath) : "",
        status: "preview_required",
        outputDigest,
        outputHandle: requiredString(receipt.outputHandle, "sandbox outputHandle"),
        sandboxBindings,
        sandboxReceiptDigest: canonicalDigest(sandboxBindings),
        approvalRef: "",
        disposition: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }
    if (proposal.runRef !== runRef || proposal.workspaceId !== workspaceId || proposal.outputDigest !== outputDigest) {
      return fail(409, "shared_space_proposal_identity_mismatch", "Proposal identity does not match the sandbox receipt.");
    }
    const files = await quarantinedOutputFiles(context.sandboxExecution, receipt, proposal);
    const restoreWorkspaceFiles = requireMethod(context.agentWorkspace, "restoreWorkspaceFiles", "shared_space_output_preview_unavailable");
    const hostPreview = await restoreWorkspaceFiles({
      workspaceId,
      operationId: "sharedspace.output.preview",
      dryRun: true,
      preview: true,
      snapshot: { basePath: proposal.targetPath, deleteExtraneous: false, files },
      proposalRef: proposal.proposalRef,
      sandboxReceiptDigest: proposal.sandboxReceiptDigest,
      sandboxBindings: proposal.sandboxBindings
    });
    if (!hostPreview?.ok || hostPreview.dryRun !== true) {
      return fail(Number(hostPreview?.status || 409), "shared_space_output_preview_failed", "Host-side output preview failed.");
    }
    proposal = await transitionProposal(proposal, "previewed", {
      previewDigest: canonicalDigest({
        runRef,
        workspaceId,
        targetPath: proposal.targetPath,
        outputDigest,
        actions: Array.isArray(hostPreview.actions) ? hostPreview.actions : [],
        summary: hostPreview.summary || {}
      }),
      previewSummary: hostPreview.summary || {}
    });
    return result(200, { ok: true, proposal: publicProposal(proposal) });
  }

  async function approve(input, context) {
    assertClosedObject(input, new Set(["workspaceId", "proposalRef", "previewDigest", "outputDigest", "policyDigest"]), "output approval request");
    const proposal = await store.getProposal(requiredString(input.proposalRef, "proposalRef"));
    const workspaceId = requiredString(input.workspaceId, "workspaceId");
    if (!proposal || proposal.workspaceId !== workspaceId) {
      return fail(404, "shared_space_proposal_not_found", "Output proposal was not found.");
    }
    const expected = {
      operationId: "sharedspace.output.approve",
      workspaceId,
      proposalRef: proposal.proposalRef,
      previewDigest: requiredDigest(input.previewDigest, "previewDigest"),
      outputDigest: requiredDigest(input.outputDigest, "outputDigest"),
      policyDigest: requiredDigest(input.policyDigest, "policyDigest")
    };
    if (
      expected.previewDigest !== proposal.previewDigest ||
      expected.outputDigest !== proposal.outputDigest ||
      expected.policyDigest !== proposal.sandboxBindings?.policyDigest
    ) {
      return fail(409, "shared_space_approval_binding_stale", "The approval request does not match the current output proposal binding.");
    }
    const approval = currentBoundApproval(context, expected);
    if (!approval.ok) return approval.response;
    const approved = await transitionProposal(proposal, "approved", {
      approvalRef: approval.approvalRef,
      approvalActorRef: approval.actorRef,
      approvalBindingDigest: approval.bindingDigest,
      approvalEvidenceDigest: approval.evidenceDigest,
      approvalPolicyRevisionDigest: approval.policyRevisionDigest
    });
    return result(200, { ok: true, proposal: publicProposal(approved) });
  }

  async function reject(input, context) {
    assertClosedObject(input, new Set(["workspaceId", "proposalRef", "reason"]), "output rejection request");
    const proposal = await store.getProposal(requiredString(input.proposalRef, "proposalRef"));
    if (!proposal || proposal.workspaceId !== requiredString(input.workspaceId, "workspaceId")) {
      return fail(404, "shared_space_proposal_not_found", "Output proposal was not found.");
    }
    const disposeOutput = requireMethod(context.sandboxExecution, "disposeOutput", "shared_space_output_disposal_unavailable");
    if (await disposeOutput(proposal.outputHandle, "rejected") !== true) {
      return fail(503, "shared_space_output_disposal_failed", "Rejected output could not be reliably disposed.");
    }
    const rejected = await transitionProposal(proposal, "rejected", {
      disposition: "rejected",
      rejectionReason: String(input.reason || "rejected").slice(0, 128)
    });
    return result(200, { ok: true, proposal: publicProposal(rejected) });
  }

  async function commit(input, context) {
    assertClosedObject(input, new Set(["workspaceId", "proposalRef", "previewDigest", "outputDigest", "policyDigest"]), "output commit request");
    let proposal = await store.getProposal(requiredString(input.proposalRef, "proposalRef"));
    const workspaceId = requiredString(input.workspaceId, "workspaceId");
    if (!proposal || proposal.workspaceId !== workspaceId) {
      return fail(404, "shared_space_proposal_not_found", "Output proposal was not found.");
    }
    if (!proposal.approvalRef || !proposal.approvalBindingDigest || !proposal.approvalEvidenceDigest) {
      return fail(403, "shared_space_output_approval_required", "The current preview must be explicitly approved before commit.");
    }
    const expected = {
      operationId: "sharedspace.output.commit",
      workspaceId,
      proposalRef: proposal.proposalRef,
      previewDigest: requiredDigest(input.previewDigest, "previewDigest"),
      outputDigest: requiredDigest(input.outputDigest, "outputDigest"),
      policyDigest: requiredDigest(input.policyDigest, "policyDigest")
    };
    if (
      expected.previewDigest !== proposal.previewDigest ||
      expected.outputDigest !== proposal.outputDigest ||
      expected.policyDigest !== proposal.sandboxBindings?.policyDigest
    ) {
      return fail(409, "shared_space_approval_binding_stale", "The commit request does not match the approved output proposal binding.");
    }
    const commitApproval = currentBoundApproval(context, expected);
    if (!commitApproval.ok) return commitApproval.response;
    if (commitApproval.approvalRef === proposal.approvalRef) {
      return fail(409, "shared_space_distinct_commit_approval_required", "Commit requires a distinct current approval.");
    }
    if (commitApproval.policyRevisionDigest !== proposal.approvalPolicyRevisionDigest) {
      return fail(409, "shared_space_approval_policy_changed", "Approval policy changed after output approval.");
    }
    const getReceipt = requireMethod(context.sandboxExecution, "getReceipt", "shared_space_sandbox_unavailable");
    const receipt = await getReceipt(proposal.runRef, { workspaceId: proposal.workspaceId });
    if (assertTerminalReceipt(receipt) !== proposal.outputDigest) {
      return fail(409, "shared_space_output_digest_mismatch", "Sandbox output changed after approval.");
    }
    const files = await quarantinedOutputFiles(context.sandboxExecution, receipt, proposal);
    proposal = await transitionProposal(proposal, "committing", {
      commitApprovalRef: commitApproval.approvalRef,
      commitApprovalActorRef: commitApproval.actorRef,
      commitApprovalBindingDigest: commitApproval.bindingDigest,
      commitApprovalEvidenceDigest: commitApproval.evidenceDigest,
      commitApprovalPolicyRevisionDigest: commitApproval.policyRevisionDigest
    });
    const restoreWorkspaceFiles = requireMethod(context.agentWorkspace, "restoreWorkspaceFiles", "shared_space_output_commit_unavailable");
    const committed = await restoreWorkspaceFiles({
      workspaceId: proposal.workspaceId,
      operationId: "sharedspace.output.commit",
      snapshot: { basePath: proposal.targetPath, deleteExtraneous: false, files },
      proposalRef: proposal.proposalRef,
      sandboxReceiptDigest: proposal.sandboxReceiptDigest,
      sandboxBindings: proposal.sandboxBindings,
      previewDigest: proposal.previewDigest,
      approvalBindingDigest: canonicalDigest({
        approve: {
          approvalRef: proposal.approvalRef,
          actorRef: proposal.approvalActorRef,
          bindingDigest: proposal.approvalBindingDigest,
          evidenceDigest: proposal.approvalEvidenceDigest
        },
        commit: {
          approvalRef: proposal.commitApprovalRef,
          actorRef: proposal.commitApprovalActorRef,
          bindingDigest: proposal.commitApprovalBindingDigest,
          evidenceDigest: proposal.commitApprovalEvidenceDigest
        },
        proposalRef: proposal.proposalRef,
        previewDigest: proposal.previewDigest,
        outputDigest: proposal.outputDigest,
        policyDigest: proposal.sandboxBindings?.policyDigest
      })
    });
    if (!committed?.ok) {
      const compensationRef = firstSafeString(committed?.compensationReceipt?.receiptRef, committed?.compensationRef);
      const compensated = committed?.compensated === true || Boolean(compensationRef);
      const failed = await transitionProposal(proposal, compensated ? "compensated" : "commit_failed", {
        disposition: compensated ? "compensated" : "pending",
        compensationRef
      });
      if (compensated) {
        const disposeOutput = requireMethod(context.sandboxExecution, "disposeOutput", "shared_space_output_disposal_unavailable");
        if (await disposeOutput(proposal.outputHandle, "compensated") !== true) {
          const cleanupFailed = await transitionProposal(failed, "output_cleanup_failed", { disposition: "compensated_cleanup_failed" });
          return result(503, { ok: false, proposal: publicProposal(cleanupFailed), error: { code: "shared_space_output_disposal_failed", message: "Compensated output could not be reliably disposed." } });
        }
      }
      return result(Number(committed?.status || 409), {
        ok: false,
        proposal: publicProposal(failed),
        error: {
          code: "shared_space_output_commit_failed",
          message: compensated
            ? "Output commit failed and the host transaction was compensated."
            : "Output commit failed and requires a new preview and approval."
        }
      });
    }
    const commitId = String(committed.stateCommit?.commitId || committed.commitId || "").trim();
    const transactionReceipt = committed.mutationReceipt;
    if (!transactionReceipt?.receiptDigest || transactionReceipt.stateCommitId !== commitId) {
      const failed = await transitionProposal(proposal, "commit_failed", {
        disposition: "pending",
        commitRef: commitId
      });
      return result(409, {
        ok: false,
        proposal: publicProposal(failed),
        error: {
          code: "shared_space_output_mutation_receipt_unavailable",
          message: "Output commit did not return an atomically verified workspace mutation receipt."
        }
      });
    }
    let persistedReceipt = null;
    try {
      const getMutationReceipt = requireMethod(
        context.agentWorkspace,
        "getWorkspaceSandboxMutationReceipt",
        "shared_space_output_mutation_receipt_unavailable"
      );
      persistedReceipt = await getMutationReceipt({
        workspaceId: proposal.workspaceId,
        commitId
      });
    } catch {
      persistedReceipt = null;
    }
    const auditReceiptMatches = persistedReceipt?.ok === true &&
      persistedReceipt.mutationReceipt?.receiptDigest === transactionReceipt.receiptDigest;
    const disposeOutput = requireMethod(context.sandboxExecution, "disposeOutput", "shared_space_output_disposal_unavailable");
    if (await disposeOutput(proposal.outputHandle, "committed") !== true) {
      const cleanupFailed = await transitionProposal(proposal, "output_cleanup_failed", { disposition: "committed_cleanup_failed" });
      return result(503, { ok: false, proposal: publicProposal(cleanupFailed), error: { code: "shared_space_output_disposal_failed", message: "Committed output could not be reliably disposed." } });
    }
    const complete = await transitionProposal(proposal, "committed", {
      disposition: "committed",
      checkpointRef: String(committed.checkpoint?.nodeId || committed.checkpointId || ""),
      commitRef: commitId,
      mutationReceipt: transactionReceipt,
      mutationReceiptDigest: transactionReceipt.receiptDigest,
      mutationReceiptAuditStatus: auditReceiptMatches ? "verified" : "unavailable"
    });
    return result(200, {
      ok: true,
      proposal: publicProposal(complete),
      commit: {
        commitRef: complete.commitRef,
        checkpointRef: complete.checkpointRef,
        disposition: complete.disposition,
        mutationReceipt: complete.mutationReceipt
      }
    });
  }

  async function execute({ operationId, input, context }) {
    try {
      if (operationId === "sharedspace.snapshot.create") return await createSnapshot(input, context);
      if (operationId === "sharedspace.sandbox.input.seal") return await sealOpaqueInput(input, context);
      if (operationId === "sharedspace.sandbox.runOpaque") return await runOpaque(input, context);
      if (operationId === "sharedspace.sandbox.run") return await run(input, context);
      if (operationId === "sharedspace.sandbox.cancel") return await cancel(input, context);
      if (operationId === "sharedspace.sandbox.status") return await status(input, context);
      if (operationId === "sharedspace.output.preview") return await preview(input, context);
      if (operationId === "sharedspace.output.approve") return await approve(input, context);
      if (operationId === "sharedspace.output.reject") return await reject(input, context);
      if (operationId === "sharedspace.output.commit") return await commit(input, context);
      return null;
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
        ? error.status
        : 503;
      const code = /^[a-z][a-z0-9_]{2,96}$/u.test(String(error?.code || ""))
        ? String(error.code)
        : "shared_space_sandbox_operation_failed";
      return fail(status, code, "Shared Space sandbox operation failed.");
    }
  }

  async function close() {
    const cancellations = [...activeRuns.entries()].map(async ([runRef, active]) => {
      try {
        const cancelRun = requireMethod(active.sandboxExecution, "cancel", "shared_space_sandbox_unavailable");
        await cancelRun(runRef, { workspaceId: active.workspaceId, reason: "plugin_shutdown" });
      } finally {
        activeRuns.delete(runRef);
      }
    });
    await Promise.allSettled(cancellations);
    await store.close();
  }

  return Object.freeze({ close, execute });
}
