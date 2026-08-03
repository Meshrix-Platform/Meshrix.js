import { computed, ref, shallowRef, watch } from "vue";
import { confirmConsoleAction, copyConsoleText } from "./console-browser-effects";
import { setApiKeyDistributionAvailability } from "./console-api-key-distribution-availability";
import {
  createApiKey,
  getApiKeyIssuerScopes,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  type ApiKeyCreateInput,
  type ApiKeyIssuerNode,
  type ApiKeyIssuerScopes,
  type ApiKeyOneTimeResult,
  type ApiKeyPage,
  type ApiKeyPolicy,
  type ApiKeyRecord,
} from "../lib/api-key-distribution-client";
import { getOperationPermissionCatalog } from "../lib/operation-permission-client";
import type {
  OperationPermissionCatalog,
  OperationPermissionTool,
} from "../lib/types/operation-permission";
import { apiKeyDistributionText, apiKeyErrorText } from "../i18n/api-key-distribution";
import { operationPermissionToolsetName } from "../i18n/operation-permission-toolsets";
import {
  API_KEY_DATA_CLASSIFICATION_OPTIONS,
  API_KEY_MCP_TARGET_OPTIONS,
} from "../lib/api-key-mcp-targets";
import {
  draftToConfigDocument,
  parseApiKeyDraftConfig,
} from "../lib/api-key-draft-config";

type ApiKeyClient = {
  getIssuerScopes: typeof getApiKeyIssuerScopes;
  list: typeof listApiKeys;
  create: typeof createApiKey;
  rotate: typeof rotateApiKey;
  revoke: typeof revokeApiKey;
  getCatalog: typeof getOperationPermissionCatalog;
};

export type ApiKeyPolicyDraft = {
  workloadDisplayName: string;
  organizationNodeId: string;
  expiresAt: string;
  selectedToolsetIds: string[];
  allowedTools: string[];
  selectedProfileId: string;
  maximumRisk: "low" | "medium" | "high";
  serverAudience: string;
  selectedTargetIds: string[];
  resourcesUnrestricted: boolean;
  selectedDataClassifications: string[];
  workspaceIds: string;
  /** Calls allowed in each fixed 60-second window. */
  requestsPerMinute: number | null;
  maxConcurrentEffects: number | null;
};

export type ApiKeyInferredPolicyFields = {
  toolsetIds: string[];
  scopeIds: string[];
  serviceIds: string[];
  capabilityIds: string[];
  minimumRisk: "low" | "medium" | "high";
};

export type ApiKeyDistributionControllerOptions = {
  client?: ApiKeyClient;
  confirmAction?: typeof confirmConsoleAction;
  copyText?: typeof copyConsoleText;
};

const RISK_ORDER = ["low", "medium", "high"] as const;
type ApiKeyRisk = (typeof RISK_ORDER)[number];

/** Server still requires positive limit integers; empty console fields mean unrestricted. */
const UNLIMITED_MAX_USES = 2_000_000_000;
const UNLIMITED_REQUESTS_PER_MINUTE = 2_000_000_000;
/** Server caps maxConcurrentEffects at 10000. */
const UNLIMITED_MAX_CONCURRENT_EFFECTS = 10_000;
const RATE_WINDOW_SECONDS = 60;
/** Vite console port; MCP clients use the proxied API port instead. */
const VITE_CONSOLE_PORT = "5173";
const DEFAULT_API_PORT = "7228";

function fallbackServerAudience(): string {
  if (typeof window === "undefined" || !window.location?.host) return "";
  const { hostname, port, host } = window.location;
  if (port === VITE_CONSOLE_PORT) return `${hostname}:${DEFAULT_API_PORT}`;
  return host;
}

function resolveServerAudience(preferred = ""): string {
  return String(preferred || "").trim() || fallbackServerAudience();
}

const defaultClient: ApiKeyClient = {
  getIssuerScopes: getApiKeyIssuerScopes,
  list: listApiKeys,
  create: createApiKey,
  rotate: rotateApiKey,
  revoke: revokeApiKey,
  getCatalog: getOperationPermissionCatalog,
};

function emptyDraft(): ApiKeyPolicyDraft {
  return {
    workloadDisplayName: "", organizationNodeId: "", expiresAt: "",
    selectedToolsetIds: [], allowedTools: [], selectedProfileId: "",
    maximumRisk: "low", serverAudience: "", selectedTargetIds: [],
    resourcesUnrestricted: true, selectedDataClassifications: [], workspaceIds: "",
    requestsPerMinute: null, maxConcurrentEffects: null,
  };
}

function toolsForToolsets(
  catalogTools: OperationPermissionTool[],
  toolsetIds: Iterable<string>,
): OperationPermissionTool[] {
  const selected = new Set([...toolsetIds].map((value) => String(value || "").trim()).filter(Boolean));
  if (selected.size === 0) return [];
  return catalogTools.filter((tool) => (tool.toolsets || []).some((toolsetId) => selected.has(toolsetId)));
}

function stringList(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean))].sort();
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => String(value || "").trim()).filter(Boolean))].sort();
}

function positiveInteger(value: number | null): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function limitUnset(value: number | null): boolean {
  return value === null || value === undefined || Number.isNaN(Number(value));
}

function limitOrUnlimited(value: number | null, unlimited: number): number {
  return positiveInteger(value) ? value : unlimited;
}

function issuerNodes(scopes: ApiKeyIssuerScopes | null): ApiKeyIssuerNode[] {
  if (!scopes) return [];
  const sourceNodes = Array.isArray(scopes.eligibleNodes) ? scopes.eligibleNodes : [];
  return sourceNodes.filter((node, index, values) =>
    node?.nodeId && values.findIndex((entry) => entry.nodeId === node.nodeId) === index,
  );
}

function riskRank(value: string): number {
  return ({
    low: 0,
    read_only: 0,
    medium: 1,
    safe_write: 1,
    high: 2,
    repair_write: 2,
    destructive: 2,
  } as Record<string, number>)[String(value || "low")] ?? 0;
}

function toApiKeyRisk(value: string): ApiKeyRisk {
  const rank = riskRank(value);
  return RISK_ORDER[Math.min(rank, RISK_ORDER.length - 1)];
}

function higherRisk(left: ApiKeyRisk, right: ApiKeyRisk): ApiKeyRisk {
  return riskRank(left) >= riskRank(right) ? left : right;
}

function inferFromTools(tools: OperationPermissionTool[]): ApiKeyInferredPolicyFields {
  const toolsetIds = uniqueSorted(tools.flatMap((tool) => tool.toolsets || []));
  const scopeIds = uniqueSorted(tools.flatMap((tool) => tool.requiredScopes || []));
  const serviceIds = uniqueSorted(tools.map((tool) => tool.serviceId || ""));
  const capabilityIds = uniqueSorted(tools.map((tool) => tool.capabilityId || ""));
  const minimumRisk = tools.reduce<ApiKeyRisk>(
    (current, tool) => higherRisk(current, toApiKeyRisk(String(tool.risk || "low"))),
    "low",
  );
  return { toolsetIds, scopeIds, serviceIds, capabilityIds, minimumRisk };
}

export function useConsoleApiKeyDistributionController(options: ApiKeyDistributionControllerOptions = {}) {
  const client = options.client || defaultClient;
  const confirmAction = options.confirmAction || confirmConsoleAction;
  const copyText = options.copyText || copyConsoleText;
  const scopes = ref<ApiKeyIssuerScopes | null>(null);
  const catalog = ref<OperationPermissionCatalog | null>(null);
  const catalogMismatch = ref(false);
  const records = ref<ApiKeyRecord[]>([]);
  const draft = ref<ApiKeyPolicyDraft>(emptyDraft());
  const oneTimeSecret = shallowRef("");
  const revealedRecord = shallowRef<ApiKeyRecord | null>(null);
  const loading = ref(false);
  const creating = ref(false);
  const mutatingKeyId = ref("");
  const copied = ref(false);
  const error = ref("");
  const status = ref("");

  const nodes = computed(() => issuerNodes(scopes.value));
  const eligible = computed(() => nodes.value.length > 0);
  const busy = computed(() => loading.value || creating.value || Boolean(mutatingKeyId.value));
  const catalogFingerprint = computed(() => String(
    catalog.value?.fingerprint || scopes.value?.catalogFingerprint || "",
  ));
  const catalogTools = computed(() => catalog.value?.tools || []);
  const catalogToolsets = computed(() => catalog.value?.toolsets || []);
  const toolsById = computed(() => new Map(catalogTools.value.map((tool) => [tool.id, tool])));

  const selectedAllowedTools = computed(() =>
    draft.value.allowedTools
      .map((toolId) => toolsById.value.get(toolId))
      .filter((tool): tool is OperationPermissionTool => Boolean(tool)),
  );

  const inferredPolicy = computed(() => {
    const inferred = inferFromTools(selectedAllowedTools.value);
    return {
      ...inferred,
      toolsetIds: uniqueSorted(draft.value.selectedToolsetIds.length
        ? draft.value.selectedToolsetIds
        : inferred.toolsetIds),
    };
  });

  const toolsetOptions = computed(() =>
    catalogToolsets.value.map((toolset) => ({
      value: toolset.id,
      label: operationPermissionToolsetName(toolset.id, toolset.label || toolset.id),
      description: toolset.id,
    })),
  );

  const targetOptions = computed(() =>
    API_KEY_MCP_TARGET_OPTIONS.map((target) => ({
      value: target.value,
      label: target.label,
      description: target.value,
    })),
  );

  const dataClassificationOptions = computed(() =>
    API_KEY_DATA_CLASSIFICATION_OPTIONS.map((entry) => ({
      value: entry.value,
      label: apiKeyDistributionText(entry.labelZh, entry.labelEn),
      description: entry.value,
    })),
  );

  const profileOptions = computed(() => [
    { value: "", label: apiKeyDistributionText("不使用档案", "No profile") },
    ...(catalog.value?.profiles || []).map((profile) => ({
      value: profile.id,
      label: profile.label || profile.id,
    })),
  ]);

  const maximumRiskOptions = computed(() => {
    const floor = riskRank(inferredPolicy.value.minimumRisk);
    return RISK_ORDER
      .filter((risk) => riskRank(risk) >= floor)
      .map((risk) => ({
        value: risk,
        label: ({
          low: apiKeyDistributionText("低", "Low"),
          medium: apiKeyDistributionText("中", "Medium"),
          high: apiKeyDistributionText("高", "High"),
        } as Record<ApiKeyRisk, string>)[risk],
      }));
  });

  const inferredSummaryItems = computed(() => {
    const inferred = inferredPolicy.value;
    const empty = apiKeyDistributionText("（未选定）", "(none selected)");
    const join = (values: string[]) => values.length ? values.join(", ") : empty;
    const audience = resolveServerAudience(draft.value.serverAudience || scopes.value?.serverAudience);
    return [
      {
        label: apiKeyDistributionText("允许的工具", "Allowed tools"),
        value: draft.value.allowedTools.length
          ? apiKeyDistributionText(
              `${draft.value.allowedTools.length} 个`,
              `${draft.value.allowedTools.length} tools`,
            )
          : empty,
      },
      {
        label: apiKeyDistributionText("权限范围", "Scopes"),
        value: join(inferred.scopeIds),
        mono: inferred.scopeIds.length > 0,
      },
      {
        label: apiKeyDistributionText("服务", "Services"),
        value: join(inferred.serviceIds),
        mono: inferred.serviceIds.length > 0,
      },
      {
        label: apiKeyDistributionText("能力", "Capabilities"),
        value: join(inferred.capabilityIds),
        mono: inferred.capabilityIds.length > 0,
      },
      {
        label: apiKeyDistributionText("服务端受众", "Server audience"),
        value: audience || empty,
        mono: Boolean(audience),
      },
      {
        label: apiKeyDistributionText("风险下限", "Minimum risk"),
        value: ({
          low: apiKeyDistributionText("低", "Low"),
          medium: apiKeyDistributionText("中", "Medium"),
          high: apiKeyDistributionText("高", "High"),
        } as Record<ApiKeyRisk, string>)[inferred.minimumRisk],
      },
    ];
  });

  const draftMissingHints = computed(() => {
    const hints: string[] = [];
    if (!draft.value.workloadDisplayName.trim()) {
      hints.push(apiKeyDistributionText("显示名称", "Display name"));
    }
    if (!draft.value.organizationNodeId) {
      hints.push(apiKeyDistributionText("所属层级", "Owning level"));
    }
    if (!draft.value.expiresAt
      || !Number.isFinite(Date.parse(draft.value.expiresAt))
      || Date.parse(draft.value.expiresAt) <= Date.now()) {
      hints.push(apiKeyDistributionText("到期时间", "Expiry"));
    }
    if (!draft.value.selectedToolsetIds.length || !draft.value.allowedTools.length) {
      hints.push(apiKeyDistributionText("工具集", "Toolsets"));
    }
    if (!resolveServerAudience(draft.value.serverAudience)) {
      hints.push(apiKeyDistributionText("服务端受众", "Server audience"));
    }
    if (!draft.value.selectedTargetIds.length) {
      hints.push(apiKeyDistributionText("客户端目标", "Client targets"));
    }
    if (!draft.value.resourcesUnrestricted
      && !draft.value.selectedDataClassifications.length
      && !stringList(draft.value.workspaceIds).length) {
      hints.push(apiKeyDistributionText("资源范围", "Resource scope"));
    }
    if (!limitUnset(draft.value.requestsPerMinute) && !positiveInteger(draft.value.requestsPerMinute)) {
      hints.push(apiKeyDistributionText("每分钟调用次数", "Calls per minute"));
    }
    if (!limitUnset(draft.value.maxConcurrentEffects) && !positiveInteger(draft.value.maxConcurrentEffects)) {
      hints.push(apiKeyDistributionText("最大并发量", "Maximum concurrency"));
    }
    if (!catalogFingerprint.value || catalogMismatch.value) {
      hints.push(apiKeyDistributionText("目录同步", "Catalog sync"));
    }
    return hints;
  });

  const draftValid = computed(() => draftMissingHints.value.length === 0);

  function sameIdList(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  function syncToolsFromToolsets(): void {
    const toolsetIds = uniqueSorted(draft.value.selectedToolsetIds);
    const allowed = uniqueSorted(
      toolsForToolsets(catalogTools.value, toolsetIds).map((tool) => tool.id),
    );
    if (!sameIdList(draft.value.selectedToolsetIds, toolsetIds)) draft.value.selectedToolsetIds = toolsetIds;
    if (!sameIdList(draft.value.allowedTools, allowed)) draft.value.allowedTools = allowed;
    const minimumRisk = inferFromTools(
      allowed.map((toolId) => toolsById.value.get(toolId)).filter((tool): tool is OperationPermissionTool => Boolean(tool)),
    ).minimumRisk;
    if (riskRank(draft.value.maximumRisk) < riskRank(minimumRisk)) {
      draft.value.maximumRisk = minimumRisk;
    }
  }

  watch(
    () => [
      draft.value.selectedToolsetIds.join("\0"),
      catalogTools.value.map((tool) => tool.id).join("\0"),
    ] as const,
    () => { syncToolsFromToolsets(); },
    { flush: "sync" },
  );

  function dismissSecret(announce = false): void {
    const hadSecret = Boolean(oneTimeSecret.value);
    oneTimeSecret.value = "";
    revealedRecord.value = null;
    copied.value = false;
    if (announce && hadSecret) {
      status.value = apiKeyDistributionText(
        "密钥明文已永久关闭；请仅使用已安全分发的副本。",
        "The plaintext key was permanently dismissed. Use only the copy already distributed securely.",
      );
    }
  }

  function beginMutation(): boolean {
    dismissSecret();
    error.value = "";
    status.value = "";
    return !busy.value;
  }

  function policyFromDraft(): ApiKeyPolicy {
    syncToolsFromToolsets();
    const value = draft.value;
    const inferred = inferredPolicy.value;
    return {
      protocol: "mcp",
      serviceIds: inferred.serviceIds,
      capabilityIds: inferred.capabilityIds,
      toolsetIds: uniqueSorted(value.selectedToolsetIds),
      allowedTools: uniqueSorted(value.allowedTools),
      deniedTools: [],
      scopeIds: inferred.scopeIds,
      maximumRisk: higherRisk(value.maximumRisk, inferred.minimumRisk),
      audience: {
        serverAudience: resolveServerAudience(value.serverAudience || scopes.value?.serverAudience),
        targetIds: uniqueSorted(value.selectedTargetIds),
        connectorPackageIds: [],
      },
      resources: {
        mode: value.resourcesUnrestricted ? "unrestricted" : "restricted",
        workspaceIds: value.resourcesUnrestricted ? [] : stringList(value.workspaceIds),
        dataClassifications: value.resourcesUnrestricted
          ? []
          : uniqueSorted(value.selectedDataClassifications),
        egressClasses: [],
        semanticFamilies: [],
        capabilityDomains: [],
        capabilityVerbs: [],
        resourceKinds: [],
        effectKinds: [],
        secretBindingIds: [],
        allowedOrigins: [],
        allowedCidrs: [],
      },
      processIdentity: { mode: "optional" },
      limits: {
        maxUses: UNLIMITED_MAX_USES,
        requestsPerWindow: limitOrUnlimited(value.requestsPerMinute, UNLIMITED_REQUESTS_PER_MINUTE),
        windowSeconds: RATE_WINDOW_SECONDS,
        maxConcurrentEffects: limitOrUnlimited(
          value.maxConcurrentEffects,
          UNLIMITED_MAX_CONCURRENT_EFFECTS,
        ),
      },
      catalogFingerprint: catalogFingerprint.value,
    };
  }

  const draftConfigDocument = computed(() => draftToConfigDocument(draft.value));

  function importDraftConfig(value: unknown): void {
    const knownNodeIds = new Set(nodes.value.map((node) => node.nodeId));
    const knownToolsetIds = new Set(catalogToolsets.value.map((toolset) => toolset.id));
    const knownTargetIds = new Set(API_KEY_MCP_TARGET_OPTIONS.map((target) => target.value));
    const knownClassificationIds = new Set(
      API_KEY_DATA_CLASSIFICATION_OPTIONS.map((entry) => entry.value),
    );
    const knownProfileIds = new Set((catalog.value?.profiles || []).map((profile) => profile.id));
    let next;
    try {
      next = parseApiKeyDraftConfig(value, {
        knownNodeIds,
        knownToolsetIds,
        knownTargetIds,
        knownClassificationIds,
        knownProfileIds,
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught || "");
      throw new Error(localizeDraftConfigError(message));
    }
    const importedToolsets = next.selectedToolsetIds;
    Object.assign(draft.value, next);
    if (next.selectedProfileId) applyProfile(next.selectedProfileId);
    if (importedToolsets) draft.value.selectedToolsetIds = uniqueSorted(importedToolsets);
    syncToolsFromToolsets();
    error.value = "";
    status.value = apiKeyDistributionText(
      "已从 JSON 配置写入创建表单，请确认后创建。",
      "The create form was filled from the JSON config. Review it before creating.",
    );
  }

  function localizeDraftConfigError(message: string): string {
    if (message.includes("must be a JSON object")) {
      return apiKeyDistributionText("配置必须是 JSON 对象。", "Config must be a JSON object.");
    }
    if (message.includes("did not contain any recognized fields")) {
      return apiKeyDistributionText("配置中没有可识别的字段。", "Config did not contain any recognized fields.");
    }
    if (message.includes("not in the manageable hierarchy")) {
      return apiKeyDistributionText(
        "所属层级不在当前可管理范围内。",
        "Owning level is outside the manageable hierarchy.",
      );
    }
    if (message.includes("selectedProfileId is unknown")) {
      return apiKeyDistributionText("权限档案不存在。", "Permission profile is unknown.");
    }
    if (message.includes("maximumRisk must be")) {
      return apiKeyDistributionText(
        "最高风险级别只能是 low、medium 或 high。",
        "maximumRisk must be low, medium, or high.",
      );
    }
    return message;
  }

  function applyProfile(profileId: string): void {
    draft.value.selectedProfileId = String(profileId || "");
    if (!draft.value.selectedProfileId || !catalog.value) return;
    const profile = catalog.value.profiles.find((entry) => entry.id === draft.value.selectedProfileId);
    if (!profile) return;
    const toolsetIds = uniqueSorted(profile.toolsets || []);
    const allowToolsets = uniqueSorted(
      (profile.toolAllow || []).flatMap((toolId) => toolsById.value.get(toolId)?.toolsets || []),
    );
    draft.value.selectedToolsetIds = toolsetIds.length ? toolsetIds : allowToolsets;
    syncToolsFromToolsets();
    draft.value.maximumRisk = higherRisk(
      toApiKeyRisk(String(profile.maxRisk || "low")),
      inferredPolicy.value.minimumRisk,
    );
  }

  function replaceRecord(record: ApiKeyRecord): void {
    const index = records.value.findIndex((entry) => entry.keyId === record.keyId);
    if (index < 0) records.value = [record, ...records.value];
    else records.value = records.value.map((entry, position) => position === index ? record : entry);
  }

  function reveal(result: ApiKeyOneTimeResult): void {
    replaceRecord(result.record);
    revealedRecord.value = result.record;
    oneTimeSecret.value = result.apiKey;
  }

  async function refresh(): Promise<boolean> {
    dismissSecret();
    if (busy.value) return false;
    loading.value = true;
    error.value = "";
    try {
      const [nextScopes, page, nextCatalog]: [ApiKeyIssuerScopes, ApiKeyPage, OperationPermissionCatalog] =
        await Promise.all([
          client.getIssuerScopes(),
          client.list({ limit: 100 }),
          client.getCatalog(),
        ]);
      scopes.value = nextScopes;
      records.value = page.records || [];
      catalog.value = nextCatalog;
      catalogMismatch.value = Boolean(
        nextCatalog?.fingerprint
        && nextScopes.catalogFingerprint
        && nextCatalog.fingerprint !== nextScopes.catalogFingerprint,
      );
      setApiKeyDistributionAvailability(issuerNodes(nextScopes).length > 0);
      draft.value.serverAudience = resolveServerAudience(
        nextScopes.serverAudience || draft.value.serverAudience,
      );
      const knownTargets = new Set<string>(API_KEY_MCP_TARGET_OPTIONS.map((target) => target.value));
      draft.value.selectedTargetIds = draft.value.selectedTargetIds.filter((targetId) => knownTargets.has(targetId));
      const knownClasses = new Set<string>(API_KEY_DATA_CLASSIFICATION_OPTIONS.map((entry) => entry.value));
      draft.value.selectedDataClassifications = draft.value.selectedDataClassifications
        .filter((entry) => knownClasses.has(entry));
      if (catalogMismatch.value) {
        error.value = apiKeyDistributionText(
          "操作权限目录与签发权威不一致，请同步后再创建密钥。",
          "The operation-permission catalog does not match issuer authority. Sync before creating a key.",
        );
        return false;
      }
      const toolsetIds = new Set(catalogToolsets.value.map((toolset) => toolset.id));
      draft.value.selectedToolsetIds = draft.value.selectedToolsetIds.filter((toolsetId) => toolsetIds.has(toolsetId));
      if (draft.value.selectedProfileId
        && !(catalog.value.profiles || []).some((profile) => profile.id === draft.value.selectedProfileId)) {
        draft.value.selectedProfileId = "";
      }
      syncToolsFromToolsets();
      return true;
    } catch (caught) {
      if (!scopes.value) setApiKeyDistributionAvailability(false);
      error.value = apiKeyErrorText(caught);
      return false;
    } finally { loading.value = false; }
  }

  async function create(): Promise<void> {
    if (!beginMutation() || !draftValid.value) return;
    const confirmation = apiKeyDistributionText(
      "仅凭此密钥即可代表这里记录的工作负载身份。若密钥被盗，攻击者可在权限范围内冒用该身份，是否继续？",
      "Possession of this key alone represents the recorded workload identity. If stolen, an attacker can impersonate it within its permissions. Continue?",
    );
    const confirmed = await confirmAction(confirmation, {
      title: apiKeyDistributionText("创建密钥", "Create Key"),
      confirmLabel: apiKeyDistributionText("创建并显示一次", "Create and Show Once"), tone: "danger",
    });
    if (!confirmed) return;
    creating.value = true;
    try {
      const input: ApiKeyCreateInput = {
        workloadDisplayName: draft.value.workloadDisplayName.trim(),
        organizationNodeId: draft.value.organizationNodeId,
        expiresAt: new Date(draft.value.expiresAt).toISOString(),
        policy: policyFromDraft(),
      };
      reveal(await client.create(input));
      status.value = apiKeyDistributionText("密钥已创建。请立即复制，关闭后无法再次查看。", "Key created. Copy it now; it cannot be viewed again after dismissal.");
    } catch (caught) { dismissSecret(); error.value = apiKeyErrorText(caught); }
    finally { creating.value = false; }
  }

  async function rotate(record: ApiKeyRecord): Promise<void> {
    if (!beginMutation() || record.status !== "active") return;
    const confirmed = await confirmAction(apiKeyDistributionText(
      "轮换后旧密钥立即停止授权；权限、到期时间和已用次数都不会重置。",
      "The old key stops authorizing immediately. Permissions, expiry, and use count do not reset.",
    ), { title: apiKeyDistributionText("轮换密钥", "Rotate Key"), confirmLabel: apiKeyDistributionText("轮换并显示一次", "Rotate and Show Once"), tone: "danger" });
    if (!confirmed) return;
    mutatingKeyId.value = record.keyId;
    try {
      reveal(await client.rotate(record.keyId, record.lifecycleRevision));
      status.value = apiKeyDistributionText("密钥已轮换。请立即复制新值。", "Key rotated. Copy the new value now.");
    } catch (caught) { dismissSecret(); error.value = apiKeyErrorText(caught); }
    finally { mutatingKeyId.value = ""; }
  }

  async function revoke(record: ApiKeyRecord): Promise<void> {
    if (!beginMutation() || record.status !== "active") return;
    const confirmed = await confirmAction(apiKeyDistributionText(
      "撤销是永久操作，该密钥将立即停止授权且不能恢复。",
      "Revocation is permanent. This key stops authorizing immediately and cannot be restored.",
    ), { title: apiKeyDistributionText("撤销密钥", "Revoke Key"), confirmLabel: apiKeyDistributionText("永久撤销", "Revoke Permanently"), tone: "danger", requireText: record.workloadDisplayName });
    if (!confirmed) return;
    mutatingKeyId.value = record.keyId;
    try {
      replaceRecord(await client.revoke(record.keyId, record.lifecycleRevision, "administrator_revoked"));
      status.value = apiKeyDistributionText("密钥已永久撤销。", "Key permanently revoked.");
    } catch (caught) { error.value = apiKeyErrorText(caught); }
    finally { mutatingKeyId.value = ""; }
  }

  async function copySecret(): Promise<void> {
    const secret = oneTimeSecret.value;
    if (!secret) return;
    try { copied.value = Boolean(await copyText(secret)); }
    catch { copied.value = false; error.value = apiKeyDistributionText("无法写入剪贴板，请手动复制。", "Could not write to the clipboard. Copy the value manually."); }
  }

  return {
    applyProfile, busy, catalog, catalogFingerprint, catalogMismatch, copied, copySecret, create,
    creating, dataClassificationOptions, dismissSecret, draft, draftConfigDocument,
    draftMissingHints, draftValid, eligible, error, importDraftConfig, inferredPolicy,
    inferredSummaryItems, loading, maximumRiskOptions, mutatingKeyId, nodes, oneTimeSecret,
    profileOptions, records, refresh, revealedRecord, revoke, rotate, scopes, status,
    targetOptions, toolsetOptions,
  };
}
