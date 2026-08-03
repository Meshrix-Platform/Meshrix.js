export type ApiKeyDraftConfigFields = {
  workloadDisplayName: string;
  organizationNodeId: string;
  expiresAt: string;
  maximumRisk: "low" | "medium" | "high";
  selectedProfileId: string;
  selectedToolsetIds: string[];
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
  maximumRisk?: "low" | "medium" | "high";
  selectedProfileId?: string;
  selectedToolsetIds?: string[];
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
  knownClassificationIds: ReadonlySet<string>;
  knownProfileIds: ReadonlySet<string>;
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
    maximumRisk: draft.maximumRisk,
    selectedProfileId: draft.selectedProfileId || undefined,
    selectedToolsetIds: [...draft.selectedToolsetIds],
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

  const targetIds = filterKnown(
    optionalStringList(root.selectedTargetIds ?? audience?.targetIds, "selectedTargetIds"),
    context.knownTargetIds,
  );
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
