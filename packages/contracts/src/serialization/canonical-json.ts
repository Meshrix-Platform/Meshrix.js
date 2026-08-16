/**
 * Versioned canonical JSON authority for all cross-layer digests and signatures.
 *
 * The accepted value domain is deliberately JSON plus the explicitly governed
 * transport value types Date, Buffer, Map and Set. Cycles and unsupported values fail
 * closed so a signature can never be computed over an ambiguous projection.
 */
export const CANONICAL_JSON_VERSION = "v0.0.1:serialization:canonical-json-1";

function compareKeys(left: unknown, right: unknown): number {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function serialize(value: unknown, seen: WeakSet<object>): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError("Invalid Date in canonical JSON value");
    return JSON.stringify(value.toISOString());
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return JSON.stringify(value.toString("base64"));
  }
  if (seen.has(value)) throw new TypeError("Cyclic canonical JSON value");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => serialize(entry, seen)).join(",")}]`;
    }
    if (value instanceof Map) {
      const entries = [...value.entries()].sort(([a], [b]) => compareKeys(a, b));
      return `{${entries.map(([key, entry]) => `${JSON.stringify(String(key))}:${serialize(entry, seen)}`).join(",")}}`;
    }
    if (value instanceof Set) {
      const entries = [...value].map((entry) => serialize(entry, seen)).sort();
      return `[${entries.join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Unsupported canonical JSON object prototype");
    }
    return `{${Object.keys(record).sort(compareKeys).map((key) => (
      `${JSON.stringify(key)}:${serialize(record[key], seen)}`
    )).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value?: unknown) {
  return serialize(value, new WeakSet<object>());
}

export function canonicalEqual(left?: unknown, right?: unknown) {
  return canonicalJson(left) === canonicalJson(right);
}
