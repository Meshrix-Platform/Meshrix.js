import { canonicalJson as stableJson } from "@lico/contracts/serialization/canonical-json";
import crypto from "node:crypto";

export const UPLOAD_WORKSPACE_MATERIALIZATION_SCHEMA_VERSION =
  "v0.0.1:jobs:upload-workspace-materialization-1";
export const UPLOAD_WORKSPACE_MATERIALIZATION_OPERATION_ID =
  "jobs.upload_workspace_materialize";


function digest(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : stableJson(value)).digest("hex");
}

function text(value) {
  return String(value || "").trim();
}

function failure(code, statusCode, message) {
  return Object.assign(new Error(message), { code, statusCode });
}

const TERMINAL_FAILURE_CODES = new Set([
  "materialization_owner_denied",
  "materialization_stale_revision",
  "materialization_path_invalid",
  "materialization_target_duplicate",
  "materialization_upload_digest_mismatch",
  "materialization_rollback_incomplete",
  "materialization_committed_revision_lost"
]);

export function materializationFailureDisposition(error) {
  const code = text(error?.code) || "materialization_failed";
  return Object.freeze({ code, retryable: !TERMINAL_FAILURE_CODES.has(code) });
}

function requireMethod(port, method, label) {
  if (typeof port?.[method] !== "function") throw new TypeError(`${label}.${method} is required.`);
}

function subjectFrom(input = {}) {
  const subjectId = text(input.subjectId || input.userId);
  if (!subjectId) throw failure("materialization_subject_required", 401, "Authenticated subject is required.");
  return { subjectId, tenantId: text(input.tenantId) };
}

function stableReceipt(receipt = {}) {
  const { verifiedAt: _verifiedAt, ...stable } = receipt;
  return stable;
}

function normalizeTargets(files = [], input = {}) {
  const prefix = text(input.targetPrefix).replace(/^\/+|\/+$/gu, "");
  const overrides = new Map(
    (Array.isArray(input.mutation?.files) ? input.mutation.files : [])
      .map((entry) => [text(entry.sourcePath), text(entry.targetPath)])
  );
  const targets = files.map((file) => {
    const sourcePath = text(file.relativePath || file.name);
    const relativePath = overrides.get(sourcePath) || (prefix ? `${prefix}/${sourcePath}` : sourcePath);
    if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
      throw failure("materialization_path_invalid", 400, "Workspace mutation path is invalid.");
    }
    return {
      sourcePath,
      relativePath,
      contentSha256: text(file.sha256),
      byteSize: Number(file.byteSize)
    };
  });
  if (targets.length === 0) throw failure("materialization_files_required", 400, "Completed upload has no files.");
  if (new Set(targets.map((target) => target.relativePath)).size !== targets.length) {
    throw failure("materialization_target_duplicate", 409, "Workspace mutation contains duplicate target paths.");
  }
  return targets;
}

function publicResult(value = {}) {
  return Object.freeze({
    schemaVersion: UPLOAD_WORKSPACE_MATERIALIZATION_SCHEMA_VERSION,
    status: "completed",
    replayed: value.replayed === true,
    materializationRef: value.materializationRef,
    uploadReceiptDigest: value.uploadReceiptDigest,
    workspaceRevision: value.workspaceRevision,
    checkpointRefs: Object.freeze([...(value.checkpointRefs || [])]),
    auditRef: value.auditRef,
    proofRef: value.proofRef,
    mutationCount: Number(value.mutationCount || 0)
  });
}

export function createUploadWorkspaceMaterialization({
  uploadPort,
  workspacePort,
  auditPort,
  proofPort,
  transactionStore,
  afterMutation = null,
  leaseHeartbeatMs = 10_000
} = {}) {
  for (const [port, methods, name] of [
    [uploadPort, ["resolveCompleted"], "uploadPort"],
    [workspacePort, ["getRevision", "captureSnapshot", "applyBatch", "restoreSnapshot", "withMutationLock"], "workspacePort"],
    [auditPort, ["append"], "auditPort"],
    [proofPort, ["beginLifecycle", "finishLifecycle"], "proofPort"],
    [transactionStore, ["create", "get", "getInputs", "begin", "renew", "assertFence", "recordPreimage", "recordMutationPending", "recordMutation", "recordEffectsCommitted", "recordEvidenceCompleted", "complete", "fail", "cancelOwned"], "transactionStore"]
  ]) for (const method of methods) requireMethod(port, method, name);

  async function resolveRequest(input = {}) {
    const subject = subjectFrom(input.subject);
    const workspaceId = text(input.workspaceId);
    const uploadSessionId = text(input.uploadSessionId);
    const expectedWorkspaceRevision = text(input.expectedWorkspaceRevision);
    const governanceReceipt = input.governanceReceipt && typeof input.governanceReceipt === "object"
      ? input.governanceReceipt
      : null;
    if (!workspaceId || !uploadSessionId || !expectedWorkspaceRevision) {
      throw failure("materialization_target_required", 400, "Upload session, workspace, and expected revision are required.");
    }
    if (
      governanceReceipt?.operationId !== UPLOAD_WORKSPACE_MATERIALIZATION_OPERATION_ID ||
      governanceReceipt?.authorized !== true ||
      governanceReceipt?.approved !== true ||
      !text(governanceReceipt.receiptDigest)
    ) {
      throw failure("materialization_governance_receipt_required", 403, "Current authorization and approval receipt is required.");
    }
    const resolved = await uploadPort.resolveCompleted({ uploadSessionId, subject, includeContent: true });
    const receiptSubject = text(resolved.receipt?.ownerSubjectId || resolved.receipt?.ownerUserId);
    if (receiptSubject !== subject.subjectId) {
      throw failure("materialization_owner_denied", 403, "Upload receipt owner does not match the authenticated subject.");
    }
    const targets = normalizeTargets(resolved.files, input);
    const immutableInputs = targets.map((target) => {
      const file = resolved.files.find((candidate) =>
        text(candidate.relativePath || candidate.name) === target.sourcePath
      );
      if (
        !file ||
        !Buffer.isBuffer(file.content) ||
        file.content.length !== target.byteSize ||
        digest(file.content) !== target.contentSha256
      ) {
        throw failure("materialization_upload_digest_mismatch", 409, "Upload content no longer matches its receipt.");
      }
      return Object.freeze({ ...target, content: file.content });
    });
    const binding = {
      uploadReceiptDigest: digest(stableReceipt(resolved.receipt)),
      workspaceId,
      subjectRef: digest(subject),
      operationId: UPLOAD_WORKSPACE_MATERIALIZATION_OPERATION_ID,
      expectedWorkspaceRevision,
      targets
    };
    const bindingDigest = digest(binding);
    return {
      requestRef: `materialization:${bindingDigest}`,
      bindingDigest,
      binding,
      governanceReceiptDigest: text(governanceReceipt.receiptDigest),
      uploadSessionId,
      workspaceId,
      subject,
      expectedWorkspaceRevision,
      targets,
      immutableInputs
    };
  }

  async function submit(input = {}) {
    const resolved = await resolveRequest(input);
    const { immutableInputs, ...request } = resolved;
    const existing = await transactionStore.get(request.requestRef);
    if (existing?.status === "completed") return { accepted: true, deduped: true, requestRef: request.requestRef, result: publicResult({ ...existing.result, replayed: true }) };
    if (existing?.status === "failed") throw failure("materialization_terminal_failed", 409, "Materialization request has exhausted its retry policy.");
    if (existing?.status === "cancelled") throw failure("materialization_cancelled", 409, "Materialization request was cancelled.");
    const created = await transactionStore.create(request, { inputs: immutableInputs });
    return { accepted: true, deduped: Boolean(existing) || created?.inserted === false, requestRef: request.requestRef };
  }

  async function execute({ requestRef, ownerFence, signal = null, renewLease = null } = {}) {
    const record = await transactionStore.get(requestRef);
    if (!record) throw failure("materialization_request_missing", 404, "Materialization request is missing.");
    if (record.status === "completed") return publicResult({ ...record.result, replayed: true });
    return workspacePort.withMutationLock(record.workspaceId, async () => {
      const execution = await transactionStore.begin(requestRef, { ownerFence });
      if (execution.status === "completed") return publicResult({ ...execution.result, replayed: true });
      let snapshot = execution.snapshot || null;
      let proofEntry = null;
      let mutationStarted = false;
      let effectsCommitted = execution.stage === "effects_committed";
      let heartbeatFailure = null;
      let heartbeatInFlight = Promise.resolve();
      const heartbeat = async () => {
        heartbeatInFlight = heartbeatInFlight.then(async () => {
          if (typeof renewLease === "function") await renewLease();
          await transactionStore.renew(requestRef, { ownerFence });
        });
        try { await heartbeatInFlight; } catch (error) { heartbeatFailure = error; throw error; }
      };
      const fence = async ({ renew = false } = {}) => {
        if (signal?.aborted) throw failure("materialization_cancelled", 409, "Materialization was cancelled.");
        if (heartbeatFailure) throw heartbeatFailure;
        if (renew) await heartbeat();
        await transactionStore.assertFence(requestRef, { ownerFence });
      };
      const heartbeatTimer = setInterval(() => void heartbeat().catch(() => null), Math.max(10, Number(leaseHeartbeatMs) || 10_000));
      heartbeatTimer.unref?.();
      try {
        await fence({ renew: true });
        if (execution.stage === "evidence_completed" && execution.result) {
          await fence({ renew: true });
          await transactionStore.complete(requestRef, { ownerFence, result: execution.result });
          return publicResult({ ...execution.result, replayed: true });
        }
        if (execution.stage === "effects_committed") {
          const committedRevision = text(execution.workspaceRevision);
          if (!committedRevision || await workspacePort.getRevision(record) !== committedRevision) {
            throw failure("materialization_committed_revision_lost", 500, "Committed workspace revision is unavailable.");
          }
        } else if (snapshot) {
          await fence({ renew: true });
          await workspacePort.restoreSnapshot({ ...record, snapshot, leaseGuard: () => fence({ renew: true }), operationId: `${UPLOAD_WORKSPACE_MATERIALIZATION_OPERATION_ID}:${record.bindingDigest}.recovery` });
          await fence({ renew: true });
          const recoveredRevision = await workspacePort.getRevision(record);
          if (recoveredRevision !== record.expectedWorkspaceRevision) throw failure("materialization_recovery_incomplete", 500, "Prior materialization recovery is incomplete.");
          snapshot = null;
        }
        const currentRevision = execution.stage === "effects_committed"
          ? text(execution.workspaceRevision)
          : await workspacePort.getRevision(record);
        if (execution.stage !== "effects_committed" && currentRevision !== record.expectedWorkspaceRevision) throw failure("materialization_stale_revision", 409, "Workspace revision is stale.");
        await fence({ renew: true });
        const immutableInputs = execution.stage === "effects_committed"
          ? []
          : await transactionStore.getInputs(requestRef);
        await fence({ renew: true });
        const contentBySource = new Map(immutableInputs.map((file) => [file.sourcePath, file]));
        for (const target of execution.stage === "effects_committed" ? [] : record.targets) {
          const file = contentBySource.get(target.sourcePath);
          if (!file || !Buffer.isBuffer(file.content) || file.content.length !== target.byteSize || digest(file.content) !== target.contentSha256) {
            throw failure("materialization_upload_digest_mismatch", 409, "Immutable upload custody no longer matches its receipt.");
          }
        }
        let checkpointRefs = [...(execution.checkpointRefs || [])];
        let revision = currentRevision;
        if (execution.stage !== "effects_committed") {
          snapshot = await workspacePort.captureSnapshot({ ...record, leaseGuard: () => fence({ renew: true }) });
          await fence({ renew: true });
          if (!snapshot || snapshot.complete !== true) throw failure("materialization_preimage_incomplete", 500, "Workspace preimage capture is incomplete.");
          await transactionStore.recordPreimage(requestRef, { ownerFence, snapshot });
        }
        proofEntry = await proofPort.beginLifecycle({
          operationId: UPLOAD_WORKSPACE_MATERIALIZATION_OPERATION_ID,
          workspaceId: record.workspaceId,
          idempotencyKey: record.bindingDigest,
          subject: { ref: record.binding.subjectRef },
          input: { bindingDigest: record.bindingDigest, uploadReceiptDigest: record.binding.uploadReceiptDigest }
        });
        if (execution.stage !== "effects_committed") {
          await fence({ renew: true });
          mutationStarted = true;
          await transactionStore.recordMutationPending(requestRef, {
            ownerFence,
            revision,
            checkpointRefs
          });
          const applied = await workspacePort.applyBatch({
            ...record,
            files: record.targets.map((target) => ({
              target,
              content: contentBySource.get(target.sourcePath).content
            })),
            leaseGuard: () => fence({ renew: true }),
            operationId: `${UPLOAD_WORKSPACE_MATERIALIZATION_OPERATION_ID}:${record.bindingDigest}`
          });
          await fence({ renew: true });
          if (
            applied?.beforeRoot !== revision ||
            !applied.afterRoot ||
            !Array.isArray(applied.checkpointRefs) ||
            applied.checkpointRefs.length === 0
          ) {
            throw failure("materialization_apply_incomplete", 500, "Workspace mutation receipt is incomplete.");
          }
          revision = applied.afterRoot;
          checkpointRefs.push(...applied.checkpointRefs);
          await transactionStore.recordMutation(requestRef, { ownerFence, revision, checkpointRefs });
        }
        if (typeof afterMutation === "function") await afterMutation({ requestRef });
        await fence({ renew: true });
        if (await workspacePort.getRevision(record) !== revision) throw failure("materialization_revision_unverified", 500, "Workspace revision verification failed.");
        await transactionStore.recordEffectsCommitted(requestRef, { ownerFence, revision, checkpointRefs });
        effectsCommitted = true;
        await fence({ renew: true });
        const audit = await auditPort.append({
          auditId: `materialization_${digest(`${requestRef}:pending`)}`,
          operationId: UPLOAD_WORKSPACE_MATERIALIZATION_OPERATION_ID,
          status: "pending",
          input: { bindingDigest: record.bindingDigest },
          output: { workspaceRevision: revision, mutationCount: record.targets.length }
        });
        const proof = await proofPort.finishLifecycle({
          entry: proofEntry,
          status: "succeeded",
          outcomeIdempotencyKey: `${record.bindingDigest}:completed`,
          receiptRefs: checkpointRefs,
          auditId: audit.auditId,
          result: { workspaceRevision: revision, mutationCount: record.targets.length }
        });
        const completedAudit = await auditPort.append({
          auditId: `materialization_${digest(`${requestRef}:completed`)}`,
          operationId: UPLOAD_WORKSPACE_MATERIALIZATION_OPERATION_ID,
          status: "completed",
          input: { bindingDigest: record.bindingDigest },
          output: { workspaceRevision: revision, proofRef: proof.ledgerEventId }
        });
        const result = publicResult({
          materializationRef: requestRef,
          uploadReceiptDigest: record.binding.uploadReceiptDigest,
          workspaceRevision: revision,
          checkpointRefs,
          auditRef: `audit:${completedAudit.auditId}`,
          proofRef: `proof:${proof.ledgerEventId}`,
          mutationCount: record.targets.length
        });
        await fence({ renew: true });
        await transactionStore.recordEvidenceCompleted(requestRef, { ownerFence, result });
        await fence({ renew: true });
        await transactionStore.complete(requestRef, { ownerFence, result });
        return result;
      } catch (error) {
        let compensationError = null;
        let ownsFence = false;
        try { await transactionStore.assertFence(requestRef, { ownerFence }); ownsFence = true; } catch {}
        if (ownsFence && snapshot && mutationStarted && !effectsCommitted) {
          try {
            await workspacePort.restoreSnapshot({ ...record, snapshot, leaseGuard: () => fence({ renew: true }), operationId: `${UPLOAD_WORKSPACE_MATERIALIZATION_OPERATION_ID}:${record.bindingDigest}.rollback` });
            if (await workspacePort.getRevision(record) !== record.expectedWorkspaceRevision) throw new Error("revision_mismatch");
          } catch (rollbackError) {
            compensationError = rollbackError;
          }
        }
        if (ownsFence && proofEntry && !effectsCommitted) await proofPort.finishLifecycle({
          entry: proofEntry,
          status: "failed",
          failed: true,
          outcomeIdempotencyKey: `${record.bindingDigest}:failed`,
          error: compensationError ? "materialization_compensation_failed" : "materialization_compensated"
        }).catch(() => null);
        if (ownsFence && !effectsCommitted) await auditPort.append({
          auditId: `materialization_${digest(`${requestRef}:failed`)}`,
          operationId: UPLOAD_WORKSPACE_MATERIALIZATION_OPERATION_ID,
          status: compensationError ? "compensation_failed" : "compensated",
          input: { bindingDigest: record.bindingDigest },
          error: compensationError ? "materialization_compensation_failed" : "materialization_failed"
        }).catch(() => null);
        if (ownsFence && text(error?.code) === "materialization_cancelled" && !compensationError) {
          await transactionStore.cancelOwned(requestRef, { ownerFence });
        } else if (ownsFence) {
          const disposition = materializationFailureDisposition(compensationError ? { code: "materialization_rollback_incomplete" } : error);
          await transactionStore.fail(requestRef, { ownerFence, recoverable: disposition.retryable, preserveCommitted: effectsCommitted });
        }
        if (compensationError) throw failure("materialization_rollback_incomplete", 500, "Workspace rollback is incomplete.");
        throw error;
      } finally {
        clearInterval(heartbeatTimer);
        await heartbeatInFlight.catch(() => null);
      }
    });
  }

  return Object.freeze({ submit, execute, get: (requestRef) => transactionStore.get(requestRef) });
}
