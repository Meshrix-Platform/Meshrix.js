export type ApiKeyDraftConfigFields = {
  workloadDisplayName: string;
  organizationNodeId: string;
  expiresAt: string;
  selectedClientGuide: string;
  maximumRisk: "low" | "medium" | "high";
  selectedProfileId: string;
  selectedToolsetIds: string[];
  selectedMcpTools: Array<{ serviceId: string; publicName: string }>;
  selectedTargetIds: string[];
  resourcesUnrestricted: boolean;
  selectedDataClassifications: string[];
  workspaceIds: string;
  requestsPerMinute: number | null;
  maxConcurrentEffects: number | null;
};

export type ApiKeyDraftConfigDocument = {
  workloadDisplayName?: string;
  organizationNodeId?: string;
  expiresAt?: string;
  selectedClientGuide?: string;
  maximumRisk?: "low" | "medium" | "high";
  selectedProfileId?: string;
  selectedToolsetIds?: string[];
  selectedMcpTools?: Array<{ serviceId: string; publicName: string }>;
  selectedTargetIds?: string[];
  resourcesUnrestricted?: boolean;
  selectedDataClassifications?: string[];
  workspaceIds?: string[] | string;
  requestsPerMinute?: number | null;
  maxConcurrentEffects?: number | null;
  /** Optional create-API shaped policy fragment. */
  policy?: {
    toolsetIds?: string[];
    maximumRisk?: "low" | "medium" | "high";
    audience?: { targetIds?: string[] };
    resources?: {
      mode?: "unrestricted" | "restricted";
      workspaceIds?: string[];
      dataClassifications?: string[];
    };
    limits?: {
      requestsPerWindow?: number;
      windowSeconds?: number;
      maxConcurrentEffects?: number;
    };
  };
};

export type ApiKeyDraftConfigContext = {
  knownNodeIds: ReadonlySet<string>;
  knownToolsetIds: ReadonlySet<string>;
  knownTargetIds: ReadonlySet<string>;
  knownClientGuideIds: ReadonlySet<string>;
  knownClassificationIds: ReadonlySet<string>;
  knownProfileIds: ReadonlySet<string>;
  knownMcpToolIdentities: ReadonlySet<string>;
};

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("API Key draft config must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${path} must be a string.`);
  return value.trim();
}

function optionalStringList(value: unknown, path: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    return [...new Set(value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean))];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${path} must be a string array.`);
  }
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
  return value;
}

function optionalPositiveIntegerOrNull(value: unknown, path: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${path} must be a positive integer or null.`);
  }
  return Number(value);
}

function toDatetimeLocal(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return trimmed;
  const date = new Date(ms);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function filterKnown(values: string[] | undefined, known: ReadonlySet<string>): string[] | undefined {
  if (!values) return undefined;
  return values.filter((value) => known.has(value));
}

export function draftToConfigDocument(draft: ApiKeyDraftConfigFields): ApiKeyDraftConfigDocument {
  return {
    workloadDisplayName: draft.workloadDisplayName,
    organizationNodeId: draft.organizationNodeId,
    expiresAt: draft.expiresAt,
    selectedClientGuide: draft.selectedClientGuide,
    maximumRisk: draft.maximumRisk,
    selectedProfileId: draft.selectedProfileId || undefined,
    selectedToolsetIds: [...draft.selectedToolsetIds],
    selectedMcpTools: draft.selectedMcpTools.map(({ serviceId, publicName }) => ({ serviceId, publicName })),
    selectedTargetIds: [...draft.selectedTargetIds],
    resourcesUnrestricted: draft.resourcesUnrestricted,
    selectedDataClassifications: [...draft.selectedDataClassifications],
    workspaceIds: draft.workspaceIds
      ? draft.workspaceIds.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean)
      : [],
    requestsPerMinute: draft.requestsPerMinute,
    maxConcurrentEffects: draft.maxConcurrentEffects,
  };
}

export function parseApiKeyDraftConfig(
  value: unknown,
  context: ApiKeyDraftConfigContext,
): Partial<ApiKeyDraftConfigFields> {
  const root = asObject(value);
  const policy = root.policy && typeof root.policy === "object" && !Array.isArray(root.policy)
    ? root.policy as Record<string, unknown>
    : null;
  const audience = policy?.audience && typeof policy.audience === "object" && !Array.isArray(policy.audience)
    ? policy.audience as Record<string, unknown>
    : null;
  const resources = policy?.resources && typeof policy.resources === "object" && !Array.isArray(policy.resources)
    ? policy.resources as Record<string, unknown>
    : null;
  const limits = policy?.limits && typeof policy.limits === "object" && !Array.isArray(policy.limits)
    ? policy.limits as Record<string, unknown>
    : null;

  const next: Partial<ApiKeyDraftConfigFields> = {};

  if (root.selectedMcpTools !== undefined) {
    if (!Array.isArray(root.selectedMcpTools)) {
      throw new Error("selectedMcpTools must be an array of current MCP tool identities.");
    }
    const identities = root.selectedMcpTools.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`selectedMcpTools[${index}] must identify a serviceId and publicName.`);
      }
      const item = entry as Record<string, unknown>;
      if (Object.keys(item).some((key) => key !== "serviceId" && key !== "publicName")) {
        throw new Error(`selectedMcpTools[${index}] contains unsupported fields.`);
      }
      if (typeof item.serviceId !== "string" || typeof item.publicName !== "string") {
        throw new Error(`selectedMcpTools[${index}] must identify a serviceId and publicName.`);
      }
      const serviceId = item.serviceId.trim();
      const publicName = item.publicName.trim();
      const identity = `${serviceId}\0${publicName}`;
      if (!serviceId || !publicName || !context.knownMcpToolIdentities.has(identity)) {
        throw new Error("selectedMcpTools contains an unavailable MCP tool selection.");
      }
      return { serviceId, publicName };
    });
    const seen = new Set<string>();
    next.selectedMcpTools = identities.filter((item) => {
      const identity = `${item.serviceId}\0${item.publicName}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  }
  const workloadDisplayName = optionalString(root.workloadDisplayName, "workloadDisplayName");
  if (workloadDisplayName !== undefined) next.workloadDisplayName = workloadDisplayName;

  const organizationNodeId = optionalString(root.organizationNodeId, "organizationNodeId");
  if (organizationNodeId !== undefined) {
    if (organizationNodeId && !context.knownNodeIds.has(organizationNodeId)) {
      throw new Error(`organizationNodeId is not in the manageable hierarchy: ${organizationNodeId}`);
    }
    next.organizationNodeId = organizationNodeId;
  }

  const expiresAt = optionalString(root.expiresAt, "expiresAt");
  if (expiresAt !== undefined) next.expiresAt = expiresAt ? toDatetimeLocal(expiresAt) : "";

  const selectedClientGuide = optionalString(root.selectedClientGuide, "selectedClientGuide");
  if (selectedClientGuide !== undefined) {
    if (!context.knownClientGuideIds.has(selectedClientGuide)) {
      throw new Error(`selectedClientGuide is unknown: ${selectedClientGuide}`);
    }
    next.selectedClientGuide = selectedClientGuide;
  }

  const maximumRisk = optionalString(root.maximumRisk ?? policy?.maximumRisk, "maximumRisk");
  if (maximumRisk !== undefined) {
    if (maximumRisk && maximumRisk !== "low" && maximumRisk !== "medium" && maximumRisk !== "high") {
      throw new Error("maximumRisk must be low, medium, or high.");
    }
    if (maximumRisk === "low" || maximumRisk === "medium" || maximumRisk === "high") {
      next.maximumRisk = maximumRisk;
    }
  }

  const selectedProfileId = optionalString(root.selectedProfileId, "selectedProfileId");
  if (selectedProfileId !== undefined) {
    if (selectedProfileId && !context.knownProfileIds.has(selectedProfileId)) {
      throw new Error(`selectedProfileId is unknown: ${selectedProfileId}`);
    }
    next.selectedProfileId = selectedProfileId;
  }

  const toolsetIds = filterKnown(
    optionalStringList(root.selectedToolsetIds ?? policy?.toolsetIds, "selectedToolsetIds"),
    context.knownToolsetIds,
  );
  if (toolsetIds) next.selectedToolsetIds = toolsetIds;

  const targetIds = optionalStringList(root.selectedTargetIds ?? audience?.targetIds, "selectedTargetIds");
  if (targetIds?.some((targetId) => !context.knownTargetIds.has(targetId))) {
    throw new Error("selectedTargetIds contains an unknown audience restriction.");
  }
  if (targetIds) next.selectedTargetIds = targetIds;

  const resourcesUnrestricted = optionalBoolean(root.resourcesUnrestricted, "resourcesUnrestricted");
  const resourceMode = optionalString(resources?.mode, "policy.resources.mode");
  if (resourcesUnrestricted !== undefined) next.resourcesUnrestricted = resourcesUnrestricted;
  else if (resourceMode === "unrestricted") next.resourcesUnrestricted = true;
  else if (resourceMode === "restricted") next.resourcesUnrestricted = false;

  const classifications = filterKnown(
    optionalStringList(
      root.selectedDataClassifications ?? resources?.dataClassifications,
      "selectedDataClassifications",
    ),
    context.knownClassificationIds,
  );
  if (classifications) next.selectedDataClassifications = classifications;

  const workspaceIds = optionalStringList(
    root.workspaceIds ?? resources?.workspaceIds,
    "workspaceIds",
  );
  if (workspaceIds) next.workspaceIds = workspaceIds.join("\n");

  const requestsPerMinute = optionalPositiveIntegerOrNull(root.requestsPerMinute, "requestsPerMinute");
  if (requestsPerMinute !== undefined) next.requestsPerMinute = requestsPerMinute;
  else if (limits?.requestsPerWindow !== undefined) {
    const windowSeconds = Number(limits.windowSeconds || 60);
    const perWindow = optionalPositiveIntegerOrNull(limits.requestsPerWindow, "policy.limits.requestsPerWindow");
    if (perWindow === null) next.requestsPerMinute = null;
    else if (perWindow !== undefined) {
      next.requestsPerMinute = windowSeconds === 60
        ? perWindow
        : Math.max(1, Math.round((perWindow * 60) / windowSeconds));
    }
  }

  const maxConcurrentEffects = optionalPositiveIntegerOrNull(
    root.maxConcurrentEffects ?? limits?.maxConcurrentEffects,
    "maxConcurrentEffects",
  );
  if (maxConcurrentEffects !== undefined) next.maxConcurrentEffects = maxConcurrentEffects;

  if (Object.keys(next).length === 0) {
    throw new Error("API Key draft config did not contain any recognized fields.");
  }
  return next;
}
