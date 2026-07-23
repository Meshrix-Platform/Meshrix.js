import crypto from "node:crypto";
import { canonicalJson } from "@lico/contracts/serialization/canonical-json";

export const HOST_OPAQUE_PAYLOAD_POLICY = Object.freeze({
  ttlMs: 15 * 60 * 1000,
  maxRecords: 2_048,
  maxBytes: 16 * 1024 * 1024,
  maxPayloadBytes: 1024 * 1024
});
export const HOST_OPAQUE_PAYLOAD_TTL_MS = HOST_OPAQUE_PAYLOAD_POLICY.ttlMs;

function clone(value) {
  try {
    return structuredClone(value);
  } catch {
    throw custodyError("opaque_payload_invalid", "Opaque payload must be safely cloneable.");
  }
}

function assertBoundedJson(value, { maxDepth = 32, maxNodes = 10_000 } = {}) {
  let nodes = 0;
  const ancestors = new WeakSet();

  function visit(input, depth) {
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) {
      throw custodyError("opaque_payload_too_complex", "Opaque payload exceeds the custody complexity limit.");
    }
    if (input === null || typeof input === "string" || typeof input === "boolean") return;
    if (typeof input === "number" && Number.isFinite(input)) return;
    if (!input || typeof input !== "object") {
      throw custodyError("opaque_payload_invalid", "Opaque payload must be JSON-compatible.");
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(input)) {
      throw custodyError("opaque_payload_invalid", "Opaque payload must contain plain JSON values.");
    }
    if (ancestors.has(input)) {
      throw custodyError("opaque_payload_invalid", "Opaque payload must not contain cycles.");
    }
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        for (const entry of input) visit(entry, depth + 1);
      } else {
        for (const entry of Object.values(input)) visit(entry, depth + 1);
      }
    } finally {
      ancestors.delete(input);
    }
  }

  visit(value, 0);
}

function digestText(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function custodyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function boundedRef(value, field) {
  const ref = String(value || "").trim();
  if (!ref || ref.length > 512 || /[\u0000-\u001f\u007f]/u.test(ref)) {
    throw custodyError("opaque_payload_scope_invalid", `Opaque payload ${field} scope is invalid.`);
  }
  return ref;
}

function normalizeScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 3 ||
      Object.keys(value).sort().some((field, index) => field !== ["sessionRef", "tenantRef", "turnRef"][index])) {
    throw custodyError("opaque_payload_scope_invalid", "Opaque payload custody scope is invalid.");
  }
  return Object.freeze({
    tenantRef: boundedRef(value.tenantRef, "tenant"),
    sessionRef: boundedRef(value.sessionRef, "session"),
    turnRef: boundedRef(value.turnRef, "turn")
  });
}

function positiveInteger(value, fallback, label) {
  const normalized = Number(value ?? fallback);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new TypeError(`Host opaque payload custody requires a positive ${label}.`);
  }
  return normalized;
}

export function createHostOpaquePayloadCustody({
  ttlMs = HOST_OPAQUE_PAYLOAD_POLICY.ttlMs,
  maxRecords = HOST_OPAQUE_PAYLOAD_POLICY.maxRecords,
  maxBytes = HOST_OPAQUE_PAYLOAD_POLICY.maxBytes,
  maxPayloadBytes = HOST_OPAQUE_PAYLOAD_POLICY.maxPayloadBytes,
  now = () => Date.now()
} = {}) {
  const policy = Object.freeze({
    ttlMs: positiveInteger(ttlMs, HOST_OPAQUE_PAYLOAD_POLICY.ttlMs, "TTL"),
    maxRecords: positiveInteger(maxRecords, HOST_OPAQUE_PAYLOAD_POLICY.maxRecords, "record limit"),
    maxBytes: positiveInteger(maxBytes, HOST_OPAQUE_PAYLOAD_POLICY.maxBytes, "byte limit"),
    maxPayloadBytes: positiveInteger(
      maxPayloadBytes,
      HOST_OPAQUE_PAYLOAD_POLICY.maxPayloadBytes,
      "payload byte limit"
    )
  });
  if (policy.maxPayloadBytes > policy.maxBytes) {
    throw new TypeError("Host opaque payload custody payload limit exceeds its total byte limit.");
  }
  const records = new Map();
  const idempotencyBindings = new Map();
  const expirationHeap = [];
  let totalBytes = 0;

  function currentTimestamp() {
    let timestamp;
    try {
      timestamp = now();
    } catch {
      throw custodyError("opaque_payload_clock_invalid", "Opaque payload custody clock is unavailable.");
    }
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw custodyError("opaque_payload_clock_invalid", "Opaque payload custody clock is invalid.");
    }
    return timestamp;
  }

  function expirationTimestamp(timestamp) {
    const expiresAt = timestamp + policy.ttlMs;
    if (!Number.isSafeInteger(expiresAt)) {
      throw custodyError("opaque_payload_clock_invalid", "Opaque payload custody expiration is invalid.");
    }
    return expiresAt;
  }

  function pushExpiration(entry) {
    expirationHeap.push(entry);
    let index = expirationHeap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (expirationHeap[parent].expiresAt <= entry.expiresAt) break;
      expirationHeap[index] = expirationHeap[parent];
      index = parent;
    }
    expirationHeap[index] = entry;
  }

  function popExpiration() {
    const first = expirationHeap[0];
    const tail = expirationHeap.pop();
    if (expirationHeap.length > 0 && tail) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= expirationHeap.length) break;
        const child = right < expirationHeap.length && expirationHeap[right].expiresAt < expirationHeap[left].expiresAt
          ? right
          : left;
        if (expirationHeap[child].expiresAt >= tail.expiresAt) break;
        expirationHeap[index] = expirationHeap[child];
        index = child;
      }
      expirationHeap[index] = tail;
    }
    return first;
  }

  function compactExpirationHeapIfNeeded() {
    if (expirationHeap.length <= policy.maxRecords * 2 || expirationHeap.length <= records.size * 2) return;
    expirationHeap.length = 0;
    for (const [ref, record] of records) {
      pushExpiration(Object.freeze({ ref, expiresAt: record.expiresAt }));
    }
  }

  function removeRecord(ref) {
    const record = records.get(ref);
    if (!record) return false;
    records.delete(ref);
    totalBytes -= record.payloadBytes;
    if (record.bindingKey && idempotencyBindings.get(record.bindingKey) === ref) {
      idempotencyBindings.delete(record.bindingKey);
    }
    compactExpirationHeapIfNeeded();
    return true;
  }

  function purgeExpired(timestamp = currentTimestamp()) {
    while (expirationHeap[0]?.expiresAt <= timestamp) {
      const expired = popExpiration();
      const record = records.get(expired.ref);
      if (record?.expiresAt === expired.expiresAt) removeRecord(expired.ref);
    }
  }

  function scopeDigest(scope) {
    const normalized = normalizeScope(scope);
    assertBoundedJson(normalized);
    return digestText(canonicalJson(normalized));
  }

  function bindingKey(scopeHash, idempotencyKey) {
    const key = String(idempotencyKey || "").trim();
    if (!key) return "";
    if (key.length > 512 || /[\u0000-\u001f\u007f]/u.test(key)) {
      throw custodyError("opaque_payload_idempotency_key_invalid", "Opaque payload idempotency key is invalid.");
    }
    return digestText(`${scopeHash}\u0000${key}`);
  }

  return Object.freeze({
    policy,
    async set(scope, payload, { idempotencyKey = "" } = {}) {
      const timestamp = currentTimestamp();
      purgeExpired(timestamp);
      const ownerScopeDigest = scopeDigest(scope);
      assertBoundedJson(payload);
      const payloadJson = canonicalJson(payload);
      const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
      if (payloadBytes > policy.maxPayloadBytes) {
        throw custodyError("opaque_payload_too_large", "Opaque payload exceeds the custody payload limit.");
      }
      const payloadDigest = digestText(payloadJson);
      const ownerBindingKey = bindingKey(ownerScopeDigest, idempotencyKey);
      const existingRef = ownerBindingKey ? idempotencyBindings.get(ownerBindingKey) : "";
      if (existingRef) {
        const existing = records.get(existingRef);
        if (existing?.payloadDigest !== payloadDigest) {
          throw custodyError("opaque_payload_idempotency_conflict", "Opaque payload custody binding conflicts.");
        }
        return existingRef;
      }
      if (records.size >= policy.maxRecords || totalBytes + payloadBytes > policy.maxBytes) {
        throw custodyError("opaque_payload_capacity_exceeded", "Opaque payload custody capacity is unavailable.");
      }
      let ref;
      do {
        ref = `custody:opaque-sensitive:${crypto.randomBytes(24).toString("hex")}`;
      } while (records.has(ref));
      const expiresAt = expirationTimestamp(timestamp);
      records.set(ref, Object.freeze({
        payload: clone(payload),
        payloadBytes,
        payloadDigest,
        scopeDigest: ownerScopeDigest,
        bindingKey: ownerBindingKey,
        expiresAt
      }));
      pushExpiration(Object.freeze({ ref, expiresAt }));
      totalBytes += payloadBytes;
      if (ownerBindingKey) idempotencyBindings.set(ownerBindingKey, ref);
      return ref;
    },
    async get(scope, ref) {
      purgeExpired();
      const record = records.get(String(ref || "").trim());
      if (!record) return null;
      if (record.scopeDigest !== scopeDigest(scope)) {
        throw custodyError("opaque_payload_scope_mismatch", "Opaque payload custody scope does not match.");
      }
      return clone(record.payload);
    },
    async delete(scope, ref) {
      purgeExpired();
      const custodyRef = String(ref || "").trim();
      const record = records.get(custodyRef);
      if (!record) return false;
      if (record.scopeDigest !== scopeDigest(scope)) {
        throw custodyError("opaque_payload_scope_mismatch", "Opaque payload custody scope does not match.");
      }
      return removeRecord(custodyRef);
    },
    async listRefs(scope) {
      purgeExpired();
      const ownerScopeDigest = scopeDigest(scope);
      return [...records.entries()]
        .filter(([, record]) => record.scopeDigest === ownerScopeDigest)
        .map(([ref]) => ref)
        .sort();
    },
    usage() {
      purgeExpired();
      return Object.freeze({ records: records.size, bytes: totalBytes });
    },
    async clear() {
      records.clear();
      idempotencyBindings.clear();
      expirationHeap.length = 0;
      totalBytes = 0;
    },
    sweep() {
      const before = records.size;
      purgeExpired();
      return before - records.size;
    }
  });
}
