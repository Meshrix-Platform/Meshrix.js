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
import { createAuditStoreMethods } from "./store-audit.mjs";
import { createGrantStoreMethods } from "./store-grants.mjs";
import { createMetricsStoreMethods } from "./store-metrics.mjs";
import { createPendingStoreMethods } from "./store-pending.mjs";
import {
  getOperationPermissionDatabasePath
} from "./store-paths.mjs";
import { ensureSchema } from "./store-schema.mjs";
import {
  isEnabled,
  normalizePolicyRevisionSnapshot,
  normalizeStringList,
  nowIso
} from "./store-utils.mjs";

export {
  getOperationPermissionDatabasePath
} from "./store-paths.mjs";

function assertActiveCatalogGrantReferences(registry, input = {}) {
  if (!registry || typeof registry.getCatalog !== "function") return;
  const catalog = registry.getCatalog();
  const activeScopes = new Set((catalog.scopes || []).map((scope) => scope.id));
  const activeToolsets = new Set((catalog.toolsets || []).map((toolset) => toolset.id));
  const activeTools = new Set((catalog.tools || []).map((tool) => tool.id));
  const checks = [
    ["scopes", activeScopes],
    ["toolsets", activeToolsets],
    ["toolAllow", activeTools],
    ["toolDeny", activeTools]
  ];
  for (const [field, activeIds] of checks) {
    if (!Object.hasOwn(input, field)) continue;
    const inactive = normalizeStringList(input[field]).filter((id) => !activeIds.has(id));
    if (inactive.length > 0) {
      const error = new Error(`Operation Permission grant references inactive ${field}.`);
      error.code = "operation_permission_inactive_catalog_reference";
      error.field = field;
      throw error;
    }
  }
}

function closeDistinctResources(resources = []) {
  const failures = [];
  const closed = new Set();
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

export function createOperationPermissionStore({
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
}) {
  const rootPath = path.join(userDataPath, "operation-permission");
  fs.mkdirSync(rootPath, { recursive: true });
  let db = null;
  let securityHelperClient = null;
  let resolvedCapabilityKeyProvider = null;
  let resolvedCapabilityBindingGuard = null;
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
  } catch (error) {
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
}) {
  const pendingChangeNotifications = new Set();
  let securityAlertStore = null;
  let closed = false;

  const ctx = {
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
    getSecurityAlertStore() {
      if (!securityAlertStore) {
        securityAlertStore = createSecurityAlertStore({ userDataPath });
      }
      return securityAlertStore;
    },
    notifyChange(event = {}) {
      if (typeof changeListener !== "function") {
        return null;
      }
      try {
        const result = changeListener({
          schemaVersion: "v0.0.1:schema:definition-1",
          source: "operation-permission-store",
          at: nowIso(),
          ...event
        });
        if (!result || (typeof result.then !== "function" && typeof result.catch !== "function")) {
          return result;
        }
        let tracked;
        tracked = Promise.resolve(result)
          .catch(() => null)
          .finally(() => {
            pendingChangeNotifications.delete(tracked);
          });
        pendingChangeNotifications.add(tracked);
        return tracked;
      } catch {
        return null;
      }
    },
    currentCatalogFingerprint() {
      try {
        return String(registry?.getCatalog?.().fingerprint || "").trim();
      } catch {
        return "";
      }
    },
    async flushChangeNotifications() {
      const pending = [...pendingChangeNotifications];
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
    currentGovernancePolicyRevision() {
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

  const createGrant = async (input = {}) => {
    assertActiveCatalogGrantReferences(registry, input);
    return ctx.createGrant(input);
  };
  const updateGrant = async (grantId, patch = {}) => {
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
    appendGrantEvent: ctx.appendGrantEvent,
    listGrantEvents: ctx.listGrantEvents,
    appendPolicyDecision: ctx.appendPolicyDecision,
    appendPolicyDecisionAnchored: ctx.appendPolicyDecisionAnchored,
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
    createMcpAuthorizationRequest: ctx.createMcpAuthorizationRequest,
    getMcpAuthorizationRequest: ctx.getMcpAuthorizationRequest,
    listMcpAuthorizationRequests: ctx.listMcpAuthorizationRequests,
    resolveMcpAuthorizationRequest: ctx.resolveMcpAuthorizationRequest,
    claimMcpAuthorizationRequest: ctx.claimMcpAuthorizationRequest,
    completeMcpAuthorizationRequest: ctx.completeMcpAuthorizationRequest,
    capabilityKeyProvider: resolvedCapabilityKeyProvider,
    capabilityBindingGuard: resolvedCapabilityBindingGuard,
    isClosed() {
      return closed || db.open === false;
    },
    close() {
      if (closed || db.open === false) return;
      try {
        db.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        // Closing must remain best-effort; verification cleanup should not depend on WAL support.
      }
      const failures = closeDistinctResources([
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
