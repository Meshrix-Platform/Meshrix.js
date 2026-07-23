import fs from "node:fs/promises";
import path from "node:path";
import { openSqliteDatabase } from "@lico/foundation/storage/sqlite-database";
import { queueStateMutation } from "#lico/state-coordinator";
import { ensurePrivateDir } from "#lico/foundation/storage/private-file-atomic";
import { ensurePrivateSqliteLocation } from "#lico/foundation/storage/private-sqlite";
import { createUploadWorkspaceMaterialization, materializationFailureDisposition } from "../jobs/upload-workspace-materialization.mjs";

const DEFINITION_ID = "queue.jobs.upload-workspace-materialization";
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RETAINED = 4096;

function fenced(message = "materialization_fenced") {
  return Object.assign(new Error(message), { code: "materialization_fenced" });
}

export function createUploadWorkspaceMaterializationTransactionStore({
  userDataPath,
  leaseMs = DEFAULT_LEASE_MS,
  maxRetained = DEFAULT_RETAINED,
  now = Date.now
}) {
  const root = path.join(userDataPath, "jobs");
  ensurePrivateDir(root);
  const file = path.join(root, "upload-workspace-materialization.sqlite");
  ensurePrivateSqliteLocation(file);
  const db = openSqliteDatabase(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS materialization_requests (
    request_ref TEXT PRIMARY KEY, status TEXT NOT NULL, stage TEXT NOT NULL,
    owner_fence TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0,
    request_json TEXT NOT NULL, snapshot_json TEXT, result_json TEXT,
    workspace_revision TEXT NOT NULL DEFAULT '', checkpoint_refs_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS materialization_inputs (
    request_ref TEXT NOT NULL,
    source_path TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    content BLOB NOT NULL,
    PRIMARY KEY(request_ref, source_path),
    FOREIGN KEY(request_ref) REFERENCES materialization_requests(request_ref) ON DELETE CASCADE
  )`);
  const columns = new Set(db.prepare("PRAGMA table_info(materialization_requests)").all().map((entry) => entry.name));
  for (const [name, sql] of [
    ["workspace_revision", "ALTER TABLE materialization_requests ADD COLUMN workspace_revision TEXT NOT NULL DEFAULT ''"],
    ["checkpoint_refs_json", "ALTER TABLE materialization_requests ADD COLUMN checkpoint_refs_json TEXT NOT NULL DEFAULT '[]'"]
  ]) if (!columns.has(name)) db.exec(sql);
  const read = db.prepare("SELECT * FROM materialization_requests WHERE request_ref=?");
  const readInputs = db.prepare("SELECT source_path,content_sha256,byte_size,content FROM materialization_inputs WHERE request_ref=? ORDER BY source_path ASC");
  const hydrate = (row) => row ? {
    ...JSON.parse(row.request_json), status: row.status, stage: row.stage,
    snapshot: row.snapshot_json ? JSON.parse(row.snapshot_json) : null,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    workspaceRevision: row.workspace_revision || "",
    checkpointRefs: JSON.parse(row.checkpoint_refs_json || "[]")
  } : null;
  const timestamp = () => new Date(now()).toISOString();
  const requireChange = (changes) => { if (!changes) throw fenced(); };
  const updateOwned = (sql, params) => {
    const current = now();
    requireChange(db.prepare(sql).run(...params(current), current).changes);
  };
  return Object.freeze({
    async create(value, { inputs = [] } = {}) {
      const retained = Math.max(1, Number(maxRetained) || DEFAULT_RETAINED);
      db.prepare("DELETE FROM materialization_requests WHERE request_ref IN (SELECT request_ref FROM materialization_requests WHERE status IN ('completed','failed','cancelled') AND stage NOT IN ('effects_committed_retry_exhausted','evidence_completed_retry_exhausted') ORDER BY updated_at ASC LIMIT MAX(0,(SELECT COUNT(*) FROM materialization_requests)-?))").run(retained - 1);
      const insertRequest = db.prepare("INSERT OR IGNORE INTO materialization_requests(request_ref,status,stage,request_json,updated_at) VALUES(?,?,?,?,?)");
      const insertInput = db.prepare("INSERT INTO materialization_inputs(request_ref,source_path,content_sha256,byte_size,content) VALUES(?,?,?,?,?)");
      const inserted = db.transaction(() => {
        const created = insertRequest.run(value.requestRef, "queued", "admitted", JSON.stringify(value), timestamp()).changes > 0;
        if (created) {
          for (const input of inputs) {
            insertInput.run(value.requestRef, input.sourcePath, input.contentSha256, input.byteSize, input.content);
          }
        }
        return created;
      })();
      return { inserted };
    },
    async get(ref) { return hydrate(read.get(ref)); },
    async getInputs(ref) {
      return readInputs.all(ref).map((entry) => ({
        sourcePath: entry.source_path,
        contentSha256: entry.content_sha256,
        byteSize: Number(entry.byte_size),
        content: Buffer.from(entry.content)
      }));
    },
    async begin(ref, { ownerFence }) {
      const current = now();
      const row = read.get(ref);
      if (!row) throw Object.assign(new Error("materialization_request_missing"), { code: "materialization_request_missing" });
      if (row.status === "completed") return hydrate(row);
      if (["failed", "cancelled"].includes(row.status)) {
        throw Object.assign(new Error("materialization_request_terminal"), { code: "materialization_request_terminal" });
      }
      const changes = db.prepare("UPDATE materialization_requests SET status='running',owner_fence=?,lease_until=?,updated_at=? WHERE request_ref=? AND (status!='running' OR lease_until<?)")
        .run(ownerFence, current + leaseMs, timestamp(), ref, current).changes;
      requireChange(changes);
      return hydrate(read.get(ref));
    },
    async renew(ref, { ownerFence }) {
      updateOwned("UPDATE materialization_requests SET lease_until=?,updated_at=? WHERE request_ref=? AND status='running' AND owner_fence=? AND lease_until>=?", (current) => [current + leaseMs, timestamp(), ref, ownerFence]);
    },
    async assertFence(ref, { ownerFence }) {
      const row = read.get(ref);
      if (!row || row.status !== "running" || row.owner_fence !== ownerFence || Number(row.lease_until) < now()) throw fenced();
      return true;
    },
    async recordPreimage(ref, { ownerFence, snapshot }) {
      updateOwned("UPDATE materialization_requests SET stage='preimage_ready',snapshot_json=?,lease_until=?,updated_at=? WHERE request_ref=? AND owner_fence=? AND lease_until>=?", (current) => [JSON.stringify(snapshot), current + leaseMs, timestamp(), ref, ownerFence]);
    },
    async recordMutationPending(ref, { ownerFence, revision, checkpointRefs }) {
      updateOwned("UPDATE materialization_requests SET stage='mutation_pending',workspace_revision=?,checkpoint_refs_json=?,lease_until=?,updated_at=? WHERE request_ref=? AND owner_fence=? AND lease_until>=?", (current) => [revision, JSON.stringify(checkpointRefs), current + leaseMs, timestamp(), ref, ownerFence]);
    },
    async recordMutation(ref, { ownerFence, revision, checkpointRefs }) {
      updateOwned("UPDATE materialization_requests SET stage='mutation_applied',workspace_revision=?,checkpoint_refs_json=?,lease_until=?,updated_at=? WHERE request_ref=? AND owner_fence=? AND lease_until>=?", (current) => [revision, JSON.stringify(checkpointRefs), current + leaseMs, timestamp(), ref, ownerFence]);
    },
    async recordEffectsCommitted(ref, { ownerFence, revision, checkpointRefs }) {
      updateOwned("UPDATE materialization_requests SET stage='effects_committed',workspace_revision=?,checkpoint_refs_json=?,lease_until=?,updated_at=? WHERE request_ref=? AND owner_fence=? AND lease_until>=?", (current) => [revision, JSON.stringify(checkpointRefs), current + leaseMs, timestamp(), ref, ownerFence]);
    },
    async recordEvidenceCompleted(ref, { ownerFence, result }) {
      updateOwned("UPDATE materialization_requests SET stage='evidence_completed',result_json=?,lease_until=?,updated_at=? WHERE request_ref=? AND owner_fence=? AND lease_until>=?", (current) => [JSON.stringify(result), current + leaseMs, timestamp(), ref, ownerFence]);
    },
    async complete(ref, { ownerFence, result }) {
      const current = now();
      requireChange(db.prepare("UPDATE materialization_requests SET status='completed',stage='completed',result_json=?,lease_until=0,updated_at=? WHERE request_ref=? AND owner_fence=? AND lease_until>=?")
        .run(JSON.stringify(result), timestamp(), ref, ownerFence, current).changes);
    },
    async fail(ref, { ownerFence, recoverable, preserveCommitted = false }) {
      const current = now();
      const status = recoverable ? "queued" : "failed";
      const stage = preserveCommitted ? "effects_committed" : recoverable ? "admitted" : "compensation_failed";
      requireChange(db.prepare("UPDATE materialization_requests SET status=?,stage=?,owner_fence='',lease_until=0,updated_at=? WHERE request_ref=? AND owner_fence=? AND lease_until>=?")
        .run(status, stage, timestamp(), ref, ownerFence, current).changes);
    },
    async cancelOwned(ref, { ownerFence }) {
      const current = now();
      requireChange(db.prepare("UPDATE materialization_requests SET status='cancelled',stage='cancelled',owner_fence='',lease_until=0,updated_at=? WHERE request_ref=? AND status='running' AND owner_fence=? AND lease_until>=?")
        .run(timestamp(), ref, ownerFence, current).changes);
    },
    async cancelQueued(ref) {
      const changes = db.prepare("UPDATE materialization_requests SET status='cancelled',stage='cancelled',owner_fence='',lease_until=0,updated_at=? WHERE request_ref=? AND status='queued'")
        .run(timestamp(), ref).changes;
      return { cancelled: changes > 0 };
    },
    async terminalFail(ref) {
      const changes = db.prepare("UPDATE materialization_requests SET status='failed',stage=CASE stage WHEN 'effects_committed' THEN 'effects_committed_retry_exhausted' WHEN 'evidence_completed' THEN 'evidence_completed_retry_exhausted' ELSE 'retry_exhausted' END,owner_fence='',lease_until=0,updated_at=? WHERE request_ref=? AND status='queued'")
        .run(timestamp(), ref).changes;
      return { terminal: changes > 0 };
    },
    count() { return Number(db.prepare("SELECT COUNT(*) AS count FROM materialization_requests").get().count); },
    close() { db.close(); }
  });
}

export async function settleMaterializationQueueFailure({ transactionStore, requestRef, error, attempt, maxAttempts }) {
  const disposition = materializationFailureDisposition(error);
  const exhausted = Number(attempt || 0) >= Number(maxAttempts || 1);
  if (!disposition.retryable || exhausted) {
    await transactionStore.terminalFail(requestRef);
    return { action: "failed", reason: disposition.code };
  }
  return { action: "retry", reason: disposition.code };
}

export async function createUploadWorkspaceMaterializationProvider({ userDataPath, queueApplicationPort, agentWorkspace, uploadSessionStore, operationAuditStore, operationProofSubstrate, transactionStore = null }) {
  const store = transactionStore || createUploadWorkspaceMaterializationTransactionStore({ userDataPath });
  const ownsTransactionStore = !transactionStore;
  const access = (record) => ({ workspaceId: record.workspaceId, actorUserId: record.subject.subjectId });
  const engine = createUploadWorkspaceMaterialization({
    uploadPort: {
      async resolveCompleted({ uploadSessionId, subject, includeContent }) {
        const [receipt, files] = await Promise.all([
          uploadSessionStore.buildCheckpointReceiptFromUploadSession(userDataPath, uploadSessionId, { owner: subject }),
          uploadSessionStore.resolveUploadSessionFiles(userDataPath, uploadSessionId, { owner: subject })
        ]);
        return {
          receipt,
          files: await Promise.all(files.map(async (file) => ({
            ...file,
            ...(includeContent
              ? { content: Buffer.isBuffer(file.content) ? file.content : await fs.readFile(file.stagedPath) }
              : {})
          })))
        };
      }
    },
    workspacePort: {
      async getRevision(record) { const value = await agentWorkspace.workspaceFileRevision(access(record)); if (!value.ok) throw new Error("workspace_revision_unavailable"); return value.revision; },
      async captureSnapshot(record) { const paths = record.targets.map((target) => target.relativePath); const value = await agentWorkspace.captureWorkspaceFileSnapshot({ ...access(record), paths, leaseGuard: record.leaseGuard }); if (!value.ok || value.snapshot?.files?.length !== paths.length) throw new Error("workspace_snapshot_unavailable"); return { complete: true, targetCount: paths.length, snapshot: value.snapshot }; },
      async applyBatch(record) {
        const value = await agentWorkspace.restoreWorkspaceFiles({
          ...access(record),
          files: record.files.map(({ target, content }) => ({
            path: target.relativePath,
            exists: true,
            contentBase64: content.toString("base64"),
            contentSha256: target.contentSha256,
            byteLength: target.byteSize,
            encoding: "base64"
          })),
          deleteExtraneous: false,
          operationId: record.operationId,
          leaseGuard: record.leaseGuard
        });
        if (!value.ok) throw new Error("workspace_mutation_failed");
        return {
          beforeRoot: value.stateCommit?.beforeRoot,
          afterRoot: value.stateCommit?.afterRoot,
          checkpointRefs: [value.checkpoint?.nodeId || value.stateCommit?.eventId].filter(Boolean)
        };
      },
      async restoreSnapshot(record) { const value = await agentWorkspace.restoreWorkspaceFiles({ ...access(record), ...record.snapshot.snapshot, operationId: record.operationId, leaseGuard: record.leaseGuard, stateRootAllowedOperationIds: [`jobs.upload_workspace_materialize:${record.bindingDigest}`] }); if (!value.ok) throw Object.assign(new Error("workspace_restore_failed"), { code: value.status === 409 ? "materialization_compensation_conflict" : "workspace_restore_failed" }); },
      withMutationLock(workspaceId, task) { return queueStateMutation(`workspace-materialization:${workspaceId}`, task); }
    },
    auditPort: {
      async append(entry) {
        try { return operationAuditStore.append({ ...entry, transport: "job-worker", actor: { type: "system" } }); }
        catch (error) { if (entry.auditId && String(error?.code || "").startsWith("SQLITE_CONSTRAINT")) return { auditId: entry.auditId }; throw error; }
      }
    },
    proofPort: operationProofSubstrate,
    transactionStore: store
  });
  let closing = false;
  const queue = await queueApplicationPort.registerQueue({
    queueDefinitionId: DEFINITION_ID,
    queueDefinitionVersion: 2,
    label: "lico.jobs.upload-workspace-materialization",
    ownerCapability: "platform.job-workflow",
    scope: { tenantId: "platform", workspaceId: "governed" },
    workerId: "upload-workspace-materialization-worker",
    maxInFlight: 4,
    batchSize: 4,
    handler: async ({ workItem }, context) => {
      if (closing) return { action: "retry", reason: "materialization_provider_closing" };
      try {
        const ownerFence = `${workItem.workItemId}:${context.lease.leaseSeq}`;
        await engine.execute({
          requestRef: workItem.payloadRef.requestRef,
          ownerFence,
          signal: context.signal,
          renewLease: () => context.renewLease({ reason: "materialization_saga_heartbeat" })
        });
        return { action: "completed", reason: "materialization_completed" };
      } catch (error) {
        return settleMaterializationQueueFailure({ transactionStore: store, requestRef: workItem.payloadRef.requestRef, error, attempt: workItem.attempt, maxAttempts: workItem.maxAttempts });
      }
    }
  });
  return Object.freeze({
    async submit(input) {
      if (closing) throw Object.assign(new Error("materialization_provider_closing"), { code: "materialization_provider_closing" });
      const admitted = await engine.submit(input);
      const record = await engine.get(admitted.requestRef);
      if (record?.status !== "completed") {
        await queue.enqueue({ schedulingScope: { workspaceId: record.workspaceId }, dedupeKey: admitted.requestRef, workItemId: `materialization-work:${record.bindingDigest}`, payloadRef: { requestRef: admitted.requestRef }, ownerRef: { capability: "platform.job-workflow", subjectRef: record.binding.subjectRef }, payloadKind: "upload_workspace_materialization", maxAttempts: 3 });
        void queue.requestDispatch();
      }
      return admitted;
    },
    get: engine.get,
    async cancel(requestRef, { subject } = {}) {
      const record = await engine.get(requestRef);
      if (!record || !subject?.subjectId || record.subject?.subjectId !== subject.subjectId) return null;
      const publicState = (value) => Object.freeze({
        requestRef: value.requestRef,
        status: value.status,
        stage: value.stage
      });
      if (["completed", "failed", "cancelled"].includes(record.status)) return publicState(record);
      await queue.cancel({
        workItemId: `materialization-work:${record.bindingDigest}`,
        operationId: "jobs.upload_workspace_materialization_cancel",
        actor: { system: "platform-job-workflow" },
        reason: "workspace_materialization_cancelled"
      });
      await store.cancelQueued(requestRef);
      return publicState(await engine.get(requestRef));
    },
    async close() {
      if (closing) return;
      closing = true;
      await queue.close({ timeoutMs: 30_000 });
      if (ownsTransactionStore) store.close();
    }
  });
}
