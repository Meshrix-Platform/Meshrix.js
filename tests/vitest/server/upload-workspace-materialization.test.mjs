import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUploadWorkspaceMaterialization } from "../../../packages/server-runtime/src/jobs/upload-workspace-materialization.mjs";
import { createUploadWorkspaceMaterializationProvider, createUploadWorkspaceMaterializationTransactionStore, settleMaterializationQueueFailure } from "../../../packages/server-runtime/src/composition/upload-workspace-materialization-provider.mjs";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function store(options = {}) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-materialization-test-"));
  roots.push(userDataPath);
  return createUploadWorkspaceMaterializationTransactionStore({ userDataPath, ...options });
}

function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function governance(receiptDigest = "receipt-a") { return { operationId: "jobs.upload_workspace_materialize", authorized: true, approved: true, receiptDigest }; }

function providerInput() {
  const content = Buffer.from("provider-content");
  return {
    content,
    input: {
      subject: { subjectId: "user-a" },
      workspaceId: "workspace-a",
      uploadSessionId: "upload-a",
      expectedWorkspaceRevision: "revision-a",
      governanceReceipt: governance(),
      mutation: { files: [{ sourcePath: "source-a", targetPath: "target-a.txt" }] }
    }
  };
}

async function providerHarness(transactionStore, enqueue) {
  const { content, input } = providerInput();
  const queue = {
    enqueue,
    cancel: vi.fn().mockResolvedValue({ cancelled: true }),
    requestDispatch: vi.fn(),
    close: vi.fn().mockResolvedValue({ closed: true })
  };
  const queueApplicationPort = {
    registerQueue: vi.fn().mockResolvedValue(queue)
  };
  const provider = await createUploadWorkspaceMaterializationProvider({
    userDataPath: "<unused-with-injected-store>",
    transactionStore,
    queueApplicationPort,
    uploadSessionStore: {
      buildCheckpointReceiptFromUploadSession: vi.fn().mockResolvedValue({
        ownerSubjectId: "user-a",
        sessionId: "upload-a"
      }),
      resolveUploadSessionFiles: vi.fn().mockResolvedValue([{
        relativePath: "source-a",
        name: "source-a",
        sha256: sha(content),
        byteSize: content.length,
        content,
        stagedPath: "<unused>"
      }])
    },
    agentWorkspace: {},
    operationAuditStore: { append: vi.fn() },
    operationProofSubstrate: {
      beginLifecycle: vi.fn(),
      finishLifecycle: vi.fn()
    }
  });
  return { provider, queue, input };
}

function harness(transactionStore, { initial = { "existing.txt": "old" }, delayMs = 0, afterMutation = null, leaseHeartbeatMs = 5 } = {}) {
  const files = new Map(Object.entries(initial));
  const content = Buffer.from("new-content");
  const revision = () => sha(JSON.stringify([...files.entries()].sort()));
  const initialRevision = revision();
  const proofOutcomes = new Map();
  const audits = new Map();
  let applyCount = 0;
  let uploadAvailable = true;
  let uploadResolveCount = 0;
  const engine = createUploadWorkspaceMaterialization({
    uploadPort: { async resolveCompleted({ includeContent }) { uploadResolveCount += 1; if (!uploadAvailable) throw new Error("upload_session_unavailable"); return { receipt: { ownerSubjectId: "user-a", sessionId: "upload-a" }, files: [
      { relativePath: "source-a", sha256: sha(content), byteSize: content.length, ...(includeContent ? { content } : {}) },
      { relativePath: "source-b", sha256: sha(content), byteSize: content.length, ...(includeContent ? { content } : {}) }
    ] }; } },
    workspacePort: {
      getRevision: async () => revision(),
      async captureSnapshot(record) { await record.leaseGuard?.(); return { complete: true, values: Object.fromEntries(record.targets.map(({ relativePath }) => [relativePath, files.has(relativePath) ? files.get(relativePath) : null])) }; },
      async applyBatch({ files: mutations, leaseGuard }) {
        const beforeRoot = revision();
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        for (const { target, content: nextContent } of mutations) {
          await leaseGuard?.();
          applyCount += 1;
          files.set(target.relativePath, nextContent.toString());
        }
        return {
          beforeRoot,
          afterRoot: revision(),
          checkpointRefs: [`checkpoint-batch-${applyCount}`]
        };
      },
      async restoreSnapshot({ snapshot }) { for (const [name, value] of Object.entries(snapshot.values)) value === null ? files.delete(name) : files.set(name, value); },
      async withMutationLock(_workspaceId, task) { return task(); }
    },
    auditPort: { async append(entry) { audits.set(entry.auditId, entry); return { auditId: entry.auditId }; } },
    proofPort: {
      async beginLifecycle(input) { return input; },
      async finishLifecycle(input) { const key = input.outcomeIdempotencyKey; if (!proofOutcomes.has(key)) proofOutcomes.set(key, { ledgerEventId: sha(key) }); return proofOutcomes.get(key); }
    },
    transactionStore,
    afterMutation,
    leaseHeartbeatMs
  });
  const input = {
    subject: { subjectId: "user-a" }, workspaceId: "workspace-a", uploadSessionId: "upload-a",
    expectedWorkspaceRevision: initialRevision, governanceReceipt: governance(),
    mutation: { files: [{ sourcePath: "source-a", targetPath: "existing.txt" }, { sourcePath: "source-b", targetPath: "new.txt" }] }
  };
  return {
    engine,
    input,
    files,
    initialRevision,
    revision,
    proofOutcomes,
    audits,
    retireUpload() { uploadAvailable = false; },
    get uploadResolveCount() { return uploadResolveCount; },
    get applyCount() { return applyCount; }
  };
}

describe("upload workspace materialization transaction", () => {
  it("retries durable admission after queue backpressure without orphaning the request", async () => {
    const tx = await store();
    const capacityError = Object.assign(new Error("capacity"), {
      code: "work_queue_capacity_exceeded"
    });
    const enqueue = vi.fn()
      .mockRejectedValueOnce(capacityError)
      .mockResolvedValueOnce({ accepted: true, deduped: false });
    const h = await providerHarness(tx, enqueue);

    await expect(h.provider.submit(h.input)).rejects.toBe(capacityError);
    expect(tx.count()).toBe(1);
    const retried = await h.provider.submit(h.input);
    expect(retried).toMatchObject({ accepted: true, deduped: true });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[1][0].dedupeKey).toBe(enqueue.mock.calls[0][0].dedupeKey);
    expect(await tx.get(retried.requestRef)).toMatchObject({ status: "queued", stage: "admitted" });
    expect(h.queue.requestDispatch).toHaveBeenCalledOnce();
    await h.provider.close();
    tx.close();
  });

  it("converges after enqueue succeeded but its first acknowledgement was lost", async () => {
    const tx = await store();
    const accepted = new Set();
    const enqueue = vi.fn(async ({ dedupeKey }) => {
      if (!accepted.has(dedupeKey)) {
        accepted.add(dedupeKey);
        throw Object.assign(new Error("acknowledgement_lost"), { code: "transport_lost" });
      }
      return { accepted: true, deduped: true };
    });
    const h = await providerHarness(tx, enqueue);

    await expect(h.provider.submit(h.input)).rejects.toMatchObject({ code: "transport_lost" });
    await expect(h.provider.submit(h.input)).resolves.toMatchObject({ accepted: true, deduped: true });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(accepted.size).toBe(1);
    expect(h.queue.requestDispatch).toHaveBeenCalledOnce();
    await h.provider.close();
    tx.close();
  });

  it("does not enqueue a completed materialization replay", async () => {
    const tx = await store();
    const enqueue = vi.fn().mockResolvedValue({ accepted: true, deduped: false });
    const h = await providerHarness(tx, enqueue);
    const admitted = await h.provider.submit(h.input);
    await tx.begin(admitted.requestRef, { ownerFence: "test-owner" });
    await tx.complete(admitted.requestRef, {
      ownerFence: "test-owner",
      result: { status: "completed", workspaceId: "workspace-a" }
    });
    enqueue.mockClear();
    h.queue.requestDispatch.mockClear();

    await expect(h.provider.submit(h.input)).resolves.toMatchObject({
      accepted: true,
      deduped: true,
      result: { status: "completed" }
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(h.queue.requestDispatch).not.toHaveBeenCalled();
    await h.provider.close();
    tx.close();
  });

  it("deduplicates across dispatcher traces and rejects duplicate targets", async () => {
    const tx = await store();
    const h = harness(tx);
    const first = await h.engine.submit(h.input);
    const second = await h.engine.submit({ ...h.input, governanceReceipt: governance("receipt-from-another-trace") });
    expect(second.requestRef).toBe(first.requestRef);
    expect(second.deduped).toBe(true);
    await expect(h.engine.submit({ ...h.input, mutation: { files: [
      { sourcePath: "source-a", targetPath: "same.txt" }, { sourcePath: "source-b", targetPath: "same.txt" }
    ] } })).rejects.toMatchObject({ code: "materialization_target_duplicate" });
    tx.close();
  });

  it("admits exactly one queue producer under concurrent duplicate submission", async () => {
    const tx = await store();
    const h = harness(tx);
    const admitted = await Promise.all(Array.from({ length: 12 }, (_, index) => h.engine.submit({
      ...h.input,
      governanceReceipt: governance(`trace-${index}`)
    })));
    expect(new Set(admitted.map((entry) => entry.requestRef)).size).toBe(1);
    expect(admitted.filter((entry) => !entry.deduped)).toHaveLength(1);
    tx.close();
  });

  it("executes from immutable custody after the upload session is unavailable", async () => {
    const tx = await store();
    const h = harness(tx);
    const admitted = await h.engine.submit(h.input);
    h.retireUpload();

    await expect(h.engine.execute({
      requestRef: admitted.requestRef,
      ownerFence: "custody-owner"
    })).resolves.toMatchObject({ status: "completed" });
    expect(h.uploadResolveCount).toBe(1);
    expect(JSON.stringify(await tx.get(admitted.requestRef))).not.toContain("new-content");
    tx.close();
  });

  it("cancels queued work through the canonical queue and terminalizes its transaction", async () => {
    const tx = await store();
    const h = await providerHarness(tx, vi.fn().mockResolvedValue({ accepted: true }));
    const admitted = await h.provider.submit(h.input);

    await expect(h.provider.cancel(admitted.requestRef, {
      subject: { subjectId: "user-a" }
    })).resolves.toMatchObject({
      status: "cancelled",
      stage: "cancelled"
    });
    expect(h.queue.cancel).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: expect.stringMatching(/^materialization-work:/u)
    }));
    await expect(h.provider.submit(h.input)).rejects.toMatchObject({
      code: "materialization_cancelled"
    });
    await h.provider.close();
    tx.close();
  });

  it("does not reveal or cancel another subject's materialization", async () => {
    const tx = await store();
    const h = await providerHarness(tx, vi.fn().mockResolvedValue({ accepted: true }));
    const admitted = await h.provider.submit(h.input);

    await expect(h.provider.cancel(admitted.requestRef, {
      subject: { subjectId: "user-b" }
    })).resolves.toBeNull();
    expect(h.queue.cancel).not.toHaveBeenCalled();
    expect(await tx.get(admitted.requestRef)).toMatchObject({ status: "queued" });
    await h.provider.close();
    tx.close();
  });

  it("compensates a running cancellation before committing its terminal state", async () => {
    const tx = await store();
    const h = harness(tx, { delayMs: 25, leaseHeartbeatMs: 5 });
    const admitted = await h.engine.submit(h.input);
    const controller = new AbortController();
    const running = h.engine.execute({
      requestRef: admitted.requestRef,
      ownerFence: "cancel-owner",
      signal: controller.signal
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    await expect(running).rejects.toMatchObject({ code: "materialization_cancelled" });
    expect(Object.fromEntries(h.files)).toEqual({ "existing.txt": "old" });
    expect(await tx.get(admitted.requestRef)).toMatchObject({
      status: "cancelled",
      stage: "cancelled"
    });
    tx.close();
  });

  it("terminalizes the saga when the canonical queue exhausts retries", async () => {
    const tx = await store();
    await tx.create({ requestRef: "request-exhausted", workspaceId: "workspace-a" });
    const outcome = await settleMaterializationQueueFailure({
      transactionStore: tx,
      requestRef: "request-exhausted",
      error: Object.assign(new Error("transient"), { code: "materialization_transient" }),
      attempt: 3,
      maxAttempts: 3
    });
    expect(outcome).toEqual({ action: "failed", reason: "materialization_transient" });
    expect(await tx.get("request-exhausted")).toMatchObject({ status: "failed", stage: "retry_exhausted" });
    tx.close();
  });

  it("preserves committed recovery diagnostics when retries exhaust", async () => {
    const tx = await store();
    await tx.create({ requestRef: "request-committed", workspaceId: "workspace-a" });
    await tx.begin("request-committed", { ownerFence: "owner-a" });
    await tx.recordEffectsCommitted("request-committed", { ownerFence: "owner-a", revision: "root-a", checkpointRefs: ["checkpoint-a"] });
    await tx.fail("request-committed", { ownerFence: "owner-a", recoverable: true, preserveCommitted: true });
    await settleMaterializationQueueFailure({ transactionStore: tx, requestRef: "request-committed", error: { code: "materialization_evidence_unavailable" }, attempt: 3, maxAttempts: 3 });
    expect(await tx.get("request-committed")).toMatchObject({
      status: "failed",
      stage: "effects_committed_retry_exhausted",
      workspaceRevision: "root-a",
      checkpointRefs: ["checkpoint-a"]
    });
    tx.close();
  });

  it("rolls back both overwritten and newly created targets", async () => {
    const tx = await store();
    const h = harness(tx, { afterMutation: async () => { throw new Error("forced_failure"); } });
    const admitted = await h.engine.submit(h.input);
    await expect(h.engine.execute({ requestRef: admitted.requestRef, ownerFence: "owner-1" })).rejects.toThrow("forced_failure");
    expect(Object.fromEntries(h.files)).toEqual({ "existing.txt": "old" });
    expect(h.revision()).toBe(h.initialRevision);
    tx.close();
  });

  it("renews a short saga lease throughout a slow mutation and prevents takeover", async () => {
    const tx = await store({ leaseMs: 25 });
    const h = harness(tx, { delayMs: 70, leaseHeartbeatMs: 5 });
    const admitted = await h.engine.submit(h.input);
    const running = h.engine.execute({ requestRef: admitted.requestRef, ownerFence: "owner-1", renewLease: async () => {} });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(tx.begin(admitted.requestRef, { ownerFence: "owner-2" })).rejects.toMatchObject({ code: "materialization_fenced" });
    await expect(running).resolves.toMatchObject({ status: "completed" });
    tx.close();
  });

  it("rejects late terminal completion after lease loss", async () => {
    let clock = 100;
    const tx = await store({ leaseMs: 10, now: () => clock });
    await tx.create({ requestRef: "request-a", workspaceId: "workspace-a" });
    await tx.begin("request-a", { ownerFence: "owner-1" });
    clock = 111;
    await tx.begin("request-a", { ownerFence: "owner-2" });
    await expect(tx.complete("request-a", { ownerFence: "owner-1", result: {} })).rejects.toMatchObject({ code: "materialization_fenced" });
    tx.close();
  });

  it("bounds retained terminal transaction rows", async () => {
    let clock = 100;
    const tx = await store({ leaseMs: 10, maxRetained: 2, now: () => clock });
    for (let index = 0; index < 5; index += 1) {
      const ref = `request-${index}`;
      await tx.create({ requestRef: ref, workspaceId: "workspace-a" });
      await tx.begin(ref, { ownerFence: ref });
      await tx.complete(ref, { ownerFence: ref, result: {} });
      clock += 1;
    }
    await tx.create({ requestRef: "request-live", workspaceId: "workspace-a" });
    expect(tx.count()).toBeLessThanOrEqual(3);
    tx.close();
  });

  it("recovers an apply-before-record crash from the target preimage", async () => {
    let clock = 100;
    const tx = await store({ leaseMs: 10, now: () => clock });
    const h = harness(tx);
    const admitted = await h.engine.submit(h.input);
    const record = await tx.get(admitted.requestRef);
    await tx.begin(admitted.requestRef, { ownerFence: "dead-owner" });
    const snapshot = { complete: true, values: { "existing.txt": "old", "new.txt": null } };
    await tx.recordPreimage(admitted.requestRef, { ownerFence: "dead-owner", snapshot });
    await tx.recordMutationPending(admitted.requestRef, { ownerFence: "dead-owner", revision: h.initialRevision, checkpointRefs: [] });
    h.files.set("existing.txt", "partial-write");
    clock = 111;
    await expect(h.engine.execute({ requestRef: admitted.requestRef, ownerFence: "recovery-owner" })).resolves.toMatchObject({ status: "completed" });
    expect(h.files.get("existing.txt")).toBe("new-content");
    expect(record.expectedWorkspaceRevision).toBe(h.initialRevision);
    tx.close();
  });

  it("finalizes an evidence-completed crash without rolling back or duplicating evidence", async () => {
    let clock = 100;
    const tx = await store({ leaseMs: 10, now: () => clock });
    let crashBeforeComplete = true;
    const proxy = {
      ...tx,
      async complete(...args) {
          if (crashBeforeComplete) { crashBeforeComplete = false; throw new Error("simulated_process_crash"); }
          return tx.complete(...args);
      },
      async fail(...args) {
        if (!crashBeforeComplete && (await tx.get(args[0]))?.stage === "evidence_completed") return;
        return tx.fail(...args);
      }
    };
    const h = harness(proxy);
    const admitted = await h.engine.submit(h.input);
    await expect(h.engine.execute({ requestRef: admitted.requestRef, ownerFence: "owner-1" })).rejects.toThrow("simulated_process_crash");
    expect((await tx.get(admitted.requestRef)).stage).toBe("evidence_completed");
    const writesAfterCrash = h.applyCount;
    clock = 111;
    await expect(h.engine.execute({ requestRef: admitted.requestRef, ownerFence: "owner-2" })).resolves.toMatchObject({ status: "completed", replayed: true });
    expect(h.applyCount).toBe(writesAfterCrash);
    expect(h.proofOutcomes.size).toBe(1);
    expect(h.audits.size).toBe(2);
    tx.close();
  });
});
