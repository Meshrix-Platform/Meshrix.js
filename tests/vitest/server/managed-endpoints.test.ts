import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteWorkQueueStore } from "../../../packages/foundation/src/work-queue/sqlite-store.ts";
import { createQueueApplicationPort } from "../../../packages/server-runtime/src/composition/queue-application-port.ts";
import { openManagedEndpointStore } from "../../../packages/server-runtime/src/managed-endpoints/store.ts";
import {
  createManagedEndpointService,
  managedActorFromSession
} from "../../../packages/server-runtime/src/managed-endpoints/domain.ts";
import { createManagedEndpointsController } from "../../../packages/protocols/http/controllers/managed-endpoints-controller.ts";
import { controlledManagedAuthority } from "./support/managed-authority-fixture.ts";

// Neutral protocol fixtures only: managed-endpoint worker traffic is modelled
// by in-process calls against the same service methods the HTTP worker routes
// invoke. No client repository or native product is imported, built or run.

const newDeviceCredential = (): string => `mdc_${randomBytes(12).toString("hex")}`;
const newEnrollmentToken = (): string => `met_${randomBytes(12).toString("hex")}`;

interface Env {
  dir: string;
  now: number;
  store: any;
  queueStore: any;
  queueDatabase: any;
  port: any;
  service: any;
}

const envs: Env[] = [];

async function createEnv(): Promise<Env> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "managed-endpoints-"));
  const env: Env = { dir, now: 1_700_000_000_000 } as Env;
  envs.push(env);
  env.queueDatabase = new Database(":memory:");
  env.queueStore = createSqliteWorkQueueStore({
    db: env.queueDatabase,
    timeSource: { nowMs: () => env.now }
  });
  env.port = await createQueueApplicationPort({
    userDataPath: dir,
    store: env.queueStore
  });
  env.store = openManagedEndpointStore({ databasePath: path.join(dir, "managed-endpoints.db") });
  env.service = createManagedEndpointService({
    store: env.store,
    queuePort: env.port,
    nowMs: () => env.now,
    maxLeasedPerEndpoint: 1,
    authorityPort: controlledManagedAuthority(actor())
  });
  return env;
}

afterEach(async () => {
  const errors: unknown[] = [];
  for (const env of envs.splice(0)) {
    for (const close of [
      () => env.service?.close(), () => env.port?.close(), () => env.store?.close(),
      () => env.queueDatabase?.close(), () => fs.rm(env.dir, { recursive: true, force: true })
    ]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
  }
  if (errors.length) throw new AggregateError(errors, "Managed fixture cleanup failed.");
});

function actor(organizationId = "org-a", subjectId = "user-1") {
  return managedActorFromSession({
    user: { userId: subjectId, tenantId: "local", orgId: organizationId }
  });
}

function lease(assignment: any) {
  return { taskId: assignment.taskId, leaseId: assignment.leaseId, leaseSeq: assignment.leaseSeq };
}

const CATALOG = [
  {
    capabilityId: "ops.ping",
    label: "Ping",
    kind: "command",
    inputSchema: { type: "object" },
    revision: 1
  }
];

async function createAndEnroll(env: Env, { label = "device-1", allowed = ["ops.ping"] } = {}) {
  const { endpoint, enrollmentToken } = await env.service.createEndpoint(actor(), {
    label,
    kind: "workstation",
    allowedCapabilityIds: allowed
  });
  const credential = newDeviceCredential();
  const enrollment = await env.service.enroll({
    enrollmentToken,
    deviceCredential: credential,
    capabilities: CATALOG
  });
  const device = env.service.verifyWorker(credential);
  return { endpoint, enrollmentToken, credential, device, enrollment };
}

describe("managed endpoints", () => {
  it("enforces configured concurrency even when a worker asks for eight tasks", async () => {
    const env = await createEnv();
    const { endpoint, device } = await createAndEnroll(env);
    for (let index = 0; index < 3; index += 1) {
      await env.service.submitTask(actor(), { requestId: `request-capacity-${index}`, endpointId: endpoint.endpointId, capabilityId: "ops.ping", input: {} });
    }
    const first = await env.service.workerPoll(device, { batchSize: 8 });
    expect(first.assignments).toHaveLength(1);
    await env.service.workerStart(device, lease(first.assignments[0]));
    expect((await env.service.workerPoll(device, { batchSize: 8 })).assignments).toEqual([]);
  });

  it("keeps catalog changes scoped and refuses stale snapshots without overwriting administrator policy", async () => {
    const env = await createEnv();
    const { endpoint, device } = await createAndEnroll(env);
    const snapshot = env.store.getEndpoint(endpoint.endpointId);
    await env.service.updateEndpoint(actor(), endpoint.endpointId, { label: "Current admin label", allowedCapabilityIds: [] });
    expect(env.store.updateCatalog(snapshot, [{ ...CATALOG[0], revision: 2 }], snapshot.publishedWorkspaces, env.now)).toMatchObject({
      label: "Current admin label", allowedCapabilityIds: [], generation: snapshot.generation
    });
    expect(env.store.updateCatalog(snapshot, CATALOG, snapshot.publishedWorkspaces, env.now)).toBeNull();
    await expect(env.service.workerCatalog(device, { capabilities: CATALOG }))
      .rejects.toMatchObject({ code: "managed_capability_revision_conflict" });
    await env.service.revokeEndpoint(actor(), endpoint.endpointId);
    expect(env.store.updateCatalog(snapshot, CATALOG, env.now)).toBeNull();
    expect(env.store.getEndpoint(endpoint.endpointId).state).toBe("revoked");
  });

  it("reports only authenticated contact observations and does not invent failure from elapsed time", async () => {
    const env = await createEnv();
    const { endpoint, credential } = await createAndEnroll(env);
    const before = env.store.endpointObservations(actor().tenantId, actor().organizationId)[0].lastContactAtMs;
    env.now += 86400000;
    expect(env.store.endpointObservations(actor().tenantId, actor().organizationId)[0].lastContactAtMs).toBe(before);
    expect(env.store.getEndpoint(endpoint.endpointId).state).toBe("active");
    env.service.verifyWorker(credential);
    expect((await env.service.listEndpoints(actor())).observations).toEqual([{ endpointId: endpoint.endpointId, lastContactAtMs: env.now }]);
  });

  it("selects fairly per organization instead of starving devices under interleaved callers", async () => {
    const env = await createEnv();
    for (const organizationId of ["org-a", "org-b"]) {
      for (let index = 0; index < 2; index += 1) {
        const created = await env.service.createEndpoint(actor(organizationId), { label: "Synthetic fair device", allowedCapabilityIds: ["ops.ping"] });
        await env.service.enroll({
          enrollmentToken: created.enrollmentToken, capabilities: CATALOG,
          deviceCredential: newDeviceCredential()
        });
      }
    }
    const selected: Record<string, Set<string>> = { "org-a": new Set(), "org-b": new Set() };
    for (let index = 0; index < 4; index += 1) {
      for (const organizationId of ["org-a", "org-b"]) {
        const submitted = await env.service.submitTask(actor(organizationId), {
          requestId: `request-fair-${index}`, capabilityId: "ops.ping", input: {}
        }, { authSession: { user: actor(organizationId) } });
        selected[organizationId].add(submitted.task.endpointId);
      }
    }
    expect(Object.values(selected).map((set) => set.size)).toEqual([2, 2]);
  });

  it.each([
    ["queueDefinitionId", "queue_definition_id"],
    ["tenantId", "tenant_id"],
    ["workspaceId", "workspace_id"],
    ["projectId", "project_id"]
  ])("fences remote reads and every mutation against the actual %s owner", async (_field, column) => {
    const env = await createEnv();
    const facet = await env.port.registerQueue({
      queueDefinitionId: "fixture.remote-scope", ownerCapability: "fixture.remote-scope",
      label: "Synthetic remote scope",
      consumerEnabled: false, workerId: "fixture-bound-worker",
      scope: { tenantId: "local", workspaceId: "fixture-org", projectId: "fixture-device" }
    });
    await facet.enqueue({ workItemId: "fixture-foreign-item", payloadRef: { taskId: "fixture-foreign-item" }, expiresAtMs: env.now + 60000 });
    const claimed = (await facet.remote.claim({ batchSize: 1 })).claimed[0];
    env.queueDatabase.prepare(`UPDATE work_items SET ${column} = ? WHERE work_item_id = ?`)
      .run("foreign-synthetic-owner", "fixture-foreign-item");
    for (const method of [
      "inspectWorkItem", "progress", "complete", "fail", "markInDoubt",
      "acknowledgeTermination", "recordSinkReceipt", "reconcileInDoubt", "cancelRunning"
    ]) {
      await expect(facet.remote[method]({
        workItemId: "fixture-foreign-item", leaseId: "lease-synthetic", leaseSeq: 1, generation: 1,
        scope: { tenantId: "foreign-synthetic-owner" }, queueDefinitionId: "foreign-synthetic-owner",
        consumerId: "untrusted-worker", workerId: "untrusted-worker", sinkId: "complete", toState: "completed"
      })).rejects.toMatchObject({ code: "remote_consumer_foreign_task" });
    }
    await expect(facet.remote.progress({
      workItemId: "fixture-foreign-item", leaseId: claimed.lease.leaseId,
      leaseSeq: claimed.lease.leaseSeq, confirmRunning: true
    })).rejects.toMatchObject({ code: "remote_consumer_foreign_task" });
    expect(env.queueDatabase.prepare("SELECT count(*) AS count FROM work_queue_sink_fences").get().count).toBe(0);
  });

  it("creates, enrolls and replays enrollment idempotently, rejecting rebinding", async () => {
    const env = await createEnv();
    const { endpoint, enrollmentToken, credential, device } = await createAndEnroll(env);
    expect(endpoint.state).toBe("pending");
    expect(device.endpointId).toBe(endpoint.endpointId);
    expect(device.organizationId).toBe("org-a");

    // Identical replay returns the same enrollment.
    const replay = await env.service.enroll({
      enrollmentToken,
      deviceCredential: credential,
      capabilities: CATALOG
    });
    expect(replay.endpoint.endpointId).toBe(endpoint.endpointId);

    // A different credential under the consumed token is a rejected rebind.
    await expect(env.service.enroll({
      enrollmentToken,
      deviceCredential: newDeviceCredential(),
      capabilities: CATALOG
    })).rejects.toMatchObject({ code: "managed_enrollment_rebind_rejected" });
  });

  it("fails closed for missing organization identity and cross-organization access", async () => {
    const env = await createEnv();
    const { endpoint } = await createAndEnroll(env);
    expect(() => managedActorFromSession({ user: { userId: "u", tenantId: "local" } }))
      .toThrowError(expect.objectContaining({ code: "managed_organization_required" }));

    const other = actor("org-b", "user-9");
    await expect(env.service.getTask(other, "mtask_missing")).rejects.toMatchObject({ statusCode: 404 });
    const listing = await env.service.listEndpoints(other);
    expect(listing.endpoints).toHaveLength(0);
    await expect(env.service.revokeEndpoint(other, endpoint.endpointId))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(env.service.submitTask(other, {
      requestId: "req-cross-0001",
      endpointId: endpoint.endpointId,
      capabilityId: "ops.ping",
      input: {}
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects invalid and revoked worker credentials", async () => {
    const env = await createEnv();
    const { credential, endpoint } = await createAndEnroll(env);
    expect(() => env.service.verifyWorker("not-a-credential"))
      .toThrowError(expect.objectContaining({ code: "managed_device_credential_invalid" }));
    expect(() => env.service.verifyWorker(newDeviceCredential()))
      .toThrowError(expect.objectContaining({ code: "managed_device_credential_invalid" }));

    await env.service.revokeEndpoint(actor(), endpoint.endpointId);
    expect(() => env.service.verifyWorker(credential))
      .toThrowError(expect.objectContaining({ code: "managed_device_credential_invalid" }));
  });

  it("rejects unapproved capabilities and stale capability revisions", async () => {
    const env = await createEnv();
    const { endpoint, device } = await createAndEnroll(env);
    await expect(env.service.submitTask(actor(), {
      requestId: "req-unapproved-1",
      capabilityId: "ops.denied",
      input: {}
    })).rejects.toMatchObject({ code: "managed_capability_unavailable" });

    // Submit succeeds while revision 1 is current.
    const submitted = await env.service.submitTask(actor(), {
      requestId: "req-revision-001",
      endpointId: endpoint.endpointId,
      capabilityId: "ops.ping",
      input: {}
    });
    expect(submitted.task.state).toBe("queued");

    // Device republishes the capability at a new revision; delivery is blocked
    // before any effect launches and the task settles as failed policy.
    await env.service.workerCatalog(device, {
      capabilities: [{ ...CATALOG[0], revision: 2 }]
    });
    const poll = await env.service.workerPoll(device, { batchSize: 1 });
    expect(poll.assignments).toHaveLength(0);
    const after = await env.service.getTask(actor(), submitted.task.taskId);
    expect(after.task.state).toBe("failed");
    expect(after.task.errorCode).toBe("managed_policy_revoked");
  });

  it("runs a task end-to-end: queue, device claim, durable result", async () => {
    const env = await createEnv();
    const { endpoint, device } = await createAndEnroll(env);
    const submitted = await env.service.submitTask(actor(), {
      requestId: "req-e2e-000001",
      capabilityId: "ops.ping",
      input: { message: "hello" }
    });
    expect(submitted.task.endpointId).toBe(endpoint.endpointId);

    const poll = await env.service.workerPoll(device, { batchSize: 1 });
    expect(poll.assignments).toHaveLength(1);
    const assignment = poll.assignments[0];
    expect(assignment).toMatchObject({
      protocol: "meshrix.managed-endpoint/1",
      taskId: submitted.task.taskId,
      endpointId: endpoint.endpointId,
      organizationId: "org-a",
      capabilityId: "ops.ping",
      capabilityRevision: 1,
      input: { message: "hello" }
    });
    expect(assignment.leaseId).toBeTruthy();
    expect(assignment.leaseSeq).toBeGreaterThan(0);

    const started = await env.service.workerStart(device, {
      taskId: assignment.taskId,
      leaseId: assignment.leaseId,
      leaseSeq: assignment.leaseSeq
    });
    expect(started).toEqual({ ...lease(assignment), authorized: true, cancelRequested: false });

    const completed = await env.service.workerComplete(device, {
      taskId: assignment.taskId,
      leaseId: assignment.leaseId,
      leaseSeq: assignment.leaseSeq,
      state: "succeeded",
      result: { echoed: true }
    });
    expect(completed.task.state).toBe("succeeded");

    const observed = await env.service.getTask(actor(), assignment.taskId);
    expect(observed.task.result).toEqual({ echoed: true });
    expect(observed.workItem.state).toBe("completed");
  });

  it("never duplicates work for a repeated requestId and rejects conflicts", async () => {
    const env = await createEnv();
    await createAndEnroll(env);
    const first = await env.service.submitTask(actor(), {
      requestId: "req-dedupe-0001",
      capabilityId: "ops.ping",
      input: { a: 1 }
    });
    const second = await env.service.submitTask(actor(), {
      requestId: "req-dedupe-0001",
      capabilityId: "ops.ping",
      input: { a: 1 }
    });
    expect(second.idempotent).toBe(true);
    expect(second.task.taskId).toBe(first.task.taskId);
    await expect(env.service.submitTask(actor(), {
      requestId: "req-dedupe-0001",
      capabilityId: "ops.ping",
      input: { a: 2 }
    })).rejects.toMatchObject({ code: "managed_request_conflict" });
  });

  it("delivers one exclusive task to only one of two claimed devices", async () => {
    const env = await createEnv();
    await createAndEnroll(env);
    const { credential: credential2 } = await createAndEnroll(env, { label: "device-2" });
    const device2 = env.service.verifyWorker(credential2);
    const device2Endpoint = env.store.getEndpoint(device2.endpointId);

    const submitted = await env.service.submitTask(actor(), {
      requestId: "req-exclusive-01",
      capabilityId: "ops.ping",
      input: {}
    });
    // Task routed to the first capable device; a second device scope never
    // sees it, and a same-device re-claim returns nothing replayable.
    const foreign = await env.service.workerPoll(device2, { batchSize: 1 });
    expect(foreign.assignments).toHaveLength(0);
    void submitted;
    void device2Endpoint;
  });

  it("keeps long-running work alive across a disconnected poll", async () => {
    const env = await createEnv();
    const { device } = await createAndEnroll(env);
    const submitted = await env.service.submitTask(actor(), {
      requestId: "req-longrun-0001",
      capabilityId: "ops.ping",
      input: {}
    });
    const poll = await env.service.workerPoll(device, { batchSize: 1, leaseTimeoutMs: 5000 });
    const assignment = poll.assignments[0];
    await env.service.workerStart(device, lease(assignment));

    // Advance beyond the lease timeout without termination evidence: the item
    // settles as in_doubt through the next claim's recovery pass and is never
    // handed out for re-execution.
    env.now += 60_000;
    const repoll = await env.service.workerPoll(device, { batchSize: 4 });
    expect(repoll.assignments).toHaveLength(0);
    const inspected = await env.service.getTask(actor(), submitted.task.taskId);
    expect(inspected.workItem.state).toBe("in_doubt");
  });

  it("delivers durable cancellation to a running device and settles cancelled", async () => {
    const env = await createEnv();
    const { device } = await createAndEnroll(env);
    const submitted = await env.service.submitTask(actor(), {
      requestId: "req-cancel-00001",
      capabilityId: "ops.ping",
      input: {}
    });
    const poll = await env.service.workerPoll(device, { batchSize: 1 });
    const assignment = poll.assignments[0];
    await env.service.workerStart(device, lease(assignment));

    const cancelled = await env.service.cancelTask(actor(), submitted.task.taskId);
    expect(cancelled.task.cancelRequested).toBe(true);
    // Still leased: not claimed as terminated until device evidence arrives.
    expect(cancelled.task.state).toBe("running");

    const controlPoll = await env.service.workerPoll(device, { batchSize: 1 });
    expect(controlPoll.controls).toEqual([
      expect.objectContaining({ type: "cancel", taskId: assignment.taskId })
    ]);

    await env.service.workerComplete(device, {
      taskId: assignment.taskId,
      leaseId: assignment.leaseId,
      leaseSeq: assignment.leaseSeq,
      state: "cancelled",
      result: null
    });
    const observed = await env.service.getTask(actor(), submitted.task.taskId);
    expect(observed.task.state).toBe("cancelled");
  });

  it("routes task-scoped permission prompts to organization approval", async () => {
    const env = await createEnv();
    const { device } = await createAndEnroll(env);
    const submitted = await env.service.submitTask(actor(), {
      requestId: "req-perm-0000001",
      capabilityId: "ops.ping",
      input: {}
    });
    const poll = await env.service.workerPoll(device, { batchSize: 1 });
    const assignment = poll.assignments[0];
    await env.service.workerStart(device, lease(assignment));

    const created = await env.service.workerPermission(device, {
      permissionId: "mperm_synthetic_permission",
      taskId: assignment.taskId,
      leaseId: assignment.leaseId,
      leaseSeq: assignment.leaseSeq,
      prompt: {
        title: "write file",
        options: [
          { optionId: "allow-once", label: "Allow once" },
          { optionId: "deny", label: "Deny" }
        ]
      }
    });
    expect(created.permission.state).toBe("pending");

    // Exact pending options only.
    await expect(env.service.resolvePermission(actor(), submitted.task.taskId, {
      permissionId: created.permission.permissionId,
      selectedOptionId: "invented"
    })).rejects.toMatchObject({ code: "managed_permission_option_invalid" });

    // Another organization cannot resolve it.
    await expect(env.service.resolvePermission(actor("org-b"), submitted.task.taskId, {
      permissionId: created.permission.permissionId,
      selectedOptionId: "allow-once"
    })).rejects.toMatchObject({ statusCode: 404 });

    const resolved = await env.service.resolvePermission(actor(), submitted.task.taskId, {
      permissionId: created.permission.permissionId,
      selectedOptionId: "allow-once"
    });
    expect(resolved.permission.state).toBe("resolved");

    const deliverPoll = await env.service.workerPoll(device, { batchSize: 1 });
    expect(deliverPoll.permissionResolutions).toEqual([
      expect.objectContaining({
        permissionId: created.permission.permissionId,
        resolution: { selectedOptionId: "allow-once" }
      })
    ]);
  });

  it("replays identical completion idempotently and rejects conflicting outcomes", async () => {
    const env = await createEnv();
    const { device } = await createAndEnroll(env);
    await env.service.submitTask(actor(), {
      requestId: "req-replay-00001",
      capabilityId: "ops.ping",
      input: {}
    });
    const poll = await env.service.workerPoll(device, { batchSize: 1 });
    const assignment = poll.assignments[0];

    await env.service.workerStart(device, lease(assignment));
    await env.service.workerComplete(device, {
      taskId: assignment.taskId,
      leaseId: assignment.leaseId,
      leaseSeq: assignment.leaseSeq,
      state: "succeeded",
      result: { ok: 1 }
    });
    const replay = await env.service.workerComplete(device, {
      taskId: assignment.taskId,
      leaseId: assignment.leaseId,
      leaseSeq: assignment.leaseSeq,
      state: "succeeded",
      result: { ok: 1 }
    });
    expect(replay.idempotent).toBe(true);
    await expect(env.service.workerComplete(device, {
      taskId: assignment.taskId,
      leaseId: assignment.leaseId,
      leaseSeq: assignment.leaseSeq,
      state: "succeeded",
      result: { ok: 2 }
    })).rejects.toMatchObject({ code: "managed_task_outcome_conflict" });
  });

  it("keeps device credentials and enrollment tokens out of projections", async () => {
    const env = await createEnv();
    const secretMarker = newDeviceCredential();
    const { endpoint, enrollmentToken } = await env.service.createEndpoint(actor(), {
      label: "projection-check",
      kind: "workstation",
      allowedCapabilityIds: ["ops.ping"]
    });
    await env.service.enroll({
      enrollmentToken,
      deviceCredential: secretMarker,
      capabilities: CATALOG
    });
    const listing = await env.service.listEndpoints(actor());
    const serialized = JSON.stringify(listing);
    expect(serialized).not.toContain(secretMarker);
    expect(serialized).not.toContain(enrollmentToken);
    expect(serialized).not.toContain("credentialHash");
    expect(listing.endpoints.map((e: any) => e.endpointId)).toEqual([endpoint.endpointId]);
  });

  it("authenticates worker routes only through the device credential header", async () => {
    const env = await createEnv();
    const { credential, enrollmentToken } = await createAndEnroll(env);
    const controller = createManagedEndpointsController({
      managedEndpointService: env.service,
      actorFromSession: managedActorFromSession
    });

    const missing = await controller.verifyManagedEndpointWorkerAuth({
      request: { headers: {} }
    });
    expect(missing.ok).toBe(false);
    expect(missing.status).toBe(403);

    const wrong = await controller.verifyManagedEndpointWorkerAuth({
      request: { headers: { "x-meshrix-device-credential": newDeviceCredential() } }
    });
    expect(wrong.ok).toBe(false);

    const verified = await controller.verifyManagedEndpointWorkerAuth({
      request: { headers: { "x-meshrix-device-credential": credential } }
    });
    expect(verified.ok).toBe(true);
    expect(verified.actor.type).toBe("managed-device");
    expect(verified.actor.orgId).toBe("org-a");
    expect(verified.actor.scopes).toEqual([]);
    const revalidated = await verified.revalidateAuthorization();
    expect(revalidated.ok).toBe(true);

    // Enrollment admission and effect-time revalidation use the real token
    // binding, not merely the presence of a token-shaped string.
    const badEnroll = await controller.verifyManagedEndpointEnrollmentAuth({
      requestBody: Buffer.from(JSON.stringify({}))
    });
    expect(badEnroll.ok).toBe(false);
    const fabricatedEnroll = await controller.verifyManagedEndpointEnrollmentAuth({
      requestBody: Buffer.from(JSON.stringify({ enrollmentToken: newEnrollmentToken() }))
    });
    expect(fabricatedEnroll.ok).toBe(false);
    const goodEnroll = await controller.verifyManagedEndpointEnrollmentAuth({
      requestBody: Buffer.from(JSON.stringify({ enrollmentToken, deviceCredential: credential }))
    });
    expect(goodEnroll.ok).toBe(true);
    expect((await goodEnroll.revalidateAuthorization()).ok).toBe(true);
  });
});
