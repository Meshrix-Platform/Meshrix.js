import crypto from "node:crypto";

import {
  QUEUE_DEFINITION_STATES,
  assertQueueDefinitionCanEnqueue,
  normalizeQueueLabel,
  normalizeStructuredQueueScope
} from "./definitions.ts";
import { resolveQueueMaxInFlight } from "./policies.ts";

export const QUEUE_DEFINITION_REGISTRY_VERSION: any = "v0.0.1:workflow:work-queue-definition-registry-1";

const DEFAULT_QUEUE_DEFINITION_VERSION: any = 1;

function toText(value?: any) : any {
  return String(value ?? "").trim();
}

function asObject(value?: any, fallback: Record<string, any> | null = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;
}

function asArray(value: any = []) : any {
  return Array.isArray(value) ? value : [];
}

function nowIso() : any {
  return new Date().toISOString();
}

function deterministicStringify(value?: any) : any {
  if (value === undefined) return "u";
  if (value === null) return "n";
  if (typeof value === "string") return `s:${JSON.stringify(value)}`;
  if (typeof value === "number") return `d:${Number.isNaN(value) ? "NaN" : String(value)}`;
  if (typeof value === "boolean") return value ? "b:1" : "b:0";
  if (typeof value === "bigint") return `i:${value.toString()}`;
  if (Array.isArray(value)) {
    return `a:[${value.map(deterministicStringify).join(",")}]`;
  }
  if (value instanceof Date) {
    return `t:${value.toISOString()}`;
  }
  if (typeof value === "object") {
    return `o:{${Object.keys(value).sort().map((key?: any) : any => `${JSON.stringify(key)}=${deterministicStringify(value[key])}`).join(",")}}`;
  }
  throw new TypeError(`Unsupported queue dedupe key value type: ${typeof value}`);
}

export function stableQueueDefinitionId({ label, ownerCapability }: Record<string, any> = {}) : any {
  const normalizedLabel: any = normalizeQueueLabel(label);
  const normalizedOwner: any = toText(ownerCapability || "system");
  if (!normalizedOwner) {
    throw new Error("Queue definition owner capability is required.");
  }
  const slug: any = `${normalizedOwner}.${normalizedLabel}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "queue";
  const digest: any = crypto.createHash("sha256")
    .update(`${normalizedOwner}\0${normalizedLabel}`)
    .digest("hex")
    .slice(0, 16);
  return `wqdef_${slug}_${digest}`;
}

export function queueDefinitionDigest(definition: Record<string, any> = {}) : any {
  const metadata: Record<string, any> = { ...asObject(definition.metadata) };
  delete metadata.definitionDigest;
  return crypto.createHash("sha256")
    .update(deterministicStringify({
      queueDefinitionId: toText(definition.queueDefinitionId),
      queueDefinitionVersion: Number(definition.queueDefinitionVersion || 0),
      label: toText(definition.label),
      lifecycleState: toText(definition.lifecycleState),
      ownerCapability: toText(definition.ownerCapability),
      allowDeprecatedEnqueue: definition.allowDeprecatedEnqueue === true,
      labelHistory: asArray(definition.labelHistory),
      metadata,
      policy: asObject(definition.policy),
      routes: asArray(definition.routes)
    }))
    .digest("hex");
}

export function normalizeQueueDedupeKey(value?: any) : any {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  return crypto.createHash("sha256").update(deterministicStringify(value)).digest("hex");
}

function asPositiveInt(value?: any, fallback: any = DEFAULT_QUEUE_DEFINITION_VERSION) : any {
  if (value === undefined || value === null) {
    return fallback;
  }
  const text: any = String(value).trim();
  if (!text) {
    return fallback;
  }
  const parsed: any = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
    throw new Error("Queue definition version must be a positive integer.");
  }
  return parsed;
}

function latestVersion(entries: any = []) : any {
  if (!entries.length) {
    return 0;
  }
  return entries[entries.length - 1].queueDefinitionVersion;
}

function normalizeScopeWithValidator({ definition, scope, structuredScopeValidation }: Record<string, any>) : any {
  const defaultScope: any = normalizeStructuredQueueScope(scope);
  if (typeof structuredScopeValidation !== "function") {
    return defaultScope;
  }

  const candidate: any = structuredScopeValidation({
    scope: defaultScope,
    queueDefinition: definition
  });

  if (candidate === false) {
    throw new Error(`Queue definition ${definition.queueDefinitionId} has invalid structured scope.`);
  }
  if (candidate === true || candidate === undefined || candidate === null) {
    return defaultScope;
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error(`Queue definition ${definition.queueDefinitionId} scope validation must return an object.`);
  }
  return normalizeStructuredQueueScope(candidate);
}

function normalizeDedupeInput({ dedupeKey, definition, scope, dedupeKeyNormalizer }: Record<string, any>) : any {
  if (typeof dedupeKeyNormalizer === "function") {
    const normalized: any = dedupeKeyNormalizer({
      dedupeKey,
      scope,
      queueDefinition: definition
    });
    if (typeof normalized !== "string") {
      throw new Error("Dedupe key normalizer must return a string.");
    }
    return normalized;
  }
  return normalizeQueueDedupeKey(dedupeKey);
}

function normalizeQueueDefinitionPolicy(value: Record<string, any> = {}) : any {
  const source: any = asObject(value);
  if (!Object.prototype.hasOwnProperty.call(source, "maxInFlight")) {
    return source;
  }
  const maxInFlight: any = resolveQueueMaxInFlight(source.maxInFlight);
  return {
    ...source,
    maxInFlight: maxInFlight.limit,
    requestedMaxInFlight: maxInFlight.normalizedRequested,
    hardMaxInFlight: maxInFlight.hardLimit,
    maxInFlightClamped: maxInFlight.clamped
  };
}

function normalizeQueueDefinitionShape(input: Record<string, any> = {}, overrides: Record<string, any> = {}) : any {
  const source: any = asObject(input);
  const label: any = normalizeQueueLabel(source.label || source.name || source.queueName || source.intent);
  const ownerCapability: any = toText(source.ownerCapability || source.owner || source.capability || "system");
  const explicitIdentity: any = ["queueDefinitionId", "id", "queueId", "idAlias", "idempotentId"]
    .some((key?: any) : any => toText(source[key]));
  const queueDefinitionId: any = toText(
    source.queueDefinitionId ||
    source.id ||
    source.queueId ||
    source.idAlias ||
    source.idempotentId ||
    stableQueueDefinitionId({ label, ownerCapability })
  );
  const lifecycleState: any = toText(source.lifecycleState || QUEUE_DEFINITION_STATES.ACTIVE);
  const allowDeprecatedEnqueue: any = source.allowDeprecatedEnqueue === true;
  const versionValue: any = source.queueDefinitionVersion ?? source.version;
  const explicitVersion: any = source.queueDefinitionVersion === undefined && source.version === undefined
    ? null
    : asPositiveInt(versionValue, null);
  const structuredScopeValidation: any = typeof source.structuredScopeValidation === "function"
    ? source.structuredScopeValidation
    : typeof overrides.structuredScopeValidation === "function"
      ? overrides.structuredScopeValidation
      : null;
  const dedupeKeyNormalizer: any = typeof source.dedupeKeyNormalizer === "function"
    ? source.dedupeKeyNormalizer
    : typeof overrides.dedupeKeyNormalizer === "function"
      ? overrides.dedupeKeyNormalizer
      : null;

  if (!queueDefinitionId) {
    throw new Error("Queue definition id is required.");
  }
  if (!ownerCapability) {
    throw new Error("Queue definition owner capability is required.");
  }
  if (!(Object.values(QUEUE_DEFINITION_STATES) as any[]).includes(lifecycleState)) {
    throw new Error(`Unknown queue definition lifecycle state: ${lifecycleState}`);
  }

  return {
    queueDefinitionId,
    explicitIdentity,
    label,
    ownerCapability,
    lifecycleState,
    allowDeprecatedEnqueue,
    explicitVersion,
    structuredScopeValidation,
    dedupeKeyNormalizer,
    metadata: asObject(source.metadata),
    policy: normalizeQueueDefinitionPolicy(source.policy),
    routes: asArray(source.routes)
  };
}

function freezeDefinition(definition?: any) : any {
  return Object.freeze(definition);
}

export function createQueueDefinitionRegistry({
  structuredScopeValidation = null,
  dedupeKeyNormalizer = null
}: Record<string, any> = {}) : any {
  const byId: any = new Map<any, any>();
  const byLabel: any = new Map<any, any>();

  function assertLabelBelongsToDefinition(label?: any, queueDefinitionId?: any) : any {
    const existing: any = byLabel.get(label);
    if (existing && existing.queueDefinitionId !== queueDefinitionId) {
      throw new Error(`Queue definition label is already in use: ${label}`);
    }
  }

  function getVersions(queueDefinitionId?: any) : any {
    return byId.get(queueDefinitionId) || [];
  }

  function registerQueueDefinition(input: Record<string, any> = {}) : any {
    const definitionInput: any = normalizeQueueDefinitionShape(input, {
      structuredScopeValidation,
      dedupeKeyNormalizer
    });
    const versions: any = getVersions(definitionInput.queueDefinitionId);
    if (versions.length > 0 && definitionInput.explicitIdentity !== true) {
      throw new Error(`Queue definition label is already in use: ${definitionInput.label}`);
    }
    assertLabelBelongsToDefinition(
      definitionInput.label,
      definitionInput.queueDefinitionId
    );

    const nextVersion: any = definitionInput.explicitVersion === null
      ? latestVersion(versions) + 1
      : definitionInput.explicitVersion;

    if (versions.length && versions.some((version?: any) : any => version.queueDefinitionVersion === nextVersion)) {
      throw new Error(`Queue definition version ${nextVersion} already exists for ${definitionInput.queueDefinitionId}.`);
    }
    if (definitionInput.explicitVersion !== null && latestVersion(versions) >= nextVersion) {
      throw new Error(`Queue definition version must be greater than existing latest for ${definitionInput.queueDefinitionId}.`);
    }

    const previous: any = versions.length ? versions[versions.length - 1] : null;
    if (previous && previous.ownerCapability !== definitionInput.ownerCapability) {
      throw new Error(`Queue definition owner cannot change for ${definitionInput.queueDefinitionId}.`);
    }
    const labelHistory: any = previous
      ? previous.label === definitionInput.label
        ? previous.labelHistory
        : [...previous.labelHistory, previous.label]
      : [];
    const definitionShape: Record<string, any> = {
      queueDefinitionId: definitionInput.queueDefinitionId,
      queueDefinitionVersion: nextVersion,
      label: definitionInput.label,
      lifecycleState: definitionInput.lifecycleState,
      ownerCapability: definitionInput.ownerCapability,
      allowDeprecatedEnqueue: definitionInput.allowDeprecatedEnqueue,
      labelHistory: Object.freeze(labelHistory),
      structuredScopeValidation: definitionInput.structuredScopeValidation,
      dedupeKeyNormalizer: definitionInput.dedupeKeyNormalizer,
      metadata: definitionInput.metadata,
      policy: definitionInput.policy,
      routes: definitionInput.routes
    };
    const definitionDigest: any = queueDefinitionDigest(definitionShape);
    const definition: any = freezeDefinition({
      ...definitionShape,
      metadata: Object.freeze({
        ...definitionInput.metadata,
        definitionDigest
      }),
      definitionDigest,
      registeredAt: nowIso(),
      protocolVersion: QUEUE_DEFINITION_REGISTRY_VERSION
    });

    byId.set(definitionInput.queueDefinitionId, [...versions, definition]);
    byLabel.set(definitionInput.label, definition);
    return definition;
  }

  function resolveQueueDefinition({
    queueDefinitionId = "",
    queueDefinitionVersion,
    label
  }: Record<string, any> = {}) : any {
    const byLabelMatch: any = label ? byLabel.get(normalizeQueueLabel(label)) : null;
    const targetId: any = toText(queueDefinitionId || byLabelMatch?.queueDefinitionId);
    if (!targetId) {
      throw new Error("Queue definition resolution requires queueDefinitionId or label.");
    }
    const versions: any = getVersions(targetId);
    if (!versions.length) {
      throw new Error(`Queue definition unresolved: ${targetId}`);
    }

    if (label && byLabelMatch && byLabelMatch.queueDefinitionId !== targetId) {
      throw new Error(`Queue definition unresolved: label ${label} does not match ${targetId}`);
    }

    if (queueDefinitionVersion === undefined) {
      return versions[versions.length - 1];
    }

    const requestedVersion: any = asPositiveInt(queueDefinitionVersion);
    const matched: any = versions.find((entry?: any) : any => entry.queueDefinitionVersion === requestedVersion);
    if (!matched) {
      throw new Error(`Queue definition unresolved: ${targetId} version ${requestedVersion}`);
    }
    return matched;
  }

  function resolveQueueDefinitionForEnqueue({
    queueDefinitionId = "",
    queueDefinitionVersion,
    label,
    scope,
    dedupeKey,
    allowDeprecatedEnqueue = false
  }: Record<string, any> = {}) : any {
    const definition: any = resolveQueueDefinition({ queueDefinitionId, queueDefinitionVersion, label });
    const normalizedScope: any = normalizeScopeWithValidator({
      definition,
      scope,
      structuredScopeValidation: definition.structuredScopeValidation
    });

    assertQueueDefinitionCanEnqueue({
      ...definition,
      allowDeprecatedEnqueue
    });

    return freezeDefinition({
      queueDefinitionId: definition.queueDefinitionId,
      queueDefinitionVersion: definition.queueDefinitionVersion,
      queueDefinition: definition,
      scope: normalizedScope,
      dedupeKey: normalizeDedupeInput({
        dedupeKey,
        definition,
        scope: normalizedScope,
        dedupeKeyNormalizer: definition.dedupeKeyNormalizer
      })
    });
  }

  function listDefinitions() : any {
    const all: any = [...byId.values()].flatMap((versions?: any) : any => versions);
    return all.map((definition?: any) : any => ({
      queueDefinitionId: definition.queueDefinitionId,
      queueDefinitionVersion: definition.queueDefinitionVersion,
      label: definition.label,
      lifecycleState: definition.lifecycleState,
      ownerCapability: definition.ownerCapability
    }));
  }

  function describe() : any {
    return {
      protocolVersion: QUEUE_DEFINITION_REGISTRY_VERSION,
      definitionCount: byLabel.size,
      definitions: listDefinitions()
    };
  }

  function normalizeDedupeKeyForDefinition(definition?: any, inputScope?: any, inputDedupeKey?: any) : any {
    const normalizedScope: any = normalizeScopeWithValidator({
      definition,
      scope: inputScope,
      structuredScopeValidation: definition.structuredScopeValidation
    });
    return normalizeDedupeInput({
      dedupeKey: inputDedupeKey,
      definition,
      scope: normalizedScope,
      dedupeKeyNormalizer: definition.dedupeKeyNormalizer
    });
  }

  return {
    registerQueueDefinition,
    resolveQueueDefinition,
    resolveQueueDefinitionForEnqueue,
    normalizeDedupeKeyForDefinition,
    listDefinitions,
    describe
  };
}
