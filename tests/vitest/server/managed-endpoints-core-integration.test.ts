import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MANAGED_ENDPOINT_PROTOCOL,
  assertManagedEndpoint,
  assertManagedTaskAssignment,
  assertManagedTaskStartResponse,
  type ManagedCapability,
  type ManagedTaskAssignment
} from "../../../packages/contracts/src/managed-endpoints.ts";
import { createManagedEndpointsController } from "../../../packages/protocols/http/controllers/managed-endpoints-controller.ts";
import { createQueueApplicationPort } from "../../../packages/server-runtime/src/composition/queue-application-port.ts";
import {
  createManagedEndpointService,
  managedActorFromSession
} from "../../../packages/server-runtime/src/managed-endpoints/domain.ts";
import { openManagedEndpointStore } from "../../../packages/server-runtime/src/managed-endpoints/store.ts";
import { controlledManagedAuthority } from "./support/managed-authority-fixture.ts";
import { getWorkQueueDatabasePath } from "../../../packages/foundation/src/work-queue/sqlite-store.ts";

type Store = ReturnType<typeof openManagedEndpointStore>;
type Service = ReturnType<typeof createManagedEndpointService>;
type QueuePort = Awaited<ReturnType<typeof createQueueApplicationPort>>;

interface Fixture {
  dir: string;
  store: Store;
  port: QueuePort;
  service: Service;
  settlement: {
    attempts: number;
    persistedAtAttempt: Array<Record<string, unknown> | null>;
  };
  inspection: { failNext: boolean };
  remote: any;
}

const resources: Array<{
  dir: string;
  store?: Store;
  port?: QueuePort;
  service?: Service;
}> = [];

const session = {
  user: { tenantId: "local", orgId: "org-core-fixture", userId: "member-core-fixture" }
};
const actor = managedActorFromSession(session);
const credential = `mdc_${randomBytes(12).toString("hex")}`;
const catalog: ManagedCapability[] = [{
  capabilityId: "fixture.echo",
  label: "Synthetic echo",
  kind: "command",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false
  },
  revision: 1
}];
const prompt = {
  message: "Allow the synthetic operation?",
  options: [
    { optionId: "allow", label: "Allow once" },
    { optionId: "deny", label: "Deny" }
  ]
};
const endpointFields = [
  "endpointId", "tenantId", "organizationId", "label", "kind", "state",
  "generation", "allowedCapabilityIds", "publishedCapabilities", "publishedWorkspaces"
].sort();
const permissionFields = [
  "permissionId", "taskId", "state", "prompt", "selectedOptionId"
].sort();

beforeEach(() => {
  vi.stubEnv("MESHRIX_WORK_QUEUE_STORE", "sqlite");
});

afterEach(async () => {
  vi.restoreAllMocks();
  const errors: unknown[] = [];
  for (const resource of resources.splice(0)) {
    for (const close of [
      () => resource.service?.close(),
      () => resource.port?.close(),
      () => resource.store?.close(),
      () => fs.rm(resource.dir, { recursive: true, force: true })
    ]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await fs.access(resource.dir);
      errors.push(new Error("Synthetic managed-endpoint fixture directory remains."));
    } catch (error: any) {
      if (error?.code !== "ENOENT") errors.push(error);
    }
  }
  vi.unstubAllEnvs();
  if (errors.length) throw new AggregateError(errors, "Managed-endpoint fixture cleanup failed.");
});

async function createFixture({
  failFirstSettlement = false, admissionFault = "", claimFault = false, authorityFault = false, interruptInspect = false, captureQueue = false,
  onEmptyClaim = undefined as (() => void) | undefined
} = {}): Promise<Fixture> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-managed-core-integration-"));
  const resource: (typeof resources)[number] = { dir };
  resources.push(resource);
  const port = await createQueueApplicationPort({ userDataPath: dir });
  resource.port = port;
  const store = openManagedEndpointStore({ userDataPath: dir });
  resource.store = store;
  const settlement: Fixture["settlement"] = { attempts: 0, persistedAtAttempt: [] };
  const inspection = { failNext: false };
  let registeredRemote: any;
  let admissionAttempts = 0;
  let claimAttempts = 0;
  const queuePort = failFirstSettlement || admissionFault || claimFault || onEmptyClaim || interruptInspect || captureQueue ? {
    async registerQueue(input: Record<string, unknown>) {
      const facet = await port.registerQueue(input);
      registeredRemote = facet.remote;
      return {
        ...facet,
        async enqueue(input: Record<string, unknown>) {
          admissionAttempts += 1;
          if (admissionFault === "before" && admissionAttempts === 1) throw new Error("Synthetic admission interruption.");
          const result = await facet.enqueue(input);
          if (admissionFault === "after" && admissionAttempts === 1) throw new Error("Synthetic admission interruption.");
          return result;
        },
        remote: {
          ...facet.remote,
          async inspectWorkItem(input: Record<string, unknown>) {
            if (inspection.failNext) {
              inspection.failNext = false;
              throw new Error("Synthetic cancellation inspection interruption.");
            }
            return facet.remote.inspectWorkItem(input);
          },
          async claim(input: Record<string, unknown>) {
            const result = await facet.remote.claim(input);
            if (!result.claimed?.length) onEmptyClaim?.();
            if (claimFault && ++claimAttempts === 1) throw new Error("Synthetic claim interruption.");
            return result;
          },
          async complete(input: Record<string, unknown>) {
            settlement.attempts += 1;
            settlement.persistedAtAttempt.push(store.getTask(String(input.workItemId)));
            if (failFirstSettlement && settlement.attempts === 1) {
              throw Object.assign(new Error("Synthetic settlement interruption."), {
                code: "synthetic_settlement_interruption"
              });
            }
            return facet.remote.complete(input);
          }
        }
      };
    }
  } : port;
  const baseAuthority = controlledManagedAuthority(actor);
  let authorityAttempts = 0;
  const service = createManagedEndpointService({
    store, queuePort, maxLeasedPerEndpoint: 1,
    authorityPort: {
      ...baseAuthority,
      async capture(input) {
        if (authorityFault && ++authorityAttempts === 1) throw new Error("Synthetic authority interruption.");
        return baseAuthority.capture(input);
      }
    }
  });
  resource.service = service;
  return { dir, port, store, service, settlement, inspection, get remote() { return registeredRemote; } };
}

async function reopenFixture(env: Fixture) {
  const resource = resources.find((entry) => entry.dir === env.dir)!;
  await env.service.close();
  await env.port.close();
  env.store.close();
  delete resource.service;
  delete resource.port;
  delete resource.store;
  resource.port = await createQueueApplicationPort({ userDataPath: env.dir });
  resource.store = openManagedEndpointStore({ userDataPath: env.dir });
  resource.service = createManagedEndpointService({
    store: resource.store, queuePort: resource.port, authorityPort: controlledManagedAuthority(actor)
  });
  Object.assign(env, { port: resource.port, store: resource.store, service: resource.service });
  await env.service.ready();
}

async function observe<T>(operation: () => T | Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: "fulfilled", value: await operation() };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

async function createAndEnroll(env: Fixture) {
  const created = await env.service.createEndpoint(actor, {
    label: "Synthetic workstation",
    kind: "workstation",
    allowedCapabilityIds: [catalog[0].capabilityId]
  });
  const enrollment = await env.service.enroll({
    enrollmentToken: created.enrollmentToken,
    deviceCredential: credential,
    capabilities: []
  });
  await env.service.workerCatalog(env.service.verifyWorker(credential), { capabilities: catalog });
  const device = env.service.verifyWorker(credential);
  return { ...created, enrollment, device };
}

function requestFor(endpointId: unknown) {
  return {
    requestId: "req-core-integration-0001",
    endpointId: String(endpointId),
    capabilityId: catalog[0].capabilityId,
    input: { message: "synthetic input" }
  };
}

function leaseFields(assignment: ManagedTaskAssignment) {
  return {
    taskId: assignment.taskId,
    leaseId: assignment.leaseId,
    leaseSeq: assignment.leaseSeq
  };
}

async function submitAndClaim(env: Fixture) {
  const enrolled = await createAndEnroll(env);
  const request = requestFor(enrolled.endpoint.endpointId);
  const submitted = await env.service.submitTask(actor, request);
  const poll = await env.service.workerPoll(enrolled.device, {
    waitMs: 0, batchSize: 1, leaseTimeoutMs: 300_000
  });
  expect(poll.assignments).toHaveLength(1);
  const assignment = assertManagedTaskAssignment(poll.assignments[0]);
  expect(assignment.taskId).toBe(submitted.task.taskId);
  return { ...enrolled, request, submitted, assignment };
}

function fixtureQueueRow(env: Fixture, taskId: string, expireLease = false): any {
  const database = new Database(getWorkQueueDatabasePath(env.dir), { fileMustExist: true });
  try {
    if (expireLease) {
      expect(database.prepare("UPDATE work_items SET lease_expires_at_ms = 1 WHERE work_item_id = ?").run(taskId).changes).toBe(1);
    }
    return database.prepare("SELECT * FROM work_items WHERE work_item_id = ?").get(taskId);
  } finally {
    database.close();
  }
}

async function controllerResponse(
  handler: (args: Record<string, unknown>) => Promise<unknown>,
  args: Record<string, unknown> = {}
) {
  let status = 0;
  let body: any;
  await handler({
    ...args,
    response: {
      writeHead(code: number) { status = code; },
      end(serialized: string) { body = JSON.parse(serialized); }
    }
  });
  return { status, body };
}

async function workerController(env: Fixture) {
  const controller = createManagedEndpointsController({
    managedEndpointService: env.service,
    actorFromSession: managedActorFromSession
  });
  const auth = await controller.verifyManagedEndpointWorkerAuth({
    request: { headers: { "x-meshrix-device-credential": credential } }
  });
  expect(auth.ok).toBe(true);
  return { controller, authSession: auth.authSession };
}

describe("managed endpoint core integration", () => {
  it.each(["expired-running", "in_doubt"])("confirms the same authorized execution after %s without redispatch", async (state) => {
    const env = await createFixture({ captureQueue: true });
    const { assignment, device } = await submitAndClaim(env);
    await env.service.workerStart(device, leaseFields(assignment));
    const before = fixtureQueueRow(env, assignment.taskId);
    if (state === "in_doubt") {
      await env.remote.markInDoubt({ workItemId: assignment.taskId, ...leaseFields(assignment) });
    } else {
      fixtureQueueRow(env, assignment.taskId, true);
    }
    await env.service.workerEvent(device, {
      ...leaseFields(assignment),
      events: [{ seq: 1, kind: "agent.progress", at: new Date().toISOString(), payload: { phase: "reconnected" } }]
    });
    const after = fixtureQueueRow(env, assignment.taskId);
    expect(after).toMatchObject({
      state: "running", lease_id: before.lease_id, lease_seq: before.lease_seq,
      attempt: before.attempt, leased_by_worker_id: before.leased_by_worker_id, expires_at_ms: before.expires_at_ms
    });
    expect(after.lease_expires_at_ms).toBeGreaterThan(Date.now());
    expect((await env.service.workerPoll(device, { batchSize: 1 })).assignments).toEqual([]);
    expect(await env.service.workerStart(device, leaseFields(assignment))).toMatchObject({ authorized: true });
    const permissionId = "perm.ReconnectedTask.json.1";
    expect(await env.service.workerPermission(device, { ...leaseFields(assignment), permissionId, prompt }))
      .toMatchObject({ permission: { permissionId, state: "pending" } });
    await env.service.resolvePermission(actor, assignment.taskId, { permissionId, selectedOptionId: "allow" });
    expect((await env.service.workerPoll(device, { batchSize: 0 })).permissionResolutions).toHaveLength(1);
  });

  it.each(["wrong-sequence", "unstarted", "unknown"])("never confirms an execution with %s evidence", async (state) => {
    const env = await createFixture({ captureQueue: true });
    const { assignment, device } = await submitAndClaim(env);
    if (state !== "unstarted") await env.service.workerStart(device, leaseFields(assignment));
    if (state === "unknown") {
      await env.service.workerComplete(device, { ...leaseFields(assignment), state: "unknown", result: null });
    } else {
      fixtureQueueRow(env, assignment.taskId, true);
    }
    const before = fixtureQueueRow(env, assignment.taskId);
    await expect(env.service.workerEvent(device, {
      ...leaseFields(assignment), leaseSeq: assignment.leaseSeq + (state === "wrong-sequence" ? 1 : 0),
      events: [{ seq: 1, kind: "agent.progress", at: new Date().toISOString(), payload: {} }]
    })).rejects.toThrow();
    expect(fixtureQueueRow(env, assignment.taskId)).toEqual(before);
    expect(env.store.getTask(assignment.taskId)).toMatchObject({
      startAuthorized: state !== "unstarted", outcomeState: state === "unknown" ? "unknown" : ""
    });
  });

  it("settles late cancellation from in_doubt on the default asynchronous SQLite lane", async () => {
    const env = await createFixture({ captureQueue: true });
    const { assignment, device } = await submitAndClaim(env);
    await env.service.workerStart(device, leaseFields(assignment));
    const before = fixtureQueueRow(env, assignment.taskId);
    await env.remote.markInDoubt({ workItemId: assignment.taskId, ...leaseFields(assignment) });
    await env.service.cancelTask(actor, assignment.taskId);
    expect((await env.service.workerComplete(device, { ...leaseFields(assignment), state: "cancelled", result: null })).task.state)
      .toBe("cancelled");
    expect(env.store.getTask(assignment.taskId)).toMatchObject({ outcomeState: "cancelled", settlementPending: false });
    expect(fixtureQueueRow(env, assignment.taskId)).toMatchObject({ state: "cancelled", attempt: before.attempt, lease_seq: before.lease_seq });
    expect((await env.service.workerPoll(device, { batchSize: 1 })).assignments).toEqual([]);
  });

  it.each([null, [], {}, { optionId: "" }, { optionId: 1 }, { optionId: "x".repeat(161) }, { optionId: "allow\u0000" }])(
    "rejects malformed opaque permission options %#", async (option) => {
      const env = await createFixture();
      const { assignment, device } = await submitAndClaim(env);
      await env.service.workerStart(device, leaseFields(assignment));
      await expect(env.service.workerPermission(device, {
        ...leaseFields(assignment), permissionId: "perm.InvalidOption.json.1", prompt: { options: [option] }
      })).rejects.toMatchObject({ code: "managed_permission_invalid" });
    }
  );

  it("preserves opaque mixed-case permission options and rejects exact duplicates", async () => {
    const env = await createFixture();
    const { assignment, device } = await submitAndClaim(env);
    await env.service.workerStart(device, leaseFields(assignment));
    const optionId = " Allow.Once/ACP ";
    const permissionId = "perm.OpaqueOption.json.1";
    await env.service.workerPermission(device, {
      ...leaseFields(assignment), permissionId, prompt: { options: [{ optionId }] }
    });
    await expect(env.service.resolvePermission(actor, assignment.taskId, { permissionId, selectedOptionId: optionId.trim() }))
      .rejects.toMatchObject({ code: "managed_permission_option_invalid" });
    expect(await env.service.resolvePermission(actor, assignment.taskId, { permissionId, selectedOptionId: optionId }))
      .toMatchObject({ permission: { selectedOptionId: optionId } });
    await reopenFixture(env);
    expect(await env.service.resolvePermission(actor, assignment.taskId, { permissionId, selectedOptionId: optionId }))
      .toMatchObject({ idempotent: true, permission: { selectedOptionId: optionId } });
    await expect(env.service.workerPermission(device, {
      ...leaseFields(assignment), permissionId: "perm.DuplicateOption.json.1", prompt: { options: [{ optionId }, { optionId }] }
    })).rejects.toMatchObject({ code: "managed_permission_invalid" });
  });

  it("persists cancellation before queue access and recovers it after restart", async () => {
    const env = await createFixture({ interruptInspect: true });
    const { endpoint, device } = await createAndEnroll(env);
    const submitted = await env.service.submitTask(actor, requestFor(endpoint.endpointId));
    env.inspection.failNext = true;
    await expect(env.service.cancelTask(actor, String(submitted.task.taskId)))
      .rejects.toThrow("Synthetic cancellation inspection interruption.");
    expect(env.store.getTask(String(submitted.task.taskId))).toMatchObject({ cancelRequested: true, admissionState: "cancelling" });
    await reopenFixture(env);
    expect((await env.service.getTask(actor, String(submitted.task.taskId))).task.state).toBe("cancelled");
    expect((await env.service.workerPoll(device, { batchSize: 1 })).assignments).toEqual([]);
  });

  it("accepts termination evidence for a cancelled lease that was never authorized to start", async () => {
    const env = await createFixture();
    const { device, assignment } = await submitAndClaim(env);
    await env.service.cancelTask(actor, assignment.taskId);
    expect(await env.service.workerStart(device, leaseFields(assignment))).toMatchObject({ authorized: false, cancelRequested: true });
    const completed = await env.service.workerComplete(device, { ...leaseFields(assignment), state: "cancelled", result: null });
    expect(completed.task.state).toBe("cancelled");
  });

  it("does not strand a requestId when authority capture fails before admission", async () => {
    const env = await createFixture({ authorityFault: true });
    const { endpoint } = await createAndEnroll(env);
    const request = requestFor(endpoint.endpointId);
    await expect(env.service.submitTask(actor, request)).rejects.toThrow("Synthetic authority interruption.");
    expect(env.store.getTaskByRequestId(actor.tenantId, actor.organizationId, request.requestId)).toBeNull();
    const admitted = await env.service.submitTask(actor, request);
    expect(admitted.task.state).toBe("queued");
    expect(env.store.getTask(String(admitted.task.taskId))?.authority).toBeTruthy();
  });

  it("recovers the exact assignment after a restart between queue claim and managed binding", async () => {
    const env = await createFixture({ claimFault: true });
    const { endpoint, device } = await createAndEnroll(env);
    const submitted = await env.service.submitTask(actor, requestFor(endpoint.endpointId));
    await expect(env.service.workerPoll(device, { batchSize: 1 })).rejects.toThrow("Synthetic claim interruption.");
    const observed = await env.service.getTask(actor, String(submitted.task.taskId));
    expect(env.store.getTask(String(submitted.task.taskId))?.resultLeaseId).toBe("");
    await reopenFixture(env);
    const recovered = await env.service.workerPoll(env.service.verifyWorker(credential), { batchSize: 1 });
    expect(recovered.assignments).toHaveLength(1);
    expect(leaseFields(recovered.assignments[0])).toEqual({
      taskId: submitted.task.taskId, leaseId: observed.workItem?.lease?.leaseId,
      leaseSeq: observed.workItem?.lease?.leaseSeq
    });
  });

  it.each(["cancel", "complete"])("does not let unacknowledged permission resolutions block polling after %s", async (action) => {
    const env = await createFixture();
    const { assignment, device } = await submitAndClaim(env);
    await env.service.workerStart(device, leaseFields(assignment));
    const permissionId = "mperm_terminal_resolution";
    await env.service.workerPermission(device, { ...leaseFields(assignment), permissionId, prompt });
    await env.service.resolvePermission(actor, assignment.taskId, { permissionId, selectedOptionId: "allow" });
    if (action === "cancel") await env.service.cancelTask(actor, assignment.taskId);
    else await env.service.workerComplete(device, { ...leaseFields(assignment), state: "succeeded", result: null });
    const polled = await env.service.workerPoll(device, { batchSize: 0, acknowledgedPermissionIds: [permissionId] });
    expect(polled.permissionResolutions).toEqual([]);
    expect(env.store.getPermission(permissionId)).toMatchObject({ state: "obsolete", selectedOptionId: "allow" });
    await expect(env.service.resolvePermission(actor, assignment.taskId, { permissionId, selectedOptionId: "allow" }))
      .rejects.toMatchObject({ code: "managed_task_not_running" });
    if (action === "cancel") expect(polled.controls).toEqual([{ type: "cancel", ...leaseFields(assignment) }]);
  });

  it.each(["work", "abort"])("wakes an outstanding poll for %s and cleans its wait subscription", async (event) => {
    let observedEmpty!: () => void;
    const empty = new Promise<void>((resolve) => { observedEmpty = resolve; });
    const env = await createFixture({ onEmptyClaim: observedEmpty });
    const { endpoint, device } = await createAndEnroll(env);
    const abort = new AbortController();
    const polling = env.service.workerPoll(device, { batchSize: 1, waitMs: 60000 }, { signal: abort.signal });
    await empty;
    if (event === "work") await env.service.submitTask(actor, requestFor(endpoint.endpointId));
    else abort.abort();
    expect((await polling).assignments).toHaveLength(event === "work" ? 1 : 0);
  });

  it("deduplicates reordered nested JSON without retaining input in queue storage", async () => {
    const env = await createFixture();
    const { endpoint, device } = await createAndEnroll(env);
    await env.service.workerCatalog(device, {
      capabilities: [{ ...catalog[0], revision: 2, inputSchema: { type: "object", properties: { data: { type: "object" } } } }]
    });
    const request = { ...requestFor(endpoint.endpointId), input: { data: { alpha: 1, beta: 2 } } };
    const first = await env.service.submitTask(actor, request);
    const replay = await env.service.submitTask(actor, { ...request, input: { data: { beta: 2, alpha: 1 } } });
    expect(replay.task.taskId).toBe(first.task.taskId);
    expect((await env.service.getTask(actor, String(first.task.taskId))).workItem?.payloadRef).toEqual({ taskId: first.task.taskId });
  });

  it("does not allow a rejected enrollment replay to poison the current schema cache", async () => {
    const env = await createFixture();
    const { endpoint, enrollmentToken } = await createAndEnroll(env);
    await expect(env.service.enroll({
      enrollmentToken, deviceCredential: `mdc_${randomBytes(12).toString("hex")}`,
      capabilities: [{ ...catalog[0], inputSchema: { type: "object" } }]
    })).rejects.toMatchObject({ code: "managed_enrollment_rebind_rejected" });
    await expect(env.service.submitTask(actor, { ...requestFor(endpoint.endpointId), input: { unexpected: true } }))
      .rejects.toMatchObject({ code: "managed_task_input_invalid" });
  });

  it.each(["before", "after"])("recovers durable admission after a restart %s queue enqueue without duplicate work", async (admissionFault) => {
    const env = await createFixture({ admissionFault });
    const { endpoint } = await createAndEnroll(env);
    const request = requestFor(endpoint.endpointId);
    await expect(env.service.submitTask(actor, request)).rejects.toThrow("Synthetic admission interruption.");
    const intent = env.store.getTaskByRequestId(actor.tenantId, actor.organizationId, request.requestId)!;
    expect(intent).toMatchObject({ admissionState: "pending", workItemId: intent.taskId });
    await reopenFixture(env);
    const replay = await env.service.submitTask(actor, request);
    expect(replay.task.taskId).toBe(intent.taskId);
    const poll = await env.service.workerPoll(env.service.verifyWorker(credential), { batchSize: 8 });
    expect(poll.assignments.map((assignment) => assignment.taskId)).toEqual([intent.taskId]);
    const task = await env.service.getTask(actor, String(intent.taskId));
    expect(task.workItem.payloadRef).toEqual({ taskId: intent.taskId });
  });

  it("repairs a durable result settlement after restart without another execution", async () => {
    const env = await createFixture({ failFirstSettlement: true });
    const { assignment, device } = await submitAndClaim(env);
    await env.service.workerStart(device, leaseFields(assignment));
    const outcome = { ...leaseFields(assignment), state: "succeeded", result: { retained: true } };
    await expect(env.service.workerComplete(device, outcome)).rejects.toMatchObject({ code: "synthetic_settlement_interruption" });
    await reopenFixture(env);
    const observed = await env.service.getTask(actor, assignment.taskId);
    expect(observed.workItem.state).toBe("completed");
    expect(observed.task.result).toEqual(outcome.result);
    expect((await env.service.workerPoll(env.service.verifyWorker(credential), { batchSize: 8 })).assignments).toEqual([]);
  });

  it("coalesces semantic JSON key order and rejects stale input schemas at start", async () => {
    const env = await createFixture();
    const { endpoint, device } = await createAndEnroll(env);
    const request = requestFor(endpoint.endpointId);
    const first = await env.service.submitTask(actor, request);
    const replay = await env.service.submitTask(actor, {
      input: request.input, capabilityId: request.capabilityId, endpointId: request.endpointId, requestId: request.requestId
    });
    expect(replay.task.taskId).toBe(first.task.taskId);
    const assignment = (await env.service.workerPoll(device, { batchSize: 1 })).assignments[0];
    await env.service.workerCatalog(device, {
      capabilities: [{ ...catalog[0], revision: 2, inputSchema: { type: "number" } }]
    });
    await expect(env.service.workerStart(device, leaseFields(assignment))).rejects.toThrow();
    expect(env.store.getTask(assignment.taskId)?.startAuthorized).toBe(false);
  });

  it("delivers control-only cancellation beyond one thousand unrelated durable intents", async () => {
    const env = await createFixture();
    const { assignment, device } = await submitAndClaim(env);
    await env.service.workerStart(device, leaseFields(assignment));
    const original = env.store.getTask(assignment.taskId)!;
    env.store.transaction(() => {
      for (let index = 0; index < 1001; index += 1) {
        const task = env.store.createTask({
          ...original, taskId: `mtask_history_${index}`, workItemId: `mtask_history_${index}`,
          requestId: `request_history_${index}`
        }, Date.now() + index);
        env.store.updateTask(task, { admissionState: "cancelled" }, Date.now() + index);
      }
    });
    await env.service.cancelTask(actor, assignment.taskId);
    const poll = await env.service.workerPoll(device, { batchSize: 0 });
    expect(poll.assignments).toEqual([]);
    expect(poll.controls).toEqual([{ type: "cancel", ...leaseFields(assignment) }]);
  });

  it("completes create/enroll/publish/submit/poll/start/event/complete on the default asynchronous SQLite lane", async () => {
    const env = await createFixture();
    const { assignment, device } = await submitAndClaim(env);
    const lease = leaseFields(assignment);
    const started = await env.service.workerStart(device, lease);
    expect(started.cancelRequested).toBe(false);
    expect(assertManagedTaskStartResponse(started)).toEqual({
      ...lease, authorized: true, cancelRequested: false
    });

    const emitted = await observe(() => env.service.workerEvent(device, {
      ...lease,
      events: [{ seq: 1, kind: "agent.progress", at: new Date().toISOString(), payload: { step: "synthetic execution" } }]
    }));
    expect.soft(emitted).toMatchObject({ status: "fulfilled" });

    const result = { echoed: "synthetic input", exitCode: 0 };
    const completion = await observe(() => env.service.workerComplete(device, {
      ...lease, state: "succeeded", result
    }));
    expect.soft(completion).toMatchObject({ status: "fulfilled" });
    const observed = await env.service.getTask(actor, assignment.taskId);
    expect.soft(observed.workItem?.state).toBe("completed");
    expect.soft(observed.task?.result).toEqual(result);
    const timeline = await env.service.taskEvents(actor, assignment.taskId, {});
    expect.soft(timeline.events).toMatchObject([
      { seq: 1, kind: "agent.progress", payload: { step: "synthetic execution" } }
    ]);
    expect.soft(timeline.lastSeq).toBe(1);
  });

  it("publishes workspaces atomically, carries workspaceId, and replays the durable event timeline", async () => {
    const env = await createFixture();
    const { endpoint, device } = await createAndEnroll(env);
    const workspaces = [{ workspaceId: "repo.main", label: "Main checkout", hint: { vcs: "git" } }];
    const published = await env.service.workerCatalog(device, { capabilities: catalog, workspaces });
    expect(published.endpoint.publishedWorkspaces).toEqual(workspaces);
    expect(env.store.getEndpoint(endpoint.endpointId).publishedWorkspaces).toEqual(workspaces);

    const request = { ...requestFor(endpoint.endpointId), requestId: "req-core-integration-ws-0001", workspaceId: "repo.main" };
    await env.service.submitTask(actor, request);
    const poll = await env.service.workerPoll(device, { batchSize: 1 });
    const assignment = assertManagedTaskAssignment(poll.assignments[0]);
    expect(assignment.workspaceId).toBe("repo.main");
    await env.service.workerStart(device, leaseFields(assignment));

    const iso = (ms: number) => new Date(ms).toISOString();
    const appended = await env.service.workerEvent(device, {
      ...leaseFields(assignment),
      events: [
        { seq: 1, kind: "agent.started", at: iso(1_000), payload: {} },
        { seq: 2, kind: "agent.progress", at: iso(2_000), payload: { pct: 50 } }
      ]
    });
    expect(appended).toMatchObject({ accepted: 2, lastSeq: 2 });
    await expect(env.service.workerEvent(device, {
      ...leaseFields(assignment),
      events: [{ seq: 2, kind: "agent.progress", at: iso(3_000), payload: {} }]
    })).rejects.toMatchObject({ code: "managed_event_seq_conflict" });
    await expect(env.service.workerEvent(device, {
      ...leaseFields(assignment),
      events: [{ seq: 3, kind: "task.completed", at: iso(3_000), payload: {} }]
    })).rejects.toMatchObject({ code: "managed_event_batch_invalid" });
    const gapped = await env.service.workerEvent(device, {
      ...leaseFields(assignment),
      events: [{ seq: 10, kind: "agent.progress", at: iso(4_000), payload: { pct: 80 } }]
    });
    expect(gapped.lastSeq).toBe(10);

    const replay = await env.service.taskEvents(actor, assignment.taskId, {});
    expect(replay.lastSeq).toBe(10);
    expect(replay.events.map((event: any) => event.seq)).toEqual([1, 2, 10]);
    const continued = await env.service.taskEvents(actor, assignment.taskId, { after: 1 });
    expect(continued.events.map((event: any) => event.seq)).toEqual([2, 10]);

    await expect(env.service.submitTask(actor, {
      ...request, requestId: "req-core-integration-ws-0002", workspaceId: "repo.missing"
    })).rejects.toMatchObject({ code: "managed_workspace_unavailable" });
  });

  it("returns enrollment matching assertManagedEndpoint and the closed public endpoint fields", async () => {
    const env = await createFixture();
    const { enrollment, endpoint } = await createAndEnroll(env);
    expect.soft(enrollment.protocol).toBe(MANAGED_ENDPOINT_PROTOCOL);
    expect.soft(Object.keys(enrollment).sort()).toEqual(["device", "endpoint", "protocol"]);
    expect.soft(() => assertManagedEndpoint(enrollment.endpoint)).not.toThrow();
    expect.soft(Object.keys(enrollment.endpoint!).sort()).toEqual(endpointFields);
    expect.soft(enrollment.device).toEqual({
      endpointId: endpoint.endpointId,
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      generation: endpoint.generation
    });
  });

  it("returns the closed public permission DTO instead of the internal persistence row", async () => {
    const env = await createFixture();
    const { assignment, device } = await submitAndClaim(env);
    await env.service.workerStart(device, leaseFields(assignment));
    const { controller, authSession } = await workerController(env);
    const response = await controllerResponse(controller.handleWorkerPermission, {
      authSession,
      requestBody: Buffer.from(JSON.stringify({
        ...leaseFields(assignment), permissionId: "mperm_core_public_dto", prompt
      }))
    });
    expect(response.status).toBe(200);
    expect.soft(Object.keys(response.body).sort()).toEqual(["idempotent", "permission"]);
    expect.soft(Object.keys(response.body.permission).sort()).toEqual(permissionFields);
    expect.soft(response.body.permission).toMatchObject({
      permissionId: expect.any(String), taskId: assignment.taskId, state: "pending", prompt
    });
  });

  it.each(["cold", "registered"] as const)(
    "coalesces concurrent identical submissions with a %s endpoint queue",
    async (registration) => {
      const env = await createFixture();
      const { endpoint, device } = await createAndEnroll(env);
      if (registration === "registered") {
        await env.service.workerPoll(device, { waitMs: 0, batchSize: 1 });
      }
      const request = requestFor(endpoint.endpointId);
      const results = await Promise.allSettled([
        env.service.submitTask(actor, request),
        env.service.submitTask(actor, structuredClone(request))
      ]);
      for (const result of results) {
        expect.soft(result).toMatchObject({ status: "fulfilled" });
      }
      if (results[0].status === "fulfilled" && results[1].status === "fulfilled") {
        expect.soft(results[1].value.task.taskId).toBe(results[0].value.task.taskId);
        expect.soft(results[1].value.task.workItemId).toBe(results[0].value.task.workItemId);
      }
      const tasks = env.store.listTasks(actor.tenantId, actor.organizationId);
      expect.soft(tasks).toHaveLength(1);
      const poll = await env.service.workerPoll(device, { waitMs: 0, batchSize: 8 });
      expect.soft(poll.assignments).toHaveLength(1);
      expect.soft(poll.assignments[0]?.taskId).toBe(tasks[0]?.taskId);
      const repeatedPoll = await env.service.workerPoll(device, { waitMs: 0, batchSize: 8 });
      expect.soft(repeatedPoll.assignments).toEqual(poll.assignments);
      await env.service.workerStart(device, leaseFields(poll.assignments[0]));
      expect.soft((await env.service.workerPoll(device, { waitMs: 0, batchSize: 8 })).assignments).toHaveLength(0);
    }
  );

  it("rejects a changed payload under the same requestId without returning the previous task", async () => {
    const env = await createFixture();
    const { request, assignment } = await submitAndClaim(env);
    const before = env.store.getTask(assignment.taskId);
    const conflict = await observe(() => env.service.submitTask(actor, {
      ...request, input: { message: "changed synthetic input" }
    }));
    expect.soft(conflict).toMatchObject({
      status: "rejected", reason: { code: "managed_request_conflict", statusCode: 409 }
    });
    expect.soft(env.store.getTask(assignment.taskId)).toEqual(before);
    expect.soft(env.store.listTasks(actor.tenantId, actor.organizationId)).toHaveLength(1);
  });

  it("rejects a different requester under the same requestId before exposing the previous result", async () => {
    const env = await createFixture();
    const { request, assignment, device } = await submitAndClaim(env);
    await env.service.workerStart(device, leaseFields(assignment));
    await env.service.workerComplete(device, {
      ...leaseFields(assignment), state: "succeeded", result: { ownerOnly: "synthetic result" }
    });
    const before = env.store.getTask(assignment.taskId);
    expect(before?.result).toEqual({ ownerOnly: "synthetic result" });
    const replay = await observe(() => env.service.submitTask({
      ...actor, subjectId: "other-synthetic-member"
    }, request));
    expect.soft(replay).toMatchObject({ status: "rejected" });
    if (replay.status === "rejected") {
      expect.soft([403, 404, 409]).toContain(replay.reason?.statusCode);
    }
    expect.soft(env.store.getTask(assignment.taskId)).toEqual(before);
    expect.soft(env.store.listTasks(actor.tenantId, actor.organizationId)).toHaveLength(1);
  });

  it("retries queue settlement after a durable result write instead of only returning an auxiliary terminal task", async () => {
    const env = await createFixture({ failFirstSettlement: true });
    const { assignment, device } = await submitAndClaim(env);
    await env.service.workerStart(device, leaseFields(assignment));
    const outcome = {
      ...leaseFields(assignment), state: "succeeded", result: { synthetic: "retained result" }
    };
    const first = await observe(() => env.service.workerComplete(device, outcome));
    expect.soft(first).toMatchObject({
      status: "rejected", reason: { code: "synthetic_settlement_interruption" }
    });
    expect.soft(env.settlement.persistedAtAttempt[0]).toMatchObject({
      result: outcome.result, resultLeaseId: outcome.leaseId, resultLeaseSeq: outcome.leaseSeq
    });
    const pending = await env.service.getTask(actor, assignment.taskId);
    expect.soft(pending.workItem?.state).toBe("running");

    const retry = await observe(() => env.service.workerComplete(device, outcome));
    expect.soft(retry).toMatchObject({ status: "fulfilled" });
    expect.soft(env.settlement.attempts).toBe(2);
    const observed = await env.service.getTask(actor, assignment.taskId);
    expect.soft(observed.workItem?.state).toBe("completed");
    expect.soft(observed.task?.result).toEqual(outcome.result);
    expect.soft(env.store.listTasks(actor.tenantId, actor.organizationId)).toHaveLength(1);
    const poll = await env.service.workerPoll(device, { waitMs: 0, batchSize: 1 });
    expect.soft(poll.assignments).toHaveLength(0);
  });

  it("rejects a wrong completion lease sequence before changing durable result or task state", async () => {
    const env = await createFixture();
    const { assignment, device } = await submitAndClaim(env);
    await env.service.workerStart(device, leaseFields(assignment));
    const before = env.store.getTask(assignment.taskId);
    const completion = await observe(() => env.service.workerComplete(device, {
      ...leaseFields(assignment),
      leaseSeq: assignment.leaseSeq + 1,
      state: "succeeded",
      result: { synthetic: "must not persist" }
    }));
    expect.soft(completion).toMatchObject({
      status: "rejected", reason: { code: "managed_lease_conflict" }
    });
    expect.soft(env.store.getTask(assignment.taskId)).toEqual(before);
    const observed = await env.service.getTask(actor, assignment.taskId);
    expect.soft(observed.workItem?.state).toBe("running");
    expect.soft(observed.workItem?.lease?.leaseSeq).toBe(assignment.leaseSeq);
  });

  it.each([
    { label: "label", patch: { label: "Renamed synthetic workstation" } },
    { label: "capability policy", patch: { allowedCapabilityIds: [] } }
  ])("keeps the machine credential valid after a $label update", async ({ patch }) => {
    const env = await createFixture();
    const { endpoint } = await createAndEnroll(env);
    const binding = env.store.resolveCredential(credential);
    await env.service.updateEndpoint(actor, String(endpoint.endpointId), patch);
    const verified = await observe(() => env.service.verifyWorker(credential));
    expect.soft(verified).toMatchObject({
      status: "fulfilled",
      value: { endpointId: endpoint.endpointId, organizationId: actor.organizationId }
    });
    expect.soft(env.store.resolveCredential(credential)).toMatchObject({
      endpointId: binding?.endpointId,
      tenantId: binding?.tenantId,
      organizationId: binding?.organizationId
    });
  });

  it("never reactivates a revoked endpoint by replaying its consumed enrollment", async () => {
    const env = await createFixture();
    const { endpoint, enrollmentToken } = await createAndEnroll(env);
    await env.service.revokeEndpoint(actor, String(endpoint.endpointId));
    const replay = await observe(() => env.service.enroll({
      enrollmentToken, deviceCredential: credential, capabilities: catalog
    }));
    expect.soft(replay).toMatchObject({ status: "rejected" });
    expect.soft(env.store.getEndpoint(String(endpoint.endpointId))?.state).toBe("revoked");
    expect.soft(env.store.resolveCredential(credential)).toBeNull();
  });

  it("rejects invalid enrollment capabilities without consuming the token or partially binding a credential", async () => {
    const env = await createFixture();
    const created = await env.service.createEndpoint(actor, {
      label: "Synthetic invalid enrollment",
      kind: "workstation",
      allowedCapabilityIds: [catalog[0].capabilityId]
    });
    const before = env.store.getEnrollment(created.enrollmentToken);
    const invalid = await observe(() => env.service.enroll({
      enrollmentToken: created.enrollmentToken,
      deviceCredential: credential,
      capabilities: [{ ...catalog[0], kind: "unapproved-kind" }]
    }));
    expect.soft(invalid).toMatchObject({
      status: "rejected", reason: { code: "managed_capability_invalid" }
    });
    expect.soft(env.store.getEnrollment(created.enrollmentToken)).toEqual(before);
    expect.soft(env.store.resolveCredential(credential)).toBeNull();
    expect.soft(env.store.getEndpoint(String(created.endpoint.endpointId))).toMatchObject({
      state: "pending", publishedCapabilities: []
    });
    const valid = await observe(() => env.service.enroll({
      enrollmentToken: created.enrollmentToken,
      deviceCredential: `mdc_${randomBytes(12).toString("hex")}`,
      capabilities: catalog
    }));
    expect.soft(valid).toMatchObject({ status: "fulfilled", value: { endpoint: { state: "active" } } });
  });

  it.each(["leaseId", "leaseSeq"] as const)(
    "rejects a permission request with the wrong %s without creating a prompt",
    async (field) => {
      const env = await createFixture();
      const { assignment, device } = await submitAndClaim(env);
      await env.service.workerStart(device, leaseFields(assignment));
      const lease = {
        ...leaseFields(assignment),
        [field]: field === "leaseId" ? "lease_synthetic_wrong" : assignment.leaseSeq + 1
      };
      const requested = await observe(() => env.service.workerPermission(device, {
        ...lease, permissionId: "mperm_core_wrong_lease", prompt
      }));
      expect.soft(requested).toMatchObject({
        status: "rejected", reason: { code: "managed_lease_conflict" }
      });
      expect.soft(env.store.listOrgPendingPermissions(actor.tenantId, actor.organizationId)).toHaveLength(0);
    }
  );

  it("redelivers permission approval on every poll until an explicit device acknowledgement", async () => {
    const env = await createFixture();
    const { assignment, device } = await submitAndClaim(env);
    await env.service.workerStart(device, leaseFields(assignment));
    const requested = await env.service.workerPermission(device, {
      ...leaseFields(assignment), permissionId: "mperm_core_redelivery", prompt
    });
    const permissionId = String(requested.permission.permissionId);
    await env.service.resolvePermission(actor, assignment.taskId, {
      permissionId, selectedOptionId: "allow"
    });
    const { controller, authSession } = await workerController(env);
    const poll = (acknowledgedPermissionIds: string[] = []) => controllerResponse(
      controller.handleWorkerPoll,
      {
        authSession,
        requestBody: Buffer.from(JSON.stringify({ waitMs: 0, batchSize: 1, acknowledgedPermissionIds }))
      }
    );
    const first = await poll();
    const second = await poll();
    const resolution = {
      permissionId, ...leaseFields(assignment), resolution: { selectedOptionId: "allow" }
    };
    expect.soft(first.status).toBe(200);
    expect.soft(first.body.permissionResolutions).toEqual([resolution]);
    expect.soft(second.status).toBe(200);
    expect.soft(second.body.permissionResolutions).toEqual([resolution]);
    const acknowledged = await poll([permissionId]);
    expect.soft(acknowledged.body.permissionResolutions).toEqual([]);
    const afterAcknowledgement = await poll();
    expect.soft(afterAcknowledgement.body.permissionResolutions).toEqual([]);
  });

  it("rejects a conflicting explicit permission resolution instead of calling it idempotent", async () => {
    const env = await createFixture();
    const { assignment, device } = await submitAndClaim(env);
    await env.service.workerStart(device, leaseFields(assignment));
    const requested = await env.service.workerPermission(device, {
      ...leaseFields(assignment), permissionId: "mperm_core_resolution", prompt
    });
    const permissionId = String(requested.permission.permissionId);
    await env.service.resolvePermission(actor, assignment.taskId, {
      permissionId, selectedOptionId: "allow"
    });
    const before = env.store.getPermission(permissionId);
    const conflict = await observe(() => env.service.resolvePermission(actor, assignment.taskId, {
      permissionId, selectedOptionId: "deny"
    }));
    expect.soft(conflict).toMatchObject({
      status: "rejected", reason: { code: "managed_permission_conflict", statusCode: 409 }
    });
    expect.soft(env.store.getPermission(permissionId)).toEqual(before);
  });

  it.each(["endpoint revocation", "capability removal"] as const)(
    "denies start after claim followed by %s",
    async (change) => {
      const env = await createFixture();
      const { assignment, device, endpoint } = await submitAndClaim(env);
      if (change === "endpoint revocation") {
        await env.service.revokeEndpoint(actor, String(endpoint.endpointId));
      } else {
        await env.service.updateEndpoint(actor, String(endpoint.endpointId), { allowedCapabilityIds: [] });
      }
      const started = await observe(() => env.service.workerStart(device, leaseFields(assignment)));
      if (started.status === "fulfilled") {
        const response = started.value as Record<string, unknown>;
        expect.soft(response.authorized === false || response.cancelRequested === true).toBe(true);
        expect.soft(response.authorized).not.toBe(true);
      } else {
        expect.soft([403, 404, 409]).toContain(started.reason?.statusCode);
      }
      expect.soft(env.store.getTask(assignment.taskId)?.startAuthorized).toBe(false);
      expect.soft(env.store.getTask(assignment.taskId)?.result).toBeNull();
    }
  );

  it("returns cancellation denial before start and never authorizes execution", async () => {
    const env = await createFixture();
    const { assignment, device } = await submitAndClaim(env);
    await env.service.cancelTask(actor, assignment.taskId);
    const started = await observe(() => env.service.workerStart(device, leaseFields(assignment)));
    if (started.status === "fulfilled") {
      expect.soft(started.value.cancelRequested).toBe(true);
      expect.soft((started.value as Record<string, unknown>).authorized).not.toBe(true);
    } else {
      expect.soft([403, 404, 409]).toContain(started.reason?.statusCode);
    }
    expect.soft(env.store.getTask(assignment.taskId)).toMatchObject({ cancelRequested: true, result: null });
    expect.soft(env.store.getTask(assignment.taskId)?.startAuthorized).toBe(false);
  });

  it.each([
    { label: "storage", method: "listEndpoints", internalCode: "SQLITE_SYNTHETIC_CORRUPT" },
    { label: "internal", method: "listTasks", internalCode: undefined }
  ] as const)("returns stable public errors without $label diagnostics or path markers", async ({ method, internalCode }) => {
    const env = await createFixture();
    const controller = createManagedEndpointsController({
      managedEndpointService: env.service,
      actorFromSession: managedActorFromSession
    });
    const spy = vi.spyOn(env.store, method);
    const responses = [];
    for (const suffix of ["FIRST", "SECOND"]) {
      spy.mockImplementation(() => {
        throw Object.assign(new Error(
          `SYNTHETIC_${suffix}_DIAGNOSTIC at /synthetic-managed-state/${suffix}.db`
        ), { code: internalCode });
      });
      const response = await controllerResponse(controller.handleListEndpoints, { authSession: session });
      responses.push(response);
      expect.soft(response.status).toBe(500);
      expect.soft(response.body.error).toEqual(expect.any(String));
      expect.soft(response.body.code).toMatch(/^managed_[a-z0-9_]+$/u);
      expect.soft(JSON.stringify(response.body)).not.toContain(`SYNTHETIC_${suffix}_DIAGNOSTIC`);
      expect.soft(JSON.stringify(response.body)).not.toContain("/synthetic-managed-state/");
      expect.soft(JSON.stringify(response.body)).not.toContain("SQLITE_SYNTHETIC_CORRUPT");
    }
    expect.soft(responses[1].body.error).toBe(responses[0].body.error);
    expect.soft(responses[1].body.code).toBe(responses[0].body.code);
  });

  describe("unstarted outcome settlement", () => {
    it("records a fenced failure without authorizing execution and recovers idempotent acknowledgement", async () => {
      const env = await createFixture();
      const { assignment, device } = await submitAndClaim(env);
      const outcome = { ...leaseFields(assignment), state: "failed", result: null, errorCode: "managed_start_denied" };
      await expect(env.service.workerComplete(device, { ...outcome, leaseSeq: assignment.leaseSeq + 1 }))
        .rejects.toMatchObject({ code: "managed_lease_conflict" });
      expect(env.store.getTask(assignment.taskId)).toMatchObject({ startAuthorized: false, outcomeState: "" });
      const completed = await env.service.workerComplete(device, outcome);
      expect(completed).toMatchObject({ idempotent: false, task: { state: "failed", errorCode: "managed_start_denied", result: null } });
      expect(env.store.getTask(assignment.taskId)).toMatchObject({ startAuthorized: false, outcomeState: "failed", settlementPending: false });
      expect((await env.service.getTask(actor, assignment.taskId)).workItem?.state).toBe("failed");
      await reopenFixture(env);
      const replay = await env.service.workerComplete(env.service.verifyWorker(credential), outcome);
      expect(replay).toMatchObject({ idempotent: true, task: { state: "failed", errorCode: "managed_start_denied" } });
      expect(env.store.getTask(assignment.taskId)?.startAuthorized).toBe(false);
      expect((await env.service.workerPoll(env.service.verifyWorker(credential), { batchSize: 1 })).assignments).toEqual([]);
    });

    it.each(["succeeded", "unknown", "cancelled"])("rejects unstarted %s without granting authority", async (state) => {
      const env = await createFixture();
      const { assignment, device } = await submitAndClaim(env);
      await expect(env.service.workerComplete(device, { ...leaseFields(assignment), state, result: null }))
        .rejects.toMatchObject({ code: "managed_task_not_running" });
      expect(env.store.getTask(assignment.taskId)).toMatchObject({ startAuthorized: false, outcomeState: "", result: null });
      expect(await env.service.workerStart(device, leaseFields(assignment))).toMatchObject({ authorized: true, cancelRequested: false });
    });
  });
});
