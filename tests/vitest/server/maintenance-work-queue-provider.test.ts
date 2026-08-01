import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAINTENANCE_WORK_QUEUE_DEFINITION_ID,
  createMaintenanceWorkQueueProvider
} from "../../../packages/server-runtime/src/composition/maintenance-work-queue-provider.ts";
import { createQueueApplicationPort } from "../../../packages/server-runtime/src/composition/queue-application-port.ts";

const roots: any[] = [];
const applicationPorts: any = new Set<any>();

async function createRoot() : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "maintenance-work-queue-"));
  roots.push(root);
  return root;
}

async function createProvider(input?: any) : Promise<any> {
  const queueApplicationPort: any = await createQueueApplicationPort({
    userDataPath: input.userDataPath
  });
  applicationPorts.add(queueApplicationPort);
  const provider: any = await createMaintenanceWorkQueueProvider({
    capabilitySelected: true,
    ...input,
    queueApplicationPort
  });
  if (input.autoStart !== false) queueApplicationPort.start();
  return provider;
}

function maintenanceRun(runId?: any, overrides: Record<string, any> = {}) : any {
  const run: Record<string, any> = {
    schemaVersion: "v0.0.1:schema:definition-1",
    runId,
    status: "queued",
    planHash: "a".repeat(64),
    risk: "safe_write",
    requiresApproval: false,
    approvedAt: "",
    approvedBy: null,
    authorization: maintenanceAuthorization("maintenance-run-grant", "maintenance:run"),
    ...overrides
  };
  if (run.approvedAt && !run.approvalAuthorization) {
    run.approvalAuthorization = maintenanceAuthorization(
      "maintenance-approval-grant",
      "maintenance:approve"
    );
  }
  return run;
}

function maintenanceAuthorization(grantId?: any, requiredScope?: any) : any {
  return {
    protocolVersion: "v0.0.1:maintenance-agent:workload-authorization-1",
    workloadPrincipal: {
      subjectType: "agent-profile",
      subjectId: "maintenance-agent",
      agentId: "maintenance-agent",
      profileId: "maintenance-agent"
    },
    grant: {
      grantId,
      projectionFingerprint: "f".repeat(64),
      policyRevision: 7,
      updatedAt: "2026-01-01T00:00:00.000Z"
    },
    policy: { decisionId: "policy_fixture", governanceRevision: 11 },
    scope: {
      requiredScope,
      grantedScopes: [requiredScope],
      plannedOperationIds: ["system.health"]
    },
    planHash: "a".repeat(64),
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z"
  };
}

function maintenanceAgent(dispatchQueuedRun?: any, getRun: any = async (runId?: any) : Promise<any> => maintenanceRun(runId)) : any {
  return {
    dispatchQueuedRun,
    getRun: vi.fn(getRun),
    revalidateRunAuthorization: vi.fn(async () : Promise<any> => ({ ok: true }))
  };
}

async function closeProvider(provider?: any) : Promise<any> {
  await provider?.close();
  for (const applicationPort of applicationPorts) {
    await applicationPort.close();
    applicationPorts.delete(applicationPort);
  }
}

async function waitForState(provider?: any, runId?: any, expected?: any) : Promise<any> {
  for (let attempt: any = 0; attempt < 100; attempt += 1) {
    const observed: any = await provider.observe(runId);
    if (observed?.state === expected) return observed;
    await new Promise((resolve?: any) : any => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${runId} to reach ${expected}.`);
}

async function waitForAnyState(provider?: any, runId?: any, expected?: any) : Promise<any> {
  for (let attempt: any = 0; attempt < 100; attempt += 1) {
    const observed: any = await provider.observe(runId);
    if (expected.includes(observed?.state)) return observed;
    await new Promise((resolve?: any) : any => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${runId} to settle.`);
}

afterEach(async () : Promise<any> => {
  await Promise.all([...applicationPorts].map((applicationPort?: any) : any => applicationPort.close()));
  applicationPorts.clear();
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, {
    recursive: true,
    force: true
  })));
});

describe("maintenance canonical work queue", () : any => {
  it("registers a producer-only facet when an external worker owns consumption", async () : Promise<any> => {
    const queueFacet: Record<string, any> = {
      definition: { queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID },
      requestDispatch: vi.fn(),
      describe: vi.fn(() : any => ({ queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID }))
    };
    const queueApplicationPort: Record<string, any> = {
      registerQueue: vi.fn(async () : Promise<any> => queueFacet)
    };
    const provider: any = await createMaintenanceWorkQueueProvider({
      queueApplicationPort,
      getMaintenanceAgent: () : any => null,
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

  it("recovers durable pending work through the stable queue definition", async () : Promise<any> => {
    const userDataPath: any = await createRoot();
    const first: any = await createProvider({
      userDataPath,
      getMaintenanceAgent: () : any => null,
      autoStart: false,
      dispatchOnSubmit: false
    });
    const submitted: any = await first.submit(maintenanceRun("maintenance-recovery"));
    expect(submitted.accepted).toBe(true);
    expect(await first.submit(maintenanceRun("maintenance-recovery"))).toMatchObject({
      deduped: true,
      workItemId: submitted.workItemId
    });
    expect(first.describe().queueDefinitionId).toBe(MAINTENANCE_WORK_QUEUE_DEFINITION_ID);
    expect((await first.observe("maintenance-recovery"))?.state).toBe("queued");
    await closeProvider(first);

    const dispatchQueuedRun: any = vi.fn(async (runId?: any) : Promise<any> => ({ runId, status: "completed" }));
    const second: any = await createProvider({
      userDataPath,
      getMaintenanceAgent: () : any => maintenanceAgent(dispatchQueuedRun),
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

  it("isolates a failed run and still dispatches independent work", async () : Promise<any> => {
    const userDataPath: any = await createRoot();
    const dispatchQueuedRun: any = vi.fn(async (runId?: any) : Promise<any> => {
      if (runId === "maintenance-failure") throw new Error("bounded fixture failure");
      return { runId, status: "completed" };
    });
    const provider: any = await createProvider({
      userDataPath,
      getMaintenanceAgent: () : any => maintenanceAgent(dispatchQueuedRun),
      autoStart: true,
      dispatchOnSubmit: false
    });
    await provider.submit(maintenanceRun("maintenance-failure"));
    const failed: any = await waitForAnyState(
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

  it("propagates cancellation through the port and settles without executing tools", async () : Promise<any> => {
    const userDataPath: any = await createRoot();
    const executeTools: any = vi.fn();
    const dispatchQueuedRun: any = vi.fn(async (runId?: any) : Promise<any> => {
      if (runId !== "maintenance-cancelled") executeTools();
      return { runId, status: "cancelled" };
    });
    const provider: any = await createProvider({
      userDataPath,
      getMaintenanceAgent: () : any => maintenanceAgent(dispatchQueuedRun),
      autoStart: false,
      dispatchOnSubmit: false
    });
    await provider.submit(maintenanceRun("maintenance-cancelled"));
    const cancelled: any = await provider.cancel({ runId: "maintenance-cancelled" });
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

  it("fences a leased worker so its late acknowledgement cannot revive cancellation", async () : Promise<any> => {
    const userDataPath: any = await createRoot();
    let releaseRun: any;
    const running: any = new Promise((resolve?: any) : any => {
      releaseRun = resolve;
    });
    const dispatchQueuedRun: any = vi.fn(async (runId?: any) : Promise<any> => {
      await running;
      return { runId, status: "completed" };
    });
    const provider: any = await createProvider({
      userDataPath,
      getMaintenanceAgent: () : any => maintenanceAgent(dispatchQueuedRun),
      autoStart: true,
      dispatchOnSubmit: false
    });
    await provider.submit(maintenanceRun("maintenance-leased-cancel"));
    await waitForState(provider, "maintenance-leased-cancel", "running");

    const cancelled: any = await provider.cancel({ runId: "maintenance-leased-cancel" });
    expect(cancelled.state).toBe("cancelled");
    releaseRun();
    await waitForState(provider, "maintenance-leased-cancel", "cancelled");
    expect((await provider.observe("maintenance-leased-cancel"))?.state).toBe("cancelled");
    await closeProvider(provider);
  });

  it("uses only the injected queue facet and emits bounded privacy-safe values", async () : Promise<any> => {
    const enqueue: any = vi.fn(async (input?: any) : Promise<any> => ({ accepted: true, workItem: { workItemId: input.workItemId } }));
    const observe: any = vi.fn(async () : Promise<any> => ({
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
    const queueFacet: Record<string, any> = {
      definition: { queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID },
      enqueue,
      observe,
      cancel: vi.fn(),
      recoverFailed: vi.fn(),
      requestDispatch: vi.fn(),
      describe: vi.fn(() : any => ({ queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID }))
    };
    const queueApplicationPort: Record<string, any> = { registerQueue: vi.fn(async () : Promise<any> => queueFacet) };
    const dispatchQueuedRun: any = vi.fn(async () : Promise<any> => ({ status: "completed" }));
    const provider: any = await createMaintenanceWorkQueueProvider({
      queueApplicationPort,
      getMaintenanceAgent: () : any => maintenanceAgent(dispatchQueuedRun),
      capabilitySelected: true,
      autoStart: false,
      dispatchOnSubmit: false
    });

    await provider.submit(maintenanceRun("maintenance_run_opaque-1"));
    const admitted: any = enqueue.mock.calls[0][0];
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

    const signal: any = new AbortController().signal;
    const registration: any = queueApplicationPort.registerQueue.mock.calls[0][0];
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

  it("rejects a queued run when its durable governance facts change", async () : Promise<any> => {
    const admittedRun: any = maintenanceRun("maintenance_run_governed-1", {
      risk: "repair_write",
      approvedAt: "2026-01-01T00:00:00.000Z",
      approvedBy: { userId: "opaque-user", username: "operator", roleId: "admin" }
    });
    const enqueue: any = vi.fn(async (input?: any) : Promise<any> => ({
      accepted: true,
      workItem: { workItemId: input.workItemId }
    }));
    const queueFacet: Record<string, any> = {
      definition: { queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID },
      enqueue,
      requestDispatch: vi.fn(),
      describe: vi.fn(() : any => ({ queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID }))
    };
    const queueApplicationPort: Record<string, any> = { registerQueue: vi.fn(async () : Promise<any> => queueFacet) };
    const dispatchQueuedRun: any = vi.fn();
    const provider: any = await createMaintenanceWorkQueueProvider({
      queueApplicationPort,
      getMaintenanceAgent: () : any => maintenanceAgent(
        dispatchQueuedRun,
        async () : Promise<any> => ({
          ...admittedRun,
          planHash: "b".repeat(64),
          authorization: {
            ...admittedRun.authorization,
            planHash: "b".repeat(64)
          },
          approvalAuthorization: {
            ...admittedRun.approvalAuthorization,
            planHash: "b".repeat(64)
          }
        })
      ),
      capabilitySelected: true,
      autoStart: false,
      dispatchOnSubmit: false
    });

    await provider.submit(admittedRun);
    const admitted: any = enqueue.mock.calls[0][0];
    expect(admitted.payloadRef).not.toHaveProperty("approvedBy");
    expect(admitted.payloadRef).not.toHaveProperty("planHash");
    const registration: any = queueApplicationPort.registerQueue.mock.calls[0][0];
    await expect(registration.handler({
      workItem: { workItemId: admitted.workItemId, payloadRef: admitted.payloadRef }
    }, { signal: new AbortController().signal })).resolves.toEqual({
      action: "failed",
      reason: "maintenance_governance_changed"
    });
    expect(dispatchQueuedRun).not.toHaveBeenCalled();
  });

  it("does not admit an unapproved repair run", async () : Promise<any> => {
    const queueApplicationPort: Record<string, any> = { registerQueue: vi.fn(async () : Promise<any> => ({
      definition: { queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID },
      enqueue: vi.fn(),
      requestDispatch: vi.fn(),
      describe: vi.fn(() : any => ({ queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID }))
    })) };
    const provider: any = await createMaintenanceWorkQueueProvider({
      queueApplicationPort,
      getMaintenanceAgent: () : any => null,
      capabilitySelected: true,
      autoStart: false,
      dispatchOnSubmit: false
    });
    await expect(provider.submit(maintenanceRun("maintenance_run_unapproved-1", {
      risk: "repair_write",
      requiresApproval: true
    }))).rejects.toThrow(/completed approval governance/u);
  });

  it("does not register a queue when the owning capability is absent", async () : Promise<any> => {
    const queueApplicationPort: Record<string, any> = { registerQueue: vi.fn() };
    const provider: any = await createMaintenanceWorkQueueProvider({
      queueApplicationPort,
      getMaintenanceAgent: () : any => null,
      capabilitySelected: false
    });
    expect(provider).toBeNull();
    expect(queueApplicationPort.registerQueue).not.toHaveBeenCalled();
  });

  it("resumes failed work only through the injected recovery facet", async () : Promise<any> => {
    const recoverFailed: any = vi.fn(async ({ workItemId }: Record<string, any>) : Promise<any> => ({
      recovered: true,
      workItem: { workItemId, state: "recovered" }
    }));
    const queueFacet: Record<string, any> = {
      definition: { queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID },
      enqueue: vi.fn(),
      observe: vi.fn(async () : Promise<any> => ({ workItem: { state: "failed" }, journal: [] })),
      cancel: vi.fn(),
      recoverFailed,
      requestDispatch: vi.fn(),
      describe: vi.fn(() : any => ({ queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID }))
    };
    const provider: any = await createMaintenanceWorkQueueProvider({
      queueApplicationPort: { registerQueue: vi.fn(async () : Promise<any> => queueFacet) },
      getMaintenanceAgent: () : any => null,
      capabilitySelected: true,
      autoStart: false,
      dispatchOnSubmit: false
    });
    const resumed: any = await provider.resume({ runId: "maintenance_run_resume-1" });
    expect(resumed).toMatchObject({ recovered: true, state: "recovered" });
    expect(recoverFailed).toHaveBeenCalledOnce();
  });
});
