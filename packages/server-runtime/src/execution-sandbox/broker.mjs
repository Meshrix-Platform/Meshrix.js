import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  SANDBOX_DENIAL_REASONS,
  SANDBOX_RECEIPT_SCHEMA,
  bindSandboxConfiguredWorkloadRequest,
  compileSandboxAdmission,
  controlledRef,
  createSandboxDenialReceipt,
  normalizeSandboxConfiguration,
  normalizeSandboxConfiguredWorkloadRequest,
  normalizeSandboxExecutionRequest,
  custodyPromotionAuthorizationDigest,
  custodyPromotionSetDigest,
  sandboxApprovalRequestDigest,
  sandboxDigest,
  stableSandboxJson
} from "#meshrix/foundation/execution-sandbox/index";
import { writePrivateFileAtomic } from "#meshrix/foundation/storage/private-file-atomic";

const REQUIRED_BACKEND_RESTRICTIONS = Object.freeze([
  "filesystem",
  "process",
  "network",
  "environment",
  "credentials",
  "resources",
  "output",
  "cleanup",
  "cross-trust-domain"
]);
const MAX_CONSUMED_APPROVALS = 16_384;
const MAX_RECOVERED_RECEIPTS = 16_384;
const MAX_RECEIPT_BYTES = 256 * 1024;

function idempotencyIdentity(value) {
  return sandboxDigest(String(value || ""));
}

function approvalIdentity(value) {
  return sandboxDigest(String(value || ""));
}

const OPAQUE_CUSTODY_FAILURE_STAGES = new Set([
  "custody_object_missing",
  "custody_promotion_owner_mismatch",
  "custody_promotion_digest_mismatch",
  "custody_promotion_idempotency_conflict",
  "custody_promotion_replay_unavailable",
  "custody_envelope_authentication_failed"
]);

function opaqueCustodyFailureStage(error) {
  const code = String(error?.code || "").trim();
  if (OPAQUE_CUSTODY_FAILURE_STAGES.has(code)) return code;
  return error instanceof TypeError
    ? "custody_promotion_contract_invalid"
    : "custody_promotion_failed";
}

function normalizeReason(error, fallback) {
  const code = String(error?.code || "").trim();
  return Object.values(SANDBOX_DENIAL_REASONS).includes(code) ? code : fallback;
}

function safeFilePath(value) {
  const normalized = String(value || "").trim().replace(/\\/gu, "/");
  if (
    !normalized ||
    normalized.length > 1024 ||
    normalized.startsWith("/") ||
    normalized.startsWith("~") ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) throw Object.assign(new Error("Sandbox file path is invalid."), { code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED });
  return normalized;
}

function contentBuffer(file) {
  if (Buffer.isBuffer(file?.content)) return Buffer.from(file.content);
  if (typeof file?.content === "string") return Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
  throw Object.assign(new Error("Sandbox input content is invalid."), { code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED });
}

async function stageInputFile({ rawFile, targetPath, maxBytes }) {
  const temporaryPath = `${targetPath}.pending-${crypto.randomUUID()}`;
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const writeChunk = async (value) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value || "");
    bytes += chunk.length;
    if (bytes > maxBytes) {
      throw Object.assign(new Error("Sandbox input exceeds the admitted disk budget."), {
        code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED
      });
    }
    hash.update(chunk);
    await handle.write(chunk);
  };
  try {
    if (typeof rawFile.stageContent === "function") {
      await rawFile.stageContent(writeChunk);
    } else {
      const buffer = contentBuffer(rawFile);
      try { await writeChunk(buffer); } finally {
        buffer.fill(0);
        if (rawFile.sensitive === true && Buffer.isBuffer(rawFile.content)) rawFile.content.fill(0);
      }
    }
    await handle.sync();
    await handle.close();
    const digest = hash.digest("hex");
    if (rawFile.digest && String(rawFile.digest).toLowerCase() !== digest) {
      throw Object.assign(new Error("Sandbox input file digest mismatch."), {
        code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED
      });
    }
    await fs.chmod(temporaryPath, 0o444);
    await fs.rename(temporaryPath, targetPath);
    return { digest, bytes };
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function ensurePrivateDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Sandbox private directory boundary is invalid.");
  }
  await fs.chmod(directoryPath, 0o700).catch(() => {});
}

async function removeOwnedTree(directoryPath) {
  async function restoreOwnerWrite(currentPath) {
    let currentStat;
    try {
      currentStat = await fs.lstat(currentPath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) return;
    let entries = [];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await fs.chmod(currentPath, 0o700).catch(() => {});
    for (const entry of entries) {
      const childPath = path.join(currentPath, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await restoreOwnerWrite(childPath);
      else if (!entry.isSymbolicLink()) await fs.chmod(childPath, 0o600).catch(() => {});
    }
  }
  await restoreOwnerWrite(directoryPath);
  await fs.rm(directoryPath, { recursive: true, force: true });
}

async function materializeInputs({ request, resolveInput, inputRoot }) {
  if (typeof resolveInput !== "function") {
    throw Object.assign(new Error("Sandbox input resolver is unavailable."), {
      code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED
    });
  }
  const staged = [];
  const limits = Object.freeze({
    diskBytes: Number.isFinite(Number(request.resources?.diskBytes))
      ? Math.max(0, Math.trunc(Number(request.resources.diskBytes)))
      : Number.POSITIVE_INFINITY,
    fileCount: Number.isFinite(Number(request.resources?.fileCount))
      ? Math.max(0, Math.trunc(Number(request.resources.fileCount)))
      : Number.POSITIVE_INFINITY,
    inodes: Number.isFinite(Number(request.resources?.inodes))
      ? Math.max(0, Math.trunc(Number(request.resources.inodes)))
      : Number.POSITIVE_INFINITY
  });
  const consumed = { diskBytes: 0, fileCount: 0, inodes: 0 };
  for (let index = 0; index < request.inputs.length; index += 1) {
    const declared = request.inputs[index];
    const resolved = await resolveInput(Object.freeze({
      handle: declared.handle,
      digest: declared.digest,
      readOnly: true
    }));
    if (!resolved || !Array.isArray(resolved.files) || resolved.files.length === 0) {
      throw Object.assign(new Error("Sandbox input resolver returned no immutable files."), {
        code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED
      });
    }
    const inputDirectory = path.join(inputRoot, String(index));
    await ensurePrivateDirectory(inputDirectory);
    const manifest = [];
    let totalBytes = 0;
    for (const rawFile of resolved.files) {
      if (consumed.fileCount >= limits.fileCount || consumed.inodes >= limits.inodes) {
        throw Object.assign(new Error("Sandbox inputs exceed the admitted file budget."), {
          code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED
        });
      }
      const relativePath = safeFilePath(rawFile.path);
      const targetPath = path.join(inputDirectory, relativePath);
      const normalizedTarget = path.resolve(targetPath);
      const normalizedRoot = path.resolve(inputDirectory);
      if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
        throw Object.assign(new Error("Sandbox input path escapes its staging boundary."), {
          code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED
        });
      }
      await ensurePrivateDirectory(path.dirname(targetPath));
      const stagedFile = await stageInputFile({
        rawFile,
        targetPath,
        maxBytes: limits.diskBytes - consumed.diskBytes
      });
      const { digest } = stagedFile;
      totalBytes += stagedFile.bytes;
      consumed.diskBytes += stagedFile.bytes;
      consumed.fileCount += 1;
      consumed.inodes += 1;
      manifest.push({ path: relativePath, digest });
    }
    manifest.sort((left, right) => left.path.localeCompare(right.path));
    const digest = sandboxDigest(manifest);
    if (digest !== declared.digest || (resolved.digest && String(resolved.digest).toLowerCase() !== digest)) {
      throw Object.assign(new Error("Sandbox immutable input digest mismatch."), {
        code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED
      });
    }
    await fs.chmod(inputDirectory, 0o555).catch(() => {});
    staged.push(Object.freeze({ index, digest, fileCount: manifest.length, totalBytes }));
  }
  await fs.chmod(inputRoot, 0o555).catch(() => {});
  return Object.freeze(staged);
}

export { materializeInputs as materializeSandboxInputs };

async function inspectOutput({ outputRoot, outputs }) {
  const files = [];
  let totalBytes = 0;
  async function walk(directoryPath, relativeRoot = "") {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      const absolutePath = path.join(directoryPath, entry.name);
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw Object.assign(new Error("Sandbox output contains an unsupported filesystem object."), {
          code: SANDBOX_DENIAL_REASONS.OUTPUT_INVALID
        });
      }
      if (stat.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      const type = path.posix.extname(relativePath).toLowerCase().replace(/^\./u, "") || "none";
      if (!outputs.allowedTypes.includes(type)) {
        throw Object.assign(new Error("Sandbox output type is not permitted."), {
          code: SANDBOX_DENIAL_REASONS.OUTPUT_INVALID
        });
      }
      totalBytes += stat.size;
      if (files.length + 1 > outputs.maxFiles || totalBytes > outputs.maxBytes) {
        throw Object.assign(new Error("Sandbox output exceeds its admitted limit."), {
          code: SANDBOX_DENIAL_REASONS.OUTPUT_INVALID
        });
      }
      const buffer = await fs.readFile(absolutePath);
      files.push({
        path: relativePath,
        digest: crypto.createHash("sha256").update(buffer).digest("hex"),
        bytes: buffer.length
      });
      await fs.chmod(absolutePath, 0o400).catch(() => {});
    }
  }
  await walk(outputRoot);
  files.sort((left, right) => left.path.localeCompare(right.path));
  await fs.chmod(outputRoot, 0o500).catch(() => {});
  return Object.freeze({
    digest: sandboxDigest(files.map(({ path: filePath, digest }) => ({ path: filePath, digest }))),
    files: Object.freeze(files),
    fileCount: files.length,
    totalBytes
  });
}

function validatedResourceTotals(value = {}, resources = {}) {
  const totals = {};
  const measuredTotals = {};
  for (const key of Object.keys(resources)) {
    const measured = Number(value?.[key] || 0);
    if (!Number.isFinite(measured) || measured < 0) {
      throw Object.assign(new Error("Sandbox backend returned invalid resource measurements."), {
        code: SANDBOX_DENIAL_REASONS.RUNTIME_FAILED,
        failureStage: "resource_budget_exceeded"
      });
    }
    measuredTotals[key] = measured;
    totals[key] = Math.trunc(measured);
  }
  const frozenTotals = Object.freeze(totals);
  if (Object.keys(resources).some((key) => measuredTotals[key] > resources[key])) {
    throw Object.assign(new Error("Sandbox backend exceeded an admitted resource budget."), {
      code: SANDBOX_DENIAL_REASONS.RUNTIME_FAILED,
      failureStage: "resource_budget_exceeded",
      resourceTotals: Object.freeze(measuredTotals)
    });
  }
  return frozenTotals;
}

function failedResourceTotals(error, resources = {}) {
  const totals = Object.fromEntries(Object.keys(resources).map((key) => [key, 0]));
  if (error?.outputBytes !== undefined) {
    const measuredLogBytes = Number(error.outputBytes);
    if (Number.isFinite(measuredLogBytes) && measuredLogBytes >= 0) {
      totals.logBytes = Math.trunc(measuredLogBytes);
    }
  }
  return Object.freeze(totals);
}

function publicStatus(receipt) {
  if (!receipt) return null;
  return Object.freeze({
    runId: receipt.runId,
    status: receipt.status,
    runtimeState: receipt.runtimeState,
    cleanupState: receipt.cleanupState,
    outputDisposition: receipt.outputDisposition,
    reasonCode: receipt.reasonCode
  });
}

export function createSandboxExecutionBroker({
  configuration = null,
  profiles = {},
  providerResolver = null,
  opaqueArtifactCustody = null,
  userDataPath = "",
  now = () => new Date(),
  persistReceipt = null,
  loadReceipts = null,
  audit = null
} = {}) {
  const configured = normalizeSandboxConfiguration(configuration);
  const active = new Map();
  const receipts = new Map();
  const idempotency = new Map();
  const consumedApprovals = new Map();
  const outputHandles = new Map();
  const internalResolution = Symbol("sandbox-internal-resolution");
  let closing = false;

  const root = path.join(String(userDataPath || ""), "execution-sandbox");
  const runsRoot = path.join(root, "runs");
  const quarantineRoot = path.join(root, "quarantine");
  const receiptsRoot = path.join(root, "receipts");
  let recovered = false;
  let recoveryPromise = null;

  function recoveredReceipt(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Sandbox receipt recovery input is invalid.");
    }
    const serialized = JSON.stringify(value);
    if (
      Buffer.byteLength(serialized, "utf8") > MAX_RECEIPT_BYTES ||
      value.schemaVersion !== SANDBOX_RECEIPT_SCHEMA ||
      !/^(?:run|denial):[a-f0-9]{24}$/u.test(String(value.runId || "")) ||
      !["denied", "provisioning", "running", "output_quarantined", "succeeded", "failed", "timed_out", "cancelled", "rejected", "compensated"].includes(String(value.status || "")) ||
      (value.requestDigest && !/^[a-f0-9]{64}$/u.test(String(value.requestDigest))) ||
      (value.idempotencyDigest && !/^[a-f0-9]{64}$/u.test(String(value.idempotencyDigest))) ||
      (value.approvalRefDigest && !/^[a-f0-9]{64}$/u.test(String(value.approvalRefDigest))) ||
      /(?:\/Users\/|\/home\/|\/private\/|[A-Za-z]:\\\\)/u.test(serialized)
    ) {
      throw new Error("Sandbox persisted receipt is invalid or privacy-unsafe.");
    }
    return Object.freeze(JSON.parse(serialized));
  }

  async function readPersistedReceipts() {
    if (typeof loadReceipts === "function") {
      const loaded = await loadReceipts();
      if (!Array.isArray(loaded) || loaded.length > MAX_RECOVERED_RECEIPTS) {
        throw new Error("Sandbox receipt recovery capacity is invalid.");
      }
      return loaded.map(recoveredReceipt);
    }
    let entries;
    try {
      entries = await fs.readdir(receiptsRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    if (entries.length > MAX_RECOVERED_RECEIPTS) {
      throw new Error("Sandbox receipt recovery capacity is exhausted.");
    }
    const output = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^(?:run|denial)_[a-f0-9]{24}\.json$/u.test(entry.name)) {
        throw new Error("Sandbox receipt storage contains an unsupported artifact.");
      }
      const receiptPath = path.join(receiptsRoot, entry.name);
      const stat = await fs.lstat(receiptPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECEIPT_BYTES) {
        throw new Error("Sandbox receipt storage artifact is invalid.");
      }
      output.push(recoveredReceipt(JSON.parse(await fs.readFile(receiptPath, "utf8"))));
    }
    return output;
  }

  async function reconcileManagedDirectories(directoryPath, prefix, retainedNames = new Set()) {
    let entries;
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (entries.length > MAX_RECOVERED_RECEIPTS) throw new Error("Sandbox recovery capacity is exhausted.");
    for (const entry of entries) {
      if (!new RegExp(`^${prefix}[a-f0-9]{24}$`, "u").test(entry.name)) {
        throw new Error("Sandbox runtime storage contains an unsupported artifact.");
      }
      if (!retainedNames.has(entry.name)) await removeOwnedTree(path.join(directoryPath, entry.name));
    }
  }

  async function storeReceipt(receipt) {
    if (typeof persistReceipt === "function") {
      await persistReceipt(receipt);
    } else {
      await writePrivateFileAtomic(
        path.join(receiptsRoot, `${receipt.runId.replace(/[^a-zA-Z0-9._-]/gu, "_")}.json`),
        `${JSON.stringify(receipt, null, 2)}\n`
      );
    }
    receipts.set(receipt.runId, receipt);
    if (typeof audit === "function") {
      await audit(Object.freeze({
        runId: receipt.runId,
        status: receipt.status,
        reasonCode: receipt.reasonCode,
        requestDigest: receipt.requestDigest,
        policyDigest: receipt.policyDigest || ""
      }));
    }
    return receipt;
  }

  async function deny(request, reasonCode) {
    const receipt = createSandboxDenialReceipt({ request, reasonCode, now: now() });
    try {
      return await storeReceipt(receipt);
    } catch {
      return Object.freeze({ ...receipt, reasonCode: SANDBOX_DENIAL_REASONS.RECEIPT_PERSISTENCE_FAILED });
    }
  }

  async function recover() {
    if (recovered) return Object.freeze({ recovered: true, receiptCount: receipts.size });
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = (async () => {
      const persisted = await readPersistedReceipts();
      const retainedQuarantineNames = new Set();
      for (const receipt of persisted) {
        if (receipts.has(receipt.runId)) throw new Error("Sandbox receipt identity is duplicated.");
        receipts.set(receipt.runId, receipt);
        if (receipt.idempotencyDigest) idempotency.set(receipt.idempotencyDigest, receipt.runId);
        const approvalExpiry = Date.parse(receipt.approvalExpiresAt || "");
        if (receipt.approvalRefDigest && Number.isFinite(approvalExpiry) && approvalExpiry > now().getTime()) {
          consumedApprovals.set(receipt.approvalRefDigest, approvalExpiry);
        }
        const managedName = receipt.runId.replace(":", "-");
        const runDirectory = path.join(runsRoot, managedName);
        const quarantineDirectory = path.join(quarantineRoot, managedName);
        if (["provisioning", "running"].includes(receipt.status)) {
          await removeOwnedTree(runDirectory);
          await removeOwnedTree(quarantineDirectory);
          await storeReceipt(Object.freeze({
            ...receipt,
            status: "failed",
            reasonCode: SANDBOX_DENIAL_REASONS.RUNTIME_FAILED,
            failureStage: "recovered_interrupted_run",
            runtimeState: "failed",
            cleanupState: "destroyed",
            outputHandle: "",
            outputDisposition: "rejected",
            outputManifest: null,
            finishedAt: now().toISOString()
          }));
          continue;
        }
        if (receipt.dispositionState === "disposing") {
          await removeOwnedTree(quarantineDirectory);
          const disposition = String(receipt.pendingDisposition || "");
          await storeReceipt(Object.freeze({
            ...receipt,
            status: disposition === "committed" ? "succeeded" : disposition,
            reasonCode: `sandbox_output_${disposition}`,
            outputHandle: "",
            outputDisposition: disposition,
            dispositionState: "complete",
            pendingDisposition: "",
            finishedAt: now().toISOString()
          }));
          continue;
        }
        if (receipt.outputDisposition === "quarantined" && receipt.outputHandle) {
          try {
            const manifest = receipt.outputManifest;
            if (
              !manifest || !Array.isArray(manifest.files) ||
              manifest.fileCount !== manifest.files.length ||
              manifest.files.length > Number(receipt.outputFileLimit || manifest.fileCount) ||
              !/^[a-f0-9]{64}$/u.test(String(manifest.digest || "")) ||
              manifest.digest !== receipt.outputDigest
            ) throw new Error("Sandbox quarantined output manifest is invalid.");
            const allowedTypes = [...new Set(manifest.files.map((file) =>
              path.posix.extname(String(file.path || "")).toLowerCase().replace(/^\./u, "") || "none"
            ))];
            const inspected = await inspectOutput({
              outputRoot: quarantineDirectory,
              outputs: {
                allowedTypes,
                maxFiles: manifest.fileCount,
                maxBytes: manifest.totalBytes
              }
            });
            if (stableSandboxJson(inspected) !== stableSandboxJson(manifest)) {
              throw new Error("Sandbox quarantined output no longer matches its receipt.");
            }
            retainedQuarantineNames.add(managedName);
            outputHandles.set(receipt.outputHandle, Object.freeze({
              runId: receipt.runId,
              path: quarantineDirectory,
              output: inspected
            }));
          } catch {
            providerResolver?.quarantine?.();
            await removeOwnedTree(quarantineDirectory).catch(() => {});
            await storeReceipt(Object.freeze({
              ...receipt,
              status: "failed",
              reasonCode: SANDBOX_DENIAL_REASONS.OUTPUT_INVALID,
              failureStage: "recovered_output_integrity_failed",
              outputHandle: "",
              outputDisposition: "rejected",
              outputManifest: null,
              finishedAt: now().toISOString()
            }));
          }
        }
      }
      await reconcileManagedDirectories(runsRoot, "run-");
      await reconcileManagedDirectories(quarantineRoot, "run-", retainedQuarantineNames);
      recovered = true;
      return Object.freeze({ recovered: true, receiptCount: receipts.size });
    })().finally(() => {
      recoveryPromise = null;
    });
    return recoveryPromise;
  }

  async function execute(rawRequest, {
    resolveInput,
    currentGovernance = null,
    pluginId = "",
    internalAuthority = null,
    signal: externalSignal = null
  } = {}) {
    await recover();
    let request;
    try {
      request = normalizeSandboxExecutionRequest(rawRequest);
    } catch {
      return deny(null, SANDBOX_DENIAL_REASONS.REQUEST_INVALID);
    }
    const requestDigest = sandboxDigest(request);
    const idempotencyDigest = idempotencyIdentity(request.idempotencyKey);
    const existingRunId = idempotency.get(idempotencyDigest);
    if (existingRunId) {
      const activeRecord = active.get(existingRunId);
      if (activeRecord) {
        if (sandboxDigest(activeRecord.context.request) !== requestDigest) {
          return deny(request, SANDBOX_DENIAL_REASONS.REQUEST_INVALID);
        }
        return activeRecord.promise;
      }
      const existing = receipts.get(existingRunId);
      if (existing?.requestDigest !== requestDigest) return deny(request, SANDBOX_DENIAL_REASONS.REQUEST_INVALID);
      return existing || deny(request, SANDBOX_DENIAL_REASONS.RECEIPT_PERSISTENCE_FAILED);
    }
    if (closing) return deny(request, SANDBOX_DENIAL_REASONS.DISABLED);
    if (configured.state === "unconfigured") return deny(request, SANDBOX_DENIAL_REASONS.UNCONFIGURED);
    if (configured.state === "disabled") return deny(request, SANDBOX_DENIAL_REASONS.DISABLED);
    if (configured.state !== "enabled") return deny(request, SANDBOX_DENIAL_REASONS.CONFIGURATION_INVALID);

    if (!providerResolver || typeof providerResolver.resolve !== "function") {
      return deny(request, SANDBOX_DENIAL_REASONS.BACKEND_MISSING);
    }
    let resolution = internalAuthority?.[internalResolution] || null;
    if (!resolution) {
      try {
        resolution = await providerResolver.resolve();
      } catch (error) {
        return deny(request, normalizeReason(error, SANDBOX_DENIAL_REASONS.BACKEND_UNHEALTHY));
      }
    }
    if (!resolution?.backend || !resolution?.descriptor) {
      return deny(request, SANDBOX_DENIAL_REASONS.BACKEND_MISSING);
    }
    if (typeof providerResolver.validate !== "function" || providerResolver.validate(resolution) !== true) {
      return deny(request, SANDBOX_DENIAL_REASONS.BACKEND_UNHEALTHY);
    }
    const { backend, descriptor } = resolution;
    const profile = profiles instanceof Map ? profiles.get(configured.profileId) : profiles?.[configured.profileId];
    const admission = compileSandboxAdmission({
      request,
      configuration,
      profile,
      backendDescriptor: descriptor,
      selectedBackendId: descriptor.id,
      currentGovernance: currentGovernance || request.governance,
      now: now()
    });
    if (!admission.admitted) return deny(request, admission.reasonCode);

    const concurrentRunId = idempotency.get(idempotencyDigest);
    if (concurrentRunId) {
      const concurrent = receipts.get(concurrentRunId);
      if (concurrent?.requestDigest && concurrent.requestDigest !== requestDigest) {
        return deny(request, SANDBOX_DENIAL_REASONS.REQUEST_INVALID);
      }
      const running = active.get(concurrentRunId)?.promise;
      if (concurrent || running) return concurrent || running;
      return deny(request, SANDBOX_DENIAL_REASONS.RECEIPT_PERSISTENCE_FAILED);
    }

    if (profile.requiresApproval === true) {
      const currentTime = now().getTime();
      for (const [approvalRef, expiresAt] of consumedApprovals) {
        if (expiresAt <= currentTime) consumedApprovals.delete(approvalRef);
      }
      const approvalRefDigest = approvalIdentity(request.governance.approvalRef);
      if (consumedApprovals.has(approvalRefDigest)) {
        return deny(request, SANDBOX_DENIAL_REASONS.APPROVAL_REUSED);
      }
      if (consumedApprovals.size >= MAX_CONSUMED_APPROVALS) {
        return deny(request, SANDBOX_DENIAL_REASONS.APPROVAL_CAPACITY_EXHAUSTED);
      }
      consumedApprovals.set(
        approvalRefDigest,
        Date.parse(request.governance.approvalExpiresAt)
      );
    }

    const runId = `run:${requestDigest.slice(0, 24)}`;
    idempotency.set(idempotencyDigest, runId);
    const controller = new AbortController();
    const startedAt = now().toISOString();
    const runDirectory = path.join(runsRoot, runId.replace(":", "-"));
    const paths = Object.freeze({
      inputRoot: path.join(runDirectory, "input"),
      scratchRoot: path.join(runDirectory, "scratch"),
      outputRoot: path.join(runDirectory, "output")
    });
    const context = { runId, request, policy: admission.policy, paths, signal: controller.signal };
    const abortFromExternal = () => {
      controller.abort(SANDBOX_DENIAL_REASONS.CANCELLED);
      void Promise.resolve(backend.cancel?.(context)).catch(() => {});
    };
    externalSignal?.addEventListener?.("abort", abortFromExternal, { once: true });
    if (externalSignal?.aborted) abortFromExternal();
    const deadlineDelay = Math.max(1, Math.min(
      request.resources.wallTimeMs,
      Date.parse(request.deadlineAt) - now().getTime()
    ));
    let timedOut = false;
    let timeout = null;
    const preliminaryReceipt = Object.freeze({
      schemaVersion: SANDBOX_RECEIPT_SCHEMA,
      runId,
      requestDigest,
      idempotencyDigest,
      approvalRefDigest: request.governance.approvalRef
        ? approvalIdentity(request.governance.approvalRef)
        : "",
      approvalExpiresAt: request.governance.approvalExpiresAt,
      authorizationContextDigest: request.governance.authorizationContextDigest,
      approvalBindingDigest: request.governance.approvalBindingDigest,
      policyDigest: admission.policyDigest,
      backendRef: controlledRef(descriptor.id, "sandbox-backend"),
      providerGeneration: Number(resolution.generation || 0),
      providerConformanceDigest: String(descriptor.conformanceReceipt?.digest || ""),
      receiptRequirement: String(admission.policy.receiptRequirement || ""),
      pluginRef: pluginId ? controlledRef(pluginId, "plugin") : "",
      principalRef: controlledRef(request.principal, "principal"),
      artifactDigest: request.artifact.digest,
      inputDigests: Object.freeze(request.inputs.map((entry) => entry.digest)),
      outputDigest: "",
      outputHandle: "",
      outputManifest: null,
      status: "provisioning",
      reasonCode: "sandbox_provisioning",
      failureStage: "",
      runtimeState: "provisioning",
      cleanupState: "pending",
      outputDisposition: "none",
      dispositionState: "none",
      pendingDisposition: "",
      owningOperationReceiptDigest: "",
      resourceTotals: validatedResourceTotals({}, request.resources),
      startedAt,
      finishedAt: ""
    });

    const promise = (async () => {
      try {
        await storeReceipt(preliminaryReceipt);
      } catch {
        return Object.freeze({
          ...preliminaryReceipt,
          status: "failed",
          reasonCode: SANDBOX_DENIAL_REASONS.RECEIPT_PERSISTENCE_FAILED,
          runtimeState: "not_started",
          cleanupState: "not_required",
          finishedAt: now().toISOString()
        });
      }
      let runtimeState = "failed";
      let cleanupState = "cleanup_failed";
      let reasonCode = SANDBOX_DENIAL_REASONS.RUNTIME_FAILED;
      let failureStage = "";
      let activeFailureStage = "input_staging_failed";
      let output = null;
      let resourceTotals = validatedResourceTotals({}, request.resources);
      try {
        await ensurePrivateDirectory(paths.inputRoot);
        await ensurePrivateDirectory(paths.scratchRoot);
        await ensurePrivateDirectory(paths.outputRoot);
        await materializeInputs({ request, resolveInput, inputRoot: paths.inputRoot });
        if (controller.signal.aborted) {
          throw Object.assign(new Error("Sandbox execution was cancelled before workload start."), {
            code: SANDBOX_DENIAL_REASONS.CANCELLED
          });
        }
        if (providerResolver.validate(resolution) !== true) {
          throw Object.assign(new Error("Sandbox provider selection is no longer current."), {
            code: SANDBOX_DENIAL_REASONS.BACKEND_UNHEALTHY
          });
        }
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort(SANDBOX_DENIAL_REASONS.TIMED_OUT);
          void Promise.resolve(backend.cancel?.(context)).catch(() => {});
        }, deadlineDelay);
        timeout.unref?.();
        activeFailureStage = "sandbox_backend_failed";
        const result = await backend.run(context);
        resourceTotals = validatedResourceTotals(result?.resourceTotals, request.resources);
        if (controller.signal.aborted) {
          runtimeState = timedOut ? "timed_out" : "cancelled";
          reasonCode = timedOut ? SANDBOX_DENIAL_REASONS.TIMED_OUT : SANDBOX_DENIAL_REASONS.CANCELLED;
        } else if (result?.status === "succeeded") {
          runtimeState = "succeeded";
          reasonCode = "sandbox_succeeded";
          activeFailureStage = "output_validation_failed";
          try {
            output = await inspectOutput({ outputRoot: paths.outputRoot, outputs: request.outputs });
          } catch (error) {
            error.failureStage = "output_validation_failed";
            throw error;
          }
        } else {
          runtimeState = "failed";
          reasonCode = normalizeReason(result, SANDBOX_DENIAL_REASONS.RUNTIME_FAILED);
        }
      } catch (error) {
        resourceTotals = error?.resourceTotals || failedResourceTotals(error, request.resources);
        runtimeState = controller.signal.aborted
          ? timedOut ? "timed_out" : "cancelled"
          : "failed";
        reasonCode = controller.signal.aborted
          ? timedOut ? SANDBOX_DENIAL_REASONS.TIMED_OUT : SANDBOX_DENIAL_REASONS.CANCELLED
          : normalizeReason(error, SANDBOX_DENIAL_REASONS.RUNTIME_FAILED);
        const reportedFailureStage = String(error?.failureStage || "");
        failureStage = /^(?:oci_(?:create|start|inspect|command|workload)_failed|custody_(?:object_missing|promotion_(?:owner_mismatch|digest_mismatch|idempotency_conflict|replay_unavailable|contract_invalid|failed)|envelope_authentication_failed)|input_staging_failed|sandbox_backend_failed|resource_budget_exceeded|output_validation_failed)$/u.test(
          reportedFailureStage
        ) ? reportedFailureStage : activeFailureStage;
      } finally {
        if (timeout) clearTimeout(timeout);
        try {
          const cleanup = await backend.cleanup(context);
          cleanupState = cleanup?.destroyed === true ? "destroyed" : "cleanup_failed";
        } catch {
          cleanupState = "cleanup_failed";
        }
      }

      let outputHandle = "";
      let outputDisposition = "none";
      if (runtimeState === "succeeded" && cleanupState === "destroyed" && output) {
        await ensurePrivateDirectory(quarantineRoot);
        const quarantineDirectory = path.join(quarantineRoot, runId.replace(":", "-"));
        await removeOwnedTree(quarantineDirectory).catch(() => {});
        await fs.chmod(paths.outputRoot, 0o700).catch(() => {});
        await fs.rename(paths.outputRoot, quarantineDirectory);
        await fs.chmod(quarantineDirectory, 0o500).catch(() => {});
        outputHandle = controlledRef(`${runId}:${output.digest}`, "sandbox-output");
        outputHandles.set(outputHandle, Object.freeze({ runId, path: quarantineDirectory, output }));
        outputDisposition = "quarantined";
      }
      try {
        await removeOwnedTree(runDirectory);
      } catch {
        cleanupState = "cleanup_failed";
      }
      if (cleanupState !== "destroyed") {
        providerResolver.quarantine?.();
        runtimeState = "failed";
        reasonCode = SANDBOX_DENIAL_REASONS.CLEANUP_FAILED;
        outputDisposition = "rejected";
        if (outputHandle) {
          const record = outputHandles.get(outputHandle);
          outputHandles.delete(outputHandle);
          outputHandle = "";
          if (record?.path) await removeOwnedTree(record.path).catch(() => {});
        }
      }
      const finishedAt = now().toISOString();
      const succeeded = runtimeState === "succeeded" && cleanupState === "destroyed";
      const receipt = Object.freeze({
        ...preliminaryReceipt,
        outputDigest: succeeded ? output?.digest || sandboxDigest([]) : "",
        outputHandle: succeeded ? outputHandle : "",
        outputManifest: succeeded ? output : null,
        status: succeeded ? "output_quarantined" : runtimeState,
        reasonCode: succeeded ? "sandbox_output_quarantined" : reasonCode,
        failureStage,
        runtimeState,
        cleanupState,
        outputDisposition,
        resourceTotals,
        startedAt,
        finishedAt
      });
      try {
        return await storeReceipt(receipt);
      } catch {
        if (outputHandle) {
          const record = outputHandles.get(outputHandle);
          outputHandles.delete(outputHandle);
          if (record?.path) await removeOwnedTree(record.path).catch(() => {});
        }
        const failedReceipt = Object.freeze({
          ...receipt,
          status: "failed",
          reasonCode: SANDBOX_DENIAL_REASONS.RECEIPT_PERSISTENCE_FAILED,
          outputHandle: "",
          outputDisposition: "rejected"
        });
        receipts.set(runId, failedReceipt);
        return failedReceipt;
      }
    })().finally(() => {
      externalSignal?.removeEventListener?.("abort", abortFromExternal);
      active.delete(runId);
    });
    active.set(runId, { controller, backend, context, promise, pluginId: String(pluginId || "") });
    return promise;
  }

  async function executeOpaque(rawRequest, opaqueInputs = [], options = {}) {
    let request;
    try {
      request = normalizeSandboxExecutionRequest(rawRequest);
    } catch {
      return deny(null, SANDBOX_DENIAL_REASONS.REQUEST_INVALID);
    }
    if (!opaqueArtifactCustody?.promote || !Array.isArray(opaqueInputs)) {
      return deny(request, SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED);
    }
    let resolution;
    try {
      resolution = await providerResolver?.resolve?.();
    } catch (error) {
      return deny(request, normalizeReason(error, SANDBOX_DENIAL_REASONS.BACKEND_UNHEALTHY));
    }
    const providerReceipt = resolution?.descriptor?.conformanceReceipt;
    if (!providerReceipt) return deny(request, SANDBOX_DENIAL_REASONS.BACKEND_MISSING);
    const byHandle = new Map(opaqueInputs.map((input) => [String(input?.handle || ""), input]));
    return execute(request, {
      ...options,
      internalAuthority: Object.freeze({ [internalResolution]: resolution }),
      resolveInput: async (declared) => {
        const opaqueInput = byHandle.get(declared.handle);
        if (!opaqueInput || !Array.isArray(opaqueInput.files) || opaqueInput.files.length === 0) {
          throw Object.assign(new Error("Opaque sandbox input is unavailable."), {
            code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED
          });
        }
        const files = [];
        for (const [index, file] of opaqueInput.files.entries()) {
          files.push({
            path: file.path,
            digest: file.digest,
            sensitive: true,
            stageContent: async (sink) => {
              try {
                return await opaqueArtifactCustody.promote({
                  schemaVersion: file.promotionSchemaVersion,
                  handle: file.custodyRef,
                  contentDigest: file.digest,
                  envelopeDigest: file.envelopeDigest,
                  authorizationRef: request.governance.grantRef,
                  approvalRef: request.governance.approvalRef,
                  policyRevision: request.governance.policyRevision,
                  providerReceipt,
                  sandboxAvailable: true,
                  idempotencyKey: `${request.idempotencyKey}:opaque:${index}`,
                  subjectRef: request.principal.subjectRef,
                  tenantRef: request.principal.tenantRef,
                  workspaceRef: request.principal.workspaceRef
                }, sink);
              } catch (error) {
                if (error && typeof error === "object") {
                  error.failureStage = opaqueCustodyFailureStage(error);
                }
                throw error;
              }
            }
          });
        }
        const promotionDigest = custodyPromotionSetDigest({
          files: opaqueInput.files.map((file) => ({
            path: file.path,
            custodyRef: file.custodyRef,
            contentDigest: file.digest,
            envelopeDigest: file.envelopeDigest,
            promotionSchemaVersion: file.promotionSchemaVersion
          }))
        });
        if (promotionDigest !== String(opaqueInput.promotionDigest || "").toLowerCase()) {
          throw Object.assign(new Error("Opaque sandbox promotion digest mismatch."), {
            code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED
          });
        }
        const authorizationDigest = custodyPromotionAuthorizationDigest({
          promotionDigest,
          ownerBinding: request.principal,
          governance: options.currentGovernance || request.governance
        });
        if (authorizationDigest !== String(opaqueInput.authorizationDigest || "").toLowerCase()) {
          throw Object.assign(new Error("Opaque sandbox authorization digest mismatch."), {
            code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED
          });
        }
        const digest = sandboxDigest(files.map((file) => ({ path: file.path, digest: file.digest }))
          .sort((left, right) => left.path.localeCompare(right.path)));
        if (digest !== declared.digest) {
          throw Object.assign(new Error("Opaque sandbox input digest mismatch."), {
            code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED
          });
        }
        return { files, digest };
      }
    });
  }

  async function executeConfiguredOpaque(rawRequest, opaqueInputs = [], options = {}) {
    const bound = bindConfiguredWorkload(rawRequest);
    if (bound.receipt) return bound.receipt;
    return executeOpaque(bound.request, opaqueInputs, {
      ...options,
      currentGovernance: bindConfiguredCurrentGovernance(bound.request, options.currentGovernance)
    });
  }

  function bindConfiguredCurrentGovernance(request, currentGovernance) {
    const governance = currentGovernance || request.governance;
    if (!request.governance.approvalRef || governance.approvalRequestDigest) return governance;
    return Object.freeze({
      ...governance,
      approvalRequestDigest: request.governance.approvalRequestDigest
    });
  }

  function bindConfiguredWorkload(rawRequest) {
    let configuredRequest;
    try {
      configuredRequest = normalizeSandboxConfiguredWorkloadRequest(rawRequest);
    } catch {
      return { receipt: deny(null, SANDBOX_DENIAL_REASONS.REQUEST_INVALID) };
    }
    if (configured.state === "unconfigured") return { receipt: deny(null, SANDBOX_DENIAL_REASONS.UNCONFIGURED) };
    if (configured.state === "disabled") return { receipt: deny(null, SANDBOX_DENIAL_REASONS.DISABLED) };
    if (configured.state !== "enabled") return { receipt: deny(null, SANDBOX_DENIAL_REASONS.CONFIGURATION_INVALID) };
    const profile = profiles instanceof Map ? profiles.get(configured.profileId) : profiles?.[configured.profileId];
    const workload = profile?.workloads?.[configuredRequest.workloadKind];
    const artifactDigests = [...new Set(
      (Array.isArray(workload?.artifactDigests) ? workload.artifactDigests : [])
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean)
    )];
    if (
      !workload ||
      artifactDigests.length !== 1 ||
      !/^[a-f0-9]{64}$/u.test(artifactDigests[0]) ||
      !String(workload.runtimeKind || "").trim() ||
      !String(workload.entryPoint || "").trim()
    ) {
      return { receipt: deny(null, SANDBOX_DENIAL_REASONS.CONFIGURATION_INVALID) };
    }
    let request;
    try {
      request = bindSandboxConfiguredWorkloadRequest(configuredRequest, {
        digest: artifactDigests[0],
        runtimeKind: workload.runtimeKind,
        entryPoint: workload.entryPoint
      });
      if (request.governance.approvalRef && !request.governance.approvalRequestDigest) {
        const draft = {
          ...request,
          governance: { ...request.governance, approvalRequestDigest: "" }
        };
        request = normalizeSandboxExecutionRequest({
          ...draft,
          governance: {
            ...draft.governance,
            approvalRequestDigest: sandboxApprovalRequestDigest(draft)
          }
        });
      }
    } catch {
      return { receipt: deny(null, SANDBOX_DENIAL_REASONS.CONFIGURATION_INVALID) };
    }
    return { request };
  }

  async function executeConfigured(rawRequest, resolveInput, options = {}) {
    const bound = bindConfiguredWorkload(rawRequest);
    if (bound.receipt) return bound.receipt;
    return execute(bound.request, {
      ...options,
      resolveInput,
      currentGovernance: bindConfiguredCurrentGovernance(bound.request, options.currentGovernance)
    });
  }

  async function cancel(runId, { pluginId = "" } = {}) {
    const reference = String(runId || "");
    const resolvedRunId = active.has(reference) ? reference : idempotency.get(idempotencyIdentity(reference));
    const record = resolvedRunId ? active.get(resolvedRunId) : null;
    if (!record) return false;
    if (pluginId && record.pluginId !== pluginId) return false;
    record.controller.abort(SANDBOX_DENIAL_REASONS.CANCELLED);
    await record.backend.cancel?.(record.context).catch?.(() => {});
    return true;
  }

  function getReceipt(runId, { pluginId = "" } = {}) {
    const receipt = receipts.get(String(runId || "")) || null;
    if (receipt && pluginId && receipt.pluginRef !== controlledRef(pluginId, "plugin")) return null;
    return receipt;
  }

  function getStatus(runId, { pluginId = "" } = {}) {
    const reference = String(runId || "");
    const id = receipts.has(reference) || active.has(reference)
      ? reference
      : idempotency.get(idempotencyIdentity(reference)) || reference;
    const receipt = receipts.get(id);
    if (receipt) {
      if (pluginId && receipt.pluginRef !== controlledRef(pluginId, "plugin")) return null;
      return publicStatus(receipt);
    }
    const activeRecord = active.get(id);
    if (activeRecord && (!pluginId || activeRecord.pluginId === pluginId)) {
      return Object.freeze({
        runId: id,
        status: "running",
        runtimeState: "running",
        cleanupState: "pending",
        outputDisposition: "none",
        reasonCode: ""
      });
    }
    return null;
  }

  function resolveQuarantinedOutput(outputHandle, { pluginId = "" } = {}) {
    const record = outputHandles.get(String(outputHandle || ""));
    if (!record) return null;
    const receipt = receipts.get(record.runId);
    if (pluginId && receipt?.pluginRef !== controlledRef(pluginId, "plugin")) return null;
    return Object.freeze({
      runId: record.runId,
      output: record.output,
      readFile: async (relativePath) => {
        const normalized = safeFilePath(relativePath);
        const targetPath = path.resolve(record.path, normalized);
        const rootPath = path.resolve(record.path);
        if (!targetPath.startsWith(`${rootPath}${path.sep}`)) throw new Error("Sandbox output path is invalid.");
        return fs.readFile(targetPath);
      }
    });
  }

  async function disposeOutput(outputHandle, disposition = "rejected", {
    pluginId = "",
    owningOperationReceiptDigest = ""
  } = {}) {
    const handle = String(outputHandle || "");
    const record = outputHandles.get(handle);
    const receipt = record ? receipts.get(record.runId) : null;
    if (
      !record ||
      (pluginId && receipt?.pluginRef !== controlledRef(pluginId, "plugin")) ||
      !["committed", "rejected", "compensated"].includes(disposition) ||
      !/^[a-f0-9]{64}$/u.test(String(owningOperationReceiptDigest || ""))
    ) return false;
    const disposingReceipt = Object.freeze({
      ...receipt,
      status: "output_quarantined",
      reasonCode: "sandbox_output_disposition_pending",
      outputDisposition: "quarantined",
      dispositionState: "disposing",
      pendingDisposition: disposition,
      owningOperationReceiptDigest: String(owningOperationReceiptDigest)
    });
    await storeReceipt(disposingReceipt);
    outputHandles.delete(handle);
    await removeOwnedTree(record.path);
    await storeReceipt(Object.freeze({
      ...disposingReceipt,
      status: disposition === "committed" ? "succeeded" : disposition,
      reasonCode: `sandbox_output_${disposition}`,
      outputHandle: "",
      outputDisposition: disposition,
      dispositionState: "complete",
      pendingDisposition: "",
      finishedAt: now().toISOString()
    }));
    return true;
  }

  async function close() {
    closing = true;
    const runs = [...active.values()];
    for (const record of runs) {
      record.controller.abort(SANDBOX_DENIAL_REASONS.CANCELLED);
      await record.backend.cancel?.(record.context).catch?.(() => {});
    }
    await Promise.allSettled(runs.map((record) => record.promise));
    if (active.size > 0) throw new Error("Sandbox execution broker did not close cleanly.");
    outputHandles.clear();
    let providerCloseError = null;
    try {
      await providerResolver?.close?.();
    } catch (error) {
      providerCloseError = error;
    }
    if (providerCloseError) {
      throw new AggregateError(
        [
          ...(providerCloseError ? [providerCloseError] : [])
        ],
        "Sandbox broker did not close cleanly."
      );
    }
  }

  return Object.freeze({
    execute,
    executeConfigured,
    executeOpaque,
    executeConfiguredOpaque,
    cancel,
    getStatus,
    getReceipt,
    resolveQuarantinedOutput,
    disposeOutput,
    recover,
    close,
    configurationState: configured.state,
    publicAvailability: () => providerResolver?.publicProjection?.() || Object.freeze({ sandboxAvailable: false }),
    administrativeAvailability: () => providerResolver?.administrativeProjection?.() ||
      Object.freeze({ state: configured.state === "enabled" ? "unavailable" : configured.state }),
    requiredBackendRestrictions: REQUIRED_BACKEND_RESTRICTIONS
  });
}
