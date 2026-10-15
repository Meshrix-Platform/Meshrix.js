/**
 * recording-content-capture.ts
 *
 * The single field-selection/redaction contract every `content` producer
 * applies *before* serialization and artifact custody:
 *
 * - `fieldAllow` selects which top-level operation-input fields may be
 *   captured; everything else is never read.
 * - `fieldRedact` removes the named keys wherever they appear inside a
 *   captured field's value — any depth, inside plain objects and arrays —
 *   so an allowed parent object cannot smuggle its sensitive children into
 *   custody unchanged.
 * - `RECORDING_FORBIDDEN_KEYS` are stripped unconditionally at the same
 *   pass: the contract denies secrets, permits and raw payload material at
 *   the serializer for every record, and artifact bytes are record custody —
 *   a nested `token` or `privateKey` inside an allowed field can never reach
 *   the artifact store.
 *
 * Only JSON/plain-object values are captured. Dates and Buffers pass
 * through as canonical leaf values; any other non-plain object (Map, Set,
 * class instances, functions) is replaced with `null` rather than
 * serialized uninspected. Cyclic references degrade to `null` so capture
 * can never spin or persist an ambiguous projection.
 */
import { RECORDING_FORBIDDEN_KEYS } from "@meshrix/contracts/recording";

type UnknownRecord = Record<string, unknown>;

const FORBIDDEN_SET: ReadonlySet<string> = new Set(RECORDING_FORBIDDEN_KEYS);

function isPlainObject(value: unknown): value is UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactValue(value: unknown, redact: ReadonlySet<string>, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") {
    return typeof value === "number" && !Number.isFinite(value) ? null : value;
  }
  if (value instanceof Date || (typeof Buffer !== "undefined" && Buffer.isBuffer(value))) {
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return null;
    seen.add(value);
    try {
      return value.map((entry) => redactValue(entry, redact, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (!isPlainObject(value)) {
    // Uninspectable container (Map, Set, class instance, callable): capture a
    // safe placeholder instead of serializing opaque internals into custody.
    return null;
  }
  if (seen.has(value)) return null;
  seen.add(value);
  try {
    const output: UnknownRecord = {};
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_SET.has(key) || redact.has(key)) continue;
      output[key] = redactValue(entry, redact, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export interface RecordingContentCapture {
  /** Top-level input keys admitted by `fieldAllow` (input order). */
  fieldNames: string[];
  /** The redacted field values safe to serialize into artifact custody. */
  captured: UnknownRecord;
}

/**
 * Select + redact one operation's content capture under the live category
 * selection. Returns `null` when the selection allows nothing or no allowed
 * field is present — the producer records nothing in that case, exactly as
 * before.
 */
export function captureRecordingContentFields(
  operationInput: unknown,
  selection: unknown
): RecordingContentCapture | null {
  const selected = selection && typeof selection === "object" && !Array.isArray(selection)
    ? (selection as UnknownRecord)
    : null;
  const allow = new Set<string>(
    Array.isArray(selected?.fieldAllow) ? (selected.fieldAllow as string[]) : []
  );
  if (!selected || allow.size === 0 || !isPlainObject(operationInput)) {
    return null;
  }
  const fieldNames = Object.keys(operationInput).filter((key) => allow.has(key));
  if (fieldNames.length === 0) {
    return { fieldNames: [], captured: {} };
  }
  const redact = new Set<string>(
    Array.isArray(selected.fieldRedact) ? (selected.fieldRedact as string[]) : []
  );
  const seen = new WeakSet<object>();
  const captured: UnknownRecord = {};
  for (const name of fieldNames) {
    captured[name] = redactValue(operationInput[name], redact, seen);
  }
  return { fieldNames, captured };
}
