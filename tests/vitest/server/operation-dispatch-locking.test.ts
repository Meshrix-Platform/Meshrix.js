import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LockManagerDestroyedError,
  MemoryLockManager
} from "#meshrix/foundation/concurrency/lock-manager";
import { createStorageKernel } from "#meshrix/foundation/storage/storage-kernel";
import { createCorePlatformProvider } from "#meshrix/server-runtime/composition/core-platform-provider";
import { createServerCompositionRoot } from "#meshrix/server-runtime/composition/composition-root";
import {
  bindOperationDispatcher,
  dispatchOperation
} from "#meshrix/server-runtime/composition/dispatch-operation";
import { OperationLockError } from "#meshrix/server-runtime/composition/operation-dispatch-lock";
import { createServerRuntime } from "#meshrix/server-runtime/module-runtime/server-runtime";
import { createSystemControllerFoundationHandlers } from "../../../packages/protocols/http/controllers/system-controller-foundation-handlers.ts";
import { createToolCatalog } from "../../../packages/capabilities/src/operation-permission-core/catalog.ts";
import { runWithAbortableTimeout } from "../../../packages/capabilities/src/operation-permission-core/runtime-transport.ts";
import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.ts";
import { stagePluginArtifactFixture } from "./support/plugin-artifact-authority-fixture.ts";

const managers: any[] = [];
const tempRoots: any[] = [];
const artifactFixtures: any[] = [];

afterEach(async () : Promise<any> => {
  await Promise.all(managers.splice(0).map((manager?: any) : any => manager.destroy?.()));
  await Promise.all(artifactFixtures.splice(0).map((fixture?: any) : any => fixture.close()));
  await Promise.all(tempRoots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

async function createRuntimeWithCanonicalArtifacts({ userDataPath, ...options }: Record<string, any>) : Promise<any> {
  const sourcePluginRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-runtime-empty-plugins-"));
  tempRoots.push(sourcePluginRoot);
  const fixture: any = await stagePluginArtifactFixture({ sourcePluginRoot, lifecycleDataRoot: userDataPath });
  artifactFixtures.push(fixture);
  return createServerRuntime({
    userDataPath,
    ...options,
    pluginHostPorts: { ...(options.pluginHostPorts || {}), artifactAuthority: fixture.authority }
  });
}

function createResponse() : any {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    headersSent: false,
    ended: false,
    writeHead(statusCode?: any, headers: Record<string, any> = {}) : any {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
      this.headersSent = true;
    },
    setHeader(name?: any, value?: any) : any {
      this.headers[name] = value;
    },
    getHeader(name?: any) : any {
      return this.headers[name];
    },
    write(chunk?: any) : any {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    },
    end(chunk?: any) : any {
      this.write(chunk);
      this.ended = true;
    }
  };
}

function unsafeOperation(overrides: Record<string, any> = {}) : any {
  return {
    id: "unit.locked.write",
    target: { controller: "unit", method: "handle" },
    http: { method: "POST", path: "/api/unit/locked-write" },
    rpc: { method: "unit.locked.write" },
    public: false,
    externalAuth: false,
    requiredScopes: [],
    readOnly: false,
    concurrency: { workloadClass: "exclusive", key: "unit-locked-write", maxParallel: 1, cost: 2 },
    safety: { risk: "safe_write" },
    inputSchema: { type: "object", properties: {} },
    audit: { enabled: true, recordInput: false },
    log: { recordInput: false, redaction: "default" },
    proof: { binding: "excluded", exclusionReason: "dispatcher-lock-test" },
    ...overrides
  };
}

function operationProofSubstrate() : any {
  return {
    beginLifecycle: vi.fn(async () : Promise<any> => ({ ledgerEventId: "dispatcher-lock-proof" })),
    finishLifecycle: vi.fn(async ({ ledgerEventId }: Record<string, any>) : Promise<any> => ({ ledgerEventId })),
    recordReceipt: vi.fn(async () : Promise<any> => ({ ledgerEventId: "dispatcher-lock-receipt" }))
  };
}

function dispatchInput(operation?: any, handler?: any) : any {
  return {
    operation,
    controllers: { unit: { handle: handler } },
    request: { headers: {} },
    response: createResponse(),
    requestBody: Buffer.from("{}"),
    url: new URL(operation.http.path, "http://127.0.0.1"),
    transport: "internal",
    actor: { type: "system" },
    revalidateAuthorization: async () : Promise<any> => ({ ok: true }),
    operationProofSubstrate: operationProofSubstrate(),
    logger: { debug() : any {}, warn() : any {}, error() : any {} }
  };
}

describe("canonical operation dispatcher locking", () : any => {
  it("revalidates current authorization after lock acquisition and denies a revoked waiter", async () : Promise<any> => {
    let finishAcquire: any;
    const acquireGate: any = new Promise((resolve?: any) : any => {
      finishAcquire = resolve;
    });
    const release: any = vi.fn(async () : Promise<any> => {});
    const manager: Record<string, any> = {
      config: { defaultTtlMs: 1_000, heartbeatIntervalMs: 100 },
      acquire: vi.fn(async (lockKey?: any) : Promise<any> => {
        await acquireGate;
        return {
          lockKey,
          fencingToken: "fence_revalidation_revoked",
          acquiredAt: new Date(),
          expiresAt: new Date(Date.now() + 1_000),
          released: false,
          heartbeat: vi.fn(async () : Promise<any> => {}),
          release
        };
      })
    };
    const operation: any = unsafeOperation({ id: "unit.locked.authorization_revoked" });
    const handler: any = vi.fn();
    let authorized: any = true;
    const authorizeOperation: any = vi.fn(async () : Promise<any> => authorized
      ? {
          ok: true,
          session: { user: { userId: "fixture-user", scopes: [] } },
          authorizationDecision: { allowed: true, decisionId: "decision-current" }
        }
      : {
          ok: false,
          status: 403,
          error: "authorization revoked",
          authorizationDecision: { allowed: false, reasonCode: "grant_revoked" }
        });
    const response: any = createResponse();
    const pending: any = dispatchOperation({
      ...dispatchInput(operation, handler),
      request: { headers: {} },
      response,
      transport: "http",
      authorizeOperation,
      revalidateAuthorization: undefined,
      lockManager: manager
    });

    await vi.waitFor(() : any => {
      expect(authorizeOperation).toHaveBeenCalledTimes(1);
      expect(manager.acquire).toHaveBeenCalledTimes(1);
    });
    authorized = false;
    finishAcquire();
    const result: any = await pending;

    expect(result).toMatchObject({ ok: false, statusCode: 403 });
    expect(authorizeOperation).toHaveBeenCalledTimes(2);
    expect(handler).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(403);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("fails closed when execution authorization revalidation throws", async () : Promise<any> => {
    const manager: any = new MemoryLockManager({ defaultTtlMs: 1_000 });
    managers.push(manager);
    const operation: any = unsafeOperation({ id: "unit.locked.authorization_failure" });
    const handler: any = vi.fn();
    const response: any = createResponse();

    const result: any = await dispatchOperation({
      ...dispatchInput(operation, handler),
      response,
      revalidateAuthorization: vi.fn(async () : Promise<any> => {
        throw new Error("private authorization backend detail");
      }),
      lockManager: manager
    });

    expect(result).toMatchObject({ ok: false, statusCode: 503 });
    expect(handler).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(503);
    expect(Buffer.concat(response.chunks).toString("utf8"))
      .not.toContain("private authorization backend detail");
  });

  it("fails closed before a protected effect when no execution revalidator is registered", async () : Promise<any> => {
    const manager: any = new MemoryLockManager({ defaultTtlMs: 1_000 });
    managers.push(manager);
    const operation: any = unsafeOperation({ id: "unit.locked.authorization_missing" });
    const handler: any = vi.fn();
    const response: any = createResponse();

    const result: any = await dispatchOperation({
      ...dispatchInput(operation, handler),
      response,
      revalidateAuthorization: undefined,
      lockManager: manager
    });

    expect(result).toMatchObject({ ok: false, statusCode: 503 });
    expect(handler).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(503);
  });

  it("passes the caller signal through a concurrency-safe wrapper controller", async () : Promise<any> => {
    const wrapperSource: any = SERVER_API_OPERATIONS.find((operation?: any) : any => operation.id === "operation_permission.execute");
    const wrapper: Record<string, any> = {
      ...wrapperSource,
      public: true,
      externalAuth: false,
      requiredScopes: [],
      proof: { binding: "excluded", exclusionReason: "dispatcher-signal-test" }
    };
    const sendConsoleDomainOperation: any = vi.fn(async () : Promise<any> => {});
    const system: any = createSystemControllerFoundationHandlers({
      sendConsoleDomainOperation,
      protocolPayload: () : any => ({}),
      workspaceIdFrom: () : any => "",
      authorizationFacadeContext: () : any => ({}),
      accessControlContext: () : any => ({}),
      getToolSkillManagementProvider: () : any => ({ handleOperationPermissionHttpRequest() : any {} }),
      getStrategyManagementProvider: () : any => null,
      agentWorkspace: {},
      runtime: {}
    });
    const controller: any = new AbortController();

    await dispatchOperation({
      ...dispatchInput(wrapper, vi.fn()),
      controllers: { system },
      requestBody: Buffer.from(JSON.stringify({ toolId: "unit.signal-passthrough" })),
      signal: controller.signal
    });

    expect(sendConsoleDomainOperation).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ signal: controller.signal })
    }));
  });

  it("keeps Operation Permission wrappers lock-free and lets their target operations own serialization", async () : Promise<any> => {
    const manager: any = new MemoryLockManager({ defaultTtlMs: 1_000, maxWaitMs: 1_000 });
    managers.push(manager);
    const dispatcher: any = bindOperationDispatcher({
      lockManager: manager,
      concurrencyScope: "operation-permission-wrapper-fixture"
    });
    const wrapperSource: any = SERVER_API_OPERATIONS.find((operation?: any) : any => operation.id === "operation_permission.execute");
    const wrapper: any = unsafeOperation({
      id: wrapperSource.id,
      concurrency: { ...wrapperSource.concurrency, key: "operation-permission-wrapper" },
      target: { controller: "unit", method: "handle" }
    });
    const target: any = unsafeOperation({
      id: "unit.wrapper.target",
      concurrency: { workloadClass: "exclusive", key: "unit-wrapper-target", maxParallel: 1, cost: 2 }
    });
    let outerInFlight: any = 0;
    let maxOuterInFlight: any = 0;
    let targetInFlight: any = 0;
    let maxTargetInFlight: any = 0;
    const wrapperHandler: any = async ({ response }: Record<string, any>) : Promise<any> => {
      outerInFlight += 1;
      maxOuterInFlight = Math.max(maxOuterInFlight, outerInFlight);
      await new Promise((resolve?: any) : any => setTimeout(resolve, 5));
      await dispatcher(dispatchInput(target, async ({ response: targetResponse }: Record<string, any>) : Promise<any> => {
        targetInFlight += 1;
        maxTargetInFlight = Math.max(maxTargetInFlight, targetInFlight);
        await new Promise((resolve?: any) : any => setTimeout(resolve, 15));
        targetInFlight -= 1;
        targetResponse.end();
      }));
      outerInFlight -= 1;
      response.end();
    };

    await Promise.all([
      dispatcher({ ...dispatchInput(wrapper, wrapperHandler), skipAuthorization: true }),
      dispatcher({ ...dispatchInput(wrapper, wrapperHandler), skipAuthorization: true })
    ]);

    expect(wrapperSource?.concurrency.maxParallel).toBeGreaterThan(1);
    expect(maxOuterInFlight).toBe(2);
    expect(maxTargetInFlight).toBe(1);
    expect(manager.getMetrics()).toMatchObject({ totalAcquired: 2, totalReleased: 2 });

    const catalog: any = createToolCatalog({ operations: SERVER_API_OPERATIONS });
    const projectedOperationIds: any = new Set<any>(catalog.tools.map((tool?: any) : any => tool.operationId));
    expect(projectedOperationIds.has("operation_permission.execute")).toBe(false);
    expect(projectedOperationIds.has("operation_permission.batch")).toBe(false);
    expect(projectedOperationIds.has("operation_permission.dry_run")).toBe(false);
  });

  it("aborts a timed-out waiter and never executes it after the held lock is released", async () : Promise<any> => {
    const manager: any = new MemoryLockManager({
      defaultTtlMs: 1_000,
      heartbeatIntervalMs: 100,
      maxWaitMs: 500
    });
    managers.push(manager);
    const dispatcher: any = bindOperationDispatcher({
      lockManager: manager,
      concurrencyScope: "timeout-fixture"
    });
    const operation: any = unsafeOperation({ id: "unit.locked.timeout_waiter" });
    let releaseFirst: any;
    const firstCanFinish: any = new Promise((resolve?: any) : any => {
      releaseFirst = resolve;
    });
    let firstStarted: any;
    const firstDidStart: any = new Promise((resolve?: any) : any => {
      firstStarted = resolve;
    });
    const firstHandler: any = vi.fn(async ({ response }: Record<string, any>) : Promise<any> => {
      firstStarted();
      await firstCanFinish;
      response.writeHead(200, {});
      response.end();
    });
    const secondHandler: any = vi.fn(({ response }: Record<string, any>) : any => {
      response.writeHead(200, {});
      response.end();
    });

    const first: any = dispatcher({
      ...dispatchInput(operation, firstHandler),
      concurrencyScope: "untrusted-scope-one"
    });
    await firstDidStart;
    const secondOutcome: any = runWithAbortableTimeout(
      (signal?: any) : any => dispatcher({
        ...dispatchInput(operation, secondHandler),
        concurrencyScope: "untrusted-scope-two",
        signal
      }),
      20
    ).then(
      (value?: any) : any => ({ value }),
      (error?: any) : any => ({ error })
    );

    await new Promise((resolve?: any) : any => setTimeout(resolve, 50));
    expect(secondHandler).not.toHaveBeenCalled();
    releaseFirst();
    await first;
    const outcome: any = await secondOutcome;

    expect(outcome.error).toMatchObject({ code: "tool_timeout" });
    expect(secondHandler).not.toHaveBeenCalled();
    expect(manager.getMetrics()).toMatchObject({
      currentActive: 0,
      currentWaiting: 0
    });
  });

  it("does not report a timeout until a non-cooperative dispatch has settled", async () : Promise<any> => {
    let observeAbort: any;
    const aborted: any = new Promise((resolve?: any) : any => {
      observeAbort = resolve;
    });
    let settleDispatch: any;
    const dispatchSettled: any = new Promise((resolve?: any) : any => {
      settleDispatch = resolve;
    });
    let outcomeSettled: any = false;
    const outcome: any = runWithAbortableTimeout(async (signal?: any) : Promise<any> => {
      signal.addEventListener("abort", observeAbort, { once: true });
      await dispatchSettled;
    }, 10).then(
      (value?: any) : any => {
        outcomeSettled = true;
        return { value };
      },
      (error?: any) : any => {
        outcomeSettled = true;
        return { error };
      }
    );

    await aborted;
    expect(outcomeSettled).toBe(false);
    settleDispatch();

    await expect(outcome).resolves.toMatchObject({
      error: { code: "tool_timeout" }
    });
  });

  it("serializes through the provider, heartbeats beyond TTL, and passes fencing context", async () : Promise<any> => {
    const manager: any = new MemoryLockManager({
      defaultTtlMs: 1_000,
      heartbeatIntervalMs: 50,
      maxWaitMs: 5_000
    });
    managers.push(manager);
    const operation: any = unsafeOperation();
    const provider: any = createCorePlatformProvider({
      operations: [operation],
      operationLockManager: manager,
      operationConcurrencyScope: "private-runtime-scope",
      operationProofSubstrate: operationProofSubstrate()
    });
    let inFlight: any = 0;
    let maxInFlight: any = 0;
    const lockContexts: any[] = [];
    const controllers: Record<string, any> = {
      unit: {
        async handle({ response, operationLock }: Record<string, any>) : Promise<any> {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          lockContexts.push(operationLock);
          operationLock.assertActive();
          await new Promise((resolve?: any) : any => setTimeout(resolve, 1_200));
          operationLock.assertActive();
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
          inFlight--;
        }
      }
    };

    const authorizeOperation: any = vi.fn(async () : Promise<any> => ({
      ok: true,
      session: { user: { scopes: [] } },
      authorizationDecision: { allowed: true, decisionId: "provider-lock-test" }
    }));
    const dispatchThroughProvider: any = (concurrencyScope?: any) : any => provider.dispatchRegisteredHttpOperation({
        controllers,
        method: "POST",
        url: new URL(operation.http.path, "http://127.0.0.1"),
        request: { headers: {} },
        response: createResponse(),
        requestBody: Buffer.from("{}"),
        authorizeOperation,
        concurrencyScope
      });

    const [first, second] = await Promise.all([
      dispatchThroughProvider("untrusted-provider-scope-one"),
      dispatchThroughProvider("untrusted-provider-scope-two")
    ]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(lockContexts).toHaveLength(2);
    expect(lockContexts[0].fencingToken).not.toBe(lockContexts[1].fencingToken);
    expect(lockContexts[0].lockKey).toBe(lockContexts[1].lockKey);
    expect(lockContexts[0].lockKey).not.toContain("private-runtime-scope");
    expect(manager.getMetrics()).toMatchObject({
      totalAcquired: 2,
      totalReleased: 2,
      totalExpired: 0,
      currentActive: 0,
      currentWaiting: 0
    });
  });

  it("aborts the controller context, surfaces a sanitized heartbeat failure, and releases in finally", async () : Promise<any> => {
    const release: any = vi.fn(async () : Promise<any> => {});
    const heartbeat: any = vi.fn(async () : Promise<any> => {
      throw new Error("backend runtime detail");
    });
    const manager: Record<string, any> = {
      config: { defaultTtlMs: 30, heartbeatIntervalMs: 5 },
      acquire: vi.fn(async (lockKey?: any) : Promise<any> => ({
        lockKey,
        fencingToken: "fence_fixture_1",
        acquiredAt: new Date(),
        expiresAt: new Date(Date.now() + 30),
        released: false,
        heartbeat,
        release
      }))
    };
    const operation: any = unsafeOperation({ id: "unit.locked.heartbeat_failure" });
    const dispatcher: any = bindOperationDispatcher({
      lockManager: manager,
      concurrencyScope: "heartbeat-fixture"
    });
    let signalAborted: any = false;

    const pending: any = dispatcher(dispatchInput(operation, async ({ response, operationLock }: Record<string, any>) : Promise<any> => {
      await new Promise((resolve?: any) : any => setTimeout(resolve, 20));
      signalAborted = operationLock.signal.aborted;
      response.writeHead(200, {});
      response.end();
    }));

    await expect(pending).rejects.toMatchObject({
      code: "operation_outcome_in_doubt",
      retryable: false,
      cause: {
        name: "OperationLockError",
        phase: "heartbeat"
      }
    });
    expect(signalAborted).toBe(true);
    expect(heartbeat).toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(String(await pending.catch((error?: any) : any => error))).not.toContain("backend runtime detail");
  });

  it("releases the lease when controller execution fails", async () : Promise<any> => {
    const manager: any = new MemoryLockManager({ defaultTtlMs: 100, heartbeatIntervalMs: 10 });
    managers.push(manager);
    const dispatcher: any = bindOperationDispatcher({ lockManager: manager, concurrencyScope: "failure-fixture" });
    const operation: any = unsafeOperation({ id: "unit.locked.handler_failure" });

    await expect(dispatcher(dispatchInput(operation, () : any => {
      throw new Error("handler failure");
    }))).rejects.toMatchObject({
      code: "operation_outcome_in_doubt",
      retryable: false
    });
    expect(manager.getMetrics()).toMatchObject({
      totalAcquired: 1,
      totalReleased: 1,
      currentActive: 0
    });
  });

  it("fails the dispatch when the backend invalidates the session before the next heartbeat", async () : Promise<any> => {
    const release: any = vi.fn(async () : Promise<any> => {});
    const handle: Record<string, any> = {
      lockKey: "operation:fixture:session-loss",
      fencingToken: "fence_fixture_session",
      acquiredAt: new Date(),
      expiresAt: new Date(Date.now() + 100),
      released: false,
      heartbeat: vi.fn(async () : Promise<any> => {}),
      release
    };
    const manager: Record<string, any> = {
      config: { defaultTtlMs: 100, heartbeatIntervalMs: 100 },
      acquire: vi.fn(async () : Promise<any> => handle)
    };
    const dispatcher: any = bindOperationDispatcher({ lockManager: manager });
    const operation: any = unsafeOperation({ id: "unit.locked.session_loss" });

    await expect(dispatcher(dispatchInput(operation, ({ response }: Record<string, any>) : any => {
      handle.released = true;
      response.writeHead(200, {});
      response.end();
    }))).rejects.toMatchObject({
      code: "operation_outcome_in_doubt",
      retryable: false,
      cause: {
        name: "OperationLockError",
        phase: "lease-lost"
      }
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects a synchronous handler that returns after its absolute lease deadline", async () : Promise<any> => {
    const manager: any = new MemoryLockManager({ defaultTtlMs: 5, heartbeatIntervalMs: 1 });
    managers.push(manager);
    const dispatcher: any = bindOperationDispatcher({ lockManager: manager });
    const operation: any = unsafeOperation({ id: "unit.locked.deadline_overrun" });

    await expect(dispatcher(dispatchInput(operation, ({ response }: Record<string, any>) : any => {
      const stopAt: any = Date.now() + 15;
      while (Date.now() < stopAt) {
        // Deliberately block the event loop past the absolute lease deadline.
      }
      response.writeHead(200, {});
      response.end();
    }))).rejects.toMatchObject({
      code: "operation_outcome_in_doubt",
      retryable: false,
      cause: {
        name: "OperationLockError",
        phase: "lease-lost"
      }
    });
    expect(manager.getMetrics()).toMatchObject({
      totalExpired: 1,
      totalReleased: 0,
      currentActive: 0
    });
  });

  it("does not execute when acquisition resolves to a handle invalidated during the await boundary", async () : Promise<any> => {
    const underlying: any = new MemoryLockManager({ defaultTtlMs: 100 });
    managers.push(underlying);
    const manager: Record<string, any> = {
      config: underlying.config,
      async acquire(key?: any, options?: any) : Promise<any> {
        const acquiring: any = underlying.acquire(key, options);
        underlying.destroy();
        return acquiring;
      }
    };
    const operation: any = unsafeOperation({ id: "unit.locked.invalidated_acquire" });
    const handler: any = vi.fn();

    await expect(dispatchOperation({
      ...dispatchInput(operation, handler),
      lockManager: manager
    })).rejects.toMatchObject({
      name: "OperationLockError",
      phase: "invalid-handle"
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed before executing an unsafe operation without an injected manager", async () : Promise<any> => {
    const operation: any = unsafeOperation({ id: "unit.locked.manager_missing" });
    const handler: any = vi.fn();
    await expect(dispatchOperation(dispatchInput(operation, handler))).rejects.toBeInstanceOf(OperationLockError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("owns a SQLite manager in the server runtime and destroys it before storage closes", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-operation-lock-runtime-"));
    tempRoots.push(userDataPath);
    const runtime: any = await createRuntimeWithCanonicalArtifacts({ userDataPath });
    expect(runtime.operationLockManager.config.backend).toBe("sqlite");
    const manager: any = runtime.operationLockManager;
    await runtime.close();
    await expect(manager.acquire("after-runtime-close")).rejects.toBeInstanceOf(LockManagerDestroyedError);
  });

  it("closes the SQLite handle when storage schema initialization fails", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-storage-init-unwind-"));
    tempRoots.push(userDataPath);
    let openedDatabase: any = null;

    expect(() : any => createStorageKernel({
      userDataPath,
      schemaContributors: [(db?: any) : any => {
        openedDatabase = db;
        throw new Error("schema contributor failed");
      }]
    })).toThrow("schema contributor failed");

    expect(openedDatabase).not.toBeNull();
    expect(openedDatabase.open).toBe(false);
  });

  it("reverse-unwinds the runtime lock manager after a real mid-composition startup failure", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-composition-init-unwind-"));
    tempRoots.push(userDataPath);
    const operationLockManager: any = new MemoryLockManager();
    const pluginControlledExecutionAuthority: Record<string, any> = {
      id: "PluginControlledExecutionAuthority",
      forOwner: vi.fn(),
      bind() : never {
        throw new Error("injected composition failure");
      }
    };

    await expect(createServerCompositionRoot({
      userDataPath,
      runtimeLogger: { debug() : any {}, info() : any {}, warn() : any {}, error() : any {} },
      operationLockManager,
      pluginHostPorts: { pluginControlledExecutionAuthority }
    })).rejects.toThrow();

    await expect(operationLockManager.acquire("after-composition-failure"))
      .rejects.toBeInstanceOf(LockManagerDestroyedError);
  });

  it("rejects an explicit non-conforming runtime lock manager instead of defaulting it", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-invalid-operation-lock-"));
    tempRoots.push(userDataPath);
    await expect(createServerRuntime({
      userDataPath,
      operationLockManager: {}
    })).rejects.toThrow("must implement acquire() and destroy()");
  });

  it("closes runtime storage even when lock-manager shutdown fails", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-operation-lock-close-"));
    tempRoots.push(userDataPath);
    const operationLockManager: Record<string, any> = {
      acquire: vi.fn(),
      destroy: vi.fn(async () : Promise<any> => {
        throw new Error("private lock backend detail");
      })
    };
    const runtime: any = await createRuntimeWithCanonicalArtifacts({ userDataPath, operationLockManager });

    const closeError: any = await runtime.close().catch((error?: any) : any => error);
    expect(closeError).toMatchObject({ name: "ServerRuntimeCloseError" });
    expect(String(closeError)).not.toContain("private lock backend detail");
    expect(runtime.storageKernel.db.open).toBe(false);
  });

  it("retries only failed runtime resources after a partial close", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-operation-lock-close-retry-"));
    tempRoots.push(userDataPath);
    let destroyAttempts: any = 0;
    const operationLockManager: Record<string, any> = {
      acquire: vi.fn(),
      destroy: vi.fn(async () : Promise<any> => {
        destroyAttempts += 1;
        if (destroyAttempts === 1) throw new Error("private first-attempt detail");
      })
    };
    const runtime: any = await createRuntimeWithCanonicalArtifacts({ userDataPath, operationLockManager });

    await expect(runtime.close()).rejects.toMatchObject({ name: "ServerRuntimeCloseError" });
    expect(runtime.storageKernel.db.open).toBe(false);
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(operationLockManager.destroy).toHaveBeenCalledTimes(2);
  });
});
