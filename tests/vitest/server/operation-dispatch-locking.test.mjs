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
import { createSystemControllerFoundationHandlers } from "../../../packages/protocols/http/controllers/system-controller-foundation-handlers.mjs";
import { createToolCatalog } from "../../../packages/capabilities/src/operation-permission-core/catalog.mjs";
import { runWithAbortableTimeout } from "../../../packages/capabilities/src/operation-permission-core/runtime-transport.mjs";
import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.mjs";
import { stagePluginArtifactFixture } from "./support/plugin-artifact-authority-fixture.mjs";

const managers = [];
const tempRoots = [];
const artifactFixtures = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.destroy?.()));
  await Promise.all(artifactFixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createRuntimeWithCanonicalArtifacts({ userDataPath, ...options }) {
  const sourcePluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-runtime-empty-plugins-"));
  tempRoots.push(sourcePluginRoot);
  const fixture = await stagePluginArtifactFixture({ sourcePluginRoot, lifecycleDataRoot: userDataPath });
  artifactFixtures.push(fixture);
  return createServerRuntime({
    userDataPath,
    ...options,
    pluginHostPorts: { ...(options.pluginHostPorts || {}), artifactAuthority: fixture.authority }
  });
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    headersSent: false,
    ended: false,
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
      this.headersSent = true;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    getHeader(name) {
      return this.headers[name];
    },
    write(chunk) {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    },
    end(chunk) {
      this.write(chunk);
      this.ended = true;
    }
  };
}

function unsafeOperation(overrides = {}) {
  return {
    id: "unit.locked.write",
    target: { controller: "unit", method: "handle" },
    http: { method: "POST", path: "/api/unit/locked-write" },
    rpc: { method: "unit.locked.write" },
    public: false,
    externalAuth: false,
    requiredScopes: [],
    readOnly: false,
    concurrencySafe: false,
    concurrencyGroup: "unit-locked-write",
    safety: { risk: "safe_write" },
    inputSchema: { type: "object", properties: {} },
    audit: { enabled: true, recordInput: false },
    log: { recordInput: false, redaction: "default" },
    proof: { binding: "excluded", exclusionReason: "dispatcher-lock-test" },
    ...overrides
  };
}

function dispatchInput(operation, handler) {
  return {
    operation,
    controllers: { unit: { handle: handler } },
    request: { headers: {} },
    response: createResponse(),
    requestBody: Buffer.from("{}"),
    url: new URL(operation.http.path, "http://127.0.0.1"),
    transport: "internal",
    actor: { type: "system" },
    logger: { debug() {}, warn() {}, error() {} }
  };
}

describe("canonical operation dispatcher locking", () => {
  it("passes the caller signal through a concurrency-safe wrapper controller", async () => {
    const wrapperSource = SERVER_API_OPERATIONS.find((operation) => operation.id === "operation_permission.execute");
    const wrapper = {
      ...wrapperSource,
      public: true,
      externalAuth: false,
      requiredScopes: [],
      proof: { binding: "excluded", exclusionReason: "dispatcher-signal-test" }
    };
    const sendConsoleDomainOperation = vi.fn(async () => {});
    const system = createSystemControllerFoundationHandlers({
      sendConsoleDomainOperation,
      protocolPayload: () => ({}),
      workspaceIdFrom: () => "",
      authorizationFacadeContext: () => ({}),
      accessControlContext: () => ({}),
      getToolSkillManagementProvider: () => ({ handleOperationPermissionHttpRequest() {} }),
      getStrategyManagementProvider: () => null,
      agentWorkspace: {},
      runtime: {}
    });
    const controller = new AbortController();

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

  it("keeps Operation Permission wrappers lock-free and lets their target operations own serialization", async () => {
    const manager = new MemoryLockManager({ defaultTtlMs: 1_000, maxWaitMs: 1_000 });
    managers.push(manager);
    const dispatcher = bindOperationDispatcher({
      lockManager: manager,
      concurrencyScope: "operation-permission-wrapper-fixture"
    });
    const wrapperSource = SERVER_API_OPERATIONS.find((operation) => operation.id === "operation_permission.execute");
    const wrapper = unsafeOperation({
      id: wrapperSource.id,
      concurrencySafe: wrapperSource.concurrencySafe,
      concurrencyGroup: "operation-permission-wrapper",
      target: { controller: "unit", method: "handle" }
    });
    const target = unsafeOperation({
      id: "unit.wrapper.target",
      concurrencyGroup: "unit-wrapper-target"
    });
    let outerInFlight = 0;
    let maxOuterInFlight = 0;
    let targetInFlight = 0;
    let maxTargetInFlight = 0;
    const wrapperHandler = async ({ response }) => {
      outerInFlight += 1;
      maxOuterInFlight = Math.max(maxOuterInFlight, outerInFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await dispatcher(dispatchInput(target, async ({ response: targetResponse }) => {
        targetInFlight += 1;
        maxTargetInFlight = Math.max(maxTargetInFlight, targetInFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
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

    expect(wrapperSource?.concurrencySafe).toBe(true);
    expect(maxOuterInFlight).toBe(2);
    expect(maxTargetInFlight).toBe(1);
    expect(manager.getMetrics()).toMatchObject({ totalAcquired: 2, totalReleased: 2 });

    const catalog = createToolCatalog({ operations: SERVER_API_OPERATIONS });
    const projectedOperationIds = new Set(catalog.tools.map((tool) => tool.operationId));
    expect(projectedOperationIds.has("operation_permission.execute")).toBe(false);
    expect(projectedOperationIds.has("operation_permission.batch")).toBe(false);
    expect(projectedOperationIds.has("operation_permission.dry_run")).toBe(false);
  });

  it("aborts a timed-out waiter and never executes it after the held lock is released", async () => {
    const manager = new MemoryLockManager({
      defaultTtlMs: 1_000,
      heartbeatIntervalMs: 100,
      maxWaitMs: 500
    });
    managers.push(manager);
    const dispatcher = bindOperationDispatcher({
      lockManager: manager,
      concurrencyScope: "timeout-fixture"
    });
    const operation = unsafeOperation({ id: "unit.locked.timeout_waiter" });
    let releaseFirst;
    const firstCanFinish = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted;
    const firstDidStart = new Promise((resolve) => {
      firstStarted = resolve;
    });
    const firstHandler = vi.fn(async ({ response }) => {
      firstStarted();
      await firstCanFinish;
      response.writeHead(200, {});
      response.end();
    });
    const secondHandler = vi.fn(({ response }) => {
      response.writeHead(200, {});
      response.end();
    });

    const first = dispatcher({
      ...dispatchInput(operation, firstHandler),
      concurrencyScope: "untrusted-scope-one"
    });
    await firstDidStart;
    const secondOutcome = runWithAbortableTimeout(
      (signal) => dispatcher({
        ...dispatchInput(operation, secondHandler),
        concurrencyScope: "untrusted-scope-two",
        signal
      }),
      20
    ).then(
      (value) => ({ value }),
      (error) => ({ error })
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondHandler).not.toHaveBeenCalled();
    releaseFirst();
    await first;
    const outcome = await secondOutcome;

    expect(outcome.error).toMatchObject({ code: "tool_timeout" });
    expect(secondHandler).not.toHaveBeenCalled();
    expect(manager.getMetrics()).toMatchObject({
      currentActive: 0,
      currentWaiting: 0
    });
  });

  it("does not report a timeout until a non-cooperative dispatch has settled", async () => {
    let observeAbort;
    const aborted = new Promise((resolve) => {
      observeAbort = resolve;
    });
    let settleDispatch;
    const dispatchSettled = new Promise((resolve) => {
      settleDispatch = resolve;
    });
    let outcomeSettled = false;
    const outcome = runWithAbortableTimeout(async (signal) => {
      signal.addEventListener("abort", observeAbort, { once: true });
      await dispatchSettled;
    }, 10).then(
      (value) => {
        outcomeSettled = true;
        return { value };
      },
      (error) => {
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

  it("serializes through the provider, heartbeats beyond TTL, and passes fencing context", async () => {
    const manager = new MemoryLockManager({
      defaultTtlMs: 30,
      heartbeatIntervalMs: 5,
      maxWaitMs: 500
    });
    managers.push(manager);
    const operation = unsafeOperation();
    const provider = createCorePlatformProvider({
      operations: [operation],
      operationLockManager: manager,
      operationConcurrencyScope: "private-runtime-scope"
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const lockContexts = [];
    const controllers = {
      unit: {
        async handle({ response, operationLock }) {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          lockContexts.push(operationLock);
          operationLock.assertActive();
          await new Promise((resolve) => setTimeout(resolve, 70));
          operationLock.assertActive();
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
          inFlight--;
        }
      }
    };

    const [first, second] = await Promise.all([
      provider.dispatchInternalOperation({
        controllers,
        operationId: operation.id,
        concurrencyScope: "untrusted-provider-scope-one"
      }),
      provider.dispatchInternalOperation({
        controllers,
        operationId: operation.id,
        concurrencyScope: "untrusted-provider-scope-two"
      })
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
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

  it("aborts the controller context, surfaces a sanitized heartbeat failure, and releases in finally", async () => {
    const release = vi.fn(async () => {});
    const heartbeat = vi.fn(async () => {
      throw new Error("backend runtime detail");
    });
    const manager = {
      config: { defaultTtlMs: 30, heartbeatIntervalMs: 5 },
      acquire: vi.fn(async (lockKey) => ({
        lockKey,
        fencingToken: "fence_fixture_1",
        acquiredAt: new Date(),
        expiresAt: new Date(Date.now() + 30),
        released: false,
        heartbeat,
        release
      }))
    };
    const operation = unsafeOperation({ id: "unit.locked.heartbeat_failure" });
    const dispatcher = bindOperationDispatcher({
      lockManager: manager,
      concurrencyScope: "heartbeat-fixture"
    });
    let signalAborted = false;

    const pending = dispatcher(dispatchInput(operation, async ({ response, operationLock }) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      signalAborted = operationLock.signal.aborted;
      response.writeHead(200, {});
      response.end();
    }));

    await expect(pending).rejects.toMatchObject({
      name: "OperationLockError",
      phase: "heartbeat"
    });
    expect(signalAborted).toBe(true);
    expect(heartbeat).toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(String(await pending.catch((error) => error))).not.toContain("backend runtime detail");
  });

  it("releases the lease when controller execution fails", async () => {
    const manager = new MemoryLockManager({ defaultTtlMs: 100, heartbeatIntervalMs: 10 });
    managers.push(manager);
    const dispatcher = bindOperationDispatcher({ lockManager: manager, concurrencyScope: "failure-fixture" });
    const operation = unsafeOperation({ id: "unit.locked.handler_failure" });

    await expect(dispatcher(dispatchInput(operation, () => {
      throw new Error("handler failure");
    }))).rejects.toThrow("handler failure");
    expect(manager.getMetrics()).toMatchObject({
      totalAcquired: 1,
      totalReleased: 1,
      currentActive: 0
    });
  });

  it("fails the dispatch when the backend invalidates the session before the next heartbeat", async () => {
    const release = vi.fn(async () => {});
    const handle = {
      lockKey: "operation:fixture:session-loss",
      fencingToken: "fence_fixture_session",
      acquiredAt: new Date(),
      expiresAt: new Date(Date.now() + 100),
      released: false,
      heartbeat: vi.fn(async () => {}),
      release
    };
    const manager = {
      config: { defaultTtlMs: 100, heartbeatIntervalMs: 100 },
      acquire: vi.fn(async () => handle)
    };
    const dispatcher = bindOperationDispatcher({ lockManager: manager });
    const operation = unsafeOperation({ id: "unit.locked.session_loss" });

    await expect(dispatcher(dispatchInput(operation, ({ response }) => {
      handle.released = true;
      response.writeHead(200, {});
      response.end();
    }))).rejects.toMatchObject({
      name: "OperationLockError",
      phase: "lease-lost"
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects a synchronous handler that returns after its absolute lease deadline", async () => {
    const manager = new MemoryLockManager({ defaultTtlMs: 5, heartbeatIntervalMs: 1 });
    managers.push(manager);
    const dispatcher = bindOperationDispatcher({ lockManager: manager });
    const operation = unsafeOperation({ id: "unit.locked.deadline_overrun" });

    await expect(dispatcher(dispatchInput(operation, ({ response }) => {
      const stopAt = Date.now() + 15;
      while (Date.now() < stopAt) {
        // Deliberately block the event loop past the absolute lease deadline.
      }
      response.writeHead(200, {});
      response.end();
    }))).rejects.toMatchObject({
      name: "OperationLockError",
      phase: "lease-lost"
    });
    expect(manager.getMetrics()).toMatchObject({
      totalExpired: 1,
      totalReleased: 0,
      currentActive: 0
    });
  });

  it("does not execute when acquisition resolves to a handle invalidated during the await boundary", async () => {
    const underlying = new MemoryLockManager({ defaultTtlMs: 100 });
    managers.push(underlying);
    const manager = {
      config: underlying.config,
      async acquire(key, options) {
        const acquiring = underlying.acquire(key, options);
        underlying.destroy();
        return acquiring;
      }
    };
    const operation = unsafeOperation({ id: "unit.locked.invalidated_acquire" });
    const handler = vi.fn();

    await expect(dispatchOperation({
      ...dispatchInput(operation, handler),
      lockManager: manager
    })).rejects.toMatchObject({
      name: "OperationLockError",
      phase: "invalid-handle"
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed before executing an unsafe operation without an injected manager", async () => {
    const operation = unsafeOperation({ id: "unit.locked.manager_missing" });
    const handler = vi.fn();
    await expect(dispatchOperation(dispatchInput(operation, handler))).rejects.toBeInstanceOf(OperationLockError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("owns a SQLite manager in the server runtime and destroys it before storage closes", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-operation-lock-runtime-"));
    tempRoots.push(userDataPath);
    const runtime = await createRuntimeWithCanonicalArtifacts({ userDataPath });
    expect(runtime.operationLockManager.config.backend).toBe("sqlite");
    const manager = runtime.operationLockManager;
    await runtime.close();
    await expect(manager.acquire("after-runtime-close")).rejects.toBeInstanceOf(LockManagerDestroyedError);
  });

  it("closes the SQLite handle when storage schema initialization fails", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-storage-init-unwind-"));
    tempRoots.push(userDataPath);
    let openedDatabase = null;

    expect(() => createStorageKernel({
      userDataPath,
      schemaContributors: [(db) => {
        openedDatabase = db;
        throw new Error("schema contributor failed");
      }]
    })).toThrow("schema contributor failed");

    expect(openedDatabase).not.toBeNull();
    expect(openedDatabase.open).toBe(false);
  });

  it("reverse-unwinds the runtime lock manager after a real mid-composition startup failure", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-composition-init-unwind-"));
    tempRoots.push(userDataPath);
    await fs.mkdir(path.join(userDataPath, "security", "operation-audit.sqlite"), { recursive: true });
    const operationLockManager = new MemoryLockManager();

    await expect(createServerCompositionRoot({
      userDataPath,
      runtimeLogger: { debug() {}, info() {}, warn() {}, error() {} },
      operationLockManager
    })).rejects.toThrow();

    await expect(operationLockManager.acquire("after-composition-failure"))
      .rejects.toBeInstanceOf(LockManagerDestroyedError);
  });

  it("rejects an explicit non-conforming runtime lock manager instead of defaulting it", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-invalid-operation-lock-"));
    tempRoots.push(userDataPath);
    await expect(createServerRuntime({
      userDataPath,
      operationLockManager: {}
    })).rejects.toThrow("must implement acquire() and destroy()");
  });

  it("closes runtime storage even when lock-manager shutdown fails", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-operation-lock-close-"));
    tempRoots.push(userDataPath);
    const operationLockManager = {
      acquire: vi.fn(),
      destroy: vi.fn(async () => {
        throw new Error("private lock backend detail");
      })
    };
    const runtime = await createRuntimeWithCanonicalArtifacts({ userDataPath, operationLockManager });

    const closeError = await runtime.close().catch((error) => error);
    expect(closeError).toMatchObject({ name: "ServerRuntimeCloseError" });
    expect(String(closeError)).not.toContain("private lock backend detail");
    expect(runtime.storageKernel.db.open).toBe(false);
  });

  it("retries only failed runtime resources after a partial close", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-operation-lock-close-retry-"));
    tempRoots.push(userDataPath);
    let destroyAttempts = 0;
    const operationLockManager = {
      acquire: vi.fn(),
      destroy: vi.fn(async () => {
        destroyAttempts += 1;
        if (destroyAttempts === 1) throw new Error("private first-attempt detail");
      })
    };
    const runtime = await createRuntimeWithCanonicalArtifacts({ userDataPath, operationLockManager });

    await expect(runtime.close()).rejects.toMatchObject({ name: "ServerRuntimeCloseError" });
    expect(runtime.storageKernel.db.open).toBe(false);
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(operationLockManager.destroy).toHaveBeenCalledTimes(2);
  });
});
