import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  closeHttpServerRuntime,
  createHttpServerLifecycle
} from "../../../apps/server/runtime/http-server-lifecycle.ts";
import {
  createHttpApplicationAssemblyCloser,
  registerPluginContributionLifecycle,
  registerPluginOwnerGrantLifecycle
} from "../../../packages/server-runtime/src/composition/http-application-assembly.ts";

function createHarness({ openAdmission = true, transportLimits = {} }: Record<string, any> = {}) : any {
  const server: any = new EventEmitter();
  server.close = vi.fn((callback?: any) : any => callback?.());
  const runtimeLogger: Record<string, any> = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    close: vi.fn(async () : Promise<any> => {})
  };
  const lifecycle: any = createHttpServerLifecycle({ server, runtimeLogger, transportLimits });
  if (openAdmission) lifecycle.openAdmission();
  const runtime: Record<string, any> = { close: vi.fn(async () : Promise<any> => {}) };
  const applicationAssembly: Record<string, any> = { close: runtime.close };
  const input: Record<string, any> = {
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

describe("HTTP shutdown lock safety", () : any => {
  it("bounds active request cost and preserves reserved credit for light control work", () : any => {
    const harness: any = createHarness({
      transportLimits: {
        maxActiveRequests: 3,
        maxActiveCost: 6,
        reservedLightCost: 2
      }
    });
    const heavy: any = harness.lifecycle.beginRequest({ workloadClass: "standard", cost: 4 });
    const rejectedHeavy: any = harness.lifecycle.beginRequest({ workloadClass: "standard", cost: 1 });
    const light: any = harness.lifecycle.beginRequest({ workloadClass: "light", cost: 2 });

    expect(heavy.signal.aborted).toBe(false);
    expect(rejectedHeavy.signal.aborted).toBe(true);
    expect(rejectedHeavy.signal.reason).toMatchObject({
      code: "http_request_capacity_exceeded",
      statusCode: 429
    });
    expect(light.signal.aborted).toBe(false);
    expect(harness.lifecycle.getAdmissionUsage()).toMatchObject({
      inFlightCount: 2,
      inFlightCost: 6,
      maxActiveCost: 6,
      reservedLightCost: 2
    });

    harness.lifecycle.endRequest(heavy);
    harness.lifecycle.endRequest(light);
    expect(harness.lifecycle.getAdmissionUsage()).toMatchObject({
      inFlightCount: 0,
      inFlightCost: 0
    });
  });

  it("keeps startup admission closed until the composition root opens it exactly once", () : any => {
    const harness: any = createHarness({ openAdmission: false });
    const earlyController: any = harness.lifecycle.beginRequest();

    expect(harness.lifecycle.isAdmissionOpen()).toBe(false);
    expect(earlyController.signal.aborted).toBe(true);
    expect(harness.lifecycle.getInFlightCount()).toBe(0);

    harness.lifecycle.openAdmission();
    const admittedController: any = harness.lifecycle.beginRequest();
    expect(admittedController.signal.aborted).toBe(false);
    expect(harness.lifecycle.getInFlightCount()).toBe(1);
    harness.lifecycle.endRequest(admittedController);

    harness.lifecycle.sealAdmission();
    expect(() : any => harness.lifecycle.openAdmission()).toThrow(
      "HTTP request admission has been permanently sealed."
    );
  });

  it("aborts active request signals and waits for their tasks before closing dependencies", async () : Promise<any> => {
    const harness: any = createHarness();
    const controller: any = harness.lifecycle.beginRequest();
    const socket: Record<string, any> = { destroy: vi.fn() };
    harness.lifecycle.openSockets.add(socket);
    harness.lifecycle.markSocketActive(socket);
    harness.runtime.close.mockImplementation(async () : Promise<any> => {
      expect(harness.lifecycle.getInFlightCount()).toBe(0);
    });
    controller.signal.addEventListener("abort", () : any => {
      setTimeout(() : any => harness.lifecycle.endRequest(controller), 0);
    }, { once: true });

    await closeHttpServerRuntime(harness.input);

    expect(controller.signal.aborted).toBe(true);
    expect(socket.destroy).toHaveBeenCalled();
    expect(harness.runtime.close).toHaveBeenCalledOnce();
    expect(harness.applicationAssembly.close).toHaveBeenCalledOnce();
  });

  it("leaves lock and storage dependencies open when an active task cannot settle", async () : Promise<any> => {
    const harness: any = createHarness();
    harness.input.runtimeOptions.httpCloseCancelTimeoutMs = 1;
    const controller: any = harness.lifecycle.beginRequest();

    await expect(closeHttpServerRuntime(harness.input)).rejects.toMatchObject({
      code: "http_shutdown_inflight"
    });

    expect(controller.signal.aborted).toBe(true);
    expect(harness.runtime.close).not.toHaveBeenCalled();
    expect(harness.applicationAssembly.close).not.toHaveBeenCalled();
    harness.lifecycle.endRequest(controller);
  });

  it("seals request admission before the first drain check", async () : Promise<any> => {
    const harness: any = createHarness();
    const closing: any = closeHttpServerRuntime(harness.input);
    const lateController: any = harness.lifecycle.beginRequest();

    expect(harness.lifecycle.isAdmissionOpen()).toBe(false);
    expect(lateController.signal.aborted).toBe(true);
    expect(harness.lifecycle.getInFlightCount()).toBe(0);
    await closing;
    expect(harness.runtime.close).toHaveBeenCalledOnce();
  });

  it("keeps a socket active until every concurrent request releases it", () : any => {
    const harness: any = createHarness();
    const socket: Record<string, any> = {};
    harness.lifecycle.markSocketActive(socket);
    harness.lifecycle.markSocketActive(socket);
    harness.lifecycle.markSocketIdle(socket);
    expect(harness.lifecycle.isSocketActive(socket)).toBe(true);
    harness.lifecycle.markSocketIdle(socket);
    expect(harness.lifecycle.isSocketActive(socket)).toBe(false);
  });

  it("settles every task-owner closer and keeps dependencies open for a safe retry", async () : Promise<any> => {
    const failure: any = () : any => {
      throw new Error("private closer detail");
    };
    const jobWorkflowProvider: Record<string, any> = { close: vi.fn(failure) };
    const jobManager: Record<string, any> = { close: vi.fn(failure) };
    const agentWorkspace: Record<string, any> = { close: vi.fn(failure) };
    const consoleOperationProviders: Record<string, any> = { close: vi.fn(failure) };
    const operationPermissionPlatform: Record<string, any> = { close: vi.fn(failure) };
    const compositionRoot: Record<string, any> = { close: vi.fn(async () : Promise<any> => {}) };
    const close: any = createHttpApplicationAssemblyCloser({
      getJobWorkflowProvider: () : any => jobWorkflowProvider,
      jobManager,
      ownsJobManager: true,
      agentWorkspace,
      consoleOperationProviders,
      operationPermissionPlatform,
      compositionRoot
    });

    const error: any = await close().catch((failureValue?: any) : any => failureValue);

    expect(error).toMatchObject({ code: "http_shutdown_dependencies" });
    expect(String(error)).not.toContain("private closer detail");
    expect(jobWorkflowProvider.close).toHaveBeenCalledOnce();
    expect(jobManager.close).toHaveBeenCalledOnce();
    expect(agentWorkspace.close).toHaveBeenCalledOnce();
    expect(consoleOperationProviders.close).toHaveBeenCalledOnce();
    expect(operationPermissionPlatform.close).toHaveBeenCalledOnce();
    expect(compositionRoot.close).not.toHaveBeenCalled();

    jobWorkflowProvider.close = vi.fn(async () : Promise<any> => {});
    jobManager.close = vi.fn(async () : Promise<any> => {});
    agentWorkspace.close = vi.fn(async () : Promise<any> => {});
    consoleOperationProviders.close = vi.fn(async () : Promise<any> => {});
    operationPermissionPlatform.close = vi.fn(async () : Promise<any> => {});
    await close();
    expect(compositionRoot.close).toHaveBeenCalledOnce();
  });

  it("unsubscribes plugin listeners before closing the permission platform", async () : Promise<any> => {
    const closeOrder: any[] = [];
    const close: any = createHttpApplicationAssemblyCloser({
      getJobWorkflowProvider: () : any => null,
      jobManager: null,
      ownsJobManager: false,
      consoleOperationProviders: { close: vi.fn(async () : Promise<any> => {}) },
      unregisterPluginListeners: vi.fn(() : any => closeOrder.push("listeners")),
      operationPermissionPlatform: {
        close: vi.fn(async () : Promise<any> => closeOrder.push("permission"))
      },
      compositionRoot: {
        close: vi.fn(async () : Promise<any> => closeOrder.push("composition"))
      }
    });

    await close();

    expect(closeOrder).toEqual(["listeners", "permission", "composition"]);
  });

  it("refreshes permission operations from plugin contribution changes", async () : Promise<any> => {
    let listener: any = null;
    const unsubscribe: any = vi.fn();
    const runtime: Record<string, any> = {
      onPluginContributionChange: vi.fn((registered?: any) : any => {
        listener = registered;
        return unsubscribe;
      })
    };
    const replacement: Record<string, any> = { commit: vi.fn() };
    const currentOperations: any[] = [{ id: "fixture.operation" }];
    const pluginContributions: Record<string, any> = {
      preparePluginContributionReplacement: vi.fn(() : any => replacement),
      refreshStateMachines: vi.fn(),
      currentActiveOperations: vi.fn(() : any => currentOperations),
      deactivatePlugin: vi.fn()
    };
    const platformRegistry: Record<string, any> = { unregisterOwner: vi.fn() };
    const operationPermissionPlatform: Record<string, any> = { refreshOperations: vi.fn() };

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

  it("binds verified artifact generations to grant registration and retirement", async () : Promise<any> => {
    const generationDigest: any = "e".repeat(64);
    let lifecycleListener: any = null;
    const unregister: any = vi.fn();
    const runtime: Record<string, any> = {
      plugins: { loadedPlugins: [{ id: "sample-plugin" }] },
      getPluginArtifactGenerationDigest: vi.fn(() : any => generationDigest),
      onPluginLifecycleTransition: vi.fn((listener?: any) : any => {
        lifecycleListener = listener;
        return unregister;
      })
    };
    const pluginContributions: Record<string, any> = {
      currentActiveOperations: vi.fn(() : any => [{ id: "fixture.operation" }])
    };
    const operationPermissionPlatform: Record<string, any> = {
      registerPluginGrantOwner: vi.fn(),
      refreshOperations: vi.fn(),
      revokeGrantsByPluginOwner: vi.fn(async () : Promise<any> => ({ ok: true, complete: true, cursor: "" }))
    };
    expect(await registerPluginOwnerGrantLifecycle({
      runtime,
      pluginContributions,
      operationPermissionPlatform
    })).toBe(unregister);
    expect(operationPermissionPlatform.registerPluginGrantOwner).toHaveBeenCalledWith({
      pluginId: "sample-plugin",
      generationDigest
    });
    const transaction: any = lifecycleListener.prepare({
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
