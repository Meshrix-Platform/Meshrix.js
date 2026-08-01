import {
  listInterfaceCatalog,
  SERVER_API_OPERATIONS,
} from "#meshrix/contracts/operations/operation-registry";
import { PROTOCOL_OPERATION_IDS } from "#meshrix/contracts/operations/protocol-operation-definitions";
import {
  dispatchRegisteredHttpOperation as dispatchRegisteredHttpOperationThroughDispatcher,
  dispatchRpcOperation as dispatchRpcOperationThroughDispatcher,
} from "./dispatch-operation.ts";
import {
  createStartupSnapshotPort as createStartupSnapshotPortThroughDispatcher,
} from "./dispatch-operation-http.ts";
import {
  findProxyRegisteredApiRequest as findProxyRegisteredApiRequestThroughDispatcher,
} from "./dispatch-operation-input.ts";
import { createOperationRouteIndex } from "../routing/operation-route-index.ts";

export const CORE_PLATFORM_PROTOCOL_VERSION: any = "v0.0.1:platform:core-1";

const CORE_VERIFICATION_COMMAND: any = "npm run verify:core-platform-surface-convergence";
const DISPATCH_VERIFICATION_COMMAND: any = "node tests/run.ts --suite runtime.operation-dispatch-lock";
const FULL_VERIFICATION_COMMAND: any = "npm run server:verify";
const PROTOCOL_OPERATION_ID_SET: any = new Set<any>(PROTOCOL_OPERATION_IDS);

function normalizeOperations(operations?: any) : any {
  if (operations === undefined) return SERVER_API_OPERATIONS;
  if (!Array.isArray(operations)) {
    throw new TypeError("Core platform operations must be an array.");
  }
  return operations;
}

function hasText(value?: any) : any {
  return String(value || "").trim().length > 0;
}

function verificationCommandsForOperation(operation: Record<string, any> = {}) : any {
  const commands: any = new Set<any>([CORE_VERIFICATION_COMMAND]);
  const id: any = String(operation.id || "");
  const feature: any = String(operation.feature || "");
  const aspects: any = new Set<any>(operation.aspects || []);

  if (PROTOCOL_OPERATION_ID_SET.has(id)) {
    commands.add("node tools/server-scripts/verify-protocol-operation-registration.ts");
  }
  if (id.startsWith("system.") || id.startsWith("runtime.") || id.startsWith("events.")) {
    commands.add(DISPATCH_VERIFICATION_COMMAND);
  }
  if (id.startsWith("discovery.")) {
    commands.add("node tools/server-scripts/verify-unified-registration.ts");
  }
  if (feature === "operation_permission" || aspects.has("operation-permission")) {
    commands.add("node tools/server-scripts/verify-operation-permission-platform.ts");
  }
  if (feature === "strategy_management" || aspects.has("strategy-management")) {
    commands.add("node tools/server-scripts/verify-strategy-management.ts");
  }
  if (feature === "agent_workspace" || id.startsWith("workspace.")) {
    commands.add("node tools/server-scripts/verify-agent-workspace.ts");
  }
  if (feature === "storage" || id.startsWith("storage.")) {
    commands.add("npm run server:verify:ops");
  }
  commands.add(FULL_VERIFICATION_COMMAND);
  return [...commands];
}

function operationIsWired(operation: Record<string, any> = {}) : any {
  return Boolean(
    hasText(operation.id) &&
    hasText(operation.target?.controller) &&
    hasText(operation.target?.method) &&
    hasText(operation.http?.method) &&
    hasText(operation.http?.path) &&
    hasText(operation.rpc?.method)
  );
}

function operationIsImplemented(operation: Record<string, any> = {}, controllers: any = null) : any {
  if (!controllers || typeof controllers !== "object") {
    return null;
  }
  const controller: any = controllers[operation.target?.controller];
  return typeof controller?.[operation.target?.method] === "function";
}

function lifecycleState({ wired, implemented, verified }: Record<string, any>) : any {
  if (verified && wired && implemented !== false) {
    return "verified";
  }
  if (implemented) {
    return "implemented";
  }
  if (wired) {
    return "wired";
  }
  return "registered";
}

function summarizeLifecycle(entries?: any) : any {
  const summary: Record<string, any> = {
    total: entries.length,
    registered: entries.filter((entry?: any) : any => entry.registered).length,
    wired: entries.filter((entry?: any) : any => entry.wired).length,
    implemented: entries.filter((entry?: any) : any => entry.implemented === true).length,
    implementationUnknown: entries.filter((entry?: any) : any => entry.implemented === null).length,
    verified: entries.filter((entry?: any) : any => entry.verified).length,
  };
  const missing: Record<string, any> = {
    registered: entries.filter((entry?: any) : any => !entry.registered).map((entry?: any) : any => entry.id),
    wired: entries.filter((entry?: any) : any => !entry.wired).map((entry?: any) : any => entry.id),
    implemented: entries
      .filter((entry?: any) : any => entry.implemented === false)
      .map((entry?: any) : any => entry.id),
    verified: entries.filter((entry?: any) : any => !entry.verified).map((entry?: any) : any => entry.id),
  };
  return {
    ...summary,
    ready:
      missing.registered.length === 0 &&
      missing.wired.length === 0 &&
      missing.implemented.length === 0 &&
      missing.verified.length === 0,
    missing,
  };
}

export function createCorePlatformProvider({
  operations = SERVER_API_OPERATIONS,
  getOperations = null,
  protocolEventBus = null,
  runtimeLogger = null,
  featureRuntime = null,
  operationLockManager = null,
  operationConcurrencyScope = "",
  operationProofSubstrate = null,
}: Record<string, any> = {}) : any {
  const configuredSourceOperations: any = normalizeOperations(operations);
  const configuredRouteIndex: any = createOperationRouteIndex(configuredSourceOperations, {
    strict: true,
  });
  const configuredOperations: any = configuredRouteIndex.operations;
  const dynamicRouteIndexes: any = new WeakMap<object, any>();
  const boundOperationConcurrencyScope: any = String(operationConcurrencyScope || "default").trim();

  function effectiveOperationSelection(input: Record<string, any> = {}) : any {
    if (
      !Object.hasOwn(input, "operations") ||
      input.operations === undefined ||
      input.operations === configuredSourceOperations ||
      input.operations === configuredOperations
    ) {
      if (typeof getOperations !== "function") {
        return { operations: configuredOperations, routeIndex: configuredRouteIndex };
      }
      const current: any = normalizeOperations(getOperations());
      let routeIndex: any = dynamicRouteIndexes.get(current);
      if (!routeIndex) {
        routeIndex = createOperationRouteIndex(current, { strict: true });
        dynamicRouteIndexes.set(current, routeIndex);
      }
      return { operations: routeIndex.operations, routeIndex };
    }
    const current: any = normalizeOperations(input.operations);
    let routeIndex: any = dynamicRouteIndexes.get(current);
    if (!routeIndex) {
      routeIndex = createOperationRouteIndex(current, { strict: true });
      dynamicRouteIndexes.set(current, routeIndex);
    }
    return { operations: routeIndex.operations, routeIndex };
  }

  function proofSubstrateForDispatch(input: Record<string, any> = {}) : any {
    if (input.skipOperationProof === true || Object.hasOwn(input, "operationProofSubstrate")) {
      return {};
    }
    return operationProofSubstrate ? { operationProofSubstrate } : {};
  }

  function describeOperationRegistry(input: Record<string, any> = {}) : any {
    const { operations: selectedOperations } = effectiveOperationSelection(input);
    const controllers: any = input.controllers || null;
    const interfaces: any = listInterfaceCatalog(selectedOperations);
    const lifecycle: any = selectedOperations.map((operation?: any) : any => {
      const verificationCommands: any = verificationCommandsForOperation(operation);
      const wired: any = operationIsWired(operation);
      const implemented: any = operationIsImplemented(operation, controllers);
      const verified: any = verificationCommands.length > 0;
      return {
        id: operation.id,
        feature: operation.feature || "",
        target: `${operation.target?.controller || ""}.${operation.target?.method || ""}`,
        registered: true,
        wired,
        implemented,
        verified,
        state: lifecycleState({ wired, implemented, verified }),
        verificationCommands,
      };
    });

    return {
      protocolVersion: CORE_PLATFORM_PROTOCOL_VERSION,
      summary: summarizeLifecycle(lifecycle),
      lifecycle,
      interfaces,
    };
  }

  function buildSystemInterfaces(input: Record<string, any> = {}) : any {
    const operationRegistry: any = describeOperationRegistry(input);
    return {
      protocolVersion: CORE_PLATFORM_PROTOCOL_VERSION,
      transport: {
        http: "direct",
        rpc: "POST /api/rpc",
        events: "GET /api/events",
      },
      interfaces: operationRegistry.interfaces,
      operationRegistry: {
        summary: operationRegistry.summary,
        lifecycle: operationRegistry.lifecycle,
      },
      features: input.features || null,
    };
  }

  function listCapabilities() : any {
    return {
      protocolVersion: CORE_PLATFORM_PROTOCOL_VERSION,
      capabilities: [
        {
          id: "operation-dispatch",
          kind: "dispatcher",
          operations: [
            "dispatchRegisteredHttpOperation",
            "dispatchRpcOperation",
            "shouldProxyRegisteredApiRequest",
          ],
        },
        {
          id: "startup-snapshot-port",
          kind: "composition",
          operations: [
            "readSystemInterfaces",
            "readDiscoveryConfig",
            "readAgentSyncConfig",
            "readConsoleState",
            "readStorageSummary",
          ],
        },
        {
          id: "operation-registry-governance",
          kind: "registry",
          operations: [
            "listInterfaceCatalog",
            "describeOperationRegistry",
            "buildSystemInterfaces",
          ],
        },
        {
          id: "runtime-core-ports",
          kind: "composition",
          operations: [
            "getProtocolEventBus",
            "getRuntimeLogger",
            "getFeatureRuntime",
            "getOperationLockManager",
            "getOperationProofSubstrate",
          ],
        },
        {
          id: "operation-proof-substrate-binding",
          kind: "proof-substrate",
          operations: [
            "beginLifecycle",
            "finishLifecycle",
            "recordReceipt",
            "denyLifecycle",
            "verifyReceipt",
            "exportProofBundle",
          ],
        },
      ],
    };
  }

  return Object.freeze({
    protocolVersion: CORE_PLATFORM_PROTOCOL_VERSION,
    getProtocolEventBus: () : any => protocolEventBus,
    getRuntimeLogger: () : any => runtimeLogger,
    getFeatureRuntime: () : any => featureRuntime,
    getOperationLockManager: () : any => operationLockManager,
    getOperationProofSubstrate: () : any => operationProofSubstrate,
    listInterfaceCatalog: (input: Record<string, any> = {}) : any => listInterfaceCatalog(
      effectiveOperationSelection(input).operations,
    ),
    describeOperationRegistry,
    buildSystemInterfaces,
    shouldProxyRegisteredApiRequest(input: Record<string, any> = {}) : any {
      const selection: any = effectiveOperationSelection(input);
      return Boolean(findProxyRegisteredApiRequestThroughDispatcher({
        ...input,
        ...selection,
      }));
    },
    findProxyRegisteredApiRequest(input: Record<string, any> = {}) : any {
      const selection: any = effectiveOperationSelection(input);
      return findProxyRegisteredApiRequestThroughDispatcher({
        ...input,
        ...selection,
      });
    },
    dispatchRegisteredHttpOperation(input: Record<string, any> = {}) : any {
      const selection: any = effectiveOperationSelection(input);
      return dispatchRegisteredHttpOperationThroughDispatcher({
        ...input,
        ...selection,
        lockManager: operationLockManager,
        concurrencyScope: boundOperationConcurrencyScope,
        ...proofSubstrateForDispatch(input),
      });
    },
    dispatchRpcOperation(input: Record<string, any> = {}) : any {
      const selection: any = effectiveOperationSelection(input);
      return dispatchRpcOperationThroughDispatcher({
        ...input,
        ...selection,
        lockManager: operationLockManager,
        concurrencyScope: boundOperationConcurrencyScope,
        ...proofSubstrateForDispatch(input),
      });
    },
    createStartupSnapshotPort({ controllers }: Record<string, any> = {}) : any {
      const selection: any = effectiveOperationSelection();
      return createStartupSnapshotPortThroughDispatcher({
        controllers,
        ...selection,
      });
    },
    listCapabilities,
  });
}
