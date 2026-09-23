import { describe, expect, it } from "vitest";

import { compileClosedJsonSchema } from "../../../packages/foundation/src/security/closed-json-schema.ts";
import { compileExternalSchema } from "@meshrix/gateway/schema";
import { publicUpstreamMcpTool } from "../../../packages/agents/src/upstream-gateway/tool-projection.ts";
import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { installUpstreamRuntimeServices } from "../../helpers/upstream-runtime-snapshot.ts";
import { executionSubject } from "../../helpers/mcp-downstream-request.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("MCP tool JSON Schema adapter", () : any => {
  it("preserves $ref target and sibling constraints", () : any => {
    const compiled: any = compileExternalSchema({
      type: "object",
      properties: {
        name: {
          $ref: "#/$defs/s",
          minLength: 5,
          description: "display name"
        }
      },
      $defs: {
        s: { type: "string" }
      }
    });
    expect(compiled.schema.properties.name).toMatchObject({ $ref: "#/$defs/s", minLength: 5, description: "display name" });
    expect(compiled.validate({ name: "abcd" })).toBe(false);
    expect(compiled.validate({ name: "abcde" })).toBe(true);
  });

  it("keeps exact JSON Pointer escaping for names that contain slash or tilde", () : any => {
    const compiled: any = compileExternalSchema({
      type: "object",
      properties: {
        slash: { $ref: "#/$defs/foo~1bar" },
        tilde: { $ref: "#/$defs/a~0b" }
      },
      $defs: {
        "foo/bar": { type: "string", const: "slash" },
        "a~b": { type: "string", const: "tilde" }
      }
    });
    expect(compiled.validate({ slash: "slash", tilde: "tilde" })).toBe(true);
    expect(compiled.validate({ slash: "no", tilde: "tilde" })).toBe(false);
  });

  it("accepts null against a nullable $ref when minLength only applies to strings", () : any => {
    const compiled: any = compileExternalSchema({
      type: "object",
      properties: {
        value: {
          $ref: "#/$defs/value",
          minLength: 3
        }
      },
      $defs: {
        value: { type: ["string", "null"] }
      }
    });
    expect(compiled.validate({ value: null })).toBe(true);
    expect(compiled.validate({ value: "ab" })).toBe(false);
    expect(compiled.validate({ value: "abc" })).toBe(true);
  });

  it("keeps ordinary annotation keywords and nested local JSON Pointers", () : any => {
    const compiled: any = compileExternalSchema({
      type: "object",
      properties: {
        value: {
          $ref: "#/$defs/container/properties/value",
          examples: ["abc"],
          deprecated: false,
          readOnly: true
        }
      },
      $defs: {
        container: {
          type: "object",
          properties: {
            value: { type: "string", minLength: 1 }
          }
        }
      }
    });
    expect(compiled.schema.properties.value).toMatchObject({ $ref: "#/$defs/container/properties/value", examples: ["abc"], deprecated: false, readOnly: true });
    expect(compiled.validate({ value: "a" })).toBe(true);
  });

  it("rejects draft-07 instead of applying 2020-12 $ref-sibling semantics under that dialect", () : any => {
    expect(() : any => compileExternalSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object"
    })).toThrow(/Only JSON Schema 2020-12 is supported/);
  });

  it("fails closed on an unsupported explicit dialect", () : any => {
    expect(() : any => compileExternalSchema({
      $schema: "https://json-schema.org/draft/2012-01/schema",
      type: "object"
    })).toThrow(/Only JSON Schema 2020-12 is supported/);
  });

  it("keeps object-root input schemas and preserves array output schemas", () : any => {
    const output: any = compileExternalSchema({
      type: "array",
      items: { type: "string" }
    });
    expect(output.schema).toMatchObject({
      type: "array",
      items: { type: "string" }
    });
    expect(output.validate(["a", "b"])).toBe(true);
    expect(output.validate({ value: "a" })).toBe(false);
    expect(() => publicUpstreamMcpTool({ service: { serviceId: "schema-service" }, tool: { name: "invalid-root", inputSchema: { type: "array", items: { type: "string" } } } })).toThrow(/input schema is invalid/u);

    const projected: any = publicUpstreamMcpTool({
      service: { serviceId: "schema-service", label: "Schema" },
      tool: {
        name: "list",
        inputSchema: { type: "object" },
        outputSchema: { type: "array", items: { type: "string" } }
      }
    });
    expect(projected.outputSchema).toMatchObject({
      type: "array",
      items: { type: "string" }
    });
    const booleanOutput: any = publicUpstreamMcpTool({
      service: { serviceId: "schema-service" },
      tool: {
        name: "list",
        inputSchema: { type: "object" },
        outputSchema: true
      }
    });
    expect(booleanOutput.outputSchema).toBe(true);
  });

  it("keeps a $ref object root without rewriting it", () : any => {
    const compiled: any = compileExternalSchema({
      type: "object",
      $ref: "#/$defs/root",
      $defs: {
        root: {
          type: "object",
          properties: {
            value: { type: "string" }
          }
        }
      }
    });
    expect(compiled.validate({ value: "abc" })).toBe(true);
    expect(compiled.validate("abc")).toBe(false);
  });

  it("keeps an explicit object root when the $ref target only has properties", () : any => {
    const compiled: any = compileExternalSchema({
      type: "object",
      $ref: "#/$defs/root",
      $defs: {
        root: {
          properties: {
            value: { type: "string" }
          }
        }
      }
    });
    expect(compiled.validate({ value: "abc" })).toBe(true);
    expect(compiled.validate("abc")).toBe(false);
  });

  it("keeps an explicit object root when the $ref target is an empty schema", () : any => {
    const compiled: any = compileExternalSchema({
      type: "object",
      $ref: "#/$defs/root",
      $defs: {
        root: {}
      }
    });
    expect(compiled.validate({})).toBe(true);
    expect(compiled.validate("abc")).toBe(false);
  });

  it("does not infer an output-root type from string keywords", () : any => {
    const compiled: any = compileExternalSchema({
      minLength: 3
    });
    expect(compiled.validate(null)).toBe(true);
    expect(compiled.validate("ab")).toBe(false);
    expect(compiled.validate("abc")).toBe(true);
  });

  it("ignores string keywords on an explicit null type", () : any => {
    const compiled: any = compileExternalSchema({
      type: "object",
      properties: {
        value: { type: "null", minLength: 3 }
      }
    });
    expect(compiled.validate({ value: null })).toBe(true);
    expect(() : any => compileClosedJsonSchema({
      type: "object",
      properties: {
        value: { type: "null", minLength: 3 }
      }
    })).toThrow(/string constraints without declaring that type/);
  });

  it("keeps control-plane closed schemas strict", () : any => {
    expect(() : any => compileClosedJsonSchema({
      type: "object",
      properties: {
        name: { type: "string", description: "not allowed here" }
      }
    })).toThrow(/unsupported keyword/);
  });

  it("enforces the external schema through governed MCP execution", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-schema-exec-"));
    const callTool: any = async (_config?: any, request?: any) : Promise<any> => ({
      result: {
        content: [{ type: "text", text: "ok" }],
        structuredContent: request.arguments
      }
    });
    const registry: any = createUpstreamGatewayRegistry({
      userDataPath: root,
      mcpSessionManager: {
        listTools: async () : Promise<any> => ({
          tools: [{
            name: "echo",
            inputSchema: {
              type: "object",
              properties: {
                name: { $ref: "#/$defs/s", minLength: 5 }
              },
              required: ["name"],
              $defs: { s: { type: "string" } }
            }
          }]
        }),
        callTool,
        async retireServiceScopes() : Promise<any> { return { retired: 0 }; },
        async close() : Promise<any> {}
      }
    });
    installUpstreamRuntimeServices(registry, [{
      serviceId: "schema-service",
      serviceProtocol: "mcp",
      mcp: {
        transport: "http",
        url: "https://example.invalid:443/mcp",
        toolNamePrefix: "schema-service"
      }
    }]);
    try {
      await expect(registry.callMcpToolByPublicName(
        "upstream.schema-service.echo",
        { arguments: { name: "abcd" } },
        executionSubject({ publicToolName: "upstream.schema-service.echo" })
      )).rejects.toMatchObject({
        status: 400,
        reasonCode: "upstream_mcp_arguments_invalid"
      });
      const accepted: any = await registry.callMcpToolByPublicName(
        "upstream.schema-service.echo",
        { arguments: { name: "abcde" } },
        executionSubject({ publicToolName: "upstream.schema-service.echo" })
      );
      expect(accepted.response.structuredContent).toEqual({ name: "abcde" });
    } finally {
      await registry.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
