export const SERVICE_COLLABORATION_SCHEMA_VERSION: any = "v0.0.1:service-collaboration:wire-1";
export const SERVICE_COLLABORATION_REPORT_SCHEMA_VERSION: any = "v0.0.1:service-collaboration:report-1";
export const SERVICE_COLLABORATION_PROTOCOL_VERSION: any = "2026-07-28";
export const SERVICE_COLLABORATION_CORE_STATE_GENERATION: any = "meshrix-core-state-1";
export const SERVICE_COLLABORATION_PROFILE: any = "service-collaboration";
export const SERVICE_COLLABORATION_FALLBACK_PATH: any = "ordinary-mcp";

export const SERVICE_COLLABORATION_SUBSCRIBE_METHOD: any = "subscriptions/listen";
export const SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD: any = "notifications/resources/updated";
export const SERVICE_COLLABORATION_FALLBACK_METHODS: readonly any[] = Object.freeze([
  "tools/call",
  "resources/read",
  "resources/list"
]);
export const SERVICE_COLLABORATION_PROFILE_METHODS: readonly any[] = Object.freeze([
  "meshrix/collaboration/open",
  "meshrix/collaboration/observe",
  "meshrix/collaboration/commit",
  "meshrix/collaboration/acknowledge",
  "meshrix/collaboration/rebase",
  "meshrix/collaboration/resync",
  "meshrix/collaboration/effect",
  SERVICE_COLLABORATION_SUBSCRIBE_METHOD,
  SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD
]);

export const SERVICE_COLLABORATION_FAMILIES: readonly any[] = Object.freeze([
  "document-state",
  "effect-command"
]);
export const SERVICE_COLLABORATION_VERBS: readonly any[] = Object.freeze([
  "open",
  "observe",
  "edit",
  "commit",
  "acknowledge",
  "subscribe",
  "rebase",
  "resync"
]);
export const SERVICE_COLLABORATION_KINDS: readonly any[] = Object.freeze([
  "open-request",
  "open-response",
  "observe-request",
  "observe-response",
  "edit-view",
  "commit-request",
  "acknowledge",
  "subscribe-request",
  "resource-updated",
  "rebase-request",
  "rebase-response",
  "resync-request",
  "resync-response",
  "effect-command",
  "fallback"
]);
export const SERVICE_COLLABORATION_CACHE_SCOPES: readonly any[] = Object.freeze([
  "public",
  "private"
]);
export const SERVICE_COLLABORATION_PRIVATE_KINDS: readonly any[] = Object.freeze([
  "open-response",
  "observe-request",
  "observe-response",
  "commit-request",
  "acknowledge",
  "subscribe-request",
  "resource-updated",
  "rebase-request",
  "rebase-response",
  "resync-request",
  "resync-response",
  "effect-command"
]);
export const SERVICE_COLLABORATION_CURSOR_STATES: readonly any[] = Object.freeze([
  "valid",
  "expired"
]);
export const SERVICE_COLLABORATION_OPERATION_TYPES: readonly any[] = Object.freeze([
  "insert",
  "update",
  "delete",
  "move",
  "retain"
]);
export const SERVICE_COLLABORATION_REBASEABLE_OPERATION_TYPES: readonly any[] = Object.freeze([
  "insert",
  "update",
  "delete",
  "retain"
]);
export const SERVICE_COLLABORATION_UNREBASEABLE_OPERATION_TYPES: readonly any[] = Object.freeze([
  "move"
]);
export const SERVICE_COLLABORATION_VISIBILITY: any = "atomic";
export const SERVICE_COLLABORATION_DELTA_ORDERING: any = "cursor-indexed-monotonic";
export const SERVICE_COLLABORATION_EFFECT_IDEMPOTENCY: readonly any[] = Object.freeze([
  "idempotent",
  "non_idempotent"
]);
export const SERVICE_COLLABORATION_EFFECT_RESULT_STATES: readonly any[] = Object.freeze([
  "accepted",
  "terminal",
  "uncertain",
  "cancelled"
]);
export const SERVICE_COLLABORATION_CANCELLATION_STATES: readonly any[] = Object.freeze([
  "none",
  "requested",
  "cancelled"
]);
export const SERVICE_COLLABORATION_REBASE_OUTCOMES: readonly any[] = Object.freeze([
  "rebased",
  "conflict"
]);
export const SERVICE_COLLABORATION_RESYNC_OUTCOMES: readonly any[] = Object.freeze([
  "delta",
  "snapshot-tail",
  "overload",
  "resync_required",
  "cancelled",
  "backpressure"
]);
export const SERVICE_COLLABORATION_CONFLICT_CODES: readonly any[] = Object.freeze([
  "conflict.concurrent_edit",
  "conflict.stale_baseline",
  "conflict.unrebasable_operation",
  "conflict.authorization_changed",
  "conflict.cursor_expired",
  "conflict.budget_exceeded",
  "conflict.overload",
  "conflict.resync_required",
  "conflict.effect_uncertain",
  "conflict.effect_not_retryable",
  "conflict.second_core_generation",
  "conflict.unknown_required_field",
  "conflict.index_collision"
]);
export const SERVICE_COLLABORATION_LOOKUP_FACTS: readonly any[] = Object.freeze([
  "handle",
  "cursor",
  "cachedBytes",
  "connectionState",
  "earlierDiscovery",
  "priorApproval"
]);
export const SERVICE_COLLABORATION_PRIVACY_FORBIDDEN_KEYS: readonly any[] = Object.freeze([
  "apiKey",
  "authorization",
  "backendRow",
  "content",
  "credential",
  "credentials",
  "grantId",
  "location",
  "log",
  "machinePath",
  "password",
  "path",
  "privateKey",
  "prompt",
  "prompts",
  "runtimeLog",
  "serviceLocation",
  "subject",
  "token"
]);
export const SERVICE_COLLABORATION_CRDT_FORBIDDEN_KEYS: readonly any[] = Object.freeze([
  "automerge",
  "automergeChange",
  "crdt",
  "crdtLibrary",
  "crdtState",
  "yjs",
  "yjsUpdate"
]);
export const SERVICE_COLLABORATION_LOCAL_ROLLBACK_REVERSES_EFFECT: any = false;
export const SERVICE_COLLABORATION_SILENT_UNCERTAIN_RETRY: any = false;
export const SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED: any = false;

export const SERVICE_COLLABORATION_LIMITS: any = Object.freeze({
  maxIdentityBytes: 128,
  maxHandleBytes: 64,
  maxCursorBytes: 128,
  maxUriBytes: 256,
  maxDigestBytes: 71,
  maxCodeBytes: 64,
  maxOperationsPerChangeSet: 64,
  maxChangeSetBytes: 16_384,
  maxEntitiesPerWorkingSet: 256,
  maxResourceLinks: 64,
  maxDeltaPage: 32,
  maxHistoryEntries: 32,
  maxResultFacts: 32,
  maxConflicts: 16,
  maxInvalidations: 16,
  maxSubscriptions: 8,
  maxSnapshotBytes: 65_536,
  maxTailOps: 32,
  maxRelevantIndexes: 32,
  minHandleChars: 8,
  minCursorChars: 8
});

const FAIL: any = Symbol("service-collaboration-fail");
const IDENTITY_PATTERN: any = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;
const HANDLE_PATTERN: any = /^[A-Za-z0-9_-]+$/u;
const CURSOR_PATTERN: any = /^[A-Za-z0-9._:-]+$/u;
const DIGEST_PATTERN: any = /^sha256:[a-f0-9]{64}$/u;
const RESOURCE_URI_PATTERN: any = /^meshrix:\/\/collaboration\/[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/u;
const KIND_PARSERS: Record<string, any> = {};

function isPlainObject(value?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: any = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value?: any, expected?: any) : any {
  if (!isPlainObject(value)) return false;
  const keys: any = Object.keys(value).sort();
  return keys.length === expected.length && expected.every((key?: any, index?: any) : any => key === keys[index]);
}

function boundedText(value?: any, maxBytes: any = SERVICE_COLLABORATION_LIMITS.maxIdentityBytes) : any {
  if (typeof value !== "string") return "";
  const normalized: any = value.trim();
  return normalized && Buffer.byteLength(normalized, "utf8") <= maxBytes ? normalized : "";
}

function revision(value?: any) : any {
  return Number.isSafeInteger(value) && value >= 0 ? value : FAIL;
}

function trueFlag(value?: any) : any {
  return value === true ? true : FAIL;
}

function enumValue(value?: any, allowed?: any) : any {
  return allowed.includes(value) ? value : FAIL;
}

function opaqueId(value?: any, maxBytes: any = SERVICE_COLLABORATION_LIMITS.maxIdentityBytes) : any {
  const normalized: any = boundedText(value, maxBytes);
  return normalized && IDENTITY_PATTERN.test(normalized) ? normalized : FAIL;
}

function handleToken(value?: any) : any {
  const normalized: any = boundedText(value, SERVICE_COLLABORATION_LIMITS.maxHandleBytes);
  return normalized
    && normalized.length >= SERVICE_COLLABORATION_LIMITS.minHandleChars
    && HANDLE_PATTERN.test(normalized)
    ? normalized
    : FAIL;
}

function cursorToken(value?: any) : any {
  const normalized: any = boundedText(value, SERVICE_COLLABORATION_LIMITS.maxCursorBytes);
  return normalized
    && normalized.length >= SERVICE_COLLABORATION_LIMITS.minCursorChars
    && CURSOR_PATTERN.test(normalized)
    ? normalized
    : FAIL;
}

function resourceUri(value?: any) : any {
  const normalized: any = boundedText(value, SERVICE_COLLABORATION_LIMITS.maxUriBytes);
  return normalized && RESOURCE_URI_PATTERN.test(normalized) ? normalized : FAIL;
}

function digest(value?: any) : any {
  const normalized: any = boundedText(value, SERVICE_COLLABORATION_LIMITS.maxDigestBytes);
  return normalized && DIGEST_PATTERN.test(normalized) ? normalized : FAIL;
}

function codeToken(value?: any) : any {
  const normalized: any = boundedText(value, SERVICE_COLLABORATION_LIMITS.maxCodeBytes);
  return normalized && IDENTITY_PATTERN.test(normalized) ? normalized : FAIL;
}

function uniqueIds(value?: any, max: any = SERVICE_COLLABORATION_LIMITS.maxEntitiesPerWorkingSet) : any {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return FAIL;
  const ids: any = value.map((entry?: any) : any => opaqueId(entry));
  if (ids.includes(FAIL) || new Set<any>(ids).size !== ids.length) return FAIL;
  return Object.freeze(ids);
}

function optionalUniqueIds(value?: any, max: any = SERVICE_COLLABORATION_LIMITS.maxEntitiesPerWorkingSet) : any {
  if (!Array.isArray(value) || value.length > max) return FAIL;
  const ids: any = value.map((entry?: any) : any => opaqueId(entry));
  if (ids.includes(FAIL) || new Set<any>(ids).size !== ids.length) return FAIL;
  return Object.freeze(ids);
}

function uniqueIndexes(value?: any) : any {
  if (!Array.isArray(value) || value.length > SERVICE_COLLABORATION_LIMITS.maxRelevantIndexes) return FAIL;
  const indexes: any = value.map((entry?: any) : any => revision(entry));
  if (indexes.includes(FAIL) || new Set<any>(indexes).size !== indexes.length) return FAIL;
  const sorted: any = [...indexes].sort((left?: any, right?: any) : any => left - right);
  return indexes.every((entry?: any, index?: any) : any => entry === sorted[index]) ? Object.freeze(indexes) : FAIL;
}

function parseObject(value?: any, spec?: any) : any {
  const keys: any = Object.keys(spec).sort();
  if (!hasExactKeys(value, keys) || containsForbiddenKeys(value)) return null;
  const output: Record<string, any> = {};
  for (const key of Object.keys(spec)) {
    const parsed: any = spec[key](value[key], value);
    if (parsed === FAIL) return null;
    output[key] = parsed;
  }
  return Object.freeze(output);
}

function parseArray(value?: any, parseItem?: any, max?: any, allowEmpty: any = true) : any {
  if (!Array.isArray(value) || value.length > max || (!allowEmpty && value.length === 0)) return FAIL;
  const items: any = value.map((entry?: any) : any => parseItem(entry));
  if (items.some((entry?: any) : any => entry === FAIL || entry == null)) return FAIL;
  return Object.freeze(items);
}

function created(parseFn?: any, value?: any, message?: any) : any {
  const parsed: any = parseFn(value);
  if (!parsed) throw new TypeError(message);
  return parsed;
}

function envelope(kind?: any, extras: Record<string, any> = {}) : any {
  return {
    schemaVersion: SERVICE_COLLABORATION_SCHEMA_VERSION,
    protocolVersion: SERVICE_COLLABORATION_PROTOCOL_VERSION,
    coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION,
    kind,
    ...extras
  };
}

export function containsForbiddenKeys(value?: any, seen: any = new WeakSet<object>()) : any {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const keys: any = Object.keys(value);
  if (keys.some((key?: any) : any => (
    SERVICE_COLLABORATION_PRIVACY_FORBIDDEN_KEYS.includes(key)
    || SERVICE_COLLABORATION_CRDT_FORBIDDEN_KEYS.includes(key)
  ))) return true;
  return Object.values(value).some((entry?: any) : any => containsForbiddenKeys(entry, seen));
}

export function requiredCacheScopeFor(kind?: any) : any {
  return SERVICE_COLLABORATION_PRIVATE_KINDS.includes(kind) ? "private" : "public";
}

export function parseCacheHint(value?: any, kind: any = "") : any {
  const parsed: any = parseObject(value, {
    ttlMs: (entry?: any) : any => Number.isSafeInteger(entry) && entry >= 0 ? entry : FAIL,
    cacheScope: (entry?: any) : any => enumValue(entry, SERVICE_COLLABORATION_CACHE_SCOPES)
  });
  if (!parsed) return null;
  if (kind && requiredCacheScopeFor(kind) === "private" && parsed.cacheScope !== "private") return null;
  return parsed;
}

export function parseCursor(value?: any) : any {
  return parseObject(value, {
    cursor: (entry?: any) : any => cursorToken(entry),
    indexedHead: revision,
    cursorState: (entry?: any) : any => enumValue(entry, SERVICE_COLLABORATION_CURSOR_STATES)
  });
}

export function parseHandle(value?: any) : any {
  return parseObject(value, {
    handle: (entry?: any) : any => handleToken(entry),
    entityId: (entry?: any) : any => opaqueId(entry)
  });
}

export function parseResourceLink(value?: any, kind: any = "observe-response") : any {
  return parseObject(value, {
    uri: (entry?: any) : any => resourceUri(entry),
    head: revision,
    cacheHint: (entry?: any) : any => parseCacheHint(entry, kind) || FAIL
  });
}

export function parseOperation(value?: any) : any {
  return parseObject(value, {
    opId: (entry?: any) : any => opaqueId(entry),
    type: (entry?: any) : any => enumValue(entry, SERVICE_COLLABORATION_OPERATION_TYPES),
    entityId: (entry?: any) : any => opaqueId(entry),
    index: revision,
    relevantIndexes: uniqueIndexes,
    payloadDigest: digest
  });
}

export function parseChangeSet(value?: any) : any {
  const parsed: any = parseObject(value, {
    changeId: (entry?: any) : any => opaqueId(entry),
    baselineHead: revision,
    operations: (entry?: any) : any => {
      const operations: any = parseArray(entry, parseOperation, SERVICE_COLLABORATION_LIMITS.maxOperationsPerChangeSet, false);
      if (operations === FAIL) return FAIL;
      const opIds: any = operations.map((item?: any) : any => item.opId);
      return new Set<any>(opIds).size === opIds.length ? operations : FAIL;
    },
    attributionRef: (entry?: any) : any => opaqueId(entry),
    family: (entry?: any) : any => entry === "document-state" ? entry : FAIL,
    visibility: (entry?: any) : any => entry === SERVICE_COLLABORATION_VISIBILITY ? entry : FAIL
  });
  if (!parsed) return null;
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > SERVICE_COLLABORATION_LIMITS.maxChangeSetBytes) return null;
  return parsed;
}

export function parseResultFact(value?: any) : any {
  return parseObject(value, {
    code: (entry?: any) : any => codeToken(entry),
    entityId: (entry?: any) : any => opaqueId(entry)
  });
}

export function parseConflictFact(value?: any) : any {
  return parseObject(value, {
    code: (entry?: any) : any => enumValue(entry, SERVICE_COLLABORATION_CONFLICT_CODES),
    entityId: (entry?: any) : any => opaqueId(entry),
    head: revision
  });
}

export function parseInvalidationFact(value?: any) : any {
  return parseObject(value, {
    code: (entry?: any) : any => codeToken(entry),
    resourceUri: (entry?: any) : any => resourceUri(entry)
  });
}

export function parseHistoryEntry(value?: any) : any {
  return parseObject(value, {
    head: revision,
    changeId: (entry?: any) : any => opaqueId(entry),
    entityIds: (entry?: any) : any => uniqueIds(entry)
  });
}

export function parseAcknowledgementFact(value?: any) : any {
  return parseObject(value, {
    head: revision,
    changeId: (entry?: any) : any => opaqueId(entry)
  });
}

export function parseSnapshot(value?: any) : any {
  const parsed: any = parseObject(value, {
    snapshotId: (entry?: any) : any => opaqueId(entry),
    head: revision,
    entityIds: (entry?: any) : any => uniqueIds(entry),
    resourceUris: (entry?: any) : any => {
      if (!Array.isArray(entry) || entry.length === 0 || entry.length > SERVICE_COLLABORATION_LIMITS.maxResourceLinks) {
        return FAIL;
      }
      const uris: any = entry.map((item?: any) : any => resourceUri(item));
      return uris.includes(FAIL) || new Set<any>(uris).size !== uris.length ? FAIL : Object.freeze(uris);
    },
    byteLength: (entry?: any) : any => (
      Number.isSafeInteger(entry) && entry >= 0 && entry <= SERVICE_COLLABORATION_LIMITS.maxSnapshotBytes
        ? entry
        : FAIL
    )
  });
  return parsed;
}

export function parseDelta(value?: any) : any {
  return parseObject(value, {
    head: revision,
    opIndex: revision,
    operation: (entry?: any) : any => parseOperation(entry) || FAIL
  });
}

export function orderDeltas(value?: any) : any {
  if (!Array.isArray(value) || value.length > SERVICE_COLLABORATION_LIMITS.maxDeltaPage) return null;
  const deltas: any = value.map((entry?: any) : any => parseDelta(entry));
  if (deltas.includes(null)) return null;
  for (let index = 1; index < deltas.length; index += 1) {
    const previous: any = deltas[index - 1];
    const current: any = deltas[index];
    if (current.head < previous.head) return null;
    if (current.head === previous.head && current.opIndex <= previous.opIndex) return null;
  }
  return Object.freeze(deltas);
}

function parseHandles(value?: any, entityIds?: any) : any {
  if (!Array.isArray(value) || value.length !== entityIds.length) return FAIL;
  const handles: any[] = [];
  const tokens: any = new Set<any>();
  for (let index = 0; index < value.length; index += 1) {
    const parsed: any = parseHandle(value[index]);
    if (!parsed || tokens.has(parsed.handle) || parsed.entityId !== entityIds[index]) return FAIL;
    tokens.add(parsed.handle);
    handles.push(parsed);
  }
  return Object.freeze(handles);
}

function parseResourceLinks(value?: any, kind?: any) : any {
  if (!Array.isArray(value) || value.length === 0 || value.length > SERVICE_COLLABORATION_LIMITS.maxResourceLinks) {
    return FAIL;
  }
  const links: any = value.map((entry?: any) : any => parseResourceLink(entry, kind));
  if (links.includes(null)) return FAIL;
  const uris: any = links.map((entry?: any) : any => entry.uri);
  return new Set<any>(uris).size === uris.length ? Object.freeze(links) : FAIL;
}

function commonRemote(kind?: any, verb?: any, extra: Record<string, any> = {}) : any {
  return {
    schemaVersion: (entry?: any) : any => entry === SERVICE_COLLABORATION_SCHEMA_VERSION ? entry : FAIL,
    protocolVersion: (entry?: any) : any => entry === SERVICE_COLLABORATION_PROTOCOL_VERSION ? entry : FAIL,
    coreStateGeneration: (entry?: any) : any => (
      entry === SERVICE_COLLABORATION_CORE_STATE_GENERATION ? entry : FAIL
    ),
    kind: (entry?: any) : any => entry === kind ? entry : FAIL,
    verb: (entry?: any) : any => entry === verb ? entry : FAIL,
    authorizationReResolved: trueFlag,
    ...extra
  };
}

export function parseOpenRequest(value?: any) : any {
  return parseObject(value, commonRemote("open-request", "open", {
    workingSetRef: (entry?: any) : any => opaqueId(entry),
    resourceRefs: (entry?: any) : any => uniqueIds(entry, SERVICE_COLLABORATION_LIMITS.maxResourceLinks),
    cursor: (entry?: any) : any => parseCursor(entry) || FAIL
  }));
}

export function parseOpenResponse(value?: any) : any {
  return parseObject(value, commonRemote("open-response", "open", {
    workingSetId: (entry?: any) : any => opaqueId(entry),
    entityIds: uniqueIds,
    handles: (entry?: any, record?: any) : any => {
      const entityIds: any = uniqueIds(record.entityIds);
      return entityIds === FAIL ? FAIL : parseHandles(entry, entityIds);
    },
    head: revision,
    resourceLinks: (entry?: any) : any => parseResourceLinks(entry, "open-response"),
    cacheHint: (entry?: any) : any => parseCacheHint(entry, "open-response") || FAIL,
    cursor: (entry?: any) : any => parseCursor(entry) || FAIL
  }));
}

export function parseObserveRequest(value?: any) : any {
  return parseObject(value, commonRemote("observe-request", "observe", {
    workingSetId: (entry?: any) : any => opaqueId(entry),
    handle: (entry?: any) : any => handleToken(entry),
    cursor: (entry?: any) : any => parseCursor(entry) || FAIL
  }));
}

export function parseObserveResponse(value?: any) : any {
  return parseObject(value, commonRemote("observe-response", "observe", {
    workingSetId: (entry?: any) : any => opaqueId(entry),
    head: revision,
    resourceLinks: (entry?: any) : any => parseResourceLinks(entry, "observe-response"),
    catalogRevision: (entry?: any) : any => opaqueId(entry),
    schemaRevision: (entry?: any) : any => opaqueId(entry),
    acknowledgements: (entry?: any) : any => parseArray(
      entry,
      parseAcknowledgementFact,
      SERVICE_COLLABORATION_LIMITS.maxHistoryEntries
    ),
    history: (entry?: any) : any => parseArray(entry, parseHistoryEntry, SERVICE_COLLABORATION_LIMITS.maxHistoryEntries),
    cacheHit: (entry?: any) : any => typeof entry === "boolean" ? entry : FAIL,
    cacheHint: (entry?: any) : any => parseCacheHint(entry, "observe-response") || FAIL
  }));
}

export function parseEditView(value?: any) : any {
  return parseObject(value, {
    schemaVersion: (entry?: any) : any => entry === SERVICE_COLLABORATION_SCHEMA_VERSION ? entry : FAIL,
    coreStateGeneration: (entry?: any) : any => (
      entry === SERVICE_COLLABORATION_CORE_STATE_GENERATION ? entry : FAIL
    ),
    kind: (entry?: any) : any => entry === "edit-view" ? entry : FAIL,
    verb: (entry?: any) : any => entry === "edit" ? entry : FAIL,
    workingSetId: (entry?: any) : any => opaqueId(entry),
    head: revision,
    dirtyEntityIds: optionalUniqueIds,
    omittedUnchanged: trueFlag
  });
}

export function parseCommitRequest(value?: any) : any {
  return parseObject(value, commonRemote("commit-request", "commit", {
    workingSetId: (entry?: any) : any => opaqueId(entry),
    handle: (entry?: any) : any => handleToken(entry),
    dirty: (entry?: any) : any => typeof entry === "boolean" ? entry : FAIL,
    changeSet: (entry?: any, record?: any) : any => {
      if (record.dirty === true) return parseChangeSet(entry) || FAIL;
      return entry === null ? null : FAIL;
    }
  }));
}

export function parseAcknowledge(value?: any) : any {
  return parseObject(value, commonRemote("acknowledge", "acknowledge", {
    workingSetId: (entry?: any) : any => opaqueId(entry),
    assignedHead: revision,
    changedEntityIds: optionalUniqueIds,
    resultFacts: (entry?: any) : any => parseArray(entry, parseResultFact, SERVICE_COLLABORATION_LIMITS.maxResultFacts),
    conflicts: (entry?: any) : any => parseArray(entry, parseConflictFact, SERVICE_COLLABORATION_LIMITS.maxConflicts),
    invalidations: (entry?: any) : any => parseArray(
      entry,
      parseInvalidationFact,
      SERVICE_COLLABORATION_LIMITS.maxInvalidations
    )
  }));
}

export function parseSubscribeRequest(value?: any) : any {
  return parseObject(value, commonRemote("subscribe-request", "subscribe", {
    method: (entry?: any) : any => entry === SERVICE_COLLABORATION_SUBSCRIBE_METHOD ? entry : FAIL,
    notifications: (entry?: any) : any => {
      if (!Array.isArray(entry) || entry.length === 0 || entry.length > SERVICE_COLLABORATION_LIMITS.maxSubscriptions) {
        return FAIL;
      }
      if (!entry.every((item?: any) : any => item === SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD)) return FAIL;
      return Object.freeze([...entry]);
    },
    workingSetId: (entry?: any) : any => opaqueId(entry),
    cursor: (entry?: any) : any => parseCursor(entry) || FAIL,
    cacheHint: (entry?: any) : any => parseCacheHint(entry, "subscribe-request") || FAIL
  }));
}

export function parseResourceUpdatedNotification(value?: any) : any {
  return parseObject(value, {
    schemaVersion: (entry?: any) : any => entry === SERVICE_COLLABORATION_SCHEMA_VERSION ? entry : FAIL,
    protocolVersion: (entry?: any) : any => entry === SERVICE_COLLABORATION_PROTOCOL_VERSION ? entry : FAIL,
    coreStateGeneration: (entry?: any) : any => (
      entry === SERVICE_COLLABORATION_CORE_STATE_GENERATION ? entry : FAIL
    ),
    kind: (entry?: any) : any => entry === "resource-updated" ? entry : FAIL,
    method: (entry?: any) : any => entry === SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD ? entry : FAIL,
    authorizationReResolved: trueFlag,
    resourceUri: (entry?: any) : any => resourceUri(entry),
    head: revision,
    cursor: (entry?: any) : any => parseCursor(entry) || FAIL,
    cacheHint: (entry?: any) : any => parseCacheHint(entry, "resource-updated") || FAIL,
    invalidationCodes: (entry?: any) : any => {
      if (!Array.isArray(entry) || entry.length === 0 || entry.length > SERVICE_COLLABORATION_LIMITS.maxInvalidations) {
        return FAIL;
      }
      const codes: any = entry.map((item?: any) : any => codeToken(item));
      return codes.includes(FAIL) || new Set<any>(codes).size !== codes.length ? FAIL : Object.freeze(codes);
    }
  });
}

export function parseRebaseRequest(value?: any) : any {
  return parseObject(value, commonRemote("rebase-request", "rebase", {
    workingSetId: (entry?: any) : any => opaqueId(entry),
    handle: (entry?: any) : any => handleToken(entry),
    baselineHead: revision,
    operations: (entry?: any) : any => parseArray(
      entry,
      parseOperation,
      SERVICE_COLLABORATION_LIMITS.maxOperationsPerChangeSet,
      false
    ),
    cursor: (entry?: any) : any => parseCursor(entry) || FAIL
  }));
}

export function parseRebaseResponse(value?: any) : any {
  return parseObject(value, commonRemote("rebase-response", "rebase", {
    workingSetId: (entry?: any) : any => opaqueId(entry),
    head: revision,
    outcome: (entry?: any) : any => enumValue(entry, SERVICE_COLLABORATION_REBASE_OUTCOMES),
    rebasedOperations: (entry?: any) : any => parseArray(
      entry,
      parseOperation,
      SERVICE_COLLABORATION_LIMITS.maxOperationsPerChangeSet
    ),
    conflicts: (entry?: any) : any => parseArray(entry, parseConflictFact, SERVICE_COLLABORATION_LIMITS.maxConflicts),
    cursor: (entry?: any) : any => parseCursor(entry) || FAIL
  }));
}

export function parseResyncRequest(value?: any) : any {
  return parseObject(value, commonRemote("resync-request", "resync", {
    workingSetId: (entry?: any) : any => opaqueId(entry),
    handle: (entry?: any) : any => handleToken(entry),
    cursor: (entry?: any) : any => parseCursor(entry) || FAIL
  }));
}

export function parseResyncResponse(value?: any) : any {
  const parsed: any = parseObject(value, commonRemote("resync-response", "resync", {
    workingSetId: (entry?: any) : any => opaqueId(entry),
    outcome: (entry?: any) : any => enumValue(entry, SERVICE_COLLABORATION_RESYNC_OUTCOMES),
    head: revision,
    deltas: (entry?: any) : any => orderDeltas(entry) || FAIL,
    snapshot: (entry?: any) : any => entry === null ? null : (parseSnapshot(entry) || FAIL),
    tail: (entry?: any) : any => parseArray(entry, parseOperation, SERVICE_COLLABORATION_LIMITS.maxTailOps),
    cursor: (entry?: any) : any => parseCursor(entry) || FAIL
  }));
  if (!parsed) return null;
  if (parsed.outcome === "delta" && (parsed.snapshot !== null || parsed.tail.length !== 0)) return null;
  if (parsed.outcome === "snapshot-tail" && (parsed.snapshot === null || parsed.deltas.length !== 0)) return null;
  if (
    ["overload", "resync_required", "cancelled", "backpressure"].includes(parsed.outcome)
    && (parsed.deltas.length !== 0 || parsed.snapshot !== null || parsed.tail.length !== 0)
  ) return null;
  if (parsed.cursor.cursorState === "expired" && parsed.outcome !== "snapshot-tail") return null;
  if (parsed.cursor.cursorState === "valid" && parsed.outcome === "snapshot-tail") return null;
  return parsed;
}

export function parseEffectCommand(value?: any) : any {
  return parseObject(value, {
    schemaVersion: (entry?: any) : any => entry === SERVICE_COLLABORATION_SCHEMA_VERSION ? entry : FAIL,
    protocolVersion: (entry?: any) : any => entry === SERVICE_COLLABORATION_PROTOCOL_VERSION ? entry : FAIL,
    coreStateGeneration: (entry?: any) : any => (
      entry === SERVICE_COLLABORATION_CORE_STATE_GENERATION ? entry : FAIL
    ),
    kind: (entry?: any) : any => entry === "effect-command" ? entry : FAIL,
    family: (entry?: any) : any => entry === "effect-command" ? entry : FAIL,
    authorizationReResolved: trueFlag,
    effectId: (entry?: any) : any => opaqueId(entry),
    idempotency: (entry?: any) : any => enumValue(entry, SERVICE_COLLABORATION_EFFECT_IDEMPOTENCY),
    principalLookup: (entry?: any) : any => opaqueId(entry),
    grantLookup: (entry?: any) : any => opaqueId(entry),
    targetRef: (entry?: any) : any => opaqueId(entry),
    policyRef: (entry?: any) : any => opaqueId(entry),
    approvalLookup: (entry?: any) : any => opaqueId(entry),
    audienceRef: (entry?: any) : any => opaqueId(entry),
    requestRef: (entry?: any) : any => opaqueId(entry),
    cancellationState: (entry?: any) : any => enumValue(entry, SERVICE_COLLABORATION_CANCELLATION_STATES),
    resultState: (entry?: any) : any => enumValue(entry, SERVICE_COLLABORATION_EFFECT_RESULT_STATES),
    auditRef: (entry?: any) : any => opaqueId(entry),
    compensationRef: (entry?: any) : any => entry === null ? null : opaqueId(entry)
  });
}

export function parseFallbackDescriptor(value?: any) : any {
  return parseObject(value, {
    schemaVersion: (entry?: any) : any => entry === SERVICE_COLLABORATION_SCHEMA_VERSION ? entry : FAIL,
    protocolVersion: (entry?: any) : any => entry === SERVICE_COLLABORATION_PROTOCOL_VERSION ? entry : FAIL,
    coreStateGeneration: (entry?: any) : any => (
      entry === SERVICE_COLLABORATION_CORE_STATE_GENERATION ? entry : FAIL
    ),
    kind: (entry?: any) : any => entry === "fallback" ? entry : FAIL,
    protocolPath: (entry?: any) : any => entry === SERVICE_COLLABORATION_FALLBACK_PATH ? entry : FAIL,
    methods: (entry?: any) : any => {
      if (!Array.isArray(entry) || entry.length !== SERVICE_COLLABORATION_FALLBACK_METHODS.length) return FAIL;
      return entry.every((item?: any, index?: any) : any => item === SERVICE_COLLABORATION_FALLBACK_METHODS[index])
        ? Object.freeze([...SERVICE_COLLABORATION_FALLBACK_METHODS])
        : FAIL;
    },
    authorizationReResolved: trueFlag
  });
}

KIND_PARSERS["open-request"] = parseOpenRequest;
KIND_PARSERS["open-response"] = parseOpenResponse;
KIND_PARSERS["observe-request"] = parseObserveRequest;
KIND_PARSERS["observe-response"] = parseObserveResponse;
KIND_PARSERS["edit-view"] = parseEditView;
KIND_PARSERS["commit-request"] = parseCommitRequest;
KIND_PARSERS["acknowledge"] = parseAcknowledge;
KIND_PARSERS["subscribe-request"] = parseSubscribeRequest;
KIND_PARSERS["resource-updated"] = parseResourceUpdatedNotification;
KIND_PARSERS["rebase-request"] = parseRebaseRequest;
KIND_PARSERS["rebase-response"] = parseRebaseResponse;
KIND_PARSERS["resync-request"] = parseResyncRequest;
KIND_PARSERS["resync-response"] = parseResyncResponse;
KIND_PARSERS["effect-command"] = parseEffectCommand;
KIND_PARSERS["fallback"] = parseFallbackDescriptor;

export function parseCollaborationMessage(value?: any) : any {
  if (!isPlainObject(value) || containsForbiddenKeys(value)) return null;
  const parser: any = KIND_PARSERS[value.kind];
  return parser ? parser(value) : null;
}

export function createOpenRequest(value: Record<string, any> = {}) : any {
  return created(parseOpenRequest, envelope("open-request", {
    verb: "open",
    authorizationReResolved: true,
    workingSetRef: value.workingSetRef,
    resourceRefs: value.resourceRefs,
    cursor: value.cursor
  }), "Service collaboration open request does not satisfy the wire contract.");
}

export function createOpenResponse(value: Record<string, any> = {}) : any {
  return created(parseOpenResponse, envelope("open-response", {
    verb: "open",
    authorizationReResolved: true,
    workingSetId: value.workingSetId,
    entityIds: value.entityIds,
    handles: value.handles,
    head: value.head,
    resourceLinks: value.resourceLinks,
    cacheHint: value.cacheHint,
    cursor: value.cursor
  }), "Service collaboration open response does not satisfy the wire contract.");
}

export function createObserveRequest(value: Record<string, any> = {}) : any {
  return created(parseObserveRequest, envelope("observe-request", {
    verb: "observe",
    authorizationReResolved: true,
    workingSetId: value.workingSetId,
    handle: value.handle,
    cursor: value.cursor
  }), "Service collaboration observe request does not satisfy the wire contract.");
}

export function createObserveResponse(value: Record<string, any> = {}) : any {
  return created(parseObserveResponse, envelope("observe-response", {
    verb: "observe",
    authorizationReResolved: true,
    workingSetId: value.workingSetId,
    head: value.head,
    resourceLinks: value.resourceLinks,
    catalogRevision: value.catalogRevision,
    schemaRevision: value.schemaRevision,
    acknowledgements: value.acknowledgements,
    history: value.history,
    cacheHit: value.cacheHit,
    cacheHint: value.cacheHint
  }), "Service collaboration observe response does not satisfy the wire contract.");
}

export function createEditView(value: Record<string, any> = {}) : any {
  return created(parseEditView, {
    schemaVersion: SERVICE_COLLABORATION_SCHEMA_VERSION,
    coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION,
    kind: "edit-view",
    verb: "edit",
    workingSetId: value.workingSetId,
    head: value.head,
    dirtyEntityIds: value.dirtyEntityIds || [],
    omittedUnchanged: true
  }, "Service collaboration edit view does not satisfy the wire contract.");
}

export function createCommitRequest(value: Record<string, any> = {}) : any {
  return created(parseCommitRequest, envelope("commit-request", {
    verb: "commit",
    authorizationReResolved: true,
    workingSetId: value.workingSetId,
    handle: value.handle,
    dirty: value.dirty === true,
    changeSet: value.dirty === true ? value.changeSet : null
  }), "Service collaboration commit request does not satisfy the wire contract.");
}

export function createAcknowledge(value: Record<string, any> = {}) : any {
  return created(parseAcknowledge, envelope("acknowledge", {
    verb: "acknowledge",
    authorizationReResolved: true,
    workingSetId: value.workingSetId,
    assignedHead: value.assignedHead,
    changedEntityIds: value.changedEntityIds || [],
    resultFacts: value.resultFacts || [],
    conflicts: value.conflicts || [],
    invalidations: value.invalidations || []
  }), "Service collaboration acknowledgement does not satisfy the wire contract.");
}

export function createSubscribeRequest(value: Record<string, any> = {}) : any {
  return created(parseSubscribeRequest, envelope("subscribe-request", {
    verb: "subscribe",
    authorizationReResolved: true,
    method: SERVICE_COLLABORATION_SUBSCRIBE_METHOD,
    notifications: value.notifications || [SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD],
    workingSetId: value.workingSetId,
    cursor: value.cursor,
    cacheHint: value.cacheHint
  }), "Service collaboration subscribe request does not satisfy the wire contract.");
}

export function createResourceUpdatedNotification(value: Record<string, any> = {}) : any {
  return created(parseResourceUpdatedNotification, envelope("resource-updated", {
    method: SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD,
    authorizationReResolved: true,
    resourceUri: value.resourceUri,
    head: value.head,
    cursor: value.cursor,
    cacheHint: value.cacheHint,
    invalidationCodes: value.invalidationCodes
  }), "Service collaboration resource notification does not satisfy the wire contract.");
}

export function createRebaseRequest(value: Record<string, any> = {}) : any {
  return created(parseRebaseRequest, envelope("rebase-request", {
    verb: "rebase",
    authorizationReResolved: true,
    workingSetId: value.workingSetId,
    handle: value.handle,
    baselineHead: value.baselineHead,
    operations: value.operations,
    cursor: value.cursor
  }), "Service collaboration rebase request does not satisfy the wire contract.");
}

export function createRebaseResponse(value: Record<string, any> = {}) : any {
  return created(parseRebaseResponse, envelope("rebase-response", {
    verb: "rebase",
    authorizationReResolved: true,
    workingSetId: value.workingSetId,
    head: value.head,
    outcome: value.outcome,
    rebasedOperations: value.rebasedOperations || [],
    conflicts: value.conflicts || [],
    cursor: value.cursor
  }), "Service collaboration rebase response does not satisfy the wire contract.");
}

export function createResyncRequest(value: Record<string, any> = {}) : any {
  return created(parseResyncRequest, envelope("resync-request", {
    verb: "resync",
    authorizationReResolved: true,
    workingSetId: value.workingSetId,
    handle: value.handle,
    cursor: value.cursor
  }), "Service collaboration resync request does not satisfy the wire contract.");
}

export function createResyncResponse(value: Record<string, any> = {}) : any {
  return created(parseResyncResponse, envelope("resync-response", {
    verb: "resync",
    authorizationReResolved: true,
    workingSetId: value.workingSetId,
    outcome: value.outcome,
    head: value.head,
    deltas: value.deltas || [],
    snapshot: value.snapshot === undefined ? null : value.snapshot,
    tail: value.tail || [],
    cursor: value.cursor
  }), "Service collaboration resync response does not satisfy the wire contract.");
}

export function createEffectCommand(value: Record<string, any> = {}) : any {
  return created(parseEffectCommand, envelope("effect-command", {
    family: "effect-command",
    authorizationReResolved: true,
    effectId: value.effectId,
    idempotency: value.idempotency,
    principalLookup: value.principalLookup,
    grantLookup: value.grantLookup,
    targetRef: value.targetRef,
    policyRef: value.policyRef,
    approvalLookup: value.approvalLookup,
    audienceRef: value.audienceRef,
    requestRef: value.requestRef,
    cancellationState: value.cancellationState,
    resultState: value.resultState,
    auditRef: value.auditRef,
    compensationRef: value.compensationRef === undefined ? null : value.compensationRef
  }), "Service collaboration Effect Command does not satisfy the wire contract.");
}

export function createFallbackDescriptor() : any {
  return created(parseFallbackDescriptor, envelope("fallback", {
    protocolPath: SERVICE_COLLABORATION_FALLBACK_PATH,
    methods: [...SERVICE_COLLABORATION_FALLBACK_METHODS],
    authorizationReResolved: true
  }), "Service collaboration fallback descriptor does not satisfy the wire contract.");
}

export function createChangeSet(value: Record<string, any> = {}) : any {
  return created(parseChangeSet, {
    changeId: value.changeId,
    baselineHead: value.baselineHead,
    operations: value.operations,
    attributionRef: value.attributionRef,
    family: "document-state",
    visibility: SERVICE_COLLABORATION_VISIBILITY
  }, "Service collaboration Change Set does not satisfy the wire contract.");
}

export function assertCommitTurn(value: Record<string, any> = {}) : any {
  const parsed: any = parseCommitRequest(value) || parseCollaborationMessage(value);
  if (!parsed || parsed.kind !== "commit-request") {
    throw new Error("Commit turn must be a versioned commit request.");
  }
  if (parsed.dirty === true && !parsed.changeSet) {
    throw new Error("A dirty turn must emit exactly one bounded Change Set.");
  }
  if (parsed.dirty !== true && parsed.changeSet !== null) {
    throw new Error("A clean or read-only turn must emit no Change Set.");
  }
  if (parsed.changeSet && parsed.changeSet.family !== "document-state") {
    throw new Error("Change Sets are a separate family from Effect Commands.");
  }
  return true;
}

export function assertObserveCacheHit(value: Record<string, any> = {}) : any {
  const parsed: any = parseObserveResponse(value) || parseCollaborationMessage(value);
  if (!parsed || parsed.kind !== "observe-response") {
    throw new Error("Observe cache contract requires a versioned observe response.");
  }
  if (parsed.cacheHit === true && parsed.cacheHint.cacheScope !== "private") {
    throw new Error("Valid cache hits are private to the current authorization partition.");
  }
  return parsed.cacheHit === true ? "no-model-visible-remote-read" : "remote-read-allowed";
}

export function assertOneCoreStateGeneration(value?: any) : any {
  if (!isPlainObject(value) || value.coreStateGeneration !== SERVICE_COLLABORATION_CORE_STATE_GENERATION) {
    throw new Error("Service collaboration retains only one Core state generation.");
  }
  if (SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED !== false) {
    throw new Error("A second Core state generation is not allowed.");
  }
  if (containsForbiddenKeys(value)) {
    throw new Error("CRDT or privacy-bearing fields cannot enter the collaboration contract.");
  }
  return true;
}

export function assertProtocolFallback(value?: any) : any {
  const parsed: any = parseFallbackDescriptor(value) || parseCollaborationMessage(value);
  if (!parsed || parsed.kind !== "fallback") {
    throw new Error("Protocol fallback must be the ordinary MCP tool and resource path.");
  }
  if (parsed.coreStateGeneration !== SERVICE_COLLABORATION_CORE_STATE_GENERATION) {
    throw new Error("Ordinary MCP fallback must not introduce a second Core state generation.");
  }
  return true;
}

export function assertEffectCommandFamily(value?: any) : any {
  const parsed: any = parseEffectCommand(value) || parseCollaborationMessage(value);
  if (!parsed || parsed.family !== "effect-command") {
    throw new Error("Effect Commands are a separate contract family from document-state Change Sets.");
  }
  if (parsed.resultState === "uncertain" && SERVICE_COLLABORATION_SILENT_UNCERTAIN_RETRY !== false) {
    throw new Error("Uncertain Effect Commands must not be retried silently.");
  }
  if (SERVICE_COLLABORATION_LOCAL_ROLLBACK_REVERSES_EFFECT !== false) {
    throw new Error("Local rollback must not claim to reverse an external effect.");
  }
  return true;
}

export function effectRetryAllowed(value?: any) : any {
  const parsed: any = parseEffectCommand(value) || parseCollaborationMessage(value);
  if (!parsed) return false;
  if (parsed.resultState === "uncertain" || parsed.resultState === "cancelled") return false;
  if (parsed.idempotency !== "idempotent") return false;
  return parsed.resultState === "accepted";
}

export function lookupFactIsAuthority(_factName?: any) : any {
  return false;
}

export function relevantOperations(localOperations: any = [], remoteOperations: any = []) : any {
  const locals: any = Array.isArray(localOperations) ? localOperations : [];
  const remotes: any = Array.isArray(remoteOperations) ? remoteOperations : [];
  const entities: any = new Set<any>(locals.map((entry?: any) : any => entry?.entityId).filter(Boolean));
  return Object.freeze(remotes.filter((entry?: any) : any => entities.has(entry?.entityId)));
}

export function transformRelevantOperation(local?: any, remote?: any) : any {
  const current: any = parseOperation(local);
  const other: any = parseOperation(remote);
  if (!current || !other) {
    return { operation: null, conflict: { code: "conflict.unknown_required_field", entityId: "ent.unknown", head: 0 } };
  }
  if (current.entityId !== other.entityId) return { operation: current, conflict: null };
  if (
    SERVICE_COLLABORATION_UNREBASEABLE_OPERATION_TYPES.includes(current.type)
    || SERVICE_COLLABORATION_UNREBASEABLE_OPERATION_TYPES.includes(other.type)
  ) {
    return {
      operation: null,
      conflict: { code: "conflict.unrebasable_operation", entityId: current.entityId, head: 0 }
    };
  }
  if (current.type === "update" && other.type === "update" && current.index === other.index) {
    return {
      operation: null,
      conflict: { code: "conflict.concurrent_edit", entityId: current.entityId, head: 0 }
    };
  }
  if (current.type === "delete" && other.type === "delete" && current.index === other.index) {
    return { operation: parseOperation({ ...current, type: "retain" }), conflict: null };
  }
  let index: any = current.index;
  if (other.type === "insert" && other.index <= index) index += 1;
  if (other.type === "delete" && other.index < index) index -= 1;
  if (other.type === "delete" && other.index === index && current.type !== "delete") {
    return {
      operation: null,
      conflict: { code: "conflict.index_collision", entityId: current.entityId, head: 0 }
    };
  }
  if (!Number.isSafeInteger(index) || index < 0) {
    return {
      operation: null,
      conflict: { code: "conflict.index_collision", entityId: current.entityId, head: 0 }
    };
  }
  return { operation: parseOperation({ ...current, index }), conflict: null };
}

export function rebaseOperations(localOperations: any = [], remoteOperations: any = []) : any {
  const locals: any = (Array.isArray(localOperations) ? localOperations : [])
    .map((entry?: any) : any => parseOperation(entry));
  if (locals.includes(null)) {
    return Object.freeze({
      rebasedOperations: Object.freeze([]),
      conflicts: Object.freeze([
        { code: "conflict.unknown_required_field", entityId: "ent.unknown", head: 0 }
      ])
    });
  }
  const relevant: any = relevantOperations(locals, remoteOperations)
    .map((entry?: any) : any => parseOperation(entry))
    .filter(Boolean);
  const rebased: any[] = [];
  const conflicts: any[] = [];
  for (const local of locals) {
    let current: any = local;
    let failed: any = false;
    for (const remote of relevant) {
      const result: any = transformRelevantOperation(current, remote);
      if (result.conflict) {
        conflicts.push(parseConflictFact({ ...result.conflict, head: result.conflict.head || 0 }));
        failed = true;
        break;
      }
      current = result.operation;
    }
    if (!failed && current) rebased.push(current);
  }
  return Object.freeze({
    rebasedOperations: Object.freeze(rebased),
    conflicts: Object.freeze(conflicts.filter(Boolean))
  });
}

export function selectProtocolPath(supportsCollaboration: any = false) : any {
  if (supportsCollaboration === true) {
    return Object.freeze({
      profile: SERVICE_COLLABORATION_PROFILE,
      methods: SERVICE_COLLABORATION_PROFILE_METHODS,
      coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION,
      fallback: createFallbackDescriptor()
    });
  }
  return Object.freeze({
    profile: SERVICE_COLLABORATION_FALLBACK_PATH,
    methods: SERVICE_COLLABORATION_FALLBACK_METHODS,
    coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION,
    fallback: createFallbackDescriptor()
  });
}

export function encodeCollaborationMessage(value?: any) : any {
  const parsed: any = parseCollaborationMessage(value);
  if (!parsed) return "";
  return JSON.stringify(parsed);
}

export function decodeCollaborationMessage(value?: any) : any {
  if (typeof value !== "string" || !value) return null;
  try {
    return parseCollaborationMessage(JSON.parse(value));
  } catch {
    return null;
  }
}

export function createServiceCollaborationPeer(peerId: any = "peer-a") : any {
  const normalizedPeerId: any = opaqueId(peerId);
  if (normalizedPeerId === FAIL) throw new TypeError("Neutral collaboration peer requires a stable opaque identity.");
  return Object.freeze({
    peerId: normalizedPeerId,
    encode: encodeCollaborationMessage,
    decode: decodeCollaborationMessage,
    validate: parseCollaborationMessage
  });
}

export function agreeServiceCollaborationPeers(left?: any, right?: any, message?: any) : any {
  if (!left?.encode || !right?.encode || !left?.decode || !right?.decode) return null;
  const encodedByLeft: any = left.encode(message);
  const encodedByRight: any = right.encode(message);
  if (!encodedByLeft || !encodedByRight) return null;
  const leftView: any = right.decode(encodedByLeft);
  const rightView: any = left.decode(encodedByRight);
  const leftEcho: any = left.decode(encodedByRight);
  const rightEcho: any = right.decode(encodedByLeft);
  if (!leftView || !rightView || !leftEcho || !rightEcho) return null;
  if (JSON.stringify(leftView) !== JSON.stringify(rightView)) return null;
  if (JSON.stringify(leftEcho) !== JSON.stringify(rightEcho)) return null;
  if (JSON.stringify(leftView) !== JSON.stringify(parseCollaborationMessage(message))) return null;
  return leftView;
}

export function rejectUnknownRequiredFields(value?: any) : any {
  return parseCollaborationMessage(value) === null;
}

export function rejectSecondCoreGeneration(value?: any) : any {
  if (!isPlainObject(value)) return true;
  if (value.coreStateGeneration !== SERVICE_COLLABORATION_CORE_STATE_GENERATION) return true;
  return containsForbiddenKeys(value);
}
