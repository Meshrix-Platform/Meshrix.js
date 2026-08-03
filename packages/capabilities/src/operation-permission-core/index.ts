import {
  OPERATION_PERMISSION_SCOPES,
  OPERATION_PERMISSION_TOOLSETS,
  OPERATION_PERMISSION_PROFILES,
  createToolCatalogRegistry
} from "./catalog.ts";
import { createOperationPermissionStore, getOperationPermissionDatabasePath } from "./store.ts";
import { createToolPolicyEngine } from "./policy.ts";
import { createToolExecutionRuntime } from "./runtime.ts";
import { createOperationPermissionHttpRouter } from "./http.ts";
import { getRuntimeLogger } from "@meshrix/foundation/observability/runtime-logger";
import { createSecurityPermissionsProvider } from "@meshrix/foundation/security/security-permissions-provider";
import { createApiKeyVerifierKeyProvider } from "@meshrix/foundation/security/authorization/api-key-verifier-key-provider";
import {
  createApiKeyDistributionProvider,
  registerApiKeyOwnerRecoveryAssignmentSync
} from "./api-key-distribution.ts";

export * from "./api-key-distribution.ts";

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
  apiKeyVerifierKeyProvider = null,
  apiKeyClock = undefined,
  apiKeyRandomBytes = undefined,
  logger = getRuntimeLogger()
}: Record<string, any>) : any {
  const registeredChangeHandlers: any = new Set<any>(
    (Array.isArray(changeHandlers) ? changeHandlers : [changeHandlers])
      .filter((handler?: any) : any => typeof handler === "function")
  );

  function notifyOperationPermissionChanged(event: Record<string, any> = {}) : any {
    const normalizedEvent: any = event && typeof event === "object" && !Array.isArray(event) ? event : {};
    const reasonCode: any = String(normalizedEvent.reasonCode || normalizedEvent.type || "operation_permission_changed");
    const publicEvent: Record<string, any> = {
      schemaVersion: "v0.0.1:schema:definition-1",
      source: String(normalizedEvent.source || "operation-permission-platform"),
      type: String(normalizedEvent.type || reasonCode),
      reasonCode,
      grantId: String(normalizedEvent.grantId || ""),
      catalogFingerprint: String(normalizedEvent.catalogFingerprint || ""),
      invalidation: normalizedEvent.invalidation || null,
      at: String(normalizedEvent.at || new Date().toISOString())
    };
    const pendingNotifications: any[] = [];
    if (typeof protocolEventBus?.publish === "function") {
      const publishResult: any = protocolEventBus.publish("operation_permission.changed", publicEvent, {
        delivery: "best-effort"
      });
      if (publishResult && (typeof publishResult.then === "function" || typeof publishResult.catch === "function")) {
        pendingNotifications.push(Promise.resolve(publishResult).catch(() : any => null));
      }
    }
    for (const handler of registeredChangeHandlers) {
      try {
        const handled: any = handler({
          ...publicEvent
        });
        if (handled && (typeof handled.then === "function" || typeof handled.catch === "function")) {
          pendingNotifications.push(Promise.resolve(handled).catch(() : any => null));
        }
      } catch {
        // best-effort notification hook
      }
    }
    const result: Readonly<Record<string, any>> = Object.freeze({
      ok: true,
      reasonCode,
      changeHandlerCount: registeredChangeHandlers.size
    });
    if (pendingNotifications.length > 0) {
      return Promise.allSettled(pendingNotifications).then(() : any => result);
    }
    return result;
  }

  const effectiveSecurityPermissions: any =
    securityPermissions ||
    (consoleAuth ? createSecurityPermissionsProvider({ consoleAuth }) : null);
  let baseOperations: any[] = [...operations];
  let upstreamOperations: any[] = [];
  let upstreamSourceRevision: any = -1;
  let upstreamSourceDigest: any = "";
  let catalogRevision: any = 1;
  const effectiveOperations: any[] = [...baseOperations];
  const tagManagementProfiles: any = effectiveSecurityPermissions?.listToolProfileTags?.() || [];
  const registry: any = createToolCatalogRegistry({
    operations: effectiveOperations,
    activeFeatureIds: featureRuntime?.activeFeatureIds || null,
    profiles: tagManagementProfiles
  });
  let store: any = null;
  let unregisterApiKeyOwnerRecoveryAssignmentSync: any = null;
  try {
    store = createOperationPermissionStore({
      userDataPath,
      registry,
      securityPermissions: effectiveSecurityPermissions,
      governancePolicyRevisionProvider: () : any => effectiveSecurityPermissions?.getGovernancePolicyRevision?.(),
      changeListener: notifyOperationPermissionChanged,
      proofSubstrate
    });
    const authorizationStore: any = effectiveSecurityPermissions?.authorizationStore || null;
    unregisterApiKeyOwnerRecoveryAssignmentSync = registerApiKeyOwnerRecoveryAssignmentSync({
      securityPermissions: effectiveSecurityPermissions
    });
    const policyEngine: any = createToolPolicyEngine({
      registry,
      store,
      securityPermissions: effectiveSecurityPermissions
    });
    const apiKeyDistributionProvider: any = createApiKeyDistributionProvider({
      store,
      registry,
      securityPermissions: effectiveSecurityPermissions,
      verifierKeyProvider: apiKeyVerifierKeyProvider || createApiKeyVerifierKeyProvider({ userDataPath }),
      ...(apiKeyClock ? { now: apiKeyClock } : {}),
      ...(apiKeyRandomBytes ? { randomBytes: apiKeyRandomBytes } : {})
    });
    const runtime: any = createToolExecutionRuntime({
      registry,
      store,
      policyEngine,
      securityPermissions: effectiveSecurityPermissions,
      operations: effectiveOperations,
      operationDispatcher,
      operationProofSubstrate: proofSubstrate,
      controllers,
      operationAuditStore,
      operationConcurrencyScope,
      apiKeyDistributionProvider,
      protocolEventBus,
      logger
    });
    const router: any = createOperationPermissionHttpRouter({
      platform: {
        registry,
        store,
        policyEngine,
        runtime,
        apiKeyDistributionProvider,
        authorizationStore,
        securityPermissions: effectiveSecurityPermissions,
        catalog: () : any => registry.getCatalog()
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
    }: Record<string, any> = {}) : any {
      const previousOperations: any[] = [...effectiveOperations];
      const previousToolIds: any = new Set<any>(registry.listTools().map((tool?: any) : any => tool.id));
      const nextOperations: any[] = [...nextBaseOperations, ...nextUpstreamOperations];
      let catalog: any;
      try {
        catalog = registry.refresh(nextOperations);
        runtime.refreshOperations(nextOperations);
        store.saveCatalogSnapshot(catalog, { notify: false });
      } catch (error: any) {
        registry.refresh(previousOperations);
        runtime.refreshOperations(previousOperations);
        throw error;
      }
      baseOperations = [...nextBaseOperations];
      upstreamOperations = [...nextUpstreamOperations];
      effectiveOperations.splice(0, effectiveOperations.length, ...nextOperations);
      catalogRevision += 1;
      const nextToolIds: any = new Set<any>(registry.listTools().map((tool?: any) : any => tool.id));
      const invalidation: Record<string, any> = {
        added: [...nextToolIds].filter((toolId?: any) : any => !previousToolIds.has(toolId)),
        updated: [...nextToolIds].filter((toolId?: any) : any => previousToolIds.has(toolId) && toolId.startsWith("upstream.")),
        removed: [...previousToolIds].filter((toolId?: any) : any => !nextToolIds.has(toolId))
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
      apiKeyDistributionProvider,
      router,
      securityPermissions: effectiveSecurityPermissions,
      authorizationStore,
      catalog: () : any => registry.getCatalog(),
      registerPluginGrantOwner(request: Record<string, any> = {}) : any {
        return store.registerPluginGrantOwner(request);
      },
      revokeGrantsByPluginOwner(request: Record<string, any> = {}) : any {
        return store.revokeGrantsByPluginOwner(request);
      },
      registerChangeHandler(handler?: any) : any {
        if (typeof handler !== "function") {
          return () : any => {};
        }
        registeredChangeHandlers.add(handler);
        return () : any => {
          registeredChangeHandlers.delete(handler);
        };
      },
      notifyUpstreamCatalogChanged(diff: Record<string, any> = {}) : any {
        const fingerprint: any = registry.getCatalog()?.fingerprint || "";
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
      replaceUpstreamOperations({ sourceRevision, sourceDigest, operations: nextOperations = [], notify = true }: Record<string, any> = {}) : any {
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
        const receipt: any = applyOperationLayers({
          nextUpstreamOperations: Array.isArray(nextOperations) ? [...nextOperations] : [],
          notify,
          reason: "Published upstream operation catalog changed."
        });
        upstreamSourceRevision = sourceRevision;
        upstreamSourceDigest = sourceDigest;
        return Object.freeze({ ...receipt, replayed: false, sourceRevision, sourceDigest });
      },
      upstreamCatalogState() : any {
        return Object.freeze({
          sourceRevision: upstreamSourceRevision,
          sourceDigest: upstreamSourceDigest,
          catalogRevision,
          operationCount: upstreamOperations.length,
          catalogFingerprint: registry.getCatalog()?.fingerprint || ""
        });
      },
      captureOperationLayersState() : any {
        return Object.freeze({
          baseOperations: Object.freeze([...baseOperations]),
          upstreamOperations: Object.freeze([...upstreamOperations]),
          upstreamSourceRevision,
          upstreamSourceDigest,
          catalogRevision
        });
      },
      restoreOperationLayersState(state?: any) : any {
        if (!state || !Array.isArray(state.baseOperations) || !Array.isArray(state.upstreamOperations)) {
          throw new TypeError("Operation catalog rollback state is invalid.");
        }
        const restored: any = applyOperationLayers({
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
      refreshOperations(nextOperations: any = []) : any {
        const normalizedOperations: any = Array.isArray(nextOperations) ? [...nextOperations] : [];
        return applyOperationLayers({ nextBaseOperations: normalizedOperations });
      },
      close() : any {
        unregisterApiKeyOwnerRecoveryAssignmentSync?.();
        unregisterApiKeyOwnerRecoveryAssignmentSync = null;
        store.close();
      }
    };
  } catch (error: any) {
    try {
      unregisterApiKeyOwnerRecoveryAssignmentSync?.();
    } catch {
      // Preserve the platform construction failure after unwinding the change subscription.
    }
    try {
      store?.close?.();
    } catch {
      // Preserve the platform construction failure after unwinding owned state.
    }
    throw error;
  }
}
