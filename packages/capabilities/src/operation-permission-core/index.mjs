import {
  OPERATION_PERMISSION_SCOPES,
  OPERATION_PERMISSION_TOOLSETS,
  OPERATION_PERMISSION_PROFILES,
  createToolCatalogRegistry
} from "./catalog.mjs";
import { createOperationPermissionStore, getOperationPermissionDatabasePath } from "./store.mjs";
import { createToolPolicyEngine } from "./policy.mjs";
import { createToolExecutionRuntime } from "./runtime.mjs";
import { createOperationPermissionHttpRouter } from "./http.mjs";
import { getRuntimeLogger } from "@meshrix/foundation/observability/runtime-logger";
import { createSecurityPermissionsProvider } from "@meshrix/foundation/security/security-permissions-provider";

export {
  OPERATION_PERMISSION_SCOPES,
  OPERATION_PERMISSION_TOOLSETS,
  OPERATION_PERMISSION_PROFILES,
  getOperationPermissionDatabasePath
};

export function createOperationPermissionPlatform({
  userDataPath,
  operations,
  operationDispatcher,
  controllers,
  operationAuditStore = null,
  operationConcurrencyScope = undefined,
  protocolEventBus = null,
  consoleAuth = null,
  securityPermissions = null,
  featureRuntime = null,
  changeHandlers = [],
  proofSubstrate = null,
  logger = getRuntimeLogger()
}) {
  const registeredChangeHandlers = new Set(
    (Array.isArray(changeHandlers) ? changeHandlers : [changeHandlers])
      .filter((handler) => typeof handler === "function")
  );

  function notifyOperationPermissionChanged(event = {}) {
    const normalizedEvent = event && typeof event === "object" && !Array.isArray(event) ? event : {};
    const reasonCode = String(normalizedEvent.reasonCode || normalizedEvent.type || "operation_permission_changed");
    const publicEvent = {
      schemaVersion: "v0.0.1:schema:definition-1",
      source: String(normalizedEvent.source || "operation-permission-platform"),
      type: String(normalizedEvent.type || reasonCode),
      reasonCode,
      grantId: String(normalizedEvent.grantId || ""),
      catalogFingerprint: String(normalizedEvent.catalogFingerprint || ""),
      invalidation: normalizedEvent.invalidation || null,
      at: String(normalizedEvent.at || new Date().toISOString())
    };
    const pendingNotifications = [];
    if (typeof protocolEventBus?.publish === "function") {
      const publishResult = protocolEventBus.publish("operation_permission.changed", publicEvent, {
        delivery: "best-effort"
      });
      if (publishResult && (typeof publishResult.then === "function" || typeof publishResult.catch === "function")) {
        pendingNotifications.push(Promise.resolve(publishResult).catch(() => null));
      }
    }
    for (const handler of registeredChangeHandlers) {
      try {
        const handled = handler({
          ...publicEvent
        });
        if (handled && (typeof handled.then === "function" || typeof handled.catch === "function")) {
          pendingNotifications.push(Promise.resolve(handled).catch(() => null));
        }
      } catch {
        // best-effort notification hook
      }
    }
    const result = Object.freeze({
      ok: true,
      reasonCode,
      changeHandlerCount: registeredChangeHandlers.size
    });
    if (pendingNotifications.length > 0) {
      return Promise.allSettled(pendingNotifications).then(() => result);
    }
    return result;
  }

  const effectiveSecurityPermissions =
    securityPermissions ||
    (consoleAuth ? createSecurityPermissionsProvider({ consoleAuth }) : null);
  let baseOperations = [...operations];
  let upstreamOperations = [];
  let upstreamSourceRevision = -1;
  let upstreamSourceDigest = "";
  let catalogRevision = 1;
  const effectiveOperations = [...baseOperations];
  const tagManagementProfiles = effectiveSecurityPermissions?.listToolProfileTags?.() || [];
  const registry = createToolCatalogRegistry({
    operations: effectiveOperations,
    activeFeatureIds: featureRuntime?.activeFeatureIds || null,
    profiles: tagManagementProfiles
  });
  let store = null;
  try {
    store = createOperationPermissionStore({
      userDataPath,
      registry,
      securityPermissions: effectiveSecurityPermissions,
      governancePolicyRevisionProvider: () => effectiveSecurityPermissions?.getGovernancePolicyRevision?.(),
      changeListener: notifyOperationPermissionChanged,
      proofSubstrate
    });
    const authorizationStore = effectiveSecurityPermissions?.authorizationStore || null;
    const policyEngine = createToolPolicyEngine({
      registry,
      store,
      securityPermissions: effectiveSecurityPermissions
    });
    const runtime = createToolExecutionRuntime({
      registry,
      store,
      policyEngine,
      securityPermissions: effectiveSecurityPermissions,
      operations: effectiveOperations,
      operationDispatcher,
      controllers,
      operationAuditStore,
      operationConcurrencyScope,
      protocolEventBus,
      logger
    });
    const router = createOperationPermissionHttpRouter({
      platform: {
        registry,
        store,
        policyEngine,
        runtime,
        authorizationStore,
        securityPermissions: effectiveSecurityPermissions,
        catalog: () => registry.getCatalog()
      },
      securityPermissions: effectiveSecurityPermissions,
      logger
    });
    store.saveCatalogSnapshot(registry.getCatalog());

    function applyOperationLayers({
      nextBaseOperations = baseOperations,
      nextUpstreamOperations = upstreamOperations,
      notify = true,
      reason = "Operation catalog changed; downstream MCP tools list must refresh."
    } = {}) {
      const previousOperations = [...effectiveOperations];
      const previousToolIds = new Set(registry.listTools().map((tool) => tool.id));
      const nextOperations = [...nextBaseOperations, ...nextUpstreamOperations];
      let catalog;
      try {
        catalog = registry.refresh(nextOperations);
        runtime.refreshOperations(nextOperations);
        store.saveCatalogSnapshot(catalog, { notify: false });
      } catch (error) {
        registry.refresh(previousOperations);
        runtime.refreshOperations(previousOperations);
        throw error;
      }
      baseOperations = [...nextBaseOperations];
      upstreamOperations = [...nextUpstreamOperations];
      effectiveOperations.splice(0, effectiveOperations.length, ...nextOperations);
      catalogRevision += 1;
      const nextToolIds = new Set(registry.listTools().map((tool) => tool.id));
      const invalidation = {
        added: [...nextToolIds].filter((toolId) => !previousToolIds.has(toolId)),
        updated: [...nextToolIds].filter((toolId) => previousToolIds.has(toolId) && toolId.startsWith("upstream.")),
        removed: [...previousToolIds].filter((toolId) => !nextToolIds.has(toolId))
      };
      if (notify) {
        notifyOperationPermissionChanged({
          reasonCode: "catalog_snapshot_saved",
          reason,
          catalogFingerprint: catalog.fingerprint || "",
          invalidation
        });
      }
      return Object.freeze({
        ok: true,
        catalogRevision,
        operationCount: effectiveOperations.length,
        catalogFingerprint: catalog.fingerprint || "",
        invalidation: Object.freeze({
          added: Object.freeze(invalidation.added),
          updated: Object.freeze(invalidation.updated),
          removed: Object.freeze(invalidation.removed)
        })
      });
    }

    return {
      registry,
      store,
      policyEngine,
      runtime,
      router,
      securityPermissions: effectiveSecurityPermissions,
      authorizationStore,
      catalog: () => registry.getCatalog(),
      registerPluginGrantOwner(request = {}) {
        return store.registerPluginGrantOwner(request);
      },
      revokeGrantsByPluginOwner(request = {}) {
        return store.revokeGrantsByPluginOwner(request);
      },
      registerChangeHandler(handler) {
        if (typeof handler !== "function") {
          return () => {};
        }
        registeredChangeHandlers.add(handler);
        return () => {
          registeredChangeHandlers.delete(handler);
        };
      },
      notifyUpstreamCatalogChanged(diff = {}) {
        const fingerprint = registry.getCatalog()?.fingerprint || "";
        return notifyOperationPermissionChanged({
          reasonCode: "catalog_snapshot_saved",
          reason: "Upstream service catalog changed; downstream MCP tools list may have changed.",
          catalogFingerprint: fingerprint,
          invalidation: {
            added: Array.isArray(diff.added) ? diff.added : [],
            updated: Array.isArray(diff.updated) ? diff.updated : [],
            removed: Array.isArray(diff.removed) ? diff.removed : []
          }
        });
      },
      replaceUpstreamOperations({ sourceRevision, sourceDigest, operations: nextOperations = [], notify = true } = {}) {
        if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0 || typeof sourceDigest !== "string") {
          throw new TypeError("Upstream operation catalog revision is invalid.");
        }
        if (sourceRevision < upstreamSourceRevision) {
          throw new Error("Upstream operation catalog revision cannot move backward.");
        }
        if (sourceRevision === upstreamSourceRevision) {
          if (sourceDigest !== upstreamSourceDigest) {
            throw new Error("Upstream operation catalog revision conflicts with its accepted digest.");
          }
          return Object.freeze({
            ok: true,
            replayed: true,
            sourceRevision,
            sourceDigest,
            catalogRevision,
            catalogFingerprint: registry.getCatalog()?.fingerprint || "",
            invalidation: Object.freeze({ added: Object.freeze([]), updated: Object.freeze([]), removed: Object.freeze([]) })
          });
        }
        const receipt = applyOperationLayers({
          nextUpstreamOperations: Array.isArray(nextOperations) ? [...nextOperations] : [],
          notify,
          reason: "Published upstream operation catalog changed."
        });
        upstreamSourceRevision = sourceRevision;
        upstreamSourceDigest = sourceDigest;
        return Object.freeze({ ...receipt, replayed: false, sourceRevision, sourceDigest });
      },
      upstreamCatalogState() {
        return Object.freeze({
          sourceRevision: upstreamSourceRevision,
          sourceDigest: upstreamSourceDigest,
          catalogRevision,
          operationCount: upstreamOperations.length,
          catalogFingerprint: registry.getCatalog()?.fingerprint || ""
        });
      },
      captureOperationLayersState() {
        return Object.freeze({
          baseOperations: Object.freeze([...baseOperations]),
          upstreamOperations: Object.freeze([...upstreamOperations]),
          upstreamSourceRevision,
          upstreamSourceDigest,
          catalogRevision
        });
      },
      restoreOperationLayersState(state) {
        if (!state || !Array.isArray(state.baseOperations) || !Array.isArray(state.upstreamOperations)) {
          throw new TypeError("Operation catalog rollback state is invalid.");
        }
        const restored = applyOperationLayers({
          nextBaseOperations: state.baseOperations,
          nextUpstreamOperations: state.upstreamOperations,
          notify: false
        });
        upstreamSourceRevision = Number.isSafeInteger(state.upstreamSourceRevision)
          ? state.upstreamSourceRevision
          : -1;
        upstreamSourceDigest = String(state.upstreamSourceDigest || "");
        catalogRevision = Number.isSafeInteger(state.catalogRevision)
          ? state.catalogRevision
          : restored.catalogRevision;
        return Object.freeze({ ok: true, catalogRevision });
      },
      refreshOperations(nextOperations = []) {
        const normalizedOperations = Array.isArray(nextOperations) ? [...nextOperations] : [];
        return applyOperationLayers({ nextBaseOperations: normalizedOperations });
      },
      close() {
        store.close();
      }
    };
  } catch (error) {
    try {
      store?.close?.();
    } catch {
      // Preserve the platform construction failure after unwinding owned state.
    }
    throw error;
  }
}
