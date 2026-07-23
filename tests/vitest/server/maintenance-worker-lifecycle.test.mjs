import { beforeEach, describe, expect, it, vi } from "vitest";

const createMaintenanceAgentServiceMock = vi.hoisted(() => vi.fn());
const createOperationPermissionStoreMock = vi.hoisted(() => vi.fn());
const createJobManagerMock = vi.hoisted(() => vi.fn());
const createProtocolEventBusMock = vi.hoisted(() => vi.fn());
const createServerRuntimeMock = vi.hoisted(() => vi.fn());
const bindOperationDispatcherMock = vi.hoisted(() => vi.fn(() => vi.fn()));
const loadSettingsMock = vi.hoisted(() => vi.fn());
const loadDiscoveryConfigMock = vi.hoisted(() => vi.fn(async () => ({})));
const createMaintenanceWorkQueueProviderMock = vi.hoisted(() => vi.fn());
const createQueueApplicationPortMock = vi.hoisted(() => vi.fn());

vi.mock("#lico/agents/maintenance/index", () => ({
  createMaintenanceAgentService: createMaintenanceAgentServiceMock
}));

vi.mock("#lico/capabilities/operation-permission-core/store", () => ({
  createOperationPermissionStore: createOperationPermissionStoreMock
}));

vi.mock("../../../packages/server-runtime/src/jobs/jobs/job-manager.mjs", () => ({
  createJobManager: createJobManagerMock
}));

vi.mock("#lico/protocols/pubsub/event-bus", () => ({
  createProtocolEventBus: createProtocolEventBusMock
}));

vi.mock("#lico/product-api", () => ({
  createServerRuntime: createServerRuntimeMock,
  bindOperationDispatcher: bindOperationDispatcherMock,
  loadSettings: loadSettingsMock,
  loadDiscoveryConfig: loadDiscoveryConfigMock
}));

vi.mock("../../../packages/server-runtime/src/composition/maintenance-work-queue-provider.mjs", () => ({
  createMaintenanceWorkQueueProvider: createMaintenanceWorkQueueProviderMock
}));

vi.mock("../../../packages/server-runtime/src/composition/queue-application-port.mjs", () => ({
  createQueueApplicationPort: createQueueApplicationPortMock
}));

import { createMaintenanceWorkerRuntime } from "../../../packages/server-runtime/src/composition/background-workers/maintenance-worker.mjs";
import { createBackgroundWorkerRuntime } from "../../../packages/server-runtime/src/composition/background-workers/registry.mjs";

function createHarness({ startFailure = null } = {}) {
  const order = [];
  const operationLockManager = { namespace: "shared-maintenance", acquire: vi.fn(), destroy: vi.fn() };
  const runtime = {
    operationLockManager,
    close: vi.fn(async () => {
      order.push("runtime");
    })
  };
  const jobManager = {
    close: vi.fn(async () => {
      order.push("jobs");
    })
  };
  const protocolEventBus = {
    close: vi.fn(async () => {
      order.push("events");
    })
  };
  const operationPermissionStore = {
    close: vi.fn(() => {
      order.push("store");
    })
  };
  const maintenanceAgent = {
    start: vi.fn(async () => {
      if (startFailure) throw startFailure;
    }),
    close: vi.fn(async () => {
      order.push("agent");
    }),
    tickScheduler: vi.fn(async () => {}),
    getConsoleSummary: vi.fn(async () => ({ config: { enabled: false } }))
  };
  const maintenanceWorkQueue = {
    start: vi.fn(() => {}),
    close: vi.fn(async () => {
      order.push("queue");
    })
  };
  const queueApplicationPort = {
    start: vi.fn(() => {}),
    stop: vi.fn(async () => {
      order.push("queue-stop");
    }),
    close: vi.fn(async () => {
      order.push("queue-application");
    })
  };
  createServerRuntimeMock.mockResolvedValue(runtime);
  createJobManagerMock.mockReturnValue(jobManager);
  createProtocolEventBusMock.mockReturnValue(protocolEventBus);
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
    operationPermissionStore,
    maintenanceAgent,
    maintenanceWorkQueue,
    queueApplicationPort
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadDiscoveryConfigMock.mockResolvedValue({});
});

describe("maintenance worker lifecycle", () => {
  it("unwinds every initialized resource in dependency-safe order when startup fails", async () => {
    const startupFailure = new Error("maintenance startup failed");
    const harness = createHarness({ startFailure: startupFailure });

    await expect(createBackgroundWorkerRuntime({
      role: "maintenance-worker",
      userDataPath: "<user-data>",
      operationLockManager: harness.operationLockManager
    })).rejects.toBe(startupFailure);

    expect(createServerRuntimeMock).toHaveBeenCalledWith({
      userDataPath: "<user-data>",
      operationLockManager: harness.operationLockManager
    });
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

  it("shares an idempotent close barrier and closes task owners before dependencies", async () => {
    const harness = createHarness();
    const worker = await createMaintenanceWorkerRuntime({
      userDataPath: "<user-data>",
      operationLockManager: harness.operationLockManager
    });

    const first = worker.close();
    const second = worker.close();
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

  it("keeps dependencies open after an owner failure and allows a safe retry", async () => {
    const harness = createHarness();
    const worker = await createMaintenanceWorkerRuntime({
      userDataPath: "<user-data>",
      operationLockManager: harness.operationLockManager
    });
    harness.maintenanceAgent.close.mockRejectedValueOnce(new Error("private owner detail"));

    const failure = await worker.close().catch((error) => error);
    expect(failure).toMatchObject({
      name: "MaintenanceWorkerCloseError",
      code: "maintenance_worker_shutdown_dependencies"
    });
    expect(String(failure)).not.toContain("private owner detail");
    expect(harness.jobManager.close).toHaveBeenCalledOnce();
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect(harness.protocolEventBus.close).not.toHaveBeenCalled();

    await worker.close();
    expect(harness.runtime.close).toHaveBeenCalledOnce();
    expect(harness.protocolEventBus.close).toHaveBeenCalledOnce();
  });
});
