import {
  SANDBOX_CONFIGURED_WORKLOAD_REQUEST_SCHEMA,
  SANDBOX_CUSTODY_PROMOTION_SCHEMA,
  custodyPromotionSetDigest,
  sandboxDigest
} from "./skill-hub-contracts.mjs";
import { SKILL_HUB_OPAQUE_BUNDLE_PATH } from "./skill-hub-opaque-bundle.mjs";

const WORKLOAD_BY_OPERATION = Object.freeze({
  "skill_hub.scan": "skill_scan",
  "skill_hub.build": "skill_build",
  "skill_hub.execute": "skill_execute"
});
const RESOURCE_FIELDS = Object.freeze([
  "wallTimeMs",
  "cpuMillis",
  "memoryBytes",
  "processes",
  "fileDescriptors",
  "diskBytes",
  "inodes",
  "fileCount",
  "outputBytes",
  "logBytes",
  "networkBytes",
  "toolCalls"
]);
const CAPABILITY_LIST_FIELDS = Object.freeze(["filesystem", "network", "tools", "secretRefs"]);

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requiredText(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function relativeLogicalPath(value, label) {
  const normalized = requiredText(value, label).replace(/\\/gu, "/");
  if (normalized.startsWith("/") || normalized.startsWith("~") || normalized.includes("\0")) {
    throw new Error(`${label} must be a sandbox-relative logical path.`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} must not contain empty or traversal segments.`);
  }
  return normalized;
}

function finiteResources(value) {
  const source = record(value);
  const output = {};
  if (Object.keys(source).some((name) => !RESOURCE_FIELDS.includes(name))) {
    throw new Error("Sandbox resources contain an unsupported budget.");
  }
  for (const name of RESOURCE_FIELDS) {
    const amount = Number(source[name]);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error(`Sandbox resource ${name} must be a finite positive integer.`);
    }
    output[name] = amount;
  }
  return output;
}

function closedOutputs(value) {
  const source = record(value);
  const allowedTypes = Array.isArray(source.allowedTypes)
    ? source.allowedTypes.map((item) => requiredText(item, "Output type"))
    : [];
  const maxFiles = Number(source.maxFiles);
  const maxBytes = Number(source.maxBytes);
  const schema = requiredText(source.schema, "Sandbox output schema");
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Sandbox output limits must be finite positive integers.");
  }
  if (allowedTypes.length === 0) throw new Error("Sandbox output types are required.");
  return { schema, maxFiles, maxBytes, allowedTypes };
}

function effectiveCapabilities(input) {
  const source = record(input.capabilities);
  const supported = new Set([...CAPABILITY_LIST_FIELDS, "clock", "randomness", "subprocesses"]);
  if (Object.keys(source).some((name) => !supported.has(name))) {
    throw new Error("Sandbox capabilities contain an unsupported field.");
  }
  const output = {};
  for (const name of CAPABILITY_LIST_FIELDS) {
    if (!Array.isArray(source[name])) throw new Error(`Sandbox capability ${name} must be an array.`);
    output[name] = [...new Set(source[name].map((item) => requiredText(item, `Sandbox capability ${name}`)))].sort();
  }
  if (typeof source.clock !== "boolean" || typeof source.randomness !== "boolean") {
    throw new Error("Sandbox clock and randomness capabilities must be explicit booleans.");
  }
  const subprocesses = Number(source.subprocesses);
  if (!Number.isSafeInteger(subprocesses) || subprocesses < 0) {
    throw new Error("Sandbox subprocess capability must be a non-negative integer.");
  }
  return {
    ...output,
    clock: source.clock,
    randomness: source.randomness,
    subprocesses
  };
}

function assertWorkloadState(workloadKind, contribution) {
  const status = String(contribution.status || "");
  if (workloadKind === "skill_scan" && !["submitted", "preview"].includes(status)) {
    throw new Error("Skill scanning requires a submitted or preview contribution.");
  }
  if (workloadKind === "skill_build" && !["scanned", "reviewed", "published", "adopted"].includes(status)) {
    throw new Error("Skill building requires a successfully scanned immutable revision.");
  }
  if (workloadKind === "skill_execute" && !["published", "adopted"].includes(status)) {
    throw new Error("Skill execution requires a published contribution.");
  }
}

function normalizedReceipt(receiptValue, request, workspaceId, packageDigest) {
  const receipt = record(receiptValue);
  const receiptInputDigests = Array.isArray(receipt.inputDigests)
    ? receipt.inputDigests.map((value) => String(value || "").trim())
    : [];
  const normalized = {
    receiptId: String(receipt.receiptId || "").trim(),
    runId: requiredText(receipt.runId, "Sandbox receipt run identifier"),
    workloadKind: String(receipt.workloadKind || request.workloadKind).trim(),
    status: requiredText(receipt.status, "Sandbox receipt status"),
    workloadArtifactDigest: String(receipt.artifactDigest || "").trim(),
    inputDigest: request.inputs[0].digest,
    packageDigest,
    policyDigest: String(receipt.policyDigest || "").trim(),
    cleanupStatus: String(receipt.cleanupState || "").trim(),
    outputDisposition: String(receipt.outputDisposition || "").trim(),
    reasonCode: String(receipt.reasonCode || "").trim(),
    failureStage: String(receipt.failureStage || "").trim(),
    workspaceId,
    createdAt: String(receipt.createdAt || new Date().toISOString()).trim()
  };
  if (normalized.workloadKind !== request.workloadKind) {
    throw new Error("Sandbox receipt does not match the requested workload.");
  }
  if (
    receiptInputDigests.length > 0 &&
    (receiptInputDigests.length !== 1 || receiptInputDigests[0] !== normalized.inputDigest)
  ) {
    throw new Error("Sandbox receipt does not match the opaque package input.");
  }
  if (
    normalized.status === "output_quarantined" &&
    !/^[a-f0-9]{64}$/u.test(normalized.workloadArtifactDigest)
  ) {
    throw new Error("Sandbox success requires a trusted workload artifact digest.");
  }
  if (normalized.status === "output_quarantined" && normalized.cleanupStatus !== "destroyed") {
    throw new Error("Sandbox success requires destroyed isolation state.");
  }
  if (normalized.status === "output_quarantined" && normalized.outputDisposition !== "quarantined") {
    throw new Error("Sandbox success requires quarantined output disposition.");
  }
  if (normalized.status === "succeeded" && normalized.outputDisposition !== "committed") {
    throw new Error("Sandbox success requires completed output disposition.");
  }
  return normalized;
}

async function acceptScanOutput(rawReceipt, sandboxExecution) {
  const outputHandle = requiredText(rawReceipt?.outputHandle, "Sandbox output handle");
  if (typeof sandboxExecution.resolveQuarantinedOutput !== "function" ||
      typeof sandboxExecution.disposeOutput !== "function" ||
      typeof sandboxExecution.getReceipt !== "function") {
    throw new Error("Controlled scan output disposition is unavailable.");
  }
  let disposition = "rejected";
  try {
    const quarantined = await sandboxExecution.resolveQuarantinedOutput(outputHandle);
    const files = Array.isArray(quarantined?.output?.files) ? quarantined.output.files : [];
    if (files.length !== 1 || files[0]?.path !== "scan.json" ||
        !Number.isSafeInteger(files[0]?.bytes) || files[0].bytes <= 0 || files[0].bytes > 1024 ||
        !/^[a-f0-9]{64}$/u.test(String(files[0]?.digest || "")) ||
        typeof quarantined?.readFile !== "function") {
      throw new Error("Controlled scan output manifest is invalid.");
    }
    const bytes = await quarantined.readFile("scan.json");
    if (!Buffer.isBuffer(bytes) || bytes.byteLength !== files[0].bytes) {
      throw new Error("Controlled scan output content is invalid.");
    }
    let result;
    try {
      result = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("Controlled scan output content is invalid.");
    }
    if (!result || typeof result !== "object" || Array.isArray(result) ||
        Object.keys(result).length !== 1 || result.scan !== "passed") {
      throw new Error("Controlled scan did not produce an accepted result.");
    }
    disposition = "committed";
  } finally {
    const disposed = await sandboxExecution.disposeOutput(outputHandle, disposition);
    if (disposed !== true) throw new Error("Controlled scan output disposition did not complete.");
  }
  const finalReceipt = await sandboxExecution.getReceipt(requiredText(rawReceipt?.runId, "Sandbox receipt run identifier"));
  if (finalReceipt?.status !== "succeeded" || finalReceipt?.outputDisposition !== "committed") {
    throw new Error("Controlled scan final receipt is unavailable.");
  }
  return finalReceipt;
}

function projectedStatus(value, runId = "") {
  if (typeof value === "boolean") {
    return {
      runId,
      status: value ? "cancellation_requested" : "not_cancelled",
      reasonCode: value ? "" : "sandbox_run_not_cancellable",
      cleanupStatus: "",
      outputDisposition: ""
    };
  }
  const status = record(value);
  return {
    runId: String(status.runId || runId).trim(),
    status: String(status.status || "unknown").trim(),
    reasonCode: String(status.reasonCode || "").trim(),
    cleanupStatus: String(status.cleanupState || "").trim(),
    outputDisposition: String(status.outputDisposition || "").trim()
  };
}

export function createSkillHubSandboxOperations({ contributionRegistryFor, workspaceIdFrom } = {}) {
  if (typeof contributionRegistryFor !== "function" || typeof workspaceIdFrom !== "function") {
    throw new TypeError("Skill Hub sandbox operations require contribution and workspace resolvers.");
  }

  async function prepare({ operationId, input = {}, context = {} }) {
    const workloadKind = WORKLOAD_BY_OPERATION[operationId];
    if (!workloadKind) throw new Error("Unsupported Skill Hub sandbox operation.");
    const registry = context.contributionRegistry || await contributionRegistryFor(input, context);
    const contributionId = requiredText(context.skillId || input.skillId, "Skill identifier");
    const contribution = await registry.getContribution(contributionId);
    assertWorkloadState(workloadKind, contribution);
    const asset = record(contribution.currentAssetRef);
    const packageDigest = requiredText(contribution.packageChecksum, "Immutable skill digest");
    const deadlineAt = requiredText(input.deadlineAt, "Sandbox deadline");
    if (!Number.isFinite(Date.parse(deadlineAt)) || Date.parse(deadlineAt) <= Date.now()) {
      throw new Error("Sandbox deadline must be a future timestamp.");
    }
    const workspaceId = workspaceIdFrom(input);
    if (workloadKind === "skill_execute") {
      await registry.assertCurrentGrant(contributionId, {
        actorId: requiredText(context.principal?.subjectRef, "Sandbox subject reference"),
        workspaceId,
        action: "use"
      });
    }
    const bundle = record(asset.packageBundle);
    const opaquePackage = Boolean(
      bundle &&
      bundle.path === SKILL_HUB_OPAQUE_BUNDLE_PATH &&
      bundle.custodyRef &&
      bundle.custodyRef === asset.opaqueCustodyRef &&
      bundle.envelopeDigest &&
      bundle.envelopeDigest === asset.opaqueEnvelopeDigest &&
      bundle.digest &&
      bundle.digest === asset.opaqueContentDigest &&
      !asset.packageRoot
    );
    if (!opaquePackage) {
      throw new Error("Immutable skill package requires one canonical opaque custody bundle.");
    }
    const inputDigest = sandboxDigest([{
      path: relativeLogicalPath(bundle.path, "Skill package bundle path"),
      digest: requiredText(bundle.digest, "Skill package bundle digest")
    }]);
    const request = {
      schemaVersion: SANDBOX_CONFIGURED_WORKLOAD_REQUEST_SCHEMA,
      workloadKind,
      principal: {
        subjectRef: requiredText(context.principal?.subjectRef, "Sandbox subject reference"),
        tenantRef: requiredText(context.principal?.tenantRef, "Sandbox tenant reference"),
        workspaceRef: workspaceId,
        operationRef: operationId
      },
      invocation: {
        args: Array.isArray(input.args) ? input.args.map((item) => String(item)) : [],
        workingDirectory: input.workingDirectory
          ? relativeLogicalPath(input.workingDirectory, "Sandbox working directory")
          : "workspace"
      },
      inputs: [{
        handle: requiredText(asset.assetId, "Skill asset handle"),
        digest: inputDigest,
        readOnly: true
      }],
      outputs: closedOutputs(input.outputs),
      capabilities: effectiveCapabilities(input),
      resources: finiteResources(input.resources),
      idempotencyKey: requiredText(input.idempotencyKey, "Sandbox idempotency key"),
      deadlineAt
    };
    return {
      registry,
      contribution,
      contributionId,
      request,
      asset,
      packageBundle: bundle,
      workspaceId,
      inputDigest,
      packageDigest
    };
  }

  async function execute({ operationId, input = {}, context = {}, sandboxExecution }) {
    if (!sandboxExecution || typeof sandboxExecution.executeConfiguredOpaque !== "function") {
      throw new Error("Controlled execution sandbox is unavailable.");
    }
    const prepared = await prepare({ operationId, input, context });
    const opaqueFile = {
      path: relativeLogicalPath(prepared.packageBundle.path, "Skill package bundle path"),
      digest: requiredText(prepared.packageBundle.digest, "Skill package bundle digest"),
      custodyRef: requiredText(prepared.packageBundle.custodyRef, "Skill package custody reference"),
      envelopeDigest: requiredText(prepared.packageBundle.envelopeDigest, "Skill package envelope digest"),
      promotionSchemaVersion: SANDBOX_CUSTODY_PROMOTION_SCHEMA
    };
    const rawReceipt = await sandboxExecution.executeConfiguredOpaque(prepared.request, [{
      handle: prepared.asset.assetId,
      promotionDigest: custodyPromotionSetDigest({
        files: [{ ...opaqueFile, contentDigest: opaqueFile.digest }]
      }),
      files: [opaqueFile]
    }], { signal: context.signal || null });
    const disposedReceipt = prepared.request.workloadKind === "skill_scan" && rawReceipt?.status === "output_quarantined"
      ? await acceptScanOutput(rawReceipt, sandboxExecution)
      : rawReceipt;
    const receipt = normalizedReceipt(
      disposedReceipt,
      prepared.request,
      prepared.workspaceId,
      prepared.packageDigest
    );
    const recorded = await prepared.registry.recordExecutionReceipt(prepared.contributionId, { receipt });
    let scan = null;
    if (prepared.request.workloadKind === "skill_scan" && receipt.status === "succeeded") {
      scan = await prepared.registry.scanContribution(prepared.contributionId, {
        actorId: context.principal.subjectRef,
        reason: "sandbox_scan_succeeded",
        scanReceipt: receipt
      });
    }
    return { request: prepared.request, receipt: recorded.executionReceipt, scan };
  }

  async function cancel({ input = {}, sandboxExecution }) {
    if (!sandboxExecution || typeof sandboxExecution.cancel !== "function") {
      throw new Error("Controlled execution sandbox is unavailable.");
    }
    const executionRef = requiredText(input.executionRef, "Sandbox execution reference");
    return projectedStatus(await sandboxExecution.cancel(executionRef), executionRef);
  }

  async function getStatus({ input = {}, sandboxExecution }) {
    if (!sandboxExecution || typeof sandboxExecution.getStatus !== "function") {
      throw new Error("Controlled execution sandbox is unavailable.");
    }
    const executionRef = requiredText(input.executionRef, "Sandbox execution reference");
    return projectedStatus(await sandboxExecution.getStatus(executionRef), executionRef);
  }

  return Object.freeze({ execute, cancel, getStatus });
}

export const SKILL_HUB_SANDBOX_OPERATION_IDS = Object.freeze(new Set([
  ...Object.keys(WORKLOAD_BY_OPERATION),
  "skill_hub.execution.cancel",
  "skill_hub.execution.status"
]));
