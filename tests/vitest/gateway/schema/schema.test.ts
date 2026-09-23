import { describe, expect, it } from "vitest";
import { compileExternalSchema, createSchemaValidator, GatewaySchemaError, JSON_SCHEMA_2020_12 } from "@meshrix/gateway";
import { context, response, route, createTestGateway as createGateway } from "../support";

describe("gateway external JSON Schema boundary", () => {
  it("[CASE-S01] [CASE-S03] supports standard numeric, tuple, pattern, and unevaluated keywords without rewriting input", () => {
    const schema = {
      $schema: JSON_SCHEMA_2020_12,
      type: "object",
      properties: {
        count: { type: "integer", exclusiveMinimum: 0, multipleOf: 3 },
        tuple: { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], items: false }
      },
      patternProperties: { "^x-": { type: "integer" } },
      unevaluatedProperties: false
    };
    const original = structuredClone(schema);
    const compiled = compileExternalSchema(schema);
    expect(compiled.schema).toEqual(original);
    expect(compiled.validate({ count: 3, tuple: ["a", 1], "x-extra": 2 })).toBe(true);
    expect(compiled.validate({ count: 0 })).toBe(false);
    expect(compiled.validate({ count: 3, tuple: ["a", 1, 2] })).toBe(false);
  });

  it("[CASE-S04] supports recursive local references and boolean sub-schemas", () => {
    const compiled = compileExternalSchema({
      type: "object",
      $defs: { node: { type: "object", properties: { children: { type: "array", items: { $ref: "#/$defs/node" } } } } },
      properties: { root: { $ref: "#/$defs/node" }, allowed: true, blocked: false }
    });
    expect(compiled.validate({ root: { children: [{ children: [] }] }, allowed: { ok: true } })).toBe(true);
    expect(compiled.validate({ root: { children: [5] } })).toBe(false);
    expect(compiled.validate({ blocked: null })).toBe(false);
  });

  it("[CASE-S05] defaults a missing dialect, rejects an unknown dialect, and does not fetch remote refs", () => {
    expect(compileExternalSchema({ type: "string" }).dialect).toBe(JSON_SCHEMA_2020_12);
    expect(() => compileExternalSchema({ $schema: "https://example.invalid/schema" })).toThrowError(GatewaySchemaError);
    expect(() => compileExternalSchema({ $ref: "https://example.invalid/schema.json" })).toThrowError(/could not be compiled/u);
  });

  it("[CASE-S07] separates structural budget failures from semantic compilation failures and caches by configuration", () => {
    expect(() => compileExternalSchema({ type: "object", properties: { a: { type: "string" } } }, { budget: { maxNodes: 1 } })).toThrowError(/node budget/u);
    expect(() => compileExternalSchema({ type: "object", properties: { a: { type: "string" } } }, { budget: { maxBytes: 10 } })).toThrowError(/byte budget/u);
    const validator = createSchemaValidator();
    expect(validator.compile({ type: "string" })).toBe(validator.compile({ type: "string" }));
  });

  it("surfaces unsupported assertion keywords instead of silently ignoring them", () => {
    expect(() => compileExternalSchema({ type: "object", unknownAssertion: 42 })).toThrowError(/unsupported JSON Schema keyword/u);
  });

  it("validates catalog input before the sink and validates declared output after the sink", async () => {
    let calls = 0;
    const gateway = createGateway({
      descriptors: [{ kind: "tool", publicName: "schema", route: route({ logicalRoute: "schema" }), inputSchema: { type: "object", required: ["id"] }, outputSchema: { type: "object", required: ["ok"] } }],
      upstream: { invoke: async () => { calls += 1; return response({ resultType: "complete", value: { wrong: true } }); } }
    });
    await gateway.start();
    try {
      expect(await gateway.invoke(context, { routeRef: "schema", method: "tools/call", params: {} })).toMatchObject({ kind: "failure", origin: "schema", code: "schema_validation_failed", effectOutcome: "not_started" });
      expect(calls).toBe(0);
      expect(await gateway.invoke(context, { routeRef: "schema", method: "tools/call", params: { id: "demo" } })).toMatchObject({ kind: "failure", origin: "schema", code: "schema_validation_failed", effectOutcome: "failed" });
      expect(calls).toBe(1);
    } finally {
      await gateway.close();
    }
  });
});
