/**
 * Unit tests for canonical-json — deterministic serialization.
 */
import { describe, it, expect } from "vitest";
import {
  CANONICAL_VERSION,
  canonicalEqual,
  canonicalHash,
  canonicalJson
} from "../../../packages/foundation/src/serialization/canonical-json.ts";

describe("canonicalJson", () : any => {
  it("sorts object keys deterministically", () : any => {
    const a: any = canonicalJson({ z: 1, a: 2, m: 3 });
    const b: any = canonicalJson({ m: 3, z: 1, a: 2 });
    expect(a).toBe(b);
  });

  it("produces stable output for same input", () : any => {
    const obj: Record<string, any> = { name: "test", values: [3, 1, 2], meta: { created: "today" } };
    const r1: any = canonicalJson(obj);
    const r2: any = canonicalJson(obj);
    const r3: any = canonicalJson(obj);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
  });

  it("handles null and undefined as null", () : any => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(undefined)).toBe("null");
  });

  it("handles NaN as null", () : any => {
    expect(canonicalJson(NaN)).toBe("null");
  });

  it("handles Infinity as null", () : any => {
    expect(canonicalJson(Infinity)).toBe("null");
    expect(canonicalJson(-Infinity)).toBe("null");
  });

  it("handles Date objects", () : any => {
    const date: any = new Date("2026-06-25T12:00:00Z");
    const result: any = canonicalJson({ created: date });
    expect(result).toContain("2026-06-25T12:00:00.000Z");
  });

  it("handles nested objects with sorted keys", () : any => {
    const obj: Record<string, any> = {
      b: { z: 1, a: 2 },
      a: { m: 3, k: 4 },
    };
    const result: any = canonicalJson(obj);
    // Keys should be sorted at both levels
    const aIndex: any = result.indexOf('"a":');
    const bIndex: any = result.indexOf('"b":');
    expect(aIndex).toBeLessThan(bIndex);
  });

  it("handles empty objects and arrays", () : any => {
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
  });

  it("handles boolean values", () : any => {
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
  });

  it("handles strings with special characters", () : any => {
    const result: any = canonicalJson({ key: 'hello "world"\n\t' });
    expect(result).toContain('hello \\"world\\"');
  });

  it("handles -0 as 0", () : any => {
    const result: any = canonicalJson({ value: -0 });
    expect(result).toContain('"value":0');
  });

  it("preserves the versioned authority contract", () : any => {
    expect(CANONICAL_VERSION).toBe("v0.0.1:serialization:canonical-json-1");
  });

  it("serializes governed transport collections deterministically", () : any => {
    expect(canonicalJson(new Map<any, any>([["z", 1], ["a", 2]]))).toBe('{"a":2,"z":1}');
    expect(canonicalJson(new Set<any>(["z", "a"]))).toBe('["a","z"]');
    expect(canonicalJson(Buffer.from("meshrix", "utf8"))).toBe('"bWVzaHJpeA=="');
  });

  it("fails closed for cycles and unsupported values", () : any => {
    const cyclic: Record<string, any> = {};
    cyclic.self = cyclic;
    expect(() : any => canonicalJson(cyclic)).toThrow(/Cyclic canonical JSON value/u);
    expect(() : any => canonicalJson(1n)).toThrow(/Unsupported canonical JSON value/u);
    expect(() : any => canonicalJson(new URL("https://example.invalid"))).toThrow(
      /Unsupported canonical JSON object prototype/u
    );
  });
});

describe("canonicalHash", () : any => {
  it("produces consistent hash for equivalent objects", () : any => {
    const hash1: any = canonicalHash({ b: 2, a: 1 });
    const hash2: any = canonicalHash({ a: 1, b: 2 });
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different objects", () : any => {
    const hash1: any = canonicalHash({ a: 1 });
    const hash2: any = canonicalHash({ a: 2 });
    expect(hash1).not.toBe(hash2);
  });
});

describe("canonicalEqual", () : any => {
  it("considers key-order-different objects equal", () : any => {
    expect(canonicalEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it("considers different values unequal", () : any => {
    expect(canonicalEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("considers null equal to null", () : any => {
    expect(canonicalEqual(null, null)).toBe(true);
  });
});
