/**
 * Enterprise recording policy contract: the versioned RecordingPolicy schema
 * that selects optional recording categories, per-category field/role/
 * retention obligations, and the privacy boundary every producer inherits.
 *
 * The policy governs *selected histories* only. Minimal correctness state
 * (current grants/revocation, replay fences, execution intents and
 * unknown-outcome reconciliation) and the mandatory compact lifecycle proof
 * remain at their existing owners and are never enabled, disabled or
 * relabelled by this contract. See
 * docs/architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md.
 */
export const RECORDING_POLICY_SCHEMA_VERSION = "v0.0.1:recording:policy-1";

export const RECORDING_CATEGORIES = Object.freeze([
  "content",
  "diagnostics",
  "execution_history",
  "governance_history",
  "usage"
]);
export const RECORDING_OBLIGATIONS = Object.freeze([
  "optional",
  "required_before_effect"
]);
export const RECORDING_REQUIRED_OBLIGATION_CATEGORIES = Object.freeze([
  "execution_history",
  "governance_history"
]);
export const RECORDING_PHASES = Object.freeze([
  "pre_effect",
  "post_effect"
]);
export const RECORDING_EVIDENCE_CLASSES = Object.freeze([
  "minimal_correctness",
  "required_evidence",
  "selected_history"
]);
export const RECORDING_ACCESS = Object.freeze([
  "read",
  "configure"
]);

/**
 * Field/lifetime inventory of correctness state at its actual owners. These
 * items authorize or recover operations; they are not recording categories,
 * and history rows may never borrow their names to survive a disabled
 * category.
 */
export const RECORDING_MINIMAL_CORRECTNESS_STATE = Object.freeze([
  Object.freeze({
    item: "grant_revocation",
    owner: "operation-permission",
    fields: Object.freeze(["grantRevision", "revocationRevision", "principalRef"]),
    lifetime: "current_revision_only"
  }),
  Object.freeze({
    item: "replay_fence",
    owner: "gateway-continuation-ledger",
    fields: Object.freeze(["tokenId", "state", "expiresAt"]),
    lifetime: "until_expiry"
  }),
  Object.freeze({
    item: "execution_intent",
    owner: "gateway-continuation-ledger",
    fields: Object.freeze(["intentId", "inputDigest", "policyRevision", "state"]),
    lifetime: "until_terminal_settlement"
  }),
  Object.freeze({
    item: "outcome_reconciliation",
    owner: "governed-execution-permit-authority",
    fields: Object.freeze(["permitId", "state", "expiresAt"]),
    lifetime: "until_consumed_or_expired"
  })
]);
export const RECORDING_REQUIRED_EVIDENCE = Object.freeze([
  Object.freeze({
    item: "lifecycle_proof",
    owner: "operation-audit-projection",
    fields: Object.freeze(["auditId", "decisionId", "proofId", "status", "inputHash", "durationMs"]),
    lifetime: "configured_retention_objective"
  })
]);

export const RECORDING_POLICY_LIMITS = Object.freeze({
  maxOpaqueIdBytes: 128,
  maxFieldRefs: 64,
  maxRoles: 16,
  maxCategories: 16,
  maxRetentionSeconds: 31_536_000,
  maxRetentionRecords: 1_000_000,
  maxRetentionBytes: 1_073_741_824,
  maxBufferedRecords: 65_536,
  maxRecordBytes: 262_144
});

/**
 * Keys that can never appear in a policy, admission, record or outcome.
 * Secrets, reusable permits and raw payload material are denied at the
 * serializer before any buffer or queue; a policy that tries to name them
 * fails validation rather than recording them "as operational evidence".
 * The category name `content` is contract vocabulary, not a payload key, so
 * it is absent here; captured bytes never appear as record fields at all —
 * records carry digests and artifact custody references only.
 */
export const RECORDING_FORBIDDEN_KEYS = Object.freeze([
  "apiKey",
  "authorization",
  "bearer",
  "clientSecret",
  "cookie",
  "credential",
  "credentials",
  "env",
  "environment",
  "exception",
  "executionPermit",
  "grant",
  "headers",
  "payload",
  "permit",
  "plaintext",
  "privateKey",
  "prompt",
  "request",
  "response",
  "result",
  "secret",
  "sessionToken",
  "stack",
  "stackTrace",
  "token"
]);

export const RECORDING_BLANKET_HISTORY_REQUIRED = false;
export const RECORDING_RECORDS_MAY_HOLD_SECRETS = false;
export const RECORDING_MAY_STORE_REUSABLE_PERMIT = false;
export const RECORDING_ENABLE_BACKFILLS_PRIOR_CONTENT = false;
export const RECORDING_OFF_DELETES_CAPTURED_RECORDS = false;
export const RECORDING_HISTORY_IS_OPERATIONAL_STATE = false;

const FAIL = Symbol("recording-policy-fail");
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
type UnknownRecord = Record<string, unknown>;
type FieldParser<T> = (value: unknown, source: UnknownRecord) => T | typeof FAIL;
type ParserSpec = Record<string, FieldParser<unknown>>;
type ParsedSpec<T extends ParserSpec> = Readonly<{
  [K in keyof T]: Exclude<ReturnType<T[K]>, typeof FAIL>;
}>;

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

function boundedText(value: unknown, maxBytes: number = RECORDING_POLICY_LIMITS.maxOpaqueIdBytes): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized && Buffer.byteLength(normalized, "utf8") <= maxBytes ? normalized : "";
}

function revision(value?: unknown): number | typeof FAIL {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : FAIL;
}

function positiveRevision(value?: unknown): number | typeof FAIL {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? value as number : FAIL;
}

function boundedInt(value: unknown, max: number): number | typeof FAIL {
  return Number.isSafeInteger(value) && (value as number) >= 0
    && (value as number) <= max ? value as number : FAIL;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | typeof FAIL {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : FAIL;
}

function opaqueId(value: unknown, maxBytes: number = RECORDING_POLICY_LIMITS.maxOpaqueIdBytes): string | typeof FAIL {
  const normalized = boundedText(value, maxBytes);
  return normalized && OPAQUE_ID_PATTERN.test(normalized) ? normalized : FAIL;
}

function instantValue(value?: unknown): string | typeof FAIL {
  const normalized = boundedText(value, 64);
  return normalized && ISO_INSTANT_PATTERN.test(normalized) ? normalized : FAIL;
}

export function containsForbiddenRecordingKeys(value?: unknown, seen: WeakSet<object> = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const keys = Object.keys(value);
  if (keys.some((key) => RECORDING_FORBIDDEN_KEYS.includes(key))) return true;
  return Object.values(value).some((entry) => containsForbiddenRecordingKeys(entry, seen));
}

function parseObject<T extends ParserSpec>(value: unknown, spec: T): ParsedSpec<T> | null {
  const keys = Object.keys(spec).sort();
  if (!hasExactKeys(value, keys) || containsForbiddenRecordingKeys(value)) return null;
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

function uniqueStrings(value: unknown, max: number, allowEmpty = true): readonly string[] | typeof FAIL {
  const items = parseArray(value, (entry) => opaqueId(entry), max, allowEmpty);
  if (items === FAIL) return FAIL;
  return items.length === new Set(items).size ? items : FAIL;
}

function parseRetentionBudget(value?: unknown) {
  return parseObject(value, {
    maxAgeSeconds: (entry) => (
      Number.isSafeInteger(entry) && (entry as number) >= 1
        && (entry as number) <= RECORDING_POLICY_LIMITS.maxRetentionSeconds ? entry as number : FAIL
    ),
    maxRecords: (entry) => (
      Number.isSafeInteger(entry) && (entry as number) >= 1
        && (entry as number) <= RECORDING_POLICY_LIMITS.maxRetentionRecords ? entry as number : FAIL
    ),
    maxContentBytes: (entry) => boundedInt(entry, RECORDING_POLICY_LIMITS.maxRetentionBytes),
    maxIndexBytes: (entry) => (
      Number.isSafeInteger(entry) && (entry as number) >= 1
        && (entry as number) <= RECORDING_POLICY_LIMITS.maxRetentionBytes ? entry as number : FAIL
    )
  });
}

function parseCapacityBudget(value?: unknown) {
  return parseObject(value, {
    maxBufferedRecords: (entry) => (
      Number.isSafeInteger(entry) && (entry as number) >= 1
        && (entry as number) <= RECORDING_POLICY_LIMITS.maxBufferedRecords ? entry as number : FAIL
    ),
    maxRecordBytes: (entry) => (
      Number.isSafeInteger(entry) && (entry as number) >= 1
        && (entry as number) <= RECORDING_POLICY_LIMITS.maxRecordBytes ? entry as number : FAIL
    )
  });
}

function selectionSpec() {
  return {
    obligation: (entry: unknown) => enumValue(entry, RECORDING_OBLIGATIONS),
    sinkRef: (entry: unknown) => opaqueId(entry),
    fieldAllow: (entry: unknown) => uniqueStrings(entry, RECORDING_POLICY_LIMITS.maxFieldRefs),
    fieldRedact: (entry: unknown) => uniqueStrings(entry, RECORDING_POLICY_LIMITS.maxFieldRefs),
    eventAllow: (entry: unknown) => uniqueStrings(entry, RECORDING_POLICY_LIMITS.maxFieldRefs),
    readerRoles: (entry: unknown) => uniqueStrings(entry, RECORDING_POLICY_LIMITS.maxRoles, false),
    configurerRoles: (entry: unknown) => uniqueStrings(entry, RECORDING_POLICY_LIMITS.maxRoles, false),
    retention: (entry: unknown) => parseRetentionBudget(entry) || FAIL,
    capacity: (entry: unknown) => parseCapacityBudget(entry) || FAIL
  };
}

export function parseRecordingCategorySelection(value?: unknown) {
  return parseObject(value, selectionSpec());
}

function parseCategoryMap(value?: unknown): Readonly<Record<string, ParsedSpec<ReturnType<typeof selectionSpec>>>> | typeof FAIL {
  if (!isPlainObject(value)) return FAIL;
  const keys = Object.keys(value);
  if (keys.length > RECORDING_POLICY_LIMITS.maxCategories) return FAIL;
  if (keys.some((key) => !RECORDING_CATEGORIES.includes(key as never))) return FAIL;
  if (containsForbiddenRecordingKeys(value)) return FAIL;
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const selection = parseRecordingCategorySelection(value[key]);
    if (!selection) return FAIL;
    output[key] = selection;
  }
  return Object.freeze(output) as Readonly<Record<string, ParsedSpec<ReturnType<typeof selectionSpec>>>>;
}

/**
 * The per-category obligations that keep optional enterprise content and core
 * privacy prohibitions reconciled in one contract:
 * - `required_before_effect` is only meaningful for history categories that
 *   can produce a start record before protected dispatch;
 * - `content` must name the approved fields it captures;
 * - `diagnostics` must name its allowlisted event codes, `usage` its counter
 *   fields;
 * - only `content` may hold a content-byte retention budget.
 */
function selectionConsistent(category: string, selection: UnknownRecord): boolean {
  if (selection.obligation === "required_before_effect"
      && !RECORDING_REQUIRED_OBLIGATION_CATEGORIES.includes(category as never)) {
    return false;
  }
  const retention = selection.retention as UnknownRecord;
  if (category !== "content" && retention.maxContentBytes !== 0) return false;
  if (category === "content" && (selection.fieldAllow as readonly string[]).length === 0) return false;
  if (category === "diagnostics" && (selection.eventAllow as readonly string[]).length === 0) return false;
  if (category === "usage" && (selection.fieldAllow as readonly string[]).length === 0) return false;
  return true;
}

export function parseRecordingPolicy(value?: unknown) {
  const parsed = parseObject(value, {
    schemaVersion: (entry) => entry === RECORDING_POLICY_SCHEMA_VERSION ? entry : FAIL,
    kind: (entry) => entry === "recording-policy" ? entry : FAIL,
    policyId: (entry) => opaqueId(entry),
    policyRevision: positiveRevision,
    issuedAt: instantValue,
    issuerRole: (entry) => opaqueId(entry),
    configurerRoles: (entry) => uniqueStrings(entry, RECORDING_POLICY_LIMITS.maxRoles, false),
    categories: (entry) => parseCategoryMap(entry)
  });
  if (!parsed) return null;
  for (const [category, selection] of Object.entries(parsed.categories)) {
    if (!selectionConsistent(category, selection)) return null;
  }
  return parsed;
}

function created<T>(parseFn: (value: unknown) => T | null, value: unknown, message: string): T {
  const parsed = parseFn(value);
  if (!parsed) throw new TypeError(message);
  return parsed;
}

export function createRecordingPolicy(value: Record<string, unknown> = {}) {
  return created(parseRecordingPolicy, {
    schemaVersion: RECORDING_POLICY_SCHEMA_VERSION,
    kind: "recording-policy",
    policyId: value.policyId,
    policyRevision: value.policyRevision,
    issuedAt: value.issuedAt,
    issuerRole: value.issuerRole,
    configurerRoles: value.configurerRoles || [],
    categories: value.categories || {}
  }, "RecordingPolicy does not satisfy the recording contract.");
}

export function createEmptyRecordingPolicy(value: Record<string, unknown> = {}) {
  return createRecordingPolicy({ ...value, categories: {} });
}

export function recordingCategoryEnabled(policy: unknown, category: unknown): boolean {
  const parsed = parseRecordingPolicy(policy);
  if (!parsed || typeof category !== "string") return false;
  return Object.hasOwn(parsed.categories, category);
}

export function recordingCategorySelectionFor(policy: unknown, category: unknown) {
  const parsed = parseRecordingPolicy(policy);
  if (!parsed || typeof category !== "string") return null;
  return Object.hasOwn(parsed.categories, category) ? parsed.categories[category] : null;
}

export function recordingCategoryObligation(policy: unknown, category: unknown): string | null {
  const selection = recordingCategorySelectionFor(policy, category);
  return selection ? String(selection.obligation) : null;
}

/**
 * Role authority is per category and per access kind: an auditor of one
 * category has no read or configure rights over another, and no role name is
 * a wildcard.
 */
export function recordingRoleAuthorized(policy: unknown, category: unknown, role: unknown, access: unknown): boolean {
  const selection = recordingCategorySelectionFor(policy, category);
  if (!selection || typeof role !== "string" || !role) return false;
  if (access !== "configure" && access !== "read") return false;
  const allowed = access === "configure" ? selection.configurerRoles : selection.readerRoles;
  return allowed.includes(role);
}

/**
 * A policy change is authenticated against the current revision's configurer
 * roles and published atomically: the next revision must advance strictly and
 * keep the same policy identity. Returns the admitted new policy or throws.
 */
export function assertRecordingPolicyChange(current: unknown, next: unknown, configurerRole: unknown) {
  const parsedCurrent = parseRecordingPolicy(current);
  const parsedNext = parseRecordingPolicy(next);
  if (!parsedCurrent || !parsedNext) {
    throw new Error("Recording policy change requires two versioned recording-policy documents.");
  }
  if (parsedNext.policyId !== parsedCurrent.policyId) {
    throw new Error("RECORDING_POLICY_IDENTITY_CHANGED: a policy revision cannot rebind the policy identity.");
  }
  if (parsedNext.policyRevision <= parsedCurrent.policyRevision) {
    throw new Error("RECORDING_POLICY_REVISION_NOT_ADVANCED: a published revision must strictly increase.");
  }
  if (typeof configurerRole !== "string"
      || !parsedCurrent.configurerRoles.includes(configurerRole)) {
    throw new Error("RECORDING_POLICY_CHANGE_DENIED: the change is not authorized by a current configurer role.");
  }
  return parsedNext;
}

/**
 * Disabling a category between revisions never authorizes further capture,
 * including for operations admitted under the earlier revision.
 */
export function recordingCategoryDisabledBetween(current: unknown, next: unknown, category: unknown): boolean {
  const parsedCurrent = parseRecordingPolicy(current);
  const parsedNext = parseRecordingPolicy(next);
  if (!parsedCurrent || !parsedNext || typeof category !== "string") return false;
  const wasEnabled = Object.hasOwn(parsedCurrent.categories, category);
  const isEnabled = Object.hasOwn(parsedNext.categories, category);
  return wasEnabled && !isEnabled;
}

export function assertRecordingCorePrivacy(value?: unknown) {
  if (!isPlainObject(value)) {
    throw new Error("Recording material must be a versioned plain object.");
  }
  if (containsForbiddenRecordingKeys(value)) {
    throw new Error("Recording material must not carry credentials, private keys, permits or raw protected content.");
  }
  if (RECORDING_RECORDS_MAY_HOLD_SECRETS !== false || RECORDING_MAY_STORE_REUSABLE_PERMIT !== false) {
    throw new Error("Recording can never persist secret material or reusable execution authority.");
  }
  return true;
}

/**
 * A history category is never operational state: producers cannot relabel a
 * selected-history write as minimal correctness state to survive an off
 * toggle.
 */
export function recordingEvidenceClassIsPolicyGated(evidenceClass: unknown): boolean {
  return evidenceClass === "selected_history";
}

export function recordingCategoryIsOperationalState(category: unknown): boolean {
  if (RECORDING_HISTORY_IS_OPERATIONAL_STATE !== false) {
    throw new Error("Recording categories cannot be reclassified as minimal correctness state.");
  }
  return !RECORDING_CATEGORIES.includes(category as never)
    && RECORDING_MINIMAL_CORRECTNESS_STATE.some((item) => item.item === category);
}
