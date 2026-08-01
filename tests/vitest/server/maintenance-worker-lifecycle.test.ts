import { beforeEach, describe, expect, it, vi } from "vitest";

const createMaintenanceAgentServiceMock: any = vi.hoisted(() : any => vi.fn());
const createOperationPermissionStoreMock: any = vi.hoisted(() : any => vi.fn());
const createJobManagerMock: any = vi.hoisted(() : any => vi.fn());
const createProtocolEventRuntimeMock: any = vi.hoisted(() : any => vi.fn());
const createServerRuntimeMock: any = vi.hoisted(() : any => vi.fn());
const bindOperationDispatcherMock: any = vi.hoisted(() : any => vi.fn(() : any => vi.fn()));
const loadSettingsMock: any = vi.hoisted(() : any => vi.fn());
const loadDiscoveryConfigMock: any = vi.hoisted(() : any => vi.fn(async () : Promise<any> => ({})));
const createMaintenanceWorkQueueProviderMock: any = vi.hoisted(() : any => vi.fn());
const createQueueApplicationPortMock: any = vi.hoisted(() : any => vi.fn());

vi.mock("#meshrix/agents/maintenance/index", () : any => ({
  createMaintenanceAgentService: createMaintenanceAgentServiceMock
}));

vi.mock("#meshrix/capabilities/operation-permission-core/store", () : any => ({
  createOperationPermissionStore: createOperationPermissionStoreMock
}));

vi.mock("../../../packages/server-runtime/src/jobs/jobs/job-manager.ts", () : any => ({
  createJobManager: createJobManagerMock
}));

vi.mock("../../../packages/server-runtime/src/events/protocol-event-runtime.ts", () : any => ({
  createProtocolEventRuntime: createProtocolEventRuntimeMock
}));

vi.mock("#meshrix/product-api", () : any => ({
  createServerRuntime: createServerRuntimeMock,
  bindOperationDispatcher: bindOperationDispatcherMock,
  loadSettings: loadSettingsMock,
  loadDiscoveryConfig: loadDiscoveryConfigMock
}));

vi.mock("../../../packages/server-runtime/src/composition/maintenance-work-queue-provider.ts", () : any => ({
  createMaintenanceWorkQueueProvider: createMaintenanceWorkQueueProviderMock
}));

vi.mock("../../../packages/server-runtime/src/composition/queue-application-port.ts", () : any => ({
  createQueueApplicationPort: createQueueApplicationPortMock
}));

import { createMaintenanceWorkerRuntime } from "../../../packages/server-runtime/src/composition/background-workers/maintenance-worker.ts";
import { createBackgroundWorkerRuntime } from "../../../packages/server-runtime/src/composition/background-workers/registry.ts";

function createHarness({ startFailure = null }: Record<string, any> = {}) : any {
  const order: any[] = [];
  const operationLockManager: Record<string, any> = { namespace: "shared-maintenance", acquire: vi.fn(), destroy: vi.fn() };
  const runtime: Record<string, any> = {
    operationLockManager,
    close: vi.fn(async () : Promise<any> => {
      order.push("runtime");
    })
  };
  const jobManager: Record<string, any> = {
    close: vi.fn(async () : Promise<any> => {
      order.push("jobs");
    })
  };
  const protocolEventBus: Record<string, any> = {
  };
  const protocolEventRuntime: Record<string, any> = {
    protocolEventBus,
    close: vi.fn(async () : Promise<any> => {
      order.push("events");
    })
  };
  const operationPermissionStore: Record<string, any> = {
    close: vi.fn(() : any => {
      order.push("store");
    })
  };
  const maintenanceAgent: Record<string, any> = {
    start: vi.fn(async () : Promise<any> => {
      if (startFailure) throw startFailure;
    }),
    close: vi.fn(async () : Promise<any> => {
      order.push("agent");
    }),
    tickScheduler: vi.fn(async () : Promise<any> => {}),
    getConsoleSummary: vi.fn(async () : Promise<any> => ({ config: { enabled: false } }))
  };
  const maintenanceWorkQueue: Record<string, any> = {
    start: vi.fn(() : any => {}),
    close: vi.fn(async () : Promise<any> => {
      order.push("queue");
    })
  };
  const queueApplicationPort: Record<string, any> = {
    start: vi.fn(() : any => {}),
    stop: vi.fn(async () : Promise<any> => {
      order.push("queue-stop");
    }),
    close: vi.fn(async () : Promise<any> => {
      order.push("queue-application");
    })
  };
  createServerRuntimeMock.mockResolvedValue(runtime);
  createJobManagerMock.mockReturnValue(jobManager);
  createProtocolEventRuntimeMock.mockResolvedValue(protocolEventRuntime);
  createOperationPermissionStoreMock.mockReturnValue(operationPermissionStore);
  createMaintenanceAgentServiceMock.mockReturnValue(maintenanceAgent);
  createMaintenanceWorkQueueProviderMock.mockResolvedValue(maintenanceWorkQueue);
  createQueueApplicationPortMock.mockResolvedValue(queueApplicationPort);
  return {
    order,
    operationLockManager,
    runtime,
    jobManager,
    protocolEventBus,
    protocolEventRuntime,
    operationPermissionStore,
    maintenanceAgent,
    maintenanceWorkQueue,
    queueApplicationPort
  };
}

beforeEach(() : any => {
  vi.clearAllMocks();
  loadDiscoveryConfigMock.mockResolvedValue({});
});

describe("maintenance worker lifecycle", () : any => {
  it("unwinds every initialized resource in dependency-safe order when startup fails", async () : Promise<any> => {
    const startupFailure: any = new Error("maintenance startup failed");
    const harness: any = createHarness({ startFailure: startupFailure });

    await expect(createBackgroundWorkerRuntime({
      role: "maintenance-worker",
      userDataPath: "<user-data>",
      operationLockManager: harness.operationLockManager
    })).rejects.toBe(startupFailure);

    expect(createServerRuntimeMock).toHaveBeenCalledWith({
      userDataPath: "<user-data>",
      operationLockManager: harness.operationLockManager
    });
    expect(createOperationPermissionStoreMock).toHaveBeenCalledWith(
      expect.objectContaining({
        governancePolicyRevisionProvider: expect.any(Function)
      })
    );
    expect(createMaintenanceAgentServiceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        getGovernancePolicyRevision: expect.any(Function)
      })
    );
    expect(harness.order).toEqual([
      "queue-stop",
      "agent",
      "queue",
      "queue-application",
      "jobs",
      "runtime",
      "events"
    ]);
    expect(harness.operationPermissionStore.close).not.toHaveBeenCalled();
  });

  it("shares an idempotent close barrier and closes task owners before dependencies", async () : Promise<any> => {
    const harness: any = createHarness();
    const worker: any = await createMaintenanceWorkerRuntime({
      userDataPath: "<user-data>",
      operationLockManager: harness.operationLockManager
    });

    const first: any = worker.close();
    const second: any = worker.close();
    expect(first).toBe(second);
    await first;

    expect(harness.order).toEqual([
      "queue-stop",
      "agent",
      "queue",
      "queue-application",
      "jobs",
      "runtime",
      "events"
    ]);
    expect(harness.maintenanceAgent.close).toHaveBeenCalledOnce();
    expect(harness.runtime.close).toHaveBeenCalledOnce();
  });

  it("keeps dependencies open after an owner failure and allows a safe retry", async () : Promise<any> => {
    const harness: any = createHarness();
    const worker: any = await createMaintenanceWorkerRuntime({
      userDataPath: "<user-data>",
      operationLockManager: harness.operationLockManager
    });
    harness.maintenanceAgent.close.mockRejectedValueOnce(new Error("private owner detail"));

    const failure: any = await worker.close().catch((error?: any) : any => error);
    expect(failure).toMatchObject({
      name: "MaintenanceWorkerCloseError",
      code: "maintenance_worker_shutdown_dependencies"
    });
    expect(String(failure)).not.toContain("private owner detail");
    expect(harness.jobManager.close).toHaveBeenCalledOnce();
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect(harness.protocolEventRuntime.close).not.toHaveBeenCalled();

    await worker.close();
    expect(harness.runtime.close).toHaveBeenCalledOnce();
    expect(harness.protocolEventRuntime.close).toHaveBeenCalledOnce();
  });
});
