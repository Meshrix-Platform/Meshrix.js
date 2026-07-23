import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  closeHttpServerRuntime,
  createHttpServerLifecycle
} from "../../../apps/server/runtime/http-server-lifecycle.mjs";
import {
  createHttpApplicationAssemblyCloser,
  registerPluginContributionLifecycle,
  registerPluginOwnerGrantLifecycle
} from "../../../packages/server-runtime/src/composition/http-application-assembly.mjs";

function createHarness({ openAdmission = true } = {}) {
  const server = new EventEmitter();
  server.close = vi.fn((callback) => callback?.());
  const runtimeLogger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    close: vi.fn(async () => {})
  };
  const lifecycle = createHttpServerLifecycle({ server, runtimeLogger });
  if (openAdmission) lifecycle.openAdmission();
  const runtime = { close: vi.fn(async () => {}) };
  const applicationAssembly = { close: runtime.close };
  const input = {
    server,
    lifecycle,
    runtimeOptions: {
      httpCloseDrainTimeoutMs: 1,
      httpCloseCancelTimeoutMs: 20
    },
    runtimeLogger,
    applicationAssembly
  };
  return {
    input,
    lifecycle,
    runtime,
    runtimeLogger,
    applicationAssembly
  };
}

describe("HTTP shutdown lock safety", () => {
  it("keeps startup admission closed until the composition root opens it exactly once", () => {
    const harness = createHarness({ openAdmission: false });
    const earlyController = harness.lifecycle.beginRequest();

    expect(harness.lifecycle.isAdmissionOpen()).toBe(false);
    expect(earlyController.signal.aborted).toBe(true);
    expect(harness.lifecycle.getInFlightCount()).toBe(0);

    harness.lifecycle.openAdmission();
    const admittedController = harness.lifecycle.beginRequest();
    expect(admittedController.signal.aborted).toBe(false);
    expect(harness.lifecycle.getInFlightCount()).toBe(1);
    harness.lifecycle.endRequest(admittedController);

    harness.lifecycle.sealAdmission();
    expect(() => harness.lifecycle.openAdmission()).toThrow(
      "HTTP request admission has been permanently sealed."
    );
  });

  it("aborts active request signals and waits for their tasks before closing dependencies", async () => {
    const harness = createHarness();
    const controller = harness.lifecycle.beginRequest();
    const socket = { destroy: vi.fn() };
    harness.lifecycle.openSockets.add(socket);
    harness.lifecycle.markSocketActive(socket);
    harness.runtime.close.mockImplementation(async () => {
      expect(harness.lifecycle.getInFlightCount()).toBe(0);
    });
    controller.signal.addEventListener("abort", () => {
      setTimeout(() => harness.lifecycle.endRequest(controller), 0);
    }, { once: true });

    await closeHttpServerRuntime(harness.input);

    expect(controller.signal.aborted).toBe(true);
    expect(socket.destroy).toHaveBeenCalled();
    expect(harness.runtime.close).toHaveBeenCalledOnce();
    expect(harness.applicationAssembly.close).toHaveBeenCalledOnce();
  });

  it("leaves lock and storage dependencies open when an active task cannot settle", async () => {
    const harness = createHarness();
    harness.input.runtimeOptions.httpCloseCancelTimeoutMs = 1;
    const controller = harness.lifecycle.beginRequest();

    await expect(closeHttpServerRuntime(harness.input)).rejects.toMatchObject({
      code: "http_shutdown_inflight"
    });

    expect(controller.signal.aborted).toBe(true);
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect(harness.applicationAssembly.close).not.toHaveBeenCalled();
    harness.lifecycle.endRequest(controller);
  });

  it("seals request admission before the first drain check", async () => {
    const harness = createHarness();
    const closing = closeHttpServerRuntime(harness.input);
    const lateController = harness.lifecycle.beginRequest();

    expect(harness.lifecycle.isAdmissionOpen()).toBe(false);
    expect(lateController.signal.aborted).toBe(true);
    expect(harness.lifecycle.getInFlightCount()).toBe(0);
    await closing;
    expect(harness.runtime.close).toHaveBeenCalledOnce();
  });

  it("keeps a socket active until every concurrent request releases it", () => {
    const harness = createHarness();
    const socket = {};
    harness.lifecycle.markSocketActive(socket);
    harness.lifecycle.markSocketActive(socket);
    harness.lifecycle.markSocketIdle(socket);
    expect(harness.lifecycle.isSocketActive(socket)).toBe(true);
    harness.lifecycle.markSocketIdle(socket);
    expect(harness.lifecycle.isSocketActive(socket)).toBe(false);
  });

  it("settles every task-owner closer and keeps dependencies open for a safe retry", async () => {
    const failure = () => {
      throw new Error("private closer detail");
    };
    const jobWorkflowProvider = { close: vi.fn(failure) };
    const jobManager = { close: vi.fn(failure) };
    const maintenanceAgent = { close: vi.fn(failure) };
    const agentWorkspace = { close: vi.fn(failure) };
    const consoleOperationProviders = { close: vi.fn(failure) };
    const operationPermissionPlatform = { close: vi.fn(failure) };
    const compositionRoot = { close: vi.fn(async () => {}) };
    const close = createHttpApplicationAssemblyCloser({
      getJobWorkflowProvider: () => jobWorkflowProvider,
      jobManager,
      ownsJobManager: true,
      maintenanceAgent,
      agentWorkspace,
      consoleOperationProviders,
      operationPermissionPlatform,
      compositionRoot
    });

    const error = await close().catch((failureValue) => failureValue);

    expect(error).toMatchObject({ code: "http_shutdown_dependencies" });
    expect(String(error)).not.toContain("private closer detail");
    expect(jobWorkflowProvider.close).toHaveBeenCalledOnce();
    expect(jobManager.close).toHaveBeenCalledOnce();
    expect(maintenanceAgent.close).toHaveBeenCalledOnce();
    expect(agentWorkspace.close).toHaveBeenCalledOnce();
    expect(consoleOperationProviders.close).toHaveBeenCalledOnce();
    expect(operationPermissionPlatform.close).toHaveBeenCalledOnce();
    expect(compositionRoot.close).not.toHaveBeenCalled();

    jobWorkflowProvider.close = vi.fn(async () => {});
    jobManager.close = vi.fn(async () => {});
    maintenanceAgent.close = vi.fn(async () => {});
    agentWorkspace.close = vi.fn(async () => {});
    consoleOperationProviders.close = vi.fn(async () => {});
    operationPermissionPlatform.close = vi.fn(async () => {});
    await close();
    expect(compositionRoot.close).toHaveBeenCalledOnce();
  });

  it("unsubscribes plugin listeners before closing the permission platform", async () => {
    const closeOrder = [];
    const close = createHttpApplicationAssemblyCloser({
      getJobWorkflowProvider: () => null,
      jobManager: null,
      ownsJobManager: false,
      consoleOperationProviders: { close: vi.fn(async () => {}) },
      unregisterPluginListeners: vi.fn(() => closeOrder.push("listeners")),
      operationPermissionPlatform: {
        close: vi.fn(async () => closeOrder.push("permission"))
      },
      compositionRoot: {
        close: vi.fn(async () => closeOrder.push("composition"))
      }
    });

    await close();

    expect(closeOrder).toEqual(["listeners", "permission", "composition"]);
  });

  it("refreshes permission operations from plugin contribution changes", async () => {
    let listener = null;
    const unsubscribe = vi.fn();
    const runtime = {
      onPluginContributionChange: vi.fn((registered) => {
        listener = registered;
        return unsubscribe;
      })
    };
    const replacement = { commit: vi.fn() };
    const currentOperations = [{ id: "fixture.operation" }];
    const pluginContributions = {
      preparePluginContributionReplacement: vi.fn(() => replacement),
      refreshStateMachines: vi.fn(),
      currentActiveOperations: vi.fn(() => currentOperations),
      deactivatePlugin: vi.fn()
    };
    const platformRegistry = { unregisterOwner: vi.fn() };
    const operationPermissionPlatform = { refreshOperations: vi.fn() };

    expect(registerPluginContributionLifecycle({
      runtime,
      pluginContributions,
      platformRegistry,
      operationPermissionPlatform
    })).toBe(unsubscribe);

    await listener({ pluginId: "sample-plugin", contributions: { operations: [] } });

    expect(replacement.commit).toHaveBeenCalledOnce();
    expect(pluginContributions.refreshStateMachines).toHaveBeenCalledWith(platformRegistry, "sample-plugin");
    expect(operationPermissionPlatform.refreshOperations).toHaveBeenCalledWith(currentOperations);
    expect(pluginContributions.deactivatePlugin).not.toHaveBeenCalled();
  });

  it("binds verified artifact generations to grant registration and retirement", async () => {
    const generationDigest = "e".repeat(64);
    let lifecycleListener = null;
    const unregister = vi.fn();
    const runtime = {
      plugins: { loadedPlugins: [{ id: "sample-plugin" }] },
      getPluginArtifactGenerationDigest: vi.fn(() => generationDigest),
      onPluginLifecycleTransition: vi.fn((listener) => {
        lifecycleListener = listener;
        return unregister;
      })
    };
    const pluginContributions = {
      currentActiveOperations: vi.fn(() => [{ id: "fixture.operation" }])
    };
    const operationPermissionPlatform = {
      registerPluginGrantOwner: vi.fn(),
      refreshOperations: vi.fn(),
      revokeGrantsByPluginOwner: vi.fn(async () => ({ ok: true, complete: true, cursor: "" }))
    };
    expect(registerPluginOwnerGrantLifecycle({
      runtime,
      pluginContributions,
      operationPermissionPlatform
    })).toBe(unregister);
    expect(operationPermissionPlatform.registerPluginGrantOwner).toHaveBeenCalledWith({
      pluginId: "sample-plugin",
      generationDigest
    });
    const transaction = lifecycleListener.prepare({
      pluginId: "sample-plugin",
      artifactGenerationDigest: generationDigest,
      operation: "disable",
      idempotencyKey: "fixture-disable"
    });
    await transaction.commitIrreversible();
    expect(operationPermissionPlatform.revokeGrantsByPluginOwner).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: "sample-plugin",
      generationDigest,
      batchSize: 256
    }));
  });
});
