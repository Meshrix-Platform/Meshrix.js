import fs from "node:fs";
import path from "node:path";
import { createSqliteExecutionLane } from "@meshrix/foundation/storage/sqlite-execution-lane";
import {
  createCapabilityBindingGuard
} from "@meshrix/foundation/security/authorization/capability-binding-guard";
import {
  createCommandCapabilitySecurityClient
} from "@meshrix/foundation/security/authorization/capability-security-helper-client";
import {
  createOpaqueCapabilityKeyProvider
} from "@meshrix/foundation/security/authorization/opaque-capability-key";
import { acquireStorageRuntimeLease } from "@meshrix/foundation/storage/storage-lifecycle-lock";
import { getOperationPermissionDatabasePath } from "./store-common.ts";
import { normalizePolicyRevisionSnapshot } from "./store-utils.ts";

const OPERATION_PERMISSION_OWNER_REGISTRY = Symbol.for("meshrix.operation-permission.sqlite-owner-registry");
const processRegistry: any = globalThis as any;
const activeStoreOwners: Map<string, any> = processRegistry[OPERATION_PERMISSION_OWNER_REGISTRY] instanceof Map
  ? processRegistry[OPERATION_PERMISSION_OWNER_REGISTRY]
  : new Map<string, any>();
processRegistry[OPERATION_PERMISSION_OWNER_REGISTRY] = activeStoreOwners;

function canonicalOperationPermissionDatabasePath(userDataPath: string): string {
  const databasePath = getOperationPermissionDatabasePath(userDataPath);
  const databaseDirectory = path.dirname(databasePath);
  fs.mkdirSync(databaseDirectory, { recursive: true });
  const canonicalPath = path.join(fs.realpathSync(databaseDirectory), path.basename(databasePath));
  return fs.existsSync(canonicalPath) ? fs.realpathSync(canonicalPath) : canonicalPath;
}

function releaseStoreOwner(owner: any): void {
  if (activeStoreOwners.get(owner.databasePath) !== owner) return;
  activeStoreOwners.delete(owner.databasePath);
  owner.runtimeLease.release();
  owner.state = "released";
}

export { getOperationPermissionDatabasePath };

export const OPERATION_PERMISSION_STORE_COMMANDS: readonly string[] = Object.freeze([
  "listGrants", "getGrant", "getRawGrant", "createGrant", "updateGrant", "deleteGrant",
  "revokeGrant", "registerPluginGrantOwner", "revokeGrantsByPluginOwner", "rotateGrantToken",
  "authorizeRequest", "authorizeGrantForExecution", "appendGrantEvent", "listGrantEvents",
  "appendPolicyDecision", "appendPolicyDecisionAnchored", "listPolicyDecisions", "appendExecution",
  "appendExecutionAnchored", "anchorPermissionAuditFact", "provePermissionAuditInclusion",
  "appendMetric", "appendHttpRequestMetric", "saveCatalogSnapshot", "flushChangeNotifications",
  "listAudit", "getAudit", "metricsSummary", "metricsExport", "metricsHealth",
  "metricsPrometheus", "metricsStorageSummary", "pruneMetrics", "createPendingOperation",
  "getPendingOperation", "listPendingOperations", "resolvePendingOperation", "diagnostic", "close"
]);

export const OPERATION_PERMISSION_API_KEY_COMMANDS: readonly string[] = Object.freeze([
  "getIssuerScopes", "list", "listAudienceGrants", "create", "rotate", "revoke", "authenticateRuntime",
  "revalidateAuthorization", "authorizeOperation", "reserveEffect", "revalidateEffect",
  "releaseEffect", "explainLookupPlan"
]);

function requestProjection(request: any = null) : any {
  if (!request || typeof request !== "object") return null;
  const headers: Record<string, any> = {};
  for (const [key, value] of Object.entries(request.headers || {})) {
    if (typeof value === "string" || Array.isArray(value)) headers[String(key).toLowerCase()] = value;
  }
  return {
    headers,
    url: String(request.url || ""),
    method: String(request.method || ""),
    socket: { remoteAddress: String(request.socket?.remoteAddress || "") },
    __meshrixRequestId: String(request.__meshrixRequestId || ""),
    __meshrixTraceContext: request.__meshrixTraceContext && typeof request.__meshrixTraceContext === "object"
      ? structuredClone(request.__meshrixTraceContext)
      : null,
    __meshrixProcessIdentity: request.__meshrixProcessIdentity && typeof request.__meshrixProcessIdentity === "object"
      ? structuredClone(request.__meshrixProcessIdentity)
      : null
  };
}

function normalizeArguments(kind?: any, args: any[] = []) : any[] {
  if (!["authorizeRequest", "authorizeGrantForExecution"].includes(String(kind || ""))) return args;
  const input: any = args[0] && typeof args[0] === "object" ? args[0] : {};
  return [{
    ...input,
    request: requestProjection(input.request),
    requestBody: Buffer.isBuffer(input.requestBody) ? input.requestBody : Buffer.from(input.requestBody || ""),
    url: input.url instanceof URL ? input.url.toString() : String(input.url || "")
  }, ...args.slice(1)];
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
  apiKeyVerifierKeyProvider = null,
  apiKeyClock = null,
  apiKeyRandomBytes = null,
  metricRetention = null,
  maxPending = 1024,
  maxPendingBytes = 16 * 1024 * 1024,
  defaultDeadlineMs = 30_000
}: Record<string, any>) : any {
  const databasePath = canonicalOperationPermissionDatabasePath(userDataPath);
  if (activeStoreOwners.has(databasePath)) {
    throw Object.assign(new Error("Operation Permission SQLite owner is already active for this database."), {
      code: "operation_permission_owner_active"
    });
  }
  const owner: any = {
    databasePath,
    runtimeLease: acquireStorageRuntimeLease(userDataPath),
    lane: null,
    state: "starting"
  };
  activeStoreOwners.set(databasePath, owner);
  let apiKeyExecutionOwnerClose: (() => Promise<void>) | null = null;
  let storeClosing = false;
  let closePromise: Promise<void> | null = null;
  let resourcesClosed = false;
  let securityHelperClient: any = null;
  let resolvedCapabilityKeyProvider: any = null;
  let resolvedCapabilityBindingGuard: any = null;
  const closeResources = async (): Promise<void> => {
    if (resourcesClosed) return;
    const resources: any[] = [...new Set<any>([resolvedCapabilityBindingGuard, resolvedCapabilityKeyProvider, securityHelperClient])];
    await Promise.allSettled(resources.filter(Boolean).map((resource?: any) : any => Promise.resolve(resource.close?.())));
    resourcesClosed = true;
  };
  try {
    securityHelperClient = (!capabilityKeyProvider && !capabilityBindingGuard && /^(1|true|yes|on|command|helper)$/i.test(String(
      process.env.MESHRIX_TOOL_GRANT_CAPABILITY_SECURITY_HELPER || process.env.MESHRIX_CAPABILITY_SECURITY_HELPER || ""
    ))) ? createCommandCapabilitySecurityClient({
      dataDir: userDataPath,
      backend: process.env.MESHRIX_TOOL_GRANT_CAPABILITY_KEY_PROVIDER ||
        process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_PROVIDER ||
        "auto",
      alias: process.env.MESHRIX_TOOL_GRANT_CAPABILITY_KEY_ALIAS || "meshrix-tool-grants",
      bindingBackend: process.env.MESHRIX_TOOL_GRANT_BINDING_GUARD_PROVIDER ||
        process.env.MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER ||
        "auto",
      bindingAlias: process.env.MESHRIX_TOOL_GRANT_BINDING_GUARD_ALIAS || "meshrix-tool-bindings"
    }) : null;
    resolvedCapabilityKeyProvider = capabilityKeyProvider || securityHelperClient || createOpaqueCapabilityKeyProvider({
      dataDir: userDataPath,
      backend: process.env.MESHRIX_TOOL_GRANT_CAPABILITY_KEY_PROVIDER ||
        process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_PROVIDER ||
        "auto",
      alias: process.env.MESHRIX_TOOL_GRANT_CAPABILITY_KEY_ALIAS || "meshrix-tool-grants"
    });
    resolvedCapabilityBindingGuard = capabilityBindingGuard === false
      ? null
      : capabilityBindingGuard || securityHelperClient || createCapabilityBindingGuard({
        dataDir: userDataPath,
        backend: process.env.MESHRIX_TOOL_GRANT_BINDING_GUARD_PROVIDER ||
          process.env.MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER ||
          "auto",
        alias: process.env.MESHRIX_TOOL_GRANT_BINDING_GUARD_ALIAS || "meshrix-tool-bindings"
      });
  } catch (error: any) {
    void closeResources();
    releaseStoreOwner(owner);
    throw error;
  }

  const catalogSnapshot: any = () : any => registry?.getCatalog?.() || null;
  const hostHandlers: Record<string, any> = {
    "catalog.get": () : any => catalogSnapshot(),
    "catalog.listTools": () : any => registry?.listTools?.() || catalogSnapshot()?.tools || [],
    "catalog.resolveToolset": (input?: any) : any => registry?.resolveToolset?.(input || {}) || { toolsets: [], tools: [], requiredScopes: [] },
    "capability.resolve": (input?: any) : any => typeof capabilityResolver === "function" ? capabilityResolver(input?.grant || {}) : [],
    "capability.issue": (input?: any) : any => resolvedCapabilityKeyProvider?.issue?.(input || {}),
    "capability.verify": (input?: any) : any => resolvedCapabilityKeyProvider?.verify?.(input || {}),
    "capability.invalidate": (input?: any) : any => resolvedCapabilityKeyProvider?.invalidateCredential?.(input || {}),
    "binding.bind": (input?: any) : any => resolvedCapabilityBindingGuard?.bindCapabilityKey?.(input || {}),
    "binding.verify": (input?: any) : any => resolvedCapabilityBindingGuard?.verifyCapabilityKeyBinding?.(input || {}),
    "binding.invalidate": (input?: any) : any => resolvedCapabilityBindingGuard?.invalidateCapabilityKeyBinding?.(input || {}),
    "governance.revision": () : any => normalizePolicyRevisionSnapshot(governancePolicyRevisionProvider?.()),
    "governance.organization": () : any => securityPermissions?.getOrganizationGovernance?.() || null,
    "governance.summary": () : any => securityPermissions?.getGovernanceSummary?.() || null,
    "processIdentity.verify": (input?: any) : any => securityPermissions?.verifyProcessIdentity?.(input || {}),
    "proof.record": (input?: any) : any => proofSubstrate?.recordWorkspaceOperation?.(input || {}),
    "proof.prove": (input?: any) : any => proofSubstrate?.proveWorkspaceMembership?.(input || {}),
    "proof.project": (input?: any) : any => proofSubstrate?.getWorkspaceProjection?.(String(input?.workspaceId || "")),
    "apiKey.verifierKey": (input?: any) : any => apiKeyVerifierKeyProvider?.getKey?.(String(input?.generation || "")),
    "change.notify": (input?: any) : any => {
      if (typeof changeListener !== "function") {
        return null;
      }
      const payload: any = input || {};
      const runWhenLaneIdle: any = () : any => {
        const stats: any = lane?.getStats?.() || {};
        if (stats.closed === true) {
          return;
        }
        if (Number(stats.pending || 0) > 0) {
          setImmediate(runWhenLaneIdle);
          return;
        }
        Promise.resolve(changeListener(payload)).catch(() : any => null);
      };
      setImmediate(runWhenLaneIdle);
      return { ok: true, deferred: true };
    }
  };
  let lane: any;
  try {
    lane = createSqliteExecutionLane({
      owner: "authorization-operation-permission",
      workerUrl: new URL(
        `./store-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
        import.meta.url
      ),
      workerData: {
        userDataPath,
        recoverStaleApiKeyEffectReservations: true,
        metricRetention,
        catalogSnapshot: catalogSnapshot(),
        hasRegistry: Boolean(registry),
        hasCapabilityResolver: typeof capabilityResolver === "function",
        hasCapabilityKeyProvider: Boolean(resolvedCapabilityKeyProvider),
        hasCapabilityBindingGuard: Boolean(resolvedCapabilityBindingGuard),
        hasGovernanceRevisionProvider: typeof governancePolicyRevisionProvider === "function",
        hasSecurityPermissions: Boolean(securityPermissions),
        hasChangeListener: typeof changeListener === "function",
        hasProofSubstrate: Boolean(proofSubstrate),
        hasApiKeyVerifierKeyProvider: Boolean(apiKeyVerifierKeyProvider),
        apiKeyVerifierGeneration: String(apiKeyVerifierKeyProvider?.currentGeneration || ""),
        hasApiKeyClock: typeof apiKeyClock === "function",
        hasApiKeyRandomBytes: typeof apiKeyRandomBytes === "function"
      },
      allowedCommands: [
        ...OPERATION_PERMISSION_STORE_COMMANDS,
        ...OPERATION_PERMISSION_API_KEY_COMMANDS.map((kind?: any) : any => `apiKey.${kind}`)
      ],
      hostHandlers,
      maxPending,
      maxPendingBytes,
      defaultDeadlineMs
    });
    owner.lane = lane;
    owner.state = "active";
  } catch (error: any) {
    void closeResources();
    releaseStoreOwner(owner);
    throw error;
  }
  const commandContext: any = () : any => ({
    catalogSnapshot: catalogSnapshot(),
    governanceRevision: normalizePolicyRevisionSnapshot(governancePolicyRevisionProvider?.()),
    resolvedCapabilities: []
  });
  const execute: any = (kind?: any, args: any[] = []) : Promise<any> => lane.execute(kind, {
    args: normalizeArguments(kind, args),
    context: commandContext()
  });
  const facade: Record<string, any> = {
    lane,
    registerApiKeyExecutionOwnerClose(closeOwner: () => Promise<void>) : any {
      if (typeof closeOwner !== "function" || apiKeyExecutionOwnerClose) {
        throw new TypeError("Operation Permission API Key execution owner is already registered.");
      }
      apiKeyExecutionOwnerClose = closeOwner;
      return () : any => {
        if (apiKeyExecutionOwnerClose === closeOwner) apiKeyExecutionOwnerClose = null;
      };
    },
    executeApiKey: (kind?: any, payload: any = {}) : Promise<any> => {
      if (storeClosing) return Promise.reject(Object.assign(new Error("Operation Permission store is closing."), {
        code: "sqlite_lane_closed"
      }));
      const command: any = String(kind || "");
      const randomMaterial: Record<string, any> = {};
      if (typeof apiKeyRandomBytes === "function") {
        if (command === "create") randomMaterial["16"] = Buffer.from(apiKeyRandomBytes(16));
        if (command === "create" || command === "rotate") randomMaterial["32"] = Buffer.from(apiKeyRandomBytes(32));
      }
      return lane.execute(`apiKey.${command}`, {
        args: [payload],
        context: {
          ...commandContext(),
          organizationSnapshot: securityPermissions?.getOrganizationGovernance?.() || null,
          governanceSummary: securityPermissions?.getGovernanceSummary?.() || null,
          apiKeyNowMs: typeof apiKeyClock === "function" ? Number(apiKeyClock()) : null,
          apiKeyRandomMaterial: randomMaterial,
          apiKeyVerifierGeneration: String(apiKeyVerifierKeyProvider?.currentGeneration || "")
        }
      });
    },
    getStats: () : any => lane.getStats(),
    isClosed: () : any => lane.getStats().closed,
    close: () : Promise<void> => {
      if (closePromise) return closePromise;
      owner.state = "closing";
      closePromise = (async () : Promise<void> => {
        try {
          await apiKeyExecutionOwnerClose?.();
          const stats: any = lane.getStats();
          if (stats.closed || stats.crashed) {
            throw Object.assign(new Error("Operation Permission SQLite owner ended before clean close."), {
              code: "operation_permission_owner_uncertain"
            });
          }
          storeClosing = true;
          await lane.close();
          await closeResources();
          releaseStoreOwner(owner);
        } catch (error: any) {
          owner.state = "poisoned";
          throw error;
        }
      })();
      return closePromise;
    }
  };
  for (const kind of OPERATION_PERMISSION_STORE_COMMANDS) {
    if (kind === "close") continue;
    facade[kind] = (...args: any[]) : Promise<any> => execute(kind, args);
  }
  return Object.freeze(facade);
}
