/**
 * Unit tests for canonical-json — deterministic serialization.
 */
import { describe, it, expect } from "vitest";
import {
  CANONICAL_VERSION,
  canonicalEqual,
  canonicalHash,
  canonicalJson
} from "../../../packages/foundation/src/serialization/canonical-json.mjs";

describe("canonicalJson", () => {
  it("sorts object keys deterministically", () => {
    const a = canonicalJson({ z: 1, a: 2, m: 3 });
    const b = canonicalJson({ m: 3, z: 1, a: 2 });
    expect(a).toBe(b);
  });

  it("produces stable output for same input", () => {
    const obj = { name: "test", values: [3, 1, 2], meta: { created: "today" } };
    const r1 = canonicalJson(obj);
    const r2 = canonicalJson(obj);
    const r3 = canonicalJson(obj);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
  });

  it("handles null and undefined as null", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(undefined)).toBe("null");
  });

  it("handles NaN as null", () => {
    expect(canonicalJson(NaN)).toBe("null");
  });

  it("handles Infinity as null", () => {
    expect(canonicalJson(Infinity)).toBe("null");
    expect(canonicalJson(-Infinity)).toBe("null");
  });

  it("handles Date objects", () => {
    const date = new Date("2026-06-25T12:00:00Z");
    const result = canonicalJson({ created: date });
    expect(result).toContain("2026-06-25T12:00:00.000Z");
  });

  it("handles nested objects with sorted keys", () => {
    const obj = {
      b: { z: 1, a: 2 },
      a: { m: 3, k: 4 },
    };
    const result = canonicalJson(obj);
    // Keys should be sorted at both levels
    const aIndex = result.indexOf('"a":');
    const bIndex = result.indexOf('"b":');
    expect(aIndex).toBeLessThan(bIndex);
  });

  it("handles empty objects and arrays", () => {
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
  });

  it("handles boolean values", () => {
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
  });

  it("handles strings with special characters", () => {
    const result = canonicalJson({ key: 'hello "world"\n\t' });
    expect(result).toContain('hello \\"world\\"');
  });

  it("handles -0 as 0", () => {
    const result = canonicalJson({ value: -0 });
    expect(result).toContain('"value":0');
  });

  it("preserves the versioned authority contract", () => {
    expect(CANONICAL_VERSION).toBe("v0.0.1:serialization:canonical-json-1");
  });

  it("serializes governed transport collections deterministically", () => {
    expect(canonicalJson(new Map([["z", 1], ["a", 2]]))).toBe('{"a":2,"z":1}');
    expect(canonicalJson(new Set(["z", "a"]))).toBe('["a","z"]');
    expect(canonicalJson(Buffer.from("meshrix", "utf8"))).toBe('"bGljbw=="');
  });

  it("fails closed for cycles and unsupported values", () => {
    const cyclic = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/Cyclic canonical JSON value/u);
    expect(() => canonicalJson(1n)).toThrow(/Unsupported canonical JSON value/u);
    expect(() => canonicalJson(new URL("https://example.invalid"))).toThrow(
      /Unsupported canonical JSON object prototype/u
    );
  });
});

describe("canonicalHash", () => {
  it("produces consistent hash for equivalent objects", () => {
    const hash1 = canonicalHash({ b: 2, a: 1 });
    const hash2 = canonicalHash({ a: 1, b: 2 });
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different objects", () => {
    const hash1 = canonicalHash({ a: 1 });
    const hash2 = canonicalHash({ a: 2 });
    expect(hash1).not.toBe(hash2);
  });
});

describe("canonicalEqual", () => {
  it("considers key-order-different objects equal", () => {
    expect(canonicalEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it("considers different values unequal", () => {
    expect(canonicalEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("considers null equal to null", () => {
    expect(canonicalEqual(null, null)).toBe(true);
  });
});
