import { describe, expect, it } from "vitest";

import {
  canonicalSerialize,
  fingerprint,
  parseWithDuplicateRejection,
} from "../../../packages/agents/src/upstream-gateway/manifest-compiler.mjs";

describe("upstream publishing raw JSON admission", () => {
  it("accepts nested JSON without confusing structural characters inside strings", () => {
    expect(parseWithDuplicateRejection(Buffer.from(JSON.stringify({
      serviceId: "service-a",
      description: "braces { } brackets [ ] and a colon: remain text",
      nested: [{ key: "value" }, { key: "other" }]
    })))).toEqual({
      serviceId: "service-a",
      description: "braces { } brackets [ ] and a colon: remain text",
      nested: [{ key: "value" }, { key: "other" }]
    });
  });

  it.each([
    '{"serviceId":"a","serviceId":"b"}',
    '{"outer":{"key":1,"key":2}}',
    '{"key":1,"\\u006bey":2}'
  ])("rejects duplicate object members before JSON projection", (source) => {
    expect(() => parseWithDuplicateRejection(source)).toThrow("Publishing input contains a duplicate object key.");
  });

  it.each([
    '{"__proto__":{}}',
    '{"\\u005f\\u005fproto__":{}}',
    '{"nested":{"constructor":{}}}',
    '{"nested":{"prototype":{}}}'
  ])("rejects prototype-mutating members before JSON projection", (source) => {
    expect(() => parseWithDuplicateRejection(source)).toThrow("Publishing input contains a prohibited object key.");
  });

  it.each([
    '{"a":1} trailing',
    '{"a":01}',
    '{"a":"unterminated}',
    '{"a":[1,]}',
    '{"a":true false}'
  ])("rejects malformed or trailing input", (source) => {
    expect(() => parseWithDuplicateRejection(source)).toThrow(SyntaxError);
  });

  it("rejects invalid UTF-8 and applies the byte budget before materialization", () => {
    expect(() => parseWithDuplicateRejection(Buffer.from([0xc3, 0x28]))).toThrow();
    expect(() => parseWithDuplicateRejection(JSON.stringify({
      value: "é".repeat(70_000)
    }))).toThrow(/byte limit/u);
  });

  it("rejects nesting beyond the depth budget before persistence", () => {
    let nested = { leaf: true };
    for (let depth = 0; depth < 40; depth += 1) nested = { nested };
    expect(() => parseWithDuplicateRejection(JSON.stringify(nested))).toThrow(/nesting depth/u);
  });

  it("rejects escaped control and line-separator Unicode after JSON projection", () => {
    expect(() => parseWithDuplicateRejection('{"value":"\\u0001"}')).toThrow(/control characters/u);
    expect(() => parseWithDuplicateRejection('{"value":"\\u2028"}')).toThrow(/control characters/u);
    expect(() => parseWithDuplicateRejection('{"value":"\\u0085"}')).toThrow(/control characters/u);
  });

  it("canonicalizes object key order without mutating array order", () => {
    const left = { z: [{ b: 2, a: 1 }], a: true };
    const right = { a: true, z: [{ a: 1, b: 2 }] };
    expect(canonicalSerialize(left)).toBe(canonicalSerialize(right));
    expect(fingerprint(left)).toBe(fingerprint(right));
    expect(fingerprint({ ...right, z: [...right.z].reverse() })).toBe(fingerprint(right));
  });

});
