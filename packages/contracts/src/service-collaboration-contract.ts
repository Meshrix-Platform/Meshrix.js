export const SERVICE_COLLABORATION_SCHEMA_VERSION = "v0.0.1:service-collaboration:wire-1";
export const SERVICE_COLLABORATION_REPORT_SCHEMA_VERSION = "v0.0.1:service-collaboration:report-1";
export const SERVICE_COLLABORATION_PROTOCOL_VERSION = "2026-07-28";
export const SERVICE_COLLABORATION_CORE_STATE_GENERATION = "meshrix-core-state-1";
export const SERVICE_COLLABORATION_PROFILE = "service-collaboration";
export const SERVICE_COLLABORATION_FALLBACK_PATH = "ordinary-mcp";

export const SERVICE_COLLABORATION_SUBSCRIBE_METHOD = "subscriptions/listen";
export const SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD = "notifications/resources/updated";
export const SERVICE_COLLABORATION_FALLBACK_METHODS = Object.freeze([
  "tools/call",
  "resources/read",
  "resources/list"
]);
export const SERVICE_COLLABORATION_PROFILE_METHODS = Object.freeze([
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

export const SERVICE_COLLABORATION_FAMILIES = Object.freeze([
  "document-state",
  "effect-command"
]);
export const SERVICE_COLLABORATION_VERBS = Object.freeze([
  "open",
  "observe",
  "edit",
  "commit",
  "acknowledge",
  "subscribe",
  "rebase",
  "resync"
]);
export const SERVICE_COLLABORATION_KINDS = Object.freeze([
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
export const SERVICE_COLLABORATION_CACHE_SCOPES = Object.freeze([
  "public",
  "private"
]);
export const SERVICE_COLLABORATION_PRIVATE_KINDS = Object.freeze([
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
export const SERVICE_COLLABORATION_CURSOR_STATES = Object.freeze([
  "valid",
  "expired"
]);
export const SERVICE_COLLABORATION_OPERATION_TYPES = Object.freeze([
  "insert",
  "update",
  "delete",
  "move",
  "retain"
]);
export const SERVICE_COLLABORATION_REBASEABLE_OPERATION_TYPES = Object.freeze([
  "insert",
  "update",
  "delete",
  "retain"
]);
export const SERVICE_COLLABORATION_UNREBASEABLE_OPERATION_TYPES = Object.freeze([
  "move"
]);
export const SERVICE_COLLABORATION_VISIBILITY = "atomic";
export const SERVICE_COLLABORATION_DELTA_ORDERING = "cursor-indexed-monotonic";
export const SERVICE_COLLABORATION_EFFECT_IDEMPOTENCY = Object.freeze([
  "idempotent",
  "non_idempotent"
]);
export const SERVICE_COLLABORATION_EFFECT_RESULT_STATES = Object.freeze([
  "accepted",
  "terminal",
  "uncertain",
  "cancelled"
]);
export const SERVICE_COLLABORATION_CANCELLATION_STATES = Object.freeze([
  "none",
  "requested",
  "cancelled"
]);
export const SERVICE_COLLABORATION_REBASE_OUTCOMES = Object.freeze([
  "rebased",
  "conflict"
]);
export const SERVICE_COLLABORATION_RESYNC_OUTCOMES = Object.freeze([
  "delta",
  "snapshot-tail",
  "overload",
  "resync_required",
  "cancelled",
  "backpressure"
]);
export const SERVICE_COLLABORATION_CONFLICT_CODES = Object.freeze([
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
export const SERVICE_COLLABORATION_LOOKUP_FACTS = Object.freeze([
  "handle",
  "cursor",
  "cachedBytes",
  "connectionState",
  "earlierDiscovery",
  "priorApproval"
]);
export const SERVICE_COLLABORATION_PRIVACY_FORBIDDEN_KEYS = Object.freeze([
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
export const SERVICE_COLLABORATION_CRDT_FORBIDDEN_KEYS = Object.freeze([
  "automerge",
  "automergeChange",
  "crdt",
  "crdtLibrary",
  "crdtState",
  "yjs",
  "yjsUpdate"
]);
export const SERVICE_COLLABORATION_LOCAL_ROLLBACK_REVERSES_EFFECT = false;
export const SERVICE_COLLABORATION_SILENT_UNCERTAIN_RETRY = false;
export const SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED: boolean = false;

export const SERVICE_COLLABORATION_LIMITS = Object.freeze({
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

const FAIL = Symbol("service-collaboration-fail");
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]+$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const RESOURCE_URI_PATTERN = /^meshrix:\/\/collaboration\/[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/u;
type UnknownRecord = Record<string, unknown>;
type FieldParser<T> = (value: unknown, source: UnknownRecord) => T | typeof FAIL;
type ParserSpec = Record<string, FieldParser<unknown>>;
type ParsedSpec<T extends ParserSpec> = Readonly<{
  [K in keyof T]: T[K] extends FieldParser<infer R> ? R : never;
}>;
type CollaborationParser = (value?: unknown) => Readonly<UnknownRecord> | null;
type BaseRemoteSpec = {
  schemaVersion: FieldParser<string>;
  protocolVersion: FieldParser<string>;
  coreStateGeneration: FieldParser<string>;
  kind: FieldParser<string>;
  verb: FieldParser<string>;
  authorizationReResolved: FieldParser<true>;
};
type ParsedDelta = Readonly<{
  head: number;
  opIndex: number;
  operation: Readonly<UnknownRecord>;
}>;
type ParsedResourceLink = Readonly<{
  uri: string;
  head: number;
  cacheHint: Readonly<UnknownRecord>;
}>;
interface ServiceCollaborationPeer {
  encode(value: unknown): string;
  decode(value: unknown): Readonly<UnknownRecord> | null;
}

const KIND_PARSERS: Record<string, CollaborationParser> = {};

function isPlainObject(value?: unknown): value is UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is UnknownRecord {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && expected.every((key, index) => key === keys[index]);
}

function boundedText(value: unknown, maxBytes: number = SERVICE_COLLABORATION_LIMITS.maxIdentityBytes): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized && Buffer.byteLength(normalized, "utf8") <= maxBytes ? normalized : "";
}

function revision(value?: unknown): number | typeof FAIL {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : FAIL;
}

function trueFlag(value?: unknown): true | typeof FAIL {
  return value === true ? true : FAIL;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | typeof FAIL {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : FAIL;
}

function opaqueId(value: unknown, maxBytes: number = SERVICE_COLLABORATION_LIMITS.maxIdentityBytes): string | typeof FAIL {
  const normalized = boundedText(value, maxBytes);
  return normalized && IDENTITY_PATTERN.test(normalized) ? normalized : FAIL;
}

function handleToken(value?: unknown): string | typeof FAIL {
  const normalized = boundedText(value, SERVICE_COLLABORATION_LIMITS.maxHandleBytes);
  return normalized
    && normalized.length >= SERVICE_COLLABORATION_LIMITS.minHandleChars
    && HANDLE_PATTERN.test(normalized)
    ? normalized
    : FAIL;
}

function cursorToken(value?: unknown): string | typeof FAIL {
  const normalized = boundedText(value, SERVICE_COLLABORATION_LIMITS.maxCursorBytes);
  return normalized
    && normalized.length >= SERVICE_COLLABORATION_LIMITS.minCursorChars
    && CURSOR_PATTERN.test(normalized)
    ? normalized
    : FAIL;
}

function resourceUri(value?: unknown): string | typeof FAIL {
  const normalized = boundedText(value, SERVICE_COLLABORATION_LIMITS.maxUriBytes);
  return normalized && RESOURCE_URI_PATTERN.test(normalized) ? normalized : FAIL;
}

function digest(value?: unknown): string | typeof FAIL {
  const normalized = boundedText(value, SERVICE_COLLABORATION_LIMITS.maxDigestBytes);
  return normalized && DIGEST_PATTERN.test(normalized) ? normalized : FAIL;
}

function codeToken(value?: unknown): string | typeof FAIL {
  const normalized = boundedText(value, SERVICE_COLLABORATION_LIMITS.maxCodeBytes);
  return normalized && IDENTITY_PATTERN.test(normalized) ? normalized : FAIL;
}

function uniqueIds(
  value?: unknown,
  max: number = SERVICE_COLLABORATION_LIMITS.maxEntitiesPerWorkingSet
): readonly string[] | typeof FAIL {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return FAIL;
  const ids: string[] = [];
  for (const entry of value) {
    const id = opaqueId(entry);
    if (id === FAIL) return FAIL;
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) return FAIL;
  return Object.freeze(ids);
}

function optionalUniqueIds(
  value?: unknown,
  max: number = SERVICE_COLLABORATION_LIMITS.maxEntitiesPerWorkingSet
): readonly string[] | typeof FAIL {
  if (!Array.isArray(value) || value.length > max) return FAIL;
  const ids: string[] = [];
  for (const entry of value) {
    const id = opaqueId(entry);
    if (id === FAIL) return FAIL;
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) return FAIL;
  return Object.freeze(ids);
}

function uniqueIndexes(value?: unknown): readonly number[] | typeof FAIL {
  if (!Array.isArray(value) || value.length > SERVICE_COLLABORATION_LIMITS.maxRelevantIndexes) return FAIL;
  const indexes: number[] = [];
  for (const entry of value) {
    const index = revision(entry);
    if (index === FAIL) return FAIL;
    indexes.push(index);
  }
  if (new Set(indexes).size !== indexes.length) return FAIL;
  const sorted = [...indexes].sort((left, right) => left - right);
  return indexes.every((entry, index) => entry === sorted[index]) ? Object.freeze(indexes) : FAIL;
}

function parseObject<T extends ParserSpec>(value: unknown, spec: T): ParsedSpec<T> | null {
  const keys = Object.keys(spec).sort();
  if (!hasExactKeys(value, keys) || containsForbiddenKeys(value)) return null;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(spec)) {
    const parsed = spec[key](value[key], value);
    if (parsed === FAIL) return null;
    output[key] = parsed;
  }
  return Object.freeze(output) as ParsedSpec<T>;
}

function parseArray<T>(
  value: unknown,
  parseItem: (value: unknown) => T | typeof FAIL | null,
  max: number,
  allowEmpty: boolean = true
): readonly T[] | typeof FAIL {
  if (!Array.isArray(value) || value.length > max || (!allowEmpty && value.length === 0)) return FAIL;
  const items: T[] = [];
  for (const entry of value) {
    const item = parseItem(entry);
    if (item === FAIL || item == null) return FAIL;
    items.push(item);
  }
  return Object.freeze(items);
}

function created<T>(parseFn: (value: unknown) => T | null, value: unknown, message: string): T {
  const parsed = parseFn(value);
  if (!parsed) throw new TypeError(message);
  return parsed;
}

function envelope(kind: string, extras: Record<string, unknown> = {}): UnknownRecord {
  return {
    schemaVersion: SERVICE_COLLABORATION_SCHEMA_VERSION,
    protocolVersion: SERVICE_COLLABORATION_PROTOCOL_VERSION,
    coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION,
    kind,
    ...extras
  };
}

export function containsForbiddenKeys(value?: unknown, seen: WeakSet<object> = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const keys = Object.keys(value);
  if (keys.some((key) => (
    SERVICE_COLLABORATION_PRIVACY_FORBIDDEN_KEYS.includes(key)
    || SERVICE_COLLABORATION_CRDT_FORBIDDEN_KEYS.includes(key)
  ))) return true;
  return Object.values(value).some((entry) => containsForbiddenKeys(entry, seen));
}

export function requiredCacheScopeFor(kind?: unknown): "public" | "private" {
  return typeof kind === "string" && SERVICE_COLLABORATION_PRIVATE_KINDS.includes(kind) ? "private" : "public";
}

export function parseCacheHint(value?: unknown, kind: unknown = "") {
  const parsed = parseObject(value, {
    ttlMs: (entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0 ? entry : FAIL,
    cacheScope: (entry) => enumValue(entry, SERVICE_COLLABORATION_CACHE_SCOPES)
  });
  if (!parsed) return null;
  if (kind && requiredCacheScopeFor(kind) === "private" && parsed.cacheScope !== "private") return null;
  return parsed;
}

export function parseCursor(value?: unknown) {
  return parseObject(value, {
    cursor: (entry) => cursorToken(entry),
    indexedHead: revision,
    cursorState: (entry) => enumValue(entry, SERVICE_COLLABORATION_CURSOR_STATES)
  });
}

export function parseHandle(value?: unknown) {
  return parseObject(value, {
    handle: (entry) => handleToken(entry),
    entityId: (entry) => opaqueId(entry)
  });
}

export function parseResourceLink(value?: unknown, kind: unknown = "observe-response") {
  return parseObject(value, {
    uri: (entry) => resourceUri(entry),
    head: revision,
    cacheHint: (entry) => parseCacheHint(entry, kind) || FAIL
  });
}

export function parseOperation(value?: unknown) {
  return parseObject(value, {
    opId: (entry) => opaqueId(entry),
    type: (entry) => enumValue(entry, SERVICE_COLLABORATION_OPERATION_TYPES),
    entityId: (entry) => opaqueId(entry),
    index: revision,
    relevantIndexes: uniqueIndexes,
    payloadDigest: digest
  });
}

export function parseChangeSet(value?: unknown) {
  const parsed = parseObject(value, {
    changeId: (entry) => opaqueId(entry),
    baselineHead: revision,
    operations: (entry) => {
      const operations = parseArray(entry, parseOperation, SERVICE_COLLABORATION_LIMITS.maxOperationsPerChangeSet, false);
      if (operations === FAIL) return FAIL;
      const opIds = operations.map((item) => item.opId);
      return new Set(opIds).size === opIds.length ? operations : FAIL;
    },
    attributionRef: (entry) => opaqueId(entry),
    family: (entry) => entry === "document-state" ? entry : FAIL,
    visibility: (entry) => entry === SERVICE_COLLABORATION_VISIBILITY ? entry : FAIL
  });
  if (!parsed) return null;
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > SERVICE_COLLABORATION_LIMITS.maxChangeSetBytes) return null;
  return parsed;
}

export function parseResultFact(value?: unknown) {
  return parseObject(value, {
    code: (entry) => codeToken(entry),
    entityId: (entry) => opaqueId(entry)
  });
}

export function parseConflictFact(value?: unknown) {
  return parseObject(value, {
    code: (entry) => enumValue(entry, SERVICE_COLLABORATION_CONFLICT_CODES),
    entityId: (entry) => opaqueId(entry),
    head: revision
  });
}

export function parseInvalidationFact(value?: unknown) {
  return parseObject(value, {
    code: (entry) => codeToken(entry),
    resourceUri: (entry) => resourceUri(entry)
  });
}

export function parseHistoryEntry(value?: unknown) {
  return parseObject(value, {
    head: revision,
    changeId: (entry) => opaqueId(entry),
    entityIds: (entry) => uniqueIds(entry)
  });
}

export function parseAcknowledgementFact(value?: unknown) {
  return parseObject(value, {
    head: revision,
    changeId: (entry) => opaqueId(entry)
  });
}

export function parseSnapshot(value?: unknown) {
  const parsed = parseObject(value, {
    snapshotId: (entry) => opaqueId(entry),
    head: revision,
    entityIds: (entry) => uniqueIds(entry),
    resourceUris: (entry) => {
      if (!Array.isArray(entry) || entry.length === 0 || entry.length > SERVICE_COLLABORATION_LIMITS.maxResourceLinks) {
        return FAIL;
      }
      const uris = entry.map((item) => resourceUri(item));
      return uris.includes(FAIL) || new Set(uris).size !== uris.length ? FAIL : Object.freeze(uris);
    },
    byteLength: (entry) => (
      typeof entry === "number" && Number.isSafeInteger(entry)
        && entry >= 0 && entry <= SERVICE_COLLABORATION_LIMITS.maxSnapshotBytes
        ? entry
        : FAIL
    )
  });
  return parsed;
}

export function parseDelta(value?: unknown) {
  return parseObject(value, {
    head: revision,
    opIndex: revision,
    operation: (entry) => parseOperation(entry) || FAIL
  });
}

export function orderDeltas(value?: unknown) {
  if (!Array.isArray(value) || value.length > SERVICE_COLLABORATION_LIMITS.maxDeltaPage) return null;
  const deltas: ParsedDelta[] = [];
  for (const entry of value) {
    const delta = parseDelta(entry);
    if (!delta) return null;
    deltas.push(delta);
  }
  for (let index = 1; index < deltas.length; index += 1) {
    const previous = deltas[index - 1];
    const current = deltas[index];
    if (current.head < previous.head) return null;
    if (current.head === previous.head && current.opIndex <= previous.opIndex) return null;
  }
  return Object.freeze(deltas);
}

function parseHandles(value: unknown, entityIds: readonly string[]) {
  if (!Array.isArray(value) || value.length !== entityIds.length) return FAIL;
  const handles = [];
  const tokens = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const parsed = parseHandle(value[index]);
    if (!parsed || tokens.has(parsed.handle) || parsed.entityId !== entityIds[index]) return FAIL;
    tokens.add(parsed.handle);
    handles.push(parsed);
  }
  return Object.freeze(handles);
}

function parseResourceLinks(value: unknown, kind: string) {
  if (!Array.isArray(value) || value.length === 0 || value.length > SERVICE_COLLABORATION_LIMITS.maxResourceLinks) {
    return FAIL;
  }
  const links: ParsedResourceLink[] = [];
  for (const entry of value) {
    const link = parseResourceLink(entry, kind);
    if (!link) return FAIL;
    links.push(link);
  }
  const uris = links.map((entry) => entry.uri);
  return new Set(uris).size === uris.length ? Object.freeze(links) : FAIL;
}

function commonRemote<T extends ParserSpec>(kind: string, verb: string, extra: T): BaseRemoteSpec & T {
  const base: BaseRemoteSpec = {
    schemaVersion: (entry) => entry === SERVICE_COLLABORATION_SCHEMA_VERSION ? entry : FAIL,
    protocolVersion: (entry) => entry === SERVICE_COLLABORATION_PROTOCOL_VERSION ? entry : FAIL,
    coreStateGeneration: (entry) => (
      entry === SERVICE_COLLABORATION_CORE_STATE_GENERATION ? entry : FAIL
    ),
    kind: (entry) => entry === kind ? entry : FAIL,
    verb: (entry) => entry === verb ? entry : FAIL,
    authorizationReResolved: trueFlag
  };
  return { ...base, ...extra };
}

export function parseOpenRequest(value?: unknown) {
  return parseObject(value, commonRemote("open-request", "open", {
    workingSetRef: (entry) => opaqueId(entry),
    resourceRefs: (entry) => uniqueIds(entry, SERVICE_COLLABORATION_LIMITS.maxResourceLinks),
    cursor: (entry) => parseCursor(entry) || FAIL
  }));
}

export function parseOpenResponse(value?: unknown) {
  return parseObject(value, commonRemote("open-response", "open", {
    workingSetId: (entry) => opaqueId(entry),
    entityIds: (entry) => uniqueIds(entry),
    handles: (entry, record) => {
      const entityIds = uniqueIds(record.entityIds);
      return entityIds === FAIL ? FAIL : parseHandles(entry, entityIds);
    },
    head: revision,
    resourceLinks: (entry) => parseResourceLinks(entry, "open-response"),
    cacheHint: (entry) => parseCacheHint(entry, "open-response") || FAIL,
    cursor: (entry) => parseCursor(entry) || FAIL
  }));
}

export function parseObserveRequest(value?: unknown) {
  return parseObject(value, commonRemote("observe-request", "observe", {
    workingSetId: (entry) => opaqueId(entry),
    handle: (entry) => handleToken(entry),
    cursor: (entry) => parseCursor(entry) || FAIL
  }));
}

export function parseObserveResponse(value?: unknown) {
  return parseObject(value, commonRemote("observe-response", "observe", {
    workingSetId: (entry) => opaqueId(entry),
    head: revision,
    resourceLinks: (entry) => parseResourceLinks(entry, "observe-response"),
    catalogRevision: (entry) => opaqueId(entry),
    schemaRevision: (entry) => opaqueId(entry),
    acknowledgements: (entry) => parseArray(
      entry,
      parseAcknowledgementFact,
      SERVICE_COLLABORATION_LIMITS.maxHistoryEntries
    ),
    history: (entry) => parseArray(entry, parseHistoryEntry, SERVICE_COLLABORATION_LIMITS.maxHistoryEntries),
    cacheHit: (entry) => typeof entry === "boolean" ? entry : FAIL,
    cacheHint: (entry) => parseCacheHint(entry, "observe-response") || FAIL
  }));
}

export function parseEditView(value?: unknown) {
  return parseObject(value, {
    schemaVersion: (entry) => entry === SERVICE_COLLABORATION_SCHEMA_VERSION ? entry : FAIL,
    coreStateGeneration: (entry) => (
      entry === SERVICE_COLLABORATION_CORE_STATE_GENERATION ? entry : FAIL
    ),
    kind: (entry) => entry === "edit-view" ? entry : FAIL,
    verb: (entry) => entry === "edit" ? entry : FAIL,
    workingSetId: (entry) => opaqueId(entry),
    head: revision,
    dirtyEntityIds: (entry) => optionalUniqueIds(entry),
    omittedUnchanged: trueFlag
  });
}

export function parseCommitRequest(value?: unknown) {
  return parseObject(value, commonRemote("commit-request", "commit", {
    workingSetId: (entry) => opaqueId(entry),
    handle: (entry) => handleToken(entry),
    dirty: (entry) => typeof entry === "boolean" ? entry : FAIL,
    changeSet: (entry, record) => {
      if (record.dirty === true) return parseChangeSet(entry) || FAIL;
      return entry === null ? null : FAIL;
    }
  }));
}

export function parseAcknowledge(value?: unknown) {
  return parseObject(value, commonRemote("acknowledge", "acknowledge", {
    workingSetId: (entry) => opaqueId(entry),
    assignedHead: revision,
    changedEntityIds: (entry) => optionalUniqueIds(entry),
    resultFacts: (entry) => parseArray(entry, parseResultFact, SERVICE_COLLABORATION_LIMITS.maxResultFacts),
    conflicts: (entry) => parseArray(entry, parseConflictFact, SERVICE_COLLABORATION_LIMITS.maxConflicts),
    invalidations: (entry) => parseArray(
      entry,
      parseInvalidationFact,
      SERVICE_COLLABORATION_LIMITS.maxInvalidations
    )
  }));
}

export function parseSubscribeRequest(value?: unknown) {
  return parseObject(value, commonRemote("subscribe-request", "subscribe", {
    method: (entry) => entry === SERVICE_COLLABORATION_SUBSCRIBE_METHOD ? entry : FAIL,
    notifications: (entry) => {
      if (!Array.isArray(entry) || entry.length === 0 || entry.length > SERVICE_COLLABORATION_LIMITS.maxSubscriptions) {
        return FAIL;
      }
      if (!entry.every((item) => item === SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD)) return FAIL;
      return Object.freeze([...entry]);
    },
    workingSetId: (entry) => opaqueId(entry),
    cursor: (entry) => parseCursor(entry) || FAIL,
    cacheHint: (entry) => parseCacheHint(entry, "subscribe-request") || FAIL
  }));
}

export function parseResourceUpdatedNotification(value?: unknown) {
  return parseObject(value, {
    schemaVersion: (entry) => entry === SERVICE_COLLABORATION_SCHEMA_VERSION ? entry : FAIL,
    protocolVersion: (entry) => entry === SERVICE_COLLABORATION_PROTOCOL_VERSION ? entry : FAIL,
    coreStateGeneration: (entry) => (
      entry === SERVICE_COLLABORATION_CORE_STATE_GENERATION ? entry : FAIL
    ),
    kind: (entry) => entry === "resource-updated" ? entry : FAIL,
    method: (entry) => entry === SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD ? entry : FAIL,
    authorizationReResolved: trueFlag,
    resourceUri: (entry) => resourceUri(entry),
    head: revision,
    cursor: (entry) => parseCursor(entry) || FAIL,
    cacheHint: (entry) => parseCacheHint(entry, "resource-updated") || FAIL,
    invalidationCodes: (entry) => {
      if (!Array.isArray(entry) || entry.length === 0 || entry.length > SERVICE_COLLABORATION_LIMITS.maxInvalidations) {
        return FAIL;
      }
      const codes = entry.map((item) => codeToken(item));
      return codes.includes(FAIL) || new Set(codes).size !== codes.length ? FAIL : Object.freeze(codes);
    }
  });
}

export function parseRebaseRequest(value?: unknown) {
  return parseObject(value, commonRemote("rebase-request", "rebase", {
    workingSetId: (entry) => opaqueId(entry),
    handle: (entry) => handleToken(entry),
    baselineHead: revision,
    operations: (entry) => parseArray(
      entry,
      parseOperation,
      SERVICE_COLLABORATION_LIMITS.maxOperationsPerChangeSet,
      false
    ),
    cursor: (entry) => parseCursor(entry) || FAIL
  }));
}

export function parseRebaseResponse(value?: unknown) {
  return parseObject(value, commonRemote("rebase-response", "rebase", {
    workingSetId: (entry) => opaqueId(entry),
    head: revision,
    outcome: (entry) => enumValue(entry, SERVICE_COLLABORATION_REBASE_OUTCOMES),
    rebasedOperations: (entry) => parseArray(
      entry,
      parseOperation,
      SERVICE_COLLABORATION_LIMITS.maxOperationsPerChangeSet
    ),
    conflicts: (entry) => parseArray(entry, parseConflictFact, SERVICE_COLLABORATION_LIMITS.maxConflicts),
    cursor: (entry) => parseCursor(entry) || FAIL
  }));
}

export function parseResyncRequest(value?: unknown) {
  return parseObject(value, commonRemote("resync-request", "resync", {
    workingSetId: (entry) => opaqueId(entry),
    handle: (entry) => handleToken(entry),
    cursor: (entry) => parseCursor(entry) || FAIL
  }));
}

export function parseResyncResponse(value?: unknown) {
  const parsed = parseObject(value, commonRemote("resync-response", "resync", {
    workingSetId: (entry) => opaqueId(entry),
    outcome: (entry) => enumValue(entry, SERVICE_COLLABORATION_RESYNC_OUTCOMES),
    head: revision,
    deltas: (entry) => orderDeltas(entry) || FAIL,
    snapshot: (entry) => entry === null ? null : (parseSnapshot(entry) || FAIL),
    tail: (entry) => parseArray(entry, parseOperation, SERVICE_COLLABORATION_LIMITS.maxTailOps),
    cursor: (entry) => parseCursor(entry) || FAIL
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

export function parseEffectCommand(value?: unknown) {
  return parseObject(value, {
    schemaVersion: (entry) => entry === SERVICE_COLLABORATION_SCHEMA_VERSION ? entry : FAIL,
    protocolVersion: (entry) => entry === SERVICE_COLLABORATION_PROTOCOL_VERSION ? entry : FAIL,
    coreStateGeneration: (entry) => (
      entry === SERVICE_COLLABORATION_CORE_STATE_GENERATION ? entry : FAIL
    ),
    kind: (entry) => entry === "effect-command" ? entry : FAIL,
    family: (entry) => entry === "effect-command" ? entry : FAIL,
    authorizationReResolved: trueFlag,
    effectId: (entry) => opaqueId(entry),
    idempotency: (entry) => enumValue(entry, SERVICE_COLLABORATION_EFFECT_IDEMPOTENCY),
    principalLookup: (entry) => opaqueId(entry),
    grantLookup: (entry) => opaqueId(entry),
    targetRef: (entry) => opaqueId(entry),
    policyRef: (entry) => opaqueId(entry),
    approvalLookup: (entry) => opaqueId(entry),
    audienceRef: (entry) => opaqueId(entry),
    requestRef: (entry) => opaqueId(entry),
    cancellationState: (entry) => enumValue(entry, SERVICE_COLLABORATION_CANCELLATION_STATES),
    resultState: (entry) => enumValue(entry, SERVICE_COLLABORATION_EFFECT_RESULT_STATES),
    auditRef: (entry) => opaqueId(entry),
    compensationRef: (entry) => entry === null ? null : opaqueId(entry)
  });
}

export function parseFallbackDescriptor(value?: unknown) {
  return parseObject(value, {
    schemaVersion: (entry) => entry === SERVICE_COLLABORATION_SCHEMA_VERSION ? entry : FAIL,
    protocolVersion: (entry) => entry === SERVICE_COLLABORATION_PROTOCOL_VERSION ? entry : FAIL,
    coreStateGeneration: (entry) => (
      entry === SERVICE_COLLABORATION_CORE_STATE_GENERATION ? entry : FAIL
    ),
    kind: (entry) => entry === "fallback" ? entry : FAIL,
    protocolPath: (entry) => entry === SERVICE_COLLABORATION_FALLBACK_PATH ? entry : FAIL,
    methods: (entry) => {
      if (!Array.isArray(entry) || entry.length !== SERVICE_COLLABORATION_FALLBACK_METHODS.length) return FAIL;
      return entry.every((item, index) => item === SERVICE_COLLABORATION_FALLBACK_METHODS[index])
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

export function parseCollaborationMessage(value?: unknown) {
  if (!isPlainObject(value) || containsForbiddenKeys(value)) return null;
  const parser = typeof value.kind === "string" ? KIND_PARSERS[value.kind] : undefined;
  return parser ? parser(value) : null;
}

export function createOpenRequest(value: Record<string, unknown> = {}) {
  return created(parseOpenRequest, envelope("open-request", {
    verb: "open",
    authorizationReResolved: true,
    workingSetRef: value.workingSetRef,
    resourceRefs: value.resourceRefs,
    cursor: value.cursor
  }), "Service collaboration open request does not satisfy the wire contract.");
}

export function createOpenResponse(value: Record<string, unknown> = {}) {
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

export function createObserveRequest(value: Record<string, unknown> = {}) {
  return created(parseObserveRequest, envelope("observe-request", {
    verb: "observe",
    authorizationReResolved: true,
    workingSetId: value.workingSetId,
    handle: value.handle,
    cursor: value.cursor
  }), "Service collaboration observe request does not satisfy the wire contract.");
}

export function createObserveResponse(value: Record<string, unknown> = {}) {
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

export function createEditView(value: Record<string, unknown> = {}) {
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

export function createCommitRequest(value: Record<string, unknown> = {}) {
  return created(parseCommitRequest, envelope("commit-request", {
    verb: "commit",
    authorizationReResolved: true,
    workingSetId: value.workingSetId,
    handle: value.handle,
    dirty: value.dirty === true,
    changeSet: value.dirty === true ? value.changeSet : null
  }), "Service collaboration commit request does not satisfy the wire contract.");
}

export function createAcknowledge(value: Record<string, unknown> = {}) {
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

export function createSubscribeRequest(value: Record<string, unknown> = {}) {
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

export function createResourceUpdatedNotification(value: Record<string, unknown> = {}) {
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

export function createRebaseRequest(value: Record<string, unknown> = {}) {
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

export function createRebaseResponse(value: Record<string, unknown> = {}) {
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

export function createResyncRequest(value: Record<string, unknown> = {}) {
  return created(parseResyncRequest, envelope("resync-request", {
    verb: "resync",
    authorizationReResolved: true,
    workingSetId: value.workingSetId,
    handle: value.handle,
    cursor: value.cursor
  }), "Service collaboration resync request does not satisfy the wire contract.");
}

export function createResyncResponse(value: Record<string, unknown> = {}) {
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

export function createEffectCommand(value: Record<string, unknown> = {}) {
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

export function createFallbackDescriptor() {
  return created(parseFallbackDescriptor, envelope("fallback", {
    protocolPath: SERVICE_COLLABORATION_FALLBACK_PATH,
    methods: [...SERVICE_COLLABORATION_FALLBACK_METHODS],
    authorizationReResolved: true
  }), "Service collaboration fallback descriptor does not satisfy the wire contract.");
}

export function createChangeSet(value: Record<string, unknown> = {}) {
  return created(parseChangeSet, {
    changeId: value.changeId,
    baselineHead: value.baselineHead,
    operations: value.operations,
    attributionRef: value.attributionRef,
    family: "document-state",
    visibility: SERVICE_COLLABORATION_VISIBILITY
  }, "Service collaboration Change Set does not satisfy the wire contract.");
}

export function assertCommitTurn(value: Record<string, unknown> = {}) {
  const parsed = parseCommitRequest(value) || parseCollaborationMessage(value);
  if (!parsed || parsed.kind !== "commit-request") {
    throw new Error("Commit turn must be a versioned commit request.");
  }
  if (parsed.dirty === true && !parsed.changeSet) {
    throw new Error("A dirty turn must emit exactly one bounded Change Set.");
  }
  if (parsed.dirty !== true && parsed.changeSet !== null) {
    throw new Error("A clean or read-only turn must emit no Change Set.");
  }
  if (parsed.changeSet && (!isPlainObject(parsed.changeSet) || parsed.changeSet.family !== "document-state")) {
    throw new Error("Change Sets are a separate family from Effect Commands.");
  }
  return true;
}

export function assertObserveCacheHit(value: Record<string, unknown> = {}) {
  const parsed = parseObserveResponse(value) || parseCollaborationMessage(value);
  if (!parsed || parsed.kind !== "observe-response") {
    throw new Error("Observe cache contract requires a versioned observe response.");
  }
  if (parsed.cacheHit === true && (
    !isPlainObject(parsed.cacheHint) || parsed.cacheHint.cacheScope !== "private"
  )) {
    throw new Error("Valid cache hits are private to the current authorization partition.");
  }
  return parsed.cacheHit === true ? "no-model-visible-remote-read" : "remote-read-allowed";
}

export function assertOneCoreStateGeneration(value?: unknown) {
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

export function assertProtocolFallback(value?: unknown) {
  const parsed = parseFallbackDescriptor(value) || parseCollaborationMessage(value);
  if (!parsed || parsed.kind !== "fallback") {
    throw new Error("Protocol fallback must be the ordinary MCP tool and resource path.");
  }
  if (parsed.coreStateGeneration !== SERVICE_COLLABORATION_CORE_STATE_GENERATION) {
    throw new Error("Ordinary MCP fallback must not introduce a second Core state generation.");
  }
  return true;
}

export function assertEffectCommandFamily(value?: unknown) {
  const parsed = parseEffectCommand(value) || parseCollaborationMessage(value);
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

export function effectRetryAllowed(value?: unknown) {
  const parsed = parseEffectCommand(value) || parseCollaborationMessage(value);
  if (!parsed) return false;
  if (parsed.resultState === "uncertain" || parsed.resultState === "cancelled") return false;
  if (parsed.idempotency !== "idempotent") return false;
  return parsed.resultState === "accepted";
}

export function lookupFactIsAuthority(_factName?: unknown) {
  return false;
}

export function relevantOperations(localOperations: unknown = [], remoteOperations: unknown = []) {
  const locals = Array.isArray(localOperations) ? localOperations : [];
  const remotes = Array.isArray(remoteOperations) ? remoteOperations : [];
  const entities = new Set(locals.map((entry) => entry?.entityId).filter(Boolean));
  return Object.freeze(remotes.filter((entry) => entities.has(entry?.entityId)));
}

export function transformRelevantOperation(local?: unknown, remote?: unknown) {
  const current = parseOperation(local);
  const other = parseOperation(remote);
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
  let index = current.index;
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

export function rebaseOperations(localOperations: unknown = [], remoteOperations: unknown = []) {
  const locals = (Array.isArray(localOperations) ? localOperations : [])
    .map((entry) => parseOperation(entry));
  if (locals.includes(null)) {
    return Object.freeze({
      rebasedOperations: Object.freeze([]),
      conflicts: Object.freeze([
        { code: "conflict.unknown_required_field", entityId: "ent.unknown", head: 0 }
      ])
    });
  }
  const relevant = relevantOperations(locals, remoteOperations)
    .map((entry) => parseOperation(entry))
    .filter(Boolean);
  const rebased = [];
  const conflicts = [];
  for (const local of locals) {
    let current = local;
    let failed = false;
    for (const remote of relevant) {
      const result = transformRelevantOperation(current, remote);
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

export function selectProtocolPath(supportsCollaboration: unknown = false) {
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

export function encodeCollaborationMessage(value?: unknown) {
  const parsed = parseCollaborationMessage(value);
  if (!parsed) return "";
  return JSON.stringify(parsed);
}

export function decodeCollaborationMessage(value?: unknown) {
  if (typeof value !== "string" || !value) return null;
  try {
    return parseCollaborationMessage(JSON.parse(value));
  } catch {
    return null;
  }
}

export function createServiceCollaborationPeer(peerId: unknown = "peer-a") {
  const normalizedPeerId = opaqueId(peerId);
  if (normalizedPeerId === FAIL) throw new TypeError("Neutral collaboration peer requires a stable opaque identity.");
  return Object.freeze({
    peerId: normalizedPeerId,
    encode: encodeCollaborationMessage,
    decode: decodeCollaborationMessage,
    validate: parseCollaborationMessage
  });
}

function isServiceCollaborationPeer(value: unknown): value is ServiceCollaborationPeer {
  return isPlainObject(value)
    && typeof value.encode === "function"
    && typeof value.decode === "function";
}

export function agreeServiceCollaborationPeers(left?: unknown, right?: unknown, message?: unknown) {
  if (!isServiceCollaborationPeer(left) || !isServiceCollaborationPeer(right)) return null;
  const encodedByLeft = left.encode(message);
  const encodedByRight = right.encode(message);
  if (!encodedByLeft || !encodedByRight) return null;
  const leftView = right.decode(encodedByLeft);
  const rightView = left.decode(encodedByRight);
  const leftEcho = left.decode(encodedByRight);
  const rightEcho = right.decode(encodedByLeft);
  if (!leftView || !rightView || !leftEcho || !rightEcho) return null;
  if (JSON.stringify(leftView) !== JSON.stringify(rightView)) return null;
  if (JSON.stringify(leftEcho) !== JSON.stringify(rightEcho)) return null;
  if (JSON.stringify(leftView) !== JSON.stringify(parseCollaborationMessage(message))) return null;
  return leftView;
}

export function rejectUnknownRequiredFields(value?: unknown) {
  return parseCollaborationMessage(value) === null;
}

export function rejectSecondCoreGeneration(value?: unknown) {
  if (!isPlainObject(value)) return true;
  if (value.coreStateGeneration !== SERVICE_COLLABORATION_CORE_STATE_GENERATION) return true;
  return containsForbiddenKeys(value);
}
