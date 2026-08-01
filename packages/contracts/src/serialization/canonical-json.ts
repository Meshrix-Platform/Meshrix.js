/**
 * Versioned canonical JSON authority for all cross-layer digests and signatures.
 *
 * The accepted value domain is deliberately JSON plus the explicitly governed
 * transport value types Date, Buffer, Map and Set. Cycles and unsupported values fail
 * closed so a signature can never be computed over an ambiguous projection.
 */
export const CANONICAL_JSON_VERSION: any = "v0.0.1:serialization:canonical-json-1";

function compareKeys(left?: any, right?: any) : any {
  const a: any = String(left);
  const b: any = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function serialize(value?: any, seen?: any) : any {
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
      return `[${value.map((entry?: any) : any => serialize(entry, seen)).join(",")}]`;
    }
    if (value instanceof Map) {
      const entries: any = [...value.entries()].sort(([a]: any[], [b]: any[]) : any => compareKeys(a, b));
      return `{${entries.map(([key, entry]: any[]) : any => `${JSON.stringify(String(key))}:${serialize(entry, seen)}`).join(",")}}`;
    }
    if (value instanceof Set) {
      const entries: any = [...value].map((entry?: any) : any => serialize(entry, seen)).sort();
      return `[${entries.join(",")}]`;
    }
    const prototype: any = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Unsupported canonical JSON object prototype");
    }
    return `{${Object.keys(value).sort(compareKeys).map((key?: any) : any => (
      `${JSON.stringify(key)}:${serialize(value[key], seen)}`
    )).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value?: any) : any {
  return serialize(value, new WeakSet<object>());
}

export function canonicalEqual(left?: any, right?: any) : any {
  return canonicalJson(left) === canonicalJson(right);
}
