import fs from "node:fs";
import path from "node:path";
import { openSqliteDatabase } from "@meshrix/foundation/storage/sqlite-database";
import {
  createCommandCapabilitySecurityClient
} from "@meshrix/foundation/security/authorization/capability-security-helper-client";
import {
  createOpaqueCapabilityKeyProvider
} from "@meshrix/foundation/security/authorization/opaque-capability-key";
import {
  createCapabilityBindingGuard
} from "@meshrix/foundation/security/authorization/capability-binding-guard";
import { createSecurityAlertStore } from "@meshrix/foundation/security/security-alerts";
import { createAuditStoreMethods } from "./store-audit.ts";
import { createGrantStoreMethods } from "./store-grants.ts";
import { createMetricsStoreMethods } from "./store-metrics.ts";
import { createPendingStoreMethods } from "./store-pending.ts";
import {
  getOperationPermissionDatabasePath
} from "./store-paths.ts";
import { ensureSchema } from "./store-schema.ts";
import {
  isEnabled,
  normalizePolicyRevisionSnapshot,
  normalizeStringList,
  nowIso
} from "./store-utils.ts";

export {
  getOperationPermissionDatabasePath
} from "./store-paths.ts";

function assertActiveCatalogGrantReferences(registry?: any, input: Record<string, any> = {}) : any {
  if (!registry || typeof registry.getCatalog !== "function") return;
  const catalog: any = registry.getCatalog();
  const activeScopes: any = new Set<any>((catalog.scopes || []).map((scope?: any) : any => scope.id));
  const activeToolsets: any = new Set<any>((catalog.toolsets || []).map((toolset?: any) : any => toolset.id));
  const activeTools: any = new Set<any>((catalog.tools || []).map((tool?: any) : any => tool.id));
  const checks: any[] = [
    ["scopes", activeScopes],
    ["toolsets", activeToolsets],
    ["toolAllow", activeTools],
    ["toolDeny", activeTools]
  ];
  for (const [field, activeIds] of checks) {
    if (!Object.hasOwn(input, field)) continue;
    const inactive: any = normalizeStringList(input[field]).filter((id?: any) : any => !activeIds.has(id));
    if (inactive.length > 0) {
      const error: Error & Record<string, any> = new Error(`Operation Permission grant references inactive ${field}.`);
      error.code = "operation_permission_inactive_catalog_reference";
      error.field = field;
      throw error;
    }
  }
}

function closeDistinctResources(resources: any = []) : any {
  const failures: any[] = [];
  const closed: any = new Set<any>();
  for (const resource of resources) {
    if (!resource || closed.has(resource) || typeof resource.close !== "function") continue;
    closed.add(resource);
    try {
      resource.close();
    } catch {
      failures.push(true);
    }
  }
  return failures;
}

export function createOperationPermissionWorkerOwner({
  userDataPath,
  registry = null,
  capabilityResolver = null,
  capabilityKeyProvider = null,
  capabilityBindingGuard = null,
  governancePolicyRevisionProvider = null,
  securityPermissions = null,
  changeListener = null,
  proofSubstrate = null,
  metricRetention = null
}: Record<string, any>) : any {
  const rootPath: any = path.join(userDataPath, "operation-permission");
  fs.mkdirSync(rootPath, { recursive: true });
  let db: any = null;
  let securityHelperClient: any = null;
  let resolvedCapabilityKeyProvider: any = null;
  let resolvedCapabilityBindingGuard: any = null;
  try {
    db = openSqliteDatabase(getOperationPermissionDatabasePath(userDataPath));
    ensureSchema(db);
    securityHelperClient = (!capabilityKeyProvider && !capabilityBindingGuard && isEnabled(
      process.env.MESHRIX_TOOL_GRANT_CAPABILITY_SECURITY_HELPER ||
        process.env.MESHRIX_CAPABILITY_SECURITY_HELPER
    ))
      ? createCommandCapabilitySecurityClient({
          dataDir: userDataPath,
          backend: process.env.MESHRIX_TOOL_GRANT_CAPABILITY_KEY_PROVIDER ||
            process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_PROVIDER ||
            "auto",
          alias: process.env.MESHRIX_TOOL_GRANT_CAPABILITY_KEY_ALIAS || "meshrix-tool-grants",
          bindingBackend: process.env.MESHRIX_TOOL_GRANT_BINDING_GUARD_PROVIDER ||
            process.env.MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER ||
            "auto",
          bindingAlias: process.env.MESHRIX_TOOL_GRANT_BINDING_GUARD_ALIAS || "meshrix-tool-bindings"
        })
      : null;
    resolvedCapabilityKeyProvider =
      capabilityKeyProvider ||
      securityHelperClient ||
      createOpaqueCapabilityKeyProvider({
        dataDir: userDataPath,
        backend: process.env.MESHRIX_TOOL_GRANT_CAPABILITY_KEY_PROVIDER ||
          process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_PROVIDER ||
          "auto",
        alias: process.env.MESHRIX_TOOL_GRANT_CAPABILITY_KEY_ALIAS || "meshrix-tool-grants"
      });
    resolvedCapabilityBindingGuard = capabilityBindingGuard === false
      ? null
      : capabilityBindingGuard ||
        securityHelperClient ||
        createCapabilityBindingGuard({
          dataDir: userDataPath,
          backend: process.env.MESHRIX_TOOL_GRANT_BINDING_GUARD_PROVIDER ||
            process.env.MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER ||
            "auto",
          alias: process.env.MESHRIX_TOOL_GRANT_BINDING_GUARD_ALIAS || "meshrix-tool-bindings"
        });
    return createOperationPermissionStoreFromResources({
      db,
      rootPath,
      userDataPath,
      registry,
      capabilityResolver,
      resolvedCapabilityKeyProvider,
      resolvedCapabilityBindingGuard,
      governancePolicyRevisionProvider,
      securityPermissions,
      changeListener,
      proofSubstrate,
      metricRetention
    });
  } catch (error: any) {
    closeDistinctResources([
      resolvedCapabilityBindingGuard,
      resolvedCapabilityKeyProvider,
      securityHelperClient,
      db
    ]);
    throw error;
  }
}

function createOperationPermissionStoreFromResources({
  db,
  rootPath,
  userDataPath,
  registry,
  capabilityResolver,
  resolvedCapabilityKeyProvider,
  resolvedCapabilityBindingGuard,
  governancePolicyRevisionProvider,
  securityPermissions,
  changeListener,
  proofSubstrate = null,
  metricRetention = null
}: Record<string, any>) : any {
  const pendingChangeNotifications: any = new Set<any>();
  let securityAlertStore: any = null;
  let closed: any = false;

  const ctx: Record<string, any> = {
    db,
    rootPath,
    userDataPath,
    registry,
    capabilityResolver,
    resolvedCapabilityKeyProvider,
    resolvedCapabilityBindingGuard,
    governancePolicyRevisionProvider,
    securityPermissions,
    proofSubstrate,
    metricRetention,
    getSecurityAlertStore() : any {
      if (!securityAlertStore) {
        securityAlertStore = createSecurityAlertStore({ userDataPath });
      }
      return securityAlertStore;
    },
    notifyChange(event: Record<string, any> = {}) : any {
      if (typeof changeListener !== "function") {
        return null;
      }
      try {
        const result: any = changeListener({
          schemaVersion: "v0.0.1:schema:definition-1",
          source: "operation-permission-store",
          at: nowIso(),
          ...event
        });
        if (!result || (typeof result.then !== "function" && typeof result.catch !== "function")) {
          return result;
        }
        let tracked: any;
        tracked = Promise.resolve(result)
          .catch(() : any => null)
          .finally(() : any => {
            pendingChangeNotifications.delete(tracked);
          });
        pendingChangeNotifications.add(tracked);
        return tracked;
      } catch {
        return null;
      }
    },
    currentCatalogFingerprint() : any {
      try {
        return String(registry?.getCatalog?.().fingerprint || "").trim();
      } catch {
        return "";
      }
    },
    async flushChangeNotifications() : Promise<any> {
      const pending: any[] = [...pendingChangeNotifications];
      if (pending.length === 0) {
        return {
          ok: true,
          flushed: 0
        };
      }
      await Promise.allSettled(pending);
      return {
        ok: true,
        flushed: pending.length
      };
    },
    currentGovernancePolicyRevision() : any {
      if (typeof governancePolicyRevisionProvider !== "function") {
        return normalizePolicyRevisionSnapshot();
      }
      return normalizePolicyRevisionSnapshot(governancePolicyRevisionProvider());
    }
  };

  Object.assign(ctx, createAuditStoreMethods(ctx));
  Object.assign(ctx, createGrantStoreMethods(ctx));
  Object.assign(ctx, createPendingStoreMethods(ctx));
  Object.assign(ctx, createMetricsStoreMethods(ctx));

  const createGrant: any = async (input: Record<string, any> = {}) : Promise<any> => {
    assertActiveCatalogGrantReferences(registry, input);
    return ctx.createGrant(input);
  };
  const updateGrant: any = async (grantId?: any, patch: Record<string, any> = {}) : Promise<any> => {
    assertActiveCatalogGrantReferences(registry, patch);
    return ctx.updateGrant(grantId, patch);
  };

  return {
    db,
    rootPath,
    listGrants: ctx.listGrants,
    getGrant: ctx.getGrant,
    getRawGrant: ctx.getRawGrant,
    createGrant,
    updateGrant,
    deleteGrant: ctx.deleteGrant,
    revokeGrant: ctx.revokeGrant,
    registerPluginGrantOwner: ctx.registerPluginGrantOwner,
    revokeGrantsByPluginOwner: ctx.revokeGrantsByPluginOwner,
    rotateGrantToken: ctx.rotateGrantToken,
    authorizeRequest: ctx.authorizeRequest,
    authorizeGrantForExecution: ctx.authorizeGrantForExecution,
    appendGrantEvent: ctx.appendGrantEvent,
    listGrantEvents: ctx.listGrantEvents,
    appendPolicyDecision: ctx.appendPolicyDecision,
    appendPolicyDecisionAnchored: ctx.appendPolicyDecisionAnchored,
    listPolicyDecisions: ctx.listPolicyDecisions,
    appendExecution: ctx.appendExecution,
    appendExecutionAnchored: ctx.appendExecutionAnchored,
    anchorPermissionAuditFact: ctx.anchorPermissionAuditFact,
    provePermissionAuditInclusion: ctx.provePermissionAuditInclusion,
    appendMetric: ctx.appendMetric,
    appendHttpRequestMetric: ctx.appendHttpRequestMetric,
    saveCatalogSnapshot: ctx.saveCatalogSnapshot,
    flushChangeNotifications: ctx.flushChangeNotifications,
    listAudit: ctx.listAudit,
    getAudit: ctx.getAudit,
    metricsSummary: ctx.metricsSummary,
    metricsExport: ctx.metricsExport,
    metricsHealth: ctx.metricsHealth,
    metricsPrometheus: ctx.metricsPrometheus,
    metricsStorageSummary: ctx.metricsStorageSummary,
    pruneMetrics: ctx.pruneMetrics,
    createPendingOperation: ctx.createPendingOperation,
    getPendingOperation: ctx.getPendingOperation,
    listPendingOperations: ctx.listPendingOperations,
    resolvePendingOperation: ctx.resolvePendingOperation,
    capabilityKeyProvider: resolvedCapabilityKeyProvider,
    capabilityBindingGuard: resolvedCapabilityBindingGuard,
    isClosed() : any {
      return closed || db.open === false;
    },
    close() : any {
      if (closed || db.open === false) return;
      try {
        db.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        // Closing must remain best-effort; verification cleanup should not depend on WAL support.
      }
      const failures: any = closeDistinctResources([
        securityAlertStore,
        resolvedCapabilityBindingGuard,
        resolvedCapabilityKeyProvider,
        db
      ]);
      if (failures.length > 0) {
        throw new Error("Operation Permission store did not close cleanly.");
      }
      closed = true;
    }
  };
}
