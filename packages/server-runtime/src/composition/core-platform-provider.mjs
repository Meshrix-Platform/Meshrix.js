import {
  listInterfaceCatalog,
  SERVER_API_OPERATIONS,
} from "../../../contracts/src/operations/operation-registry.mjs";
import { PROTOCOL_OPERATION_IDS } from "../../../contracts/src/operations/protocol-operation-definitions.mjs";
import {
  dispatchRegisteredHttpOperation as dispatchRegisteredHttpOperationThroughDispatcher,
  dispatchRpcOperation as dispatchRpcOperationThroughDispatcher,
} from "./dispatch-operation.mjs";
import {
  createStartupSnapshotPort as createStartupSnapshotPortThroughDispatcher,
} from "./dispatch-operation-http.mjs";
import {
  findProxyRegisteredApiRequest as findProxyRegisteredApiRequestThroughDispatcher,
} from "./dispatch-operation-input.mjs";
import { createOperationRouteIndex } from "../routing/operation-route-index.mjs";

export const CORE_PLATFORM_PROTOCOL_VERSION = "v0.0.1:platform:core-1";

const CORE_VERIFICATION_COMMAND = "npm run verify:core-platform-surface-convergence";
const DISPATCH_VERIFICATION_COMMAND = "node tests/run.mjs --suite runtime.operation-dispatch-lock";
const FULL_VERIFICATION_COMMAND = "npm run server:verify";
const PROTOCOL_OPERATION_ID_SET = new Set(PROTOCOL_OPERATION_IDS);

function normalizeOperations(operations) {
  if (operations === undefined) return SERVER_API_OPERATIONS;
  if (!Array.isArray(operations)) {
    throw new TypeError("Core platform operations must be an array.");
  }
  return operations;
}

function hasText(value) {
  return String(value || "").trim().length > 0;
}

function verificationCommandsForOperation(operation = {}) {
  const commands = new Set([CORE_VERIFICATION_COMMAND]);
  const id = String(operation.id || "");
  const feature = String(operation.feature || "");
  const aspects = new Set(operation.aspects || []);

  if (PROTOCOL_OPERATION_ID_SET.has(id)) {
    commands.add("node tools/server-scripts/verify-protocol-operation-registration.mjs");
  }
  if (id.startsWith("system.") || id.startsWith("runtime.") || id.startsWith("events.")) {
    commands.add(DISPATCH_VERIFICATION_COMMAND);
  }
  if (id.startsWith("discovery.")) {
    commands.add("node tools/server-scripts/verify-unified-registration.mjs");
  }
  if (feature === "operation_permission" || aspects.has("operation-permission")) {
    commands.add("node tools/server-scripts/verify-operation-permission-platform.mjs");
  }
  if (feature === "strategy_management" || aspects.has("strategy-management")) {
    commands.add("node tools/server-scripts/verify-strategy-management.mjs");
  }
  if (feature === "agent_workspace" || id.startsWith("workspace.")) {
    commands.add("node tools/server-scripts/verify-agent-workspace.mjs");
  }
  if (feature === "storage" || id.startsWith("storage.")) {
    commands.add("npm run server:verify:ops");
  }
  commands.add(FULL_VERIFICATION_COMMAND);
  return [...commands];
}

function operationIsWired(operation = {}) {
  return Boolean(
    hasText(operation.id) &&
    hasText(operation.target?.controller) &&
    hasText(operation.target?.method) &&
    hasText(operation.http?.method) &&
    hasText(operation.http?.path) &&
    hasText(operation.rpc?.method)
  );
}

function operationIsImplemented(operation = {}, controllers = null) {
  if (!controllers || typeof controllers !== "object") {
    return null;
  }
  const controller = controllers[operation.target?.controller];
  return typeof controller?.[operation.target?.method] === "function";
}

function lifecycleState({ wired, implemented, verified }) {
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

function summarizeLifecycle(entries) {
  const summary = {
    total: entries.length,
    registered: entries.filter((entry) => entry.registered).length,
    wired: entries.filter((entry) => entry.wired).length,
    implemented: entries.filter((entry) => entry.implemented === true).length,
    implementationUnknown: entries.filter((entry) => entry.implemented === null).length,
    verified: entries.filter((entry) => entry.verified).length,
  };
  const missing = {
    registered: entries.filter((entry) => !entry.registered).map((entry) => entry.id),
    wired: entries.filter((entry) => !entry.wired).map((entry) => entry.id),
    implemented: entries
      .filter((entry) => entry.implemented === false)
      .map((entry) => entry.id),
    verified: entries.filter((entry) => !entry.verified).map((entry) => entry.id),
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
} = {}) {
  const configuredSourceOperations = normalizeOperations(operations);
  const configuredRouteIndex = createOperationRouteIndex(configuredSourceOperations, {
    strict: true,
  });
  const configuredOperations = configuredRouteIndex.operations;
  const dynamicRouteIndexes = new WeakMap();
  const boundOperationConcurrencyScope = String(operationConcurrencyScope || "default").trim();

  function effectiveOperationSelection(input = {}) {
    if (
      !Object.hasOwn(input, "operations") ||
      input.operations === undefined ||
      input.operations === configuredSourceOperations ||
      input.operations === configuredOperations
    ) {
      if (typeof getOperations !== "function") {
        return { operations: configuredOperations, routeIndex: configuredRouteIndex };
      }
      const current = normalizeOperations(getOperations());
      let routeIndex = dynamicRouteIndexes.get(current);
      if (!routeIndex) {
        routeIndex = createOperationRouteIndex(current, { strict: true });
        dynamicRouteIndexes.set(current, routeIndex);
      }
      return { operations: routeIndex.operations, routeIndex };
    }
    const current = normalizeOperations(input.operations);
    let routeIndex = dynamicRouteIndexes.get(current);
    if (!routeIndex) {
      routeIndex = createOperationRouteIndex(current, { strict: true });
      dynamicRouteIndexes.set(current, routeIndex);
    }
    return { operations: routeIndex.operations, routeIndex };
  }

  function proofSubstrateForDispatch(input = {}) {
    if (input.skipOperationProof === true || Object.hasOwn(input, "operationProofSubstrate")) {
      return {};
    }
    return operationProofSubstrate ? { operationProofSubstrate } : {};
  }

  function describeOperationRegistry(input = {}) {
    const { operations: selectedOperations } = effectiveOperationSelection(input);
    const controllers = input.controllers || null;
    const interfaces = listInterfaceCatalog(selectedOperations);
    const lifecycle = selectedOperations.map((operation) => {
      const verificationCommands = verificationCommandsForOperation(operation);
      const wired = operationIsWired(operation);
      const implemented = operationIsImplemented(operation, controllers);
      const verified = verificationCommands.length > 0;
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

  function buildSystemInterfaces(input = {}) {
    const operationRegistry = describeOperationRegistry(input);
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

  function listCapabilities() {
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
    getProtocolEventBus: () => protocolEventBus,
    getRuntimeLogger: () => runtimeLogger,
    getFeatureRuntime: () => featureRuntime,
    getOperationLockManager: () => operationLockManager,
    getOperationProofSubstrate: () => operationProofSubstrate,
    listInterfaceCatalog: (input = {}) => listInterfaceCatalog(
      effectiveOperationSelection(input).operations,
    ),
    describeOperationRegistry,
    buildSystemInterfaces,
    shouldProxyRegisteredApiRequest(input = {}) {
      const selection = effectiveOperationSelection(input);
      return Boolean(findProxyRegisteredApiRequestThroughDispatcher({
        ...input,
        ...selection,
      }));
    },
    findProxyRegisteredApiRequest(input = {}) {
      const selection = effectiveOperationSelection(input);
      return findProxyRegisteredApiRequestThroughDispatcher({
        ...input,
        ...selection,
      });
    },
    dispatchRegisteredHttpOperation(input = {}) {
      const selection = effectiveOperationSelection(input);
      return dispatchRegisteredHttpOperationThroughDispatcher({
        ...input,
        ...selection,
        lockManager: operationLockManager,
        concurrencyScope: boundOperationConcurrencyScope,
        ...proofSubstrateForDispatch(input),
      });
    },
    dispatchRpcOperation(input = {}) {
      const selection = effectiveOperationSelection(input);
      return dispatchRpcOperationThroughDispatcher({
        ...input,
        ...selection,
        lockManager: operationLockManager,
        concurrencyScope: boundOperationConcurrencyScope,
        ...proofSubstrateForDispatch(input),
      });
    },
    createStartupSnapshotPort({ controllers } = {}) {
      const selection = effectiveOperationSelection();
      return createStartupSnapshotPortThroughDispatcher({
        controllers,
        ...selection,
      });
    },
    listCapabilities,
  });
}
