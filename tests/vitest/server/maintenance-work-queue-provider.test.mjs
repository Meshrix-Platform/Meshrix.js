import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAINTENANCE_WORK_QUEUE_DEFINITION_ID,
  createMaintenanceWorkQueueProvider
} from "../../../packages/server-runtime/src/composition/maintenance-work-queue-provider.mjs";
import { createQueueApplicationPort } from "../../../packages/server-runtime/src/composition/queue-application-port.mjs";

const roots = [];
const applicationPorts = new Set();

async function createRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maintenance-work-queue-"));
  roots.push(root);
  return root;
}

async function createProvider(input) {
  const queueApplicationPort = await createQueueApplicationPort({
    userDataPath: input.userDataPath
  });
  applicationPorts.add(queueApplicationPort);
  const provider = await createMaintenanceWorkQueueProvider({
    capabilitySelected: true,
    ...input,
    queueApplicationPort
  });
  if (input.autoStart !== false) queueApplicationPort.start();
  return provider;
}

function maintenanceRun(runId, overrides = {}) {
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    runId,
    status: "queued",
    planHash: "a".repeat(64),
    risk: "safe_write",
    requiresApproval: false,
    approvedAt: "",
    approvedBy: null,
    ...overrides
  };
}

function maintenanceAgent(dispatchQueuedRun, getRun = async (runId) => maintenanceRun(runId)) {
  return { dispatchQueuedRun, getRun: vi.fn(getRun) };
}

async function closeProvider(provider) {
  await provider?.close();
  for (const applicationPort of applicationPorts) {
    await applicationPort.close();
    applicationPorts.delete(applicationPort);
  }
}

async function waitForState(provider, runId, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observed = await provider.observe(runId);
    if (observed?.state === expected) return observed;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${runId} to reach ${expected}.`);
}

async function waitForAnyState(provider, runId, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observed = await provider.observe(runId);
    if (expected.includes(observed?.state)) return observed;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${runId} to settle.`);
}

afterEach(async () => {
  await Promise.all([...applicationPorts].map((applicationPort) => applicationPort.close()));
  applicationPorts.clear();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {
    recursive: true,
    force: true
  })));
});

describe("maintenance canonical work queue", () => {
  it("registers a producer-only facet when an external worker owns consumption", async () => {
    const queueFacet = {
      definition: { queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID },
      requestDispatch: vi.fn(),
      describe: vi.fn(() => ({ queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID }))
    };
    const queueApplicationPort = {
      registerQueue: vi.fn(async () => queueFacet)
    };
    const provider = await createMaintenanceWorkQueueProvider({
      queueApplicationPort,
      getMaintenanceAgent: () => null,
      capabilitySelected: true,
      autoStart: false,
      consumerEnabled: false
    });

    expect(queueApplicationPort.registerQueue).toHaveBeenCalledWith(expect.objectContaining({
      queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID,
      consumerEnabled: false
    }));
    expect(provider.start()).toEqual({ started: false, reason: "consumer_not_owned" });
    expect(queueFacet.requestDispatch).not.toHaveBeenCalled();
  });

  it("recovers durable pending work through the stable queue definition", async () => {
    const userDataPath = await createRoot();
    const first = await createProvider({
      userDataPath,
      getMaintenanceAgent: () => null,
      autoStart: false,
      dispatchOnSubmit: false
    });
    const submitted = await first.submit(maintenanceRun("maintenance-recovery"));
    expect(submitted.accepted).toBe(true);
    expect(await first.submit(maintenanceRun("maintenance-recovery"))).toMatchObject({
      deduped: true,
      workItemId: submitted.workItemId
    });
    expect(first.describe().queueDefinitionId).toBe(MAINTENANCE_WORK_QUEUE_DEFINITION_ID);
    expect((await first.observe("maintenance-recovery"))?.state).toBe("queued");
    await closeProvider(first);

    const dispatchQueuedRun = vi.fn(async (runId) => ({ runId, status: "completed" }));
    const second = await createProvider({
      userDataPath,
      getMaintenanceAgent: () => maintenanceAgent(dispatchQueuedRun),
      autoStart: true,
      dispatchOnSubmit: false
    });
    await waitForState(second, "maintenance-recovery", "completed");
    expect(dispatchQueuedRun).toHaveBeenCalledWith(
      "maintenance-recovery",
      expect.objectContaining({ workItemId: expect.any(String) })
    );
    await closeProvider(second);
  });

  it("isolates a failed run and still dispatches independent work", async () => {
    const userDataPath = await createRoot();
    const dispatchQueuedRun = vi.fn(async (runId) => {
      if (runId === "maintenance-failure") throw new Error("bounded fixture failure");
      return { runId, status: "completed" };
    });
    const provider = await createProvider({
      userDataPath,
      getMaintenanceAgent: () => maintenanceAgent(dispatchQueuedRun),
      autoStart: true,
      dispatchOnSubmit: false
    });
    await provider.submit(maintenanceRun("maintenance-failure"));
    const failed = await waitForAnyState(
      provider,
      "maintenance-failure",
      ["retry_wait", "queued"]
    );
    expect(["retry_wait", "queued"]).toContain(failed?.state);

    await provider.submit(maintenanceRun("maintenance-independent"));
    await waitForState(provider, "maintenance-independent", "completed");
    expect(dispatchQueuedRun).toHaveBeenCalledWith(
      "maintenance-independent",
      expect.any(Object)
    );
    await closeProvider(provider);
  });

  it("propagates cancellation through the port and settles without executing tools", async () => {
    const userDataPath = await createRoot();
    const executeTools = vi.fn();
    const dispatchQueuedRun = vi.fn(async (runId) => {
      if (runId !== "maintenance-cancelled") executeTools();
      return { runId, status: "cancelled" };
    });
    const provider = await createProvider({
      userDataPath,
      getMaintenanceAgent: () => maintenanceAgent(dispatchQueuedRun),
      autoStart: false,
      dispatchOnSubmit: false
    });
    await provider.submit(maintenanceRun("maintenance-cancelled"));
    const cancelled = await provider.cancel({ runId: "maintenance-cancelled" });
    expect(cancelled).toMatchObject({
      cancelled: true,
      idempotent: false,
      state: "cancelled"
    });
    expect(await provider.cancel({ runId: "maintenance-cancelled" })).toMatchObject({
      cancelled: true,
      idempotent: true,
      state: "cancelled"
    });
    await waitForState(provider, "maintenance-cancelled", "cancelled");
    expect(dispatchQueuedRun).not.toHaveBeenCalled();
    expect(executeTools).not.toHaveBeenCalled();
    await closeProvider(provider);
  });

  it("fences a leased worker so its late acknowledgement cannot revive cancellation", async () => {
    const userDataPath = await createRoot();
    let releaseRun;
    const running = new Promise((resolve) => {
      releaseRun = resolve;
    });
    const dispatchQueuedRun = vi.fn(async (runId) => {
      await running;
      return { runId, status: "completed" };
    });
    const provider = await createProvider({
      userDataPath,
      getMaintenanceAgent: () => maintenanceAgent(dispatchQueuedRun),
      autoStart: true,
      dispatchOnSubmit: false
    });
    await provider.submit(maintenanceRun("maintenance-leased-cancel"));
    await waitForState(provider, "maintenance-leased-cancel", "running");

    const cancelled = await provider.cancel({ runId: "maintenance-leased-cancel" });
    expect(cancelled.state).toBe("cancelled");
    releaseRun();
    await waitForState(provider, "maintenance-leased-cancel", "cancelled");
    expect((await provider.observe("maintenance-leased-cancel"))?.state).toBe("cancelled");
    await closeProvider(provider);
  });

  it("uses only the injected queue facet and emits bounded privacy-safe values", async () => {
    const enqueue = vi.fn(async (input) => ({ accepted: true, workItem: { workItemId: input.workItemId } }));
    const observe = vi.fn(async () => ({
      workItem: {
        workItemId: "wqwi_safe",
        state: "queued",
        attempt: 0,
        maxAttempts: 3,
        availableAtMs: 1,
        expiresAtMs: 2,
        payloadRef: { protected: true },
        ownerRef: { protected: true },
        lastError: "protected"
      },
      journal: [{ protected: true }]
    }));
    const queueFacet = {
      definition: { queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID },
      enqueue,
      observe,
      cancel: vi.fn(),
      recoverFailed: vi.fn(),
      requestDispatch: vi.fn(),
      describe: vi.fn(() => ({ queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID }))
    };
    const queueApplicationPort = { registerQueue: vi.fn(async () => queueFacet) };
    const dispatchQueuedRun = vi.fn(async () => ({ status: "completed" }));
    const provider = await createMaintenanceWorkQueueProvider({
      queueApplicationPort,
      getMaintenanceAgent: () => maintenanceAgent(dispatchQueuedRun),
      capabilitySelected: true,
      autoStart: false,
      dispatchOnSubmit: false
    });

    await provider.submit(maintenanceRun("maintenance_run_opaque-1"));
    const admitted = enqueue.mock.calls[0][0];
    expect(admitted.payloadRef).toEqual({
      kind: "maintenance_agent_run",
      contextRef: "maintenance_run_opaque-1",
      governanceRevision: "maintenance-run-governance-1",
      governanceDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
    });
    expect(admitted.payloadRef).not.toHaveProperty("context");
    expect(admitted.dedupeKey).not.toContain("maintenance_run_opaque-1");
    expect(await provider.observe("maintenance_run_opaque-1")).toEqual({
      workItemId: "wqwi_safe",
      state: "queued",
      attempt: 0,
      maxAttempts: 3,
      availableAtMs: 1,
      expiresAtMs: 2
    });
    await expect(provider.submit(maintenanceRun("raw operator context is not an identifier")))
      .rejects.toThrow(/bounded opaque identifier/u);

    const signal = new AbortController().signal;
    const registration = queueApplicationPort.registerQueue.mock.calls[0][0];
    await registration.handler({
      workItem: {
        workItemId: admitted.workItemId,
        payloadRef: admitted.payloadRef
      }
    }, { signal });
    expect(dispatchQueuedRun).toHaveBeenCalledWith("maintenance_run_opaque-1", {
      workItemId: admitted.workItemId,
      signal
    });
    dispatchQueuedRun.mockResolvedValueOnce({ status: "cancelled" });
    await expect(registration.handler({
      workItem: {
        workItemId: admitted.workItemId,
        payloadRef: admitted.payloadRef
      }
    }, { signal })).resolves.toMatchObject({ action: "cancelled" });
  });

  it("rejects a queued run when its durable governance facts change", async () => {
    const admittedRun = maintenanceRun("maintenance_run_governed-1", {
      risk: "repair_write",
      approvedAt: "2026-01-01T00:00:00.000Z",
      approvedBy: { userId: "opaque-user", username: "operator", roleId: "admin" }
    });
    const enqueue = vi.fn(async (input) => ({
      accepted: true,
      workItem: { workItemId: input.workItemId }
    }));
    const queueFacet = {
      definition: { queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID },
      enqueue,
      requestDispatch: vi.fn(),
      describe: vi.fn(() => ({ queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID }))
    };
    const queueApplicationPort = { registerQueue: vi.fn(async () => queueFacet) };
    const dispatchQueuedRun = vi.fn();
    const provider = await createMaintenanceWorkQueueProvider({
      queueApplicationPort,
      getMaintenanceAgent: () => maintenanceAgent(
        dispatchQueuedRun,
        async () => ({ ...admittedRun, planHash: "b".repeat(64) })
      ),
      capabilitySelected: true,
      autoStart: false,
      dispatchOnSubmit: false
    });

    await provider.submit(admittedRun);
    const admitted = enqueue.mock.calls[0][0];
    expect(admitted.payloadRef).not.toHaveProperty("approvedBy");
    expect(admitted.payloadRef).not.toHaveProperty("planHash");
    const registration = queueApplicationPort.registerQueue.mock.calls[0][0];
    await expect(registration.handler({
      workItem: { workItemId: admitted.workItemId, payloadRef: admitted.payloadRef }
    }, { signal: new AbortController().signal })).resolves.toEqual({
      action: "failed",
      reason: "maintenance_governance_changed"
    });
    expect(dispatchQueuedRun).not.toHaveBeenCalled();
  });

  it("does not admit an unapproved repair run", async () => {
    const queueApplicationPort = { registerQueue: vi.fn(async () => ({
      definition: { queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID },
      enqueue: vi.fn(),
      requestDispatch: vi.fn(),
      describe: vi.fn(() => ({ queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID }))
    })) };
    const provider = await createMaintenanceWorkQueueProvider({
      queueApplicationPort,
      getMaintenanceAgent: () => null,
      capabilitySelected: true,
      autoStart: false,
      dispatchOnSubmit: false
    });
    await expect(provider.submit(maintenanceRun("maintenance_run_unapproved-1", {
      risk: "repair_write",
      requiresApproval: true
    }))).rejects.toThrow(/completed approval governance/u);
  });

  it("does not register a queue when the owning capability is absent", async () => {
    const queueApplicationPort = { registerQueue: vi.fn() };
    const provider = await createMaintenanceWorkQueueProvider({
      queueApplicationPort,
      getMaintenanceAgent: () => null,
      capabilitySelected: false
    });
    expect(provider).toBeNull();
    expect(queueApplicationPort.registerQueue).not.toHaveBeenCalled();
  });

  it("resumes failed work only through the injected recovery facet", async () => {
    const recoverFailed = vi.fn(async ({ workItemId }) => ({
      recovered: true,
      workItem: { workItemId, state: "recovered" }
    }));
    const queueFacet = {
      definition: { queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID },
      enqueue: vi.fn(),
      observe: vi.fn(async () => ({ workItem: { state: "failed" }, journal: [] })),
      cancel: vi.fn(),
      recoverFailed,
      requestDispatch: vi.fn(),
      describe: vi.fn(() => ({ queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID }))
    };
    const provider = await createMaintenanceWorkQueueProvider({
      queueApplicationPort: { registerQueue: vi.fn(async () => queueFacet) },
      getMaintenanceAgent: () => null,
      capabilitySelected: true,
      autoStart: false,
      dispatchOnSubmit: false
    });
    const resumed = await provider.resume({ runId: "maintenance_run_resume-1" });
    expect(resumed).toMatchObject({ recovered: true, state: "recovered" });
    expect(recoverFailed).toHaveBeenCalledOnce();
  });
});
