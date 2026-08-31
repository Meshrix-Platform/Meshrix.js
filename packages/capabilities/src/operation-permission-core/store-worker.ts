import { parentPort, workerData } from "node:worker_threads";
import crypto from "node:crypto";
import { createApiKeyVerifierKeyProvider } from "@meshrix/foundation/security/authorization/api-key-verifier-key-provider";
import {
  normalizeRegisteredToolCapabilities,
  toolExecuteCapabilityId
} from "@meshrix/foundation/security/authorization/authorization-engine";
import { createOperationPermissionWorkerOwner } from "./store-worker-owner.ts";
import { createApiKeyDistributionWorkerOwner } from "./api-key-distribution-worker-owner.ts";
import {
  OPERATION_PERMISSION_API_KEY_COMMANDS,
  OPERATION_PERMISSION_STORE_COMMANDS
} from "./store.ts";
import {
  callOperationPermissionHost,
  setOperationPermissionCommandDeadline
} from "./store-worker-bridge.ts";

let commandContext: Record<string, any> = {
  catalogSnapshot: workerData.catalogSnapshot || null,
  governanceRevision: null,
  organizationSnapshot: null,
  governanceSummary: null,
  resolvedCapabilities: [],
  apiKeyNowMs: null,
  apiKeyRandomMaterial: {},
  apiKeyVerifierGeneration: String(workerData.apiKeyVerifierGeneration || "")
};

function uniqueStrings(values: any = []) : any[] {
  return [...new Set<any>((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
}

function registryProxy() : any {
  return {
    getCatalog: () : any => commandContext.catalogSnapshot,
    listTools(filters: Record<string, any> = {}) : any[] {
      return (commandContext.catalogSnapshot?.tools || []).filter((tool?: any) : any =>
        (!filters.status || tool.status === filters.status) &&
        (!filters.toolset || tool.toolsets?.includes(filters.toolset)) &&
        (!filters.scope || tool.requiredScopes?.includes(filters.scope)) &&
        (!filters.risk || tool.risk === filters.risk) &&
        (!filters.owner || tool.owner === filters.owner)
      );
    },
    resolveToolset(input: Record<string, any> = {}) : any {
      const catalog: any = commandContext.catalogSnapshot || { tools: [], toolsets: [] };
      const requestedToolsets: any[] = uniqueStrings(input.toolsets || input.toolsetIds || input.toolset || []);
      const requestedScopes: any[] = uniqueStrings(input.scopes || input.scopeIds || input.scope || []);
      const toolsetsById: any = new Map<any, any>((catalog.toolsets || []).map((entry?: any) : any => [entry.id, entry]));
      const selected: any = new Set<any>([
        ...requestedToolsets,
        ...(catalog.toolsets || []).filter((entry?: any) : any => {
          const required: any[] = uniqueStrings(entry.requiredScopes || []);
          return required.length > 0 && required.every((scope?: any) : any => requestedScopes.includes(scope));
        }).map((entry?: any) : any => entry.id)
      ].filter((id?: any) : any => toolsetsById.has(id)));
      const allow: any = new Set<any>(uniqueStrings(input.toolAllow || []));
      const deny: any = new Set<any>(uniqueStrings(input.toolDeny || []));
      const capabilityCandidates: any = normalizeRegisteredToolCapabilities(input.capabilities || input.capabilityIds || []);
      const tools: any[] = (catalog.tools || []).filter((tool?: any) : any =>
        !deny.has(tool.id) &&
        (allow.size === 0 || allow.has(tool.id)) &&
        (
          (tool.toolsets || []).some((toolset?: any) : any => selected.has(toolset)) ||
          capabilityCandidates.includes(toolExecuteCapabilityId(tool.id))
        )
      );
      return {
        toolsets: [...selected],
        tools,
        toolIds: tools.map((tool?: any) : any => tool.id),
        requiredScopes: uniqueStrings([
          ...[...selected].flatMap((id?: any) : any => toolsetsById.get(id)?.requiredScopes || []),
          ...tools.flatMap((tool?: any) : any => tool.requiredScopes || [])
        ])
      };
    }
  };
}

function hostProxy(kind?: any) : any {
  return (input: Record<string, any> = {}) : Promise<any> => callOperationPermissionHost(kind, input);
}

const registry: any = workerData.hasRegistry ? registryProxy() : null;
const capabilityKeyProvider: any = workerData.hasCapabilityKeyProvider ? {
  issue: hostProxy("capability.issue"),
  verify: hostProxy("capability.verify"),
  invalidateCredential: hostProxy("capability.invalidate"),
  close() : any {}
} : null;
const capabilityBindingGuard: any = workerData.hasCapabilityBindingGuard ? {
  bindCapabilityKey: hostProxy("binding.bind"),
  verifyCapabilityKeyBinding: hostProxy("binding.verify"),
  invalidateCapabilityKeyBinding: hostProxy("binding.invalidate"),
  close() : any {}
} : false;
const securityPermissions: any = workerData.hasSecurityPermissions ? {
  getOrganizationGovernance: () : any => commandContext.organizationSnapshot,
  getGovernanceSummary: () : any => commandContext.governanceSummary,
  verifyProcessIdentity: hostProxy("processIdentity.verify")
} : null;
const proofSubstrate: any = workerData.hasProofSubstrate ? {
  recordWorkspaceOperation: hostProxy("proof.record"),
  proveWorkspaceMembership: hostProxy("proof.prove"),
  getWorkspaceProjection: (workspaceId?: any) : Promise<any> => callOperationPermissionHost("proof.project", { workspaceId })
} : null;
const defaultApiKeyVerifierKeyProvider: any = workerData.hasApiKeyVerifierKeyProvider
  ? null
  : createApiKeyVerifierKeyProvider({ userDataPath: workerData.userDataPath });
const apiKeyVerifierKeyProvider: any = workerData.hasApiKeyVerifierKeyProvider ? {
  get currentGeneration() : any {
    return commandContext.apiKeyVerifierGeneration;
  },
  getKey: (generation?: any) : Promise<any> => callOperationPermissionHost("apiKey.verifierKey", { generation })
} : defaultApiKeyVerifierKeyProvider;

function apiKeyRandomBytes(size?: any) : Buffer {
  const key: any = String(Number(size));
  const candidate: any = commandContext.apiKeyRandomMaterial?.[key];
  if (candidate) {
    delete commandContext.apiKeyRandomMaterial[key];
    const material: any = Buffer.from(candidate);
    if (material.length === Number(size)) return material;
  }
  return crypto.randomBytes(Number(size));
}
const store: any = createOperationPermissionWorkerOwner({
  userDataPath: workerData.userDataPath,
  registry,
  capabilityResolver: workerData.hasCapabilityResolver
    ? () : any => commandContext.resolvedCapabilities || []
    : null,
  capabilityKeyProvider,
  capabilityBindingGuard,
  governancePolicyRevisionProvider: workerData.hasGovernanceRevisionProvider
    ? () : any => commandContext.governanceRevision
    : null,
  securityPermissions,
  changeListener: workerData.hasChangeListener ? hostProxy("change.notify") : null,
  proofSubstrate,
  metricRetention: workerData.metricRetention
});
const apiKeyProvider: any = createApiKeyDistributionWorkerOwner({
  store,
  registry,
  securityPermissions,
  verifierKeyProvider: apiKeyVerifierKeyProvider,
  ...(workerData.hasApiKeyClock
    ? { now: () : any => Number(commandContext.apiKeyNowMs) }
    : {}),
  ...(workerData.hasApiKeyRandomBytes ? { randomBytes: apiKeyRandomBytes } : {})
});

const storeCommands: any = new Set<any>(OPERATION_PERMISSION_STORE_COMMANDS);
const apiKeyCommands: any = new Set<any>(OPERATION_PERMISSION_API_KEY_COMMANDS);

function errorProjection(error?: any) : any {
  return {
    name: String(error?.name || "Error"),
    code: String(error?.code || "sqlite_lane_command_failed"),
    message: String(error?.message || "Operation Permission SQLite command failed."),
    statusCode: Number(error?.statusCode || error?.status || 0),
    field: String(error?.field || ""),
    details: error?.details && typeof error.details === "object" ? error.details : {}
  };
}

async function handle(message?: any) : Promise<void> {
  const reply: Record<string, any> = { id: message?.id, ok: false };
  const closeAfterReply: boolean = message?.kind === "close";
  try {
    const kind: string = String(message?.kind || "");
    const isApiKey: boolean = kind.startsWith("apiKey.");
    const method: string = isApiKey ? kind.slice("apiKey.".length) : kind;
    if (!(isApiKey ? apiKeyCommands : storeCommands).has(method)) {
      throw Object.assign(new Error("Operation Permission SQLite command is not allowed."), { code: "sqlite_lane_command_rejected" });
    }
    if (Date.now() > Number(message?.deadlineAtMs || 0)) {
      throw Object.assign(new Error("Operation Permission SQLite command deadline elapsed."), { code: "sqlite_lane_deadline_exceeded" });
    }
    setOperationPermissionCommandDeadline(message.deadlineAtMs);
    commandContext = {
      ...commandContext,
      ...(message.payload?.context || {}),
      resolvedCapabilities: []
    };
    if (method === "close") {
      await Promise.resolve(store.close());
      reply.result = null;
    } else {
      const target: any = isApiKey ? apiKeyProvider : store;
      if (typeof target[method] !== "function") {
        throw Object.assign(new Error("Operation Permission SQLite command has no handler."), { code: "sqlite_lane_command_rejected" });
      }
      const args: any[] = Array.isArray(message.payload?.args) ? message.payload.args : [];
      if (!isApiKey && workerData.hasCapabilityResolver && ["createGrant", "updateGrant", "rotateGrantToken"].includes(method)) {
        const current: any = method === "createGrant"
          ? null
          : store.getRawGrant(String(args[0] || ""));
        const grant: any = method === "createGrant"
          ? (args[0] || {})
          : method === "updateGrant"
            ? { ...(current || {}), ...(args[1] || {}), id: String(args[0] || "") }
            : current;
        commandContext.resolvedCapabilities = await callOperationPermissionHost("capability.resolve", { grant });
      }
      reply.result = await target[method](...args);
    }
    reply.ok = true;
  } catch (error: any) {
    reply.error = errorProjection(error);
  }
  parentPort?.postMessage(reply);
  if (reply.ok && closeAfterReply) parentPort?.close();
}

let commandTail: Promise<any> = Promise.resolve();
parentPort?.on("message", (message?: any) : any => {
  if (message?.type === "host-response") return;
  commandTail = commandTail.then(() : any => handle(message), () : any => handle(message));
});
