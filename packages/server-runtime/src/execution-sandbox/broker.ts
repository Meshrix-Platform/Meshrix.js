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

const REQUIRED_BACKEND_RESTRICTIONS: readonly any[] = Object.freeze([
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
const MAX_CONSUMED_APPROVALS: any = 16_384;
const MAX_RECOVERED_RECEIPTS: any = 16_384;
const MAX_RECEIPT_BYTES: any = 256 * 1024;

function idempotencyIdentity(value?: any) : any {
  return sandboxDigest(String(value || ""));
}

function approvalIdentity(value?: any) : any {
  return sandboxDigest(String(value || ""));
}

const OPAQUE_CUSTODY_FAILURE_STAGES: any = new Set<any>([
  "custody_object_missing",
  "custody_promotion_owner_mismatch",
  "custody_promotion_digest_mismatch",
  "custody_promotion_idempotency_conflict",
  "custody_promotion_replay_unavailable",
  "custody_envelope_authentication_failed"
]);

function opaqueCustodyFailureStage(error?: any) : any {
  const code: any = String(error?.code || "").trim();
  if (OPAQUE_CUSTODY_FAILURE_STAGES.has(code)) return code;
  return error instanceof TypeError
    ? "custody_promotion_contract_invalid"
    : "custody_promotion_failed";
}

function normalizeReason(error?: any, fallback?: any) : any {
  const code: any = String(error?.code || "").trim();
  return (Object.values(SANDBOX_DENIAL_REASONS) as any[]).includes(code) ? code : fallback;
}

function safeFilePath(value?: any) : any {
  const normalized: any = String(value || "").trim().replace(/\\/gu, "/");
  if (
    !normalized ||
    normalized.length > 1024 ||
    normalized.startsWith("/") ||
    normalized.startsWith("~") ||
    normalized.split("/").some((segment?: any) : any => !segment || segment === "." || segment === "..")
  ) throw Object.assign(new Error("Sandbox file path is invalid."), { code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED });
  return normalized;
}

function contentBuffer(file?: any) : any {
  if (Buffer.isBuffer(file?.content)) return Buffer.from(file.content);
  if (typeof file?.content === "string") return Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
  throw Object.assign(new Error("Sandbox input content is invalid."), { code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED });
}

async function stageInputFile({ rawFile, targetPath, maxBytes }: Record<string, any>) : Promise<any> {
  const temporaryPath: any = `${targetPath}.pending-${crypto.randomUUID()}`;
  const handle: any = await fs.open(temporaryPath, "wx", 0o600);
  const hash: any = crypto.createHash("sha256");
  let bytes: any = 0;
  const writeChunk: any = async (value?: any) : Promise<any> => {
    const chunk: any = Buffer.isBuffer(value) ? value : Buffer.from(value || "");
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
      const buffer: any = contentBuffer(rawFile);
      try { await writeChunk(buffer); } finally {
        buffer.fill(0);
        if (rawFile.sensitive === true && Buffer.isBuffer(rawFile.content)) rawFile.content.fill(0);
      }
    }
    await handle.sync();
    await handle.close();
    const digest: any = hash.digest("hex");
    if (rawFile.digest && String(rawFile.digest).toLowerCase() !== digest) {
      throw Object.assign(new Error("Sandbox input file digest mismatch."), {
        code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED
      });
    }
    await fs.chmod(temporaryPath, 0o444);
    await fs.rename(temporaryPath, targetPath);
    return { digest, bytes };
  } catch (error: any) {
    await handle.close().catch(() : any => {});
    await fs.rm(temporaryPath, { force: true }).catch(() : any => {});
    throw error;
  }
}

async function ensurePrivateDirectory(directoryPath?: any) : Promise<any> {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const stat: any = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Sandbox private directory boundary is invalid.");
  }
  await fs.chmod(directoryPath, 0o700).catch(() : any => {});
}

async function removeOwnedTree(directoryPath?: any) : Promise<any> {
  async function restoreOwnerWrite(currentPath?: any) : Promise<any> {
    let currentStat: any;
    try {
      currentStat = await fs.lstat(currentPath);
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) return;
    let entries: any[] = [];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await fs.chmod(currentPath, 0o700).catch(() : any => {});
    for (const entry of entries) {
      const childPath: any = path.join(currentPath, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await restoreOwnerWrite(childPath);
      else if (!entry.isSymbolicLink()) await fs.chmod(childPath, 0o600).catch(() : any => {});
    }
  }
  await restoreOwnerWrite(directoryPath);
  await fs.rm(directoryPath, { recursive: true, force: true });
}

async function materializeInputs({ request, resolveInput, inputRoot }: Record<string, any>) : Promise<any> {
  if (typeof resolveInput !== "function") {
    throw Object.assign(new Error("Sandbox input resolver is unavailable."), {
      code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED
    });
  }
  const staged: any[] = [];
  const limits: Readonly<Record<string, any>> = Object.freeze({
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
  const consumed: Record<string, any> = { diskBytes: 0, fileCount: 0, inodes: 0 };
  for (let index: any = 0; index < request.inputs.length; index += 1) {
    const declared: any = request.inputs[index];
    const resolved: any = await resolveInput(Object.freeze({
      handle: declared.handle,
      digest: declared.digest,
      readOnly: true
    }));
    if (!resolved || !Array.isArray(resolved.files) || resolved.files.length === 0) {
      throw Object.assign(new Error("Sandbox input resolver returned no immutable files."), {
        code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED
      });
    }
    const inputDirectory: any = path.join(inputRoot, String(index));
    await ensurePrivateDirectory(inputDirectory);
    const manifest: any[] = [];
    let totalBytes: any = 0;
    for (const rawFile of resolved.files) {
      if (consumed.fileCount >= limits.fileCount || consumed.inodes >= limits.inodes) {
        throw Object.assign(new Error("Sandbox inputs exceed the admitted file budget."), {
          code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED
        });
      }
      const relativePath: any = safeFilePath(rawFile.path);
      const targetPath: any = path.join(inputDirectory, relativePath);
      const normalizedTarget: any = path.resolve(targetPath);
      const normalizedRoot: any = path.resolve(inputDirectory);
      if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
        throw Object.assign(new Error("Sandbox input path escapes its staging boundary."), {
          code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED
        });
      }
      await ensurePrivateDirectory(path.dirname(targetPath));
      const stagedFile: any = await stageInputFile({
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
    manifest.sort((left?: any, right?: any) : any => left.path.localeCompare(right.path));
    const digest: any = sandboxDigest(manifest);
    if (digest !== declared.digest || (resolved.digest && String(resolved.digest).toLowerCase() !== digest)) {
      throw Object.assign(new Error("Sandbox immutable input digest mismatch."), {
        code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED
      });
    }
    await fs.chmod(inputDirectory, 0o555).catch(() : any => {});
    staged.push(Object.freeze({ index, digest, fileCount: manifest.length, totalBytes }));
  }
  await fs.chmod(inputRoot, 0o555).catch(() : any => {});
  return Object.freeze(staged);
}

export { materializeInputs as materializeSandboxInputs };

async function inspectOutput({ outputRoot, outputs }: Record<string, any>) : Promise<any> {
  const files: any[] = [];
  let totalBytes: any = 0;
  async function walk(directoryPath?: any, relativeRoot: any = "") : Promise<any> {
    const entries: any = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath: any = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      const absolutePath: any = path.join(directoryPath, entry.name);
      const stat: any = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw Object.assign(new Error("Sandbox output contains an unsupported filesystem object."), {
          code: SANDBOX_DENIAL_REASONS.OUTPUT_INVALID
        });
      }
      if (stat.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      const type: any = path.posix.extname(relativePath).toLowerCase().replace(/^\./u, "") || "none";
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
      const buffer: any = await fs.readFile(absolutePath);
      files.push({
        path: relativePath,
        digest: crypto.createHash("sha256").update(buffer).digest("hex"),
        bytes: buffer.length
      });
      await fs.chmod(absolutePath, 0o400).catch(() : any => {});
    }
  }
  await walk(outputRoot);
  files.sort((left?: any, right?: any) : any => left.path.localeCompare(right.path));
  await fs.chmod(outputRoot, 0o500).catch(() : any => {});
  return Object.freeze({
    digest: sandboxDigest(files.map(({ path: filePath, digest }: Record<string, any>) : any => ({ path: filePath, digest }))),
    files: Object.freeze(files),
    fileCount: files.length,
    totalBytes
  });
}

function validatedResourceTotals(value: Record<string, any> = {}, resources: Record<string, any> = {}) : any {
  const totals: Record<string, any> = {};
  const measuredTotals: Record<string, any> = {};
  for (const key of Object.keys(resources)) {
    const measured: any = Number(value?.[key] || 0);
    if (!Number.isFinite(measured) || measured < 0) {
      throw Object.assign(new Error("Sandbox backend returned invalid resource measurements."), {
        code: SANDBOX_DENIAL_REASONS.RUNTIME_FAILED,
        failureStage: "resource_budget_exceeded"
      });
    }
    measuredTotals[key] = measured;
    totals[key] = Math.trunc(measured);
  }
  const frozenTotals: any = Object.freeze(totals);
  if (Object.keys(resources).some((key?: any) : any => measuredTotals[key] > resources[key])) {
    throw Object.assign(new Error("Sandbox backend exceeded an admitted resource budget."), {
      code: SANDBOX_DENIAL_REASONS.RUNTIME_FAILED,
      failureStage: "resource_budget_exceeded",
      resourceTotals: Object.freeze(measuredTotals)
    });
  }
  return frozenTotals;
}

function failedResourceTotals(error?: any, resources: Record<string, any> = {}) : any {
  const totals: any = Object.fromEntries(Object.keys(resources).map((key?: any) : any => [key, 0]));
  if (error?.outputBytes !== undefined) {
    const measuredLogBytes: any = Number(error.outputBytes);
    if (Number.isFinite(measuredLogBytes) && measuredLogBytes >= 0) {
      totals.logBytes = Math.trunc(measuredLogBytes);
    }
  }
  return Object.freeze(totals);
}

function publicStatus(receipt?: any) : any {
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
  now = () : any => new Date(),
  persistReceipt = null,
  loadReceipts = null,
  audit = null
}: Record<string, any> = {}) : any {
  const configured: any = normalizeSandboxConfiguration(configuration);
  const active: any = new Map<any, any>();
  const receipts: any = new Map<any, any>();
  const idempotency: any = new Map<any, any>();
  const consumedApprovals: any = new Map<any, any>();
  const outputHandles: any = new Map<any, any>();
  const internalResolution: any = Symbol("sandbox-internal-resolution");
  let closing: any = false;

  const root: any = path.join(String(userDataPath || ""), "execution-sandbox");
  const runsRoot: any = path.join(root, "runs");
  const quarantineRoot: any = path.join(root, "quarantine");
  const receiptsRoot: any = path.join(root, "receipts");
  let recovered: any = false;
  let recoveryPromise: any = null;

  function recoveredReceipt(value?: any) : any {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Sandbox receipt recovery input is invalid.");
    }
    const serialized: any = JSON.stringify(value);
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

  async function readPersistedReceipts() : Promise<any> {
    if (typeof loadReceipts === "function") {
      const loaded: any = await loadReceipts();
      if (!Array.isArray(loaded) || loaded.length > MAX_RECOVERED_RECEIPTS) {
        throw new Error("Sandbox receipt recovery capacity is invalid.");
      }
      return loaded.map(recoveredReceipt);
    }
    let entries: any;
    try {
      entries = await fs.readdir(receiptsRoot, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    if (entries.length > MAX_RECOVERED_RECEIPTS) {
      throw new Error("Sandbox receipt recovery capacity is exhausted.");
    }
    const output: any[] = [];
    for (const entry of entries.sort((left?: any, right?: any) : any => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^(?:run|denial)_[a-f0-9]{24}\.json$/u.test(entry.name)) {
        throw new Error("Sandbox receipt storage contains an unsupported artifact.");
      }
      const receiptPath: any = path.join(receiptsRoot, entry.name);
      const stat: any = await fs.lstat(receiptPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECEIPT_BYTES) {
        throw new Error("Sandbox receipt storage artifact is invalid.");
      }
      output.push(recoveredReceipt(JSON.parse(await fs.readFile(receiptPath, "utf8"))));
    }
    return output;
  }

  async function reconcileManagedDirectories(directoryPath?: any, prefix?: any, retainedNames: any = new Set<any>()) : Promise<any> {
    let entries: any;
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch (error: any) {
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

  async function storeReceipt(receipt?: any) : Promise<any> {
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

  async function deny(request?: any, reasonCode?: any) : Promise<any> {
    const receipt: any = createSandboxDenialReceipt({ request, reasonCode, now: now() });
    try {
      return await storeReceipt(receipt);
    } catch {
      return Object.freeze({ ...receipt, reasonCode: SANDBOX_DENIAL_REASONS.RECEIPT_PERSISTENCE_FAILED });
    }
  }

  async function recover() : Promise<any> {
    if (recovered) return Object.freeze({ recovered: true, receiptCount: receipts.size });
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = (async () : Promise<any> => {
      const persisted: any = await readPersistedReceipts();
      const retainedQuarantineNames: any = new Set<any>();
      for (const receipt of persisted) {
        if (receipts.has(receipt.runId)) throw new Error("Sandbox receipt identity is duplicated.");
        receipts.set(receipt.runId, receipt);
        if (receipt.idempotencyDigest) idempotency.set(receipt.idempotencyDigest, receipt.runId);
        const approvalExpiry: any = Date.parse(receipt.approvalExpiresAt || "");
        if (receipt.approvalRefDigest && Number.isFinite(approvalExpiry) && approvalExpiry > now().getTime()) {
          consumedApprovals.set(receipt.approvalRefDigest, approvalExpiry);
        }
        const managedName: any = receipt.runId.replace(":", "-");
        const runDirectory: any = path.join(runsRoot, managedName);
        const quarantineDirectory: any = path.join(quarantineRoot, managedName);
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
          const disposition: any = String(receipt.pendingDisposition || "");
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
            const manifest: any = receipt.outputManifest;
            if (
              !manifest || !Array.isArray(manifest.files) ||
              manifest.fileCount !== manifest.files.length ||
              manifest.files.length > Number(receipt.outputFileLimit || manifest.fileCount) ||
              !/^[a-f0-9]{64}$/u.test(String(manifest.digest || "")) ||
              manifest.digest !== receipt.outputDigest
            ) throw new Error("Sandbox quarantined output manifest is invalid.");
            const allowedTypes: any[] = [...new Set<any>(manifest.files.map((file?: any) : any =>
              path.posix.extname(String(file.path || "")).toLowerCase().replace(/^\./u, "") || "none"
            ))];
            const inspected: any = await inspectOutput({
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
            await removeOwnedTree(quarantineDirectory).catch(() : any => {});
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
    })().finally(() : any => {
      recoveryPromise = null;
    });
    return recoveryPromise;
  }

  async function execute(rawRequest?: any, {
    resolveInput,
    currentGovernance = null,
    pluginId = "",
    internalAuthority = null,
    signal: externalSignal = null
  }: Record<string, any> = {}) : Promise<any> {
    await recover();
    let request: any;
    try {
      request = normalizeSandboxExecutionRequest(rawRequest);
    } catch {
      return deny(null, SANDBOX_DENIAL_REASONS.REQUEST_INVALID);
    }
    const requestDigest: any = sandboxDigest(request);
    const idempotencyDigest: any = idempotencyIdentity(request.idempotencyKey);
    const existingRunId: any = idempotency.get(idempotencyDigest);
    if (existingRunId) {
      const activeRecord: any = active.get(existingRunId);
      if (activeRecord) {
        if (sandboxDigest(activeRecord.context.request) !== requestDigest) {
          return deny(request, SANDBOX_DENIAL_REASONS.REQUEST_INVALID);
        }
        return activeRecord.promise;
      }
      const existing: any = receipts.get(existingRunId);
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
    let resolution: any = internalAuthority?.[internalResolution] || null;
    if (!resolution) {
      try {
        resolution = await providerResolver.resolve();
      } catch (error: any) {
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
    const profile: any = profiles instanceof Map ? profiles.get(configured.profileId) : profiles?.[configured.profileId];
    const admission: any = compileSandboxAdmission({
      request,
      configuration,
      profile,
      backendDescriptor: descriptor,
      selectedBackendId: descriptor.id,
      currentGovernance: currentGovernance || request.governance,
      now: now()
    });
    if (!admission.admitted) return deny(request, admission.reasonCode);

    const concurrentRunId: any = idempotency.get(idempotencyDigest);
    if (concurrentRunId) {
      const concurrent: any = receipts.get(concurrentRunId);
      if (concurrent?.requestDigest && concurrent.requestDigest !== requestDigest) {
        return deny(request, SANDBOX_DENIAL_REASONS.REQUEST_INVALID);
      }
      const running: any = active.get(concurrentRunId)?.promise;
      if (concurrent || running) return concurrent || running;
      return deny(request, SANDBOX_DENIAL_REASONS.RECEIPT_PERSISTENCE_FAILED);
    }

    if (profile.requiresApproval === true) {
      const currentTime: any = now().getTime();
      for (const [approvalRef, expiresAt] of consumedApprovals) {
        if (expiresAt <= currentTime) consumedApprovals.delete(approvalRef);
      }
      const approvalRefDigest: any = approvalIdentity(request.governance.approvalRef);
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

    const runId: any = `run:${requestDigest.slice(0, 24)}`;
    idempotency.set(idempotencyDigest, runId);
    const controller: any = new AbortController();
    const startedAt: any = now().toISOString();
    const runDirectory: any = path.join(runsRoot, runId.replace(":", "-"));
    const paths: Readonly<Record<string, any>> = Object.freeze({
      inputRoot: path.join(runDirectory, "input"),
      scratchRoot: path.join(runDirectory, "scratch"),
      outputRoot: path.join(runDirectory, "output")
    });
    const context: Record<string, any> = { runId, request, policy: admission.policy, paths, signal: controller.signal };
    const abortFromExternal: any = () : any => {
      controller.abort(SANDBOX_DENIAL_REASONS.CANCELLED);
      void Promise.resolve(backend.cancel?.(context)).catch(() : any => {});
    };
    externalSignal?.addEventListener?.("abort", abortFromExternal, { once: true });
    if (externalSignal?.aborted) abortFromExternal();
    const deadlineDelay: any = Math.max(1, Math.min(
      request.resources.wallTimeMs,
      Date.parse(request.deadlineAt) - now().getTime()
    ));
    let timedOut: any = false;
    let timeout: any = null;
    const preliminaryReceipt: Readonly<Record<string, any>> = Object.freeze({
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
      inputDigests: Object.freeze(request.inputs.map((entry?: any) : any => entry.digest)),
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

    const promise: any = (async () : Promise<any> => {
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
      let runtimeState: any = "failed";
      let cleanupState: any = "cleanup_failed";
      let reasonCode: any = SANDBOX_DENIAL_REASONS.RUNTIME_FAILED;
      let failureStage: any = "";
      let activeFailureStage: any = "input_staging_failed";
      let output: any = null;
      let resourceTotals: any = validatedResourceTotals({}, request.resources);
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
        timeout = setTimeout(() : any => {
          timedOut = true;
          controller.abort(SANDBOX_DENIAL_REASONS.TIMED_OUT);
          void Promise.resolve(backend.cancel?.(context)).catch(() : any => {});
        }, deadlineDelay);
        timeout.unref?.();
        activeFailureStage = "sandbox_backend_failed";
        const result: any = await backend.run(context);
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
          } catch (error: any) {
            error.failureStage = "output_validation_failed";
            throw error;
          }
        } else {
          runtimeState = "failed";
          reasonCode = normalizeReason(result, SANDBOX_DENIAL_REASONS.RUNTIME_FAILED);
        }
      } catch (error: any) {
        resourceTotals = error?.resourceTotals || failedResourceTotals(error, request.resources);
        runtimeState = controller.signal.aborted
          ? timedOut ? "timed_out" : "cancelled"
          : "failed";
        reasonCode = controller.signal.aborted
          ? timedOut ? SANDBOX_DENIAL_REASONS.TIMED_OUT : SANDBOX_DENIAL_REASONS.CANCELLED
          : normalizeReason(error, SANDBOX_DENIAL_REASONS.RUNTIME_FAILED);
        const reportedFailureStage: any = String(error?.failureStage || "");
        failureStage = /^(?:oci_(?:create|start|inspect|command|workload)_failed|custody_(?:object_missing|promotion_(?:owner_mismatch|digest_mismatch|idempotency_conflict|replay_unavailable|contract_invalid|failed)|envelope_authentication_failed)|input_staging_failed|sandbox_backend_failed|resource_budget_exceeded|output_validation_failed)$/u.test(
          reportedFailureStage
        ) ? reportedFailureStage : activeFailureStage;
      } finally {
        if (timeout) clearTimeout(timeout);
        try {
          const cleanup: any = await backend.cleanup(context);
          cleanupState = cleanup?.destroyed === true ? "destroyed" : "cleanup_failed";
        } catch {
          cleanupState = "cleanup_failed";
        }
      }

      let outputHandle: any = "";
      let outputDisposition: any = "none";
      if (runtimeState === "succeeded" && cleanupState === "destroyed" && output) {
        await ensurePrivateDirectory(quarantineRoot);
        const quarantineDirectory: any = path.join(quarantineRoot, runId.replace(":", "-"));
        await removeOwnedTree(quarantineDirectory).catch(() : any => {});
        await fs.chmod(paths.outputRoot, 0o700).catch(() : any => {});
        await fs.rename(paths.outputRoot, quarantineDirectory);
        await fs.chmod(quarantineDirectory, 0o500).catch(() : any => {});
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
          const record: any = outputHandles.get(outputHandle);
          outputHandles.delete(outputHandle);
          outputHandle = "";
          if (record?.path) await removeOwnedTree(record.path).catch(() : any => {});
        }
      }
      const finishedAt: any = now().toISOString();
      const succeeded: any = runtimeState === "succeeded" && cleanupState === "destroyed";
      const receipt: Readonly<Record<string, any>> = Object.freeze({
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
          const record: any = outputHandles.get(outputHandle);
          outputHandles.delete(outputHandle);
          if (record?.path) await removeOwnedTree(record.path).catch(() : any => {});
        }
        const failedReceipt: Readonly<Record<string, any>> = Object.freeze({
          ...receipt,
          status: "failed",
          reasonCode: SANDBOX_DENIAL_REASONS.RECEIPT_PERSISTENCE_FAILED,
          outputHandle: "",
          outputDisposition: "rejected"
        });
        receipts.set(runId, failedReceipt);
        return failedReceipt;
      }
    })().finally(() : any => {
      externalSignal?.removeEventListener?.("abort", abortFromExternal);
      active.delete(runId);
    });
    active.set(runId, { controller, backend, context, promise, pluginId: String(pluginId || "") });
    return promise;
  }

  async function executeOpaque(rawRequest?: any, opaqueInputs: any = [], options: Record<string, any> = {}) : Promise<any> {
    let request: any;
    try {
      request = normalizeSandboxExecutionRequest(rawRequest);
    } catch {
      return deny(null, SANDBOX_DENIAL_REASONS.REQUEST_INVALID);
    }
    if (!opaqueArtifactCustody?.promote || !Array.isArray(opaqueInputs)) {
      return deny(request, SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED);
    }
    let resolution: any;
    try {
      resolution = await providerResolver?.resolve?.();
    } catch (error: any) {
      return deny(request, normalizeReason(error, SANDBOX_DENIAL_REASONS.BACKEND_UNHEALTHY));
    }
    const providerReceipt: any = resolution?.descriptor?.conformanceReceipt;
    if (!providerReceipt) return deny(request, SANDBOX_DENIAL_REASONS.BACKEND_MISSING);
    const byHandle: any = new Map<any, any>(opaqueInputs.map((input?: any) : any => [String(input?.handle || ""), input]));
    return execute(request, {
      ...options,
      internalAuthority: Object.freeze({ [internalResolution]: resolution }),
      resolveInput: async (declared?: any) : Promise<any> => {
        const opaqueInput: any = byHandle.get(declared.handle);
        if (!opaqueInput || !Array.isArray(opaqueInput.files) || opaqueInput.files.length === 0) {
          throw Object.assign(new Error("Opaque sandbox input is unavailable."), {
            code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED
          });
        }
        const files: any[] = [];
        for (const [index, file] of opaqueInput.files.entries()) {
          files.push({
            path: file.path,
            digest: file.digest,
            sensitive: true,
            stageContent: async (sink?: any) : Promise<any> => {
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
              } catch (error: any) {
                if (error && typeof error === "object") {
                  error.failureStage = opaqueCustodyFailureStage(error);
                }
                throw error;
              }
            }
          });
        }
        const promotionDigest: any = custodyPromotionSetDigest({
          files: opaqueInput.files.map((file?: any) : any => ({
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
        const authorizationDigest: any = custodyPromotionAuthorizationDigest({
          promotionDigest,
          ownerBinding: request.principal,
          governance: options.currentGovernance || request.governance
        });
        if (authorizationDigest !== String(opaqueInput.authorizationDigest || "").toLowerCase()) {
          throw Object.assign(new Error("Opaque sandbox authorization digest mismatch."), {
            code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED
          });
        }
        const digest: any = sandboxDigest(files.map((file?: any) : any => ({ path: file.path, digest: file.digest }))
          .sort((left?: any, right?: any) : any => left.path.localeCompare(right.path)));
        if (digest !== declared.digest) {
          throw Object.assign(new Error("Opaque sandbox input digest mismatch."), {
            code: SANDBOX_DENIAL_REASONS.INPUT_INTEGRITY_FAILED
          });
        }
        return { files, digest };
      }
    });
  }

  async function executeConfiguredOpaque(rawRequest?: any, opaqueInputs: any = [], options: Record<string, any> = {}) : Promise<any> {
    const bound: any = bindConfiguredWorkload(rawRequest);
    if (bound.receipt) return bound.receipt;
    return executeOpaque(bound.request, opaqueInputs, {
      ...options,
      currentGovernance: bindConfiguredCurrentGovernance(bound.request, options.currentGovernance)
    });
  }

  function bindConfiguredCurrentGovernance(request?: any, currentGovernance?: any) : any {
    const governance: any = currentGovernance || request.governance;
    if (!request.governance.approvalRef || governance.approvalRequestDigest) return governance;
    return Object.freeze({
      ...governance,
      approvalRequestDigest: request.governance.approvalRequestDigest
    });
  }

  function bindConfiguredWorkload(rawRequest?: any) : any {
    let configuredRequest: any;
    try {
      configuredRequest = normalizeSandboxConfiguredWorkloadRequest(rawRequest);
    } catch {
      return { receipt: deny(null, SANDBOX_DENIAL_REASONS.REQUEST_INVALID) };
    }
    if (configured.state === "unconfigured") return { receipt: deny(null, SANDBOX_DENIAL_REASONS.UNCONFIGURED) };
    if (configured.state === "disabled") return { receipt: deny(null, SANDBOX_DENIAL_REASONS.DISABLED) };
    if (configured.state !== "enabled") return { receipt: deny(null, SANDBOX_DENIAL_REASONS.CONFIGURATION_INVALID) };
    const profile: any = profiles instanceof Map ? profiles.get(configured.profileId) : profiles?.[configured.profileId];
    const workload: any = profile?.workloads?.[configuredRequest.workloadKind];
    const artifactDigests: any[] = [...new Set<any>(
      (Array.isArray(workload?.artifactDigests) ? workload.artifactDigests : [])
        .map((value?: any) : any => String(value || "").trim().toLowerCase())
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
    let request: any;
    try {
      request = bindSandboxConfiguredWorkloadRequest(configuredRequest, {
        digest: artifactDigests[0],
        runtimeKind: workload.runtimeKind,
        entryPoint: workload.entryPoint
      });
      if (request.governance.approvalRef && !request.governance.approvalRequestDigest) {
        const draft: Record<string, any> = {
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

  async function executeConfigured(rawRequest?: any, resolveInput?: any, options: Record<string, any> = {}) : Promise<any> {
    const bound: any = bindConfiguredWorkload(rawRequest);
    if (bound.receipt) return bound.receipt;
    return execute(bound.request, {
      ...options,
      resolveInput,
      currentGovernance: bindConfiguredCurrentGovernance(bound.request, options.currentGovernance)
    });
  }

  async function cancel(runId?: any, { pluginId = "" }: Record<string, any> = {}) : Promise<any> {
    const reference: any = String(runId || "");
    const resolvedRunId: any = active.has(reference) ? reference : idempotency.get(idempotencyIdentity(reference));
    const record: any = resolvedRunId ? active.get(resolvedRunId) : null;
    if (!record) return false;
    if (pluginId && record.pluginId !== pluginId) return false;
    record.controller.abort(SANDBOX_DENIAL_REASONS.CANCELLED);
    await record.backend.cancel?.(record.context).catch?.(() : any => {});
    return true;
  }

  function getReceipt(runId?: any, { pluginId = "" }: Record<string, any> = {}) : any {
    const receipt: any = receipts.get(String(runId || "")) || null;
    if (receipt && pluginId && receipt.pluginRef !== controlledRef(pluginId, "plugin")) return null;
    return receipt;
  }

  function getStatus(runId?: any, { pluginId = "" }: Record<string, any> = {}) : any {
    const reference: any = String(runId || "");
    const id: any = receipts.has(reference) || active.has(reference)
      ? reference
      : idempotency.get(idempotencyIdentity(reference)) || reference;
    const receipt: any = receipts.get(id);
    if (receipt) {
      if (pluginId && receipt.pluginRef !== controlledRef(pluginId, "plugin")) return null;
      return publicStatus(receipt);
    }
    const activeRecord: any = active.get(id);
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

  function resolveQuarantinedOutput(outputHandle?: any, { pluginId = "" }: Record<string, any> = {}) : any {
    const record: any = outputHandles.get(String(outputHandle || ""));
    if (!record) return null;
    const receipt: any = receipts.get(record.runId);
    if (pluginId && receipt?.pluginRef !== controlledRef(pluginId, "plugin")) return null;
    return Object.freeze({
      runId: record.runId,
      output: record.output,
      readFile: async (relativePath?: any) : Promise<any> => {
        const normalized: any = safeFilePath(relativePath);
        const targetPath: any = path.resolve(record.path, normalized);
        const rootPath: any = path.resolve(record.path);
        if (!targetPath.startsWith(`${rootPath}${path.sep}`)) throw new Error("Sandbox output path is invalid.");
        return fs.readFile(targetPath);
      }
    });
  }

  async function disposeOutput(outputHandle?: any, disposition: any = "rejected", {
    pluginId = "",
    owningOperationReceiptDigest = ""
  }: Record<string, any> = {}) : Promise<any> {
    const handle: any = String(outputHandle || "");
    const record: any = outputHandles.get(handle);
    const receipt: any = record ? receipts.get(record.runId) : null;
    if (
      !record ||
      (pluginId && receipt?.pluginRef !== controlledRef(pluginId, "plugin")) ||
      !["committed", "rejected", "compensated"].includes(disposition) ||
      !/^[a-f0-9]{64}$/u.test(String(owningOperationReceiptDigest || ""))
    ) return false;
    const disposingReceipt: Readonly<Record<string, any>> = Object.freeze({
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

  async function close() : Promise<any> {
    closing = true;
    const runs: any[] = [...active.values()];
    for (const record of runs) {
      record.controller.abort(SANDBOX_DENIAL_REASONS.CANCELLED);
      await record.backend.cancel?.(record.context).catch?.(() : any => {});
    }
    await Promise.allSettled(runs.map((record?: any) : any => record.promise));
    if (active.size > 0) throw new Error("Sandbox execution broker did not close cleanly.");
    outputHandles.clear();
    let providerCloseError: any = null;
    try {
      await providerResolver?.close?.();
    } catch (error: any) {
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
    publicAvailability: () : any => providerResolver?.publicProjection?.() || Object.freeze({ sandboxAvailable: false }),
    administrativeAvailability: () : any => providerResolver?.administrativeProjection?.() ||
      Object.freeze({ state: configured.state === "enabled" ? "unavailable" : configured.state }),
    requiredBackendRestrictions: REQUIRED_BACKEND_RESTRICTIONS
  });
}
