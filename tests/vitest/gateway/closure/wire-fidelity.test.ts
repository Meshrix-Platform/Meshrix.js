import { describe, expect, it } from "vitest";
import { decodeUpstreamResult, compileExternalSchema } from "@meshrix/gateway";
import { buildModernRequest } from "@meshrix/protocols/mcp/modern-upstream";
import { publicUpstreamMcpTool } from "../../../../packages/agents/src/upstream-gateway/tool-projection.ts";
import { createModernDownstreamAdapter } from "@meshrix/protocols/mcp/modern-downstream";
import { context, createTestGateway, descriptor, QueueUpstream, response, route } from "../support";

describe("PR82 externally validated MCP wire", () => {
  it("[GC-023 GC-024 GC-029] preserves the complete envelope and rejects unknown and private discriminants", () => {
    const raw = { resultType: "complete", content: [{ type: "text", text: "business" }], structuredContent: { ok: true, kind: "complete" }, _meta: { "business-id": "synthetic" }, value: { businessField: 7 } };
    expect(decodeUpstreamResult(raw)).toMatchObject({ kind: "complete", value: raw });
    expect(decodeUpstreamResult({ resultType: "demo/unknown", value: {} })).toMatchObject({ kind: "failure", code: "upstream_result_type_unnegotiated" });
    expect(decodeUpstreamResult({ kind: "complete", value: { trusted: false } })).toMatchObject({ kind: "failure", code: "upstream_result_invalid" });
  });

  it("[GC-017 GC-018] accepts state-only MRTR and distinguishes empty from absent state", () => {
    expect(decodeUpstreamResult({ resultType: "input_required", requestState: "" })).toMatchObject({ kind: "input_required", upstreamState: { present: true, value: "" } });
    expect(decodeUpstreamResult({ resultType: "input_required", inputRequests: {} })).toMatchObject({ kind: "input_required", upstreamState: { present: false } });
    expect(decodeUpstreamResult({ resultType: "input_required" })).toMatchObject({ kind: "failure", code: "input_required_invalid" });
  });

  it("[GC-030 GC-032] puts hop metadata in params._meta without erasing application metadata", () => {
    const request = buildModernRequest({ id: 3, method: "tools/call", params: { name: "demo", _meta: { "business-id": "synthetic", "io.modelcontextprotocol/protocolVersion": "forged" } }, protocolVersion: "2026-07-28", headers: {} });
    expect(request).toMatchObject({ params: { _meta: { "business-id": "synthetic", "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "meshrix-gateway" }, "io.modelcontextprotocol/clientCapabilities": {} } } });
    expect(request).not.toHaveProperty("clientInfo");
  });

  it("[GC-031 partial] retains valid external JSON Schema 2020-12 keywords and validates the business object", () => {
    const schema = { type: "object", properties: { count: { type: "number", exclusiveMinimum: 0 }, node: { $ref: "#/$defs/node" } }, required: ["count"], $defs: { node: { type: "object", properties: { next: { $ref: "#/$defs/node" } } } } };
    const projected = publicUpstreamMcpTool({ service: { serviceId: "synthetic", operations: [{ operationKey: "tools/call", risk: "read_only" }] }, tool: { name: "recursive", inputSchema: schema, annotations: { readOnlyHint: true, arbitraryHint: "informational" } } });
    expect(projected.inputSchema).toEqual(schema);
    expect(projected.annotations.arbitraryHint).toBe("informational");
    const validator = compileExternalSchema(projected.inputSchema);
    expect(validator.validate({ count: 2, node: { next: {} } })).toBe(true);
    expect(validator.validate({ count: 0 })).toBe(false);
  });

  it("[GC-028] preserves safe peer error code/data while tool isError remains a successful tool result", async () => {
    const upstream = new QueueUpstream([
      response({ jsonrpc: "2.0", id: 1, error: { code: -32042, message: "Synthetic peer refusal", data: { field: "value", credential: "synthetic-private", stack: "synthetic-stack" } } }),
      response({ jsonrpc: "2.0", id: 2, result: { resultType: "complete", isError: true, content: [{ type: "text", text: "business failure" }] } })
    ]);
    const gateway = createTestGateway({ descriptors: [descriptor({ route: route({ effectClass: "read" }) })], upstream });
    await gateway.start();
    try {
      const adapter = createModernDownstreamAdapter({ gateway, authenticate: () => context });
      const send = async (id: number) => adapter.handle({ method: "POST", headers: { "content-type": "application/json" }, body: { jsonrpc: "2.0", id, method: "tools/call", params: { name: "demo", arguments: {} } } });
      const rejected = await send(1);
      expect(rejected).toMatchObject({ status: 200, body: { error: { code: -32042, message: "Synthetic peer refusal", data: { field: "value", code: "upstream_jsonrpc_error" } } } });
      expect(JSON.stringify(rejected.body)).not.toMatch(/synthetic-private|synthetic-stack/u);
      expect(await send(2)).toMatchObject({ status: 200, body: { result: { resultType: "complete", isError: true, content: [{ text: "business failure" }] } } });
    } finally { await gateway.close(); }
  });

  it("[GC-025] validates structuredContent without replacing valid MCP content or hiding invalid output", async () => {
    const upstream = new QueueUpstream([
      response({ resultType: "complete", content: [{ type: "text", text: "plain business" }], structuredContent: { count: 1 }, _meta: { businessId: "synthetic" } }),
      response({ resultType: "complete", content: [{ type: "text", text: "untrusted business" }], structuredContent: { count: "invalid" } })
    ]);
    const gateway = createTestGateway({ descriptors: [descriptor({ route: route({ effectClass: "read" }), outputSchema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] } })], upstream });
    await gateway.start();
    try {
      const adapter = createModernDownstreamAdapter({ gateway, authenticate: () => context });
      const send = async (id: number) => adapter.handle({ method: "POST", headers: { "content-type": "application/json" }, body: { jsonrpc: "2.0", id, method: "tools/call", params: { name: "demo", arguments: {} } } });
      expect((await send(1)).body).toMatchObject({ result: { resultType: "complete", content: [{ text: "plain business" }], structuredContent: { count: 1 }, _meta: { businessId: "synthetic" } } });
      expect((await send(2)).body).toMatchObject({ error: { data: { code: "schema_validation_failed" } } });
    } finally { await gateway.close(); }
  });
});
