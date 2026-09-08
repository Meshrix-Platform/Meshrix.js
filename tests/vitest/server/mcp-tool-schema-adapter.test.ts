import { describe, expect, it } from "vitest";

import { compileClosedJsonSchema } from "../../../packages/foundation/src/security/closed-json-schema.ts";
import { compileMcpToolJsonSchema } from "../../../packages/agents/src/upstream-gateway/mcp-tool-schema.ts";
import { publicUpstreamMcpTool } from "../../../packages/agents/src/upstream-gateway/tool-projection.ts";
import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { installUpstreamRuntimeServices } from "../../helpers/upstream-runtime-snapshot.ts";
import { executionSubject } from "../../helpers/mcp-downstream-request.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("MCP tool JSON Schema adapter", () : any => {
  it("preserves $ref target and sibling constraints", () : any => {
    const compiled: any = compileMcpToolJsonSchema({
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
    expect(compiled.schema.properties.name).toMatchObject({
      allOf: [
        { type: "string" },
        { minLength: 5, description: "display name" }
      ]
    });
    expect(compiled.validate({ name: "abcd" }).ok).toBe(false);
    expect(compiled.validate({ name: "abcde" }).ok).toBe(true);
  });

  it("keeps exact JSON Pointer escaping for names that contain slash or tilde", () : any => {
    const compiled: any = compileMcpToolJsonSchema({
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
    expect(compiled.validate({ slash: "slash", tilde: "tilde" }).ok).toBe(true);
    expect(compiled.validate({ slash: "no", tilde: "tilde" }).ok).toBe(false);
  });

  it("accepts null against a nullable $ref when minLength only applies to strings", () : any => {
    const compiled: any = compileMcpToolJsonSchema({
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
    expect(compiled.validate({ value: null }).ok).toBe(true);
    expect(compiled.validate({ value: "ab" }).ok).toBe(false);
    expect(compiled.validate({ value: "abc" }).ok).toBe(true);
  });

  it("keeps ordinary annotation keywords and nested local JSON Pointers", () : any => {
    const compiled: any = compileMcpToolJsonSchema({
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
    expect(compiled.schema.properties.value).toMatchObject({
      allOf: [
        { type: "string", minLength: 1 },
        { examples: ["abc"], deprecated: false, readOnly: true }
      ]
    });
    expect(compiled.validate({ value: "a" }).ok).toBe(true);
  });

  it("rejects draft-07 instead of applying 2020-12 $ref-sibling semantics under that dialect", () : any => {
    expect(() : any => compileMcpToolJsonSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object"
    })).toThrow(/unsupported JSON Schema dialect/);
  });

  it("fails closed on an unsupported explicit dialect", () : any => {
    expect(() : any => compileMcpToolJsonSchema({
      $schema: "https://json-schema.org/draft/2012-01/schema",
      type: "object"
    })).toThrow(/unsupported JSON Schema dialect/);
  });

  it("keeps object-root input schemas and preserves array output schemas", () : any => {
    expect(() : any => compileMcpToolJsonSchema({
      type: "array",
      items: { type: "string" }
    })).toThrow(/object root/);
    const output: any = compileMcpToolJsonSchema({
      type: "array",
      items: { type: "string" }
    }, {
      label: "Upstream MCP tool output schema",
      requireTopLevelObject: false
    });
    expect(output.schema).toMatchObject({
      type: "array",
      items: { type: "string" }
    });
    expect(output.validate(["a", "b"]).ok).toBe(true);
    expect(output.validate({ value: "a" }).ok).toBe(false);

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
    expect(() : any => publicUpstreamMcpTool({
      service: { serviceId: "schema-service" },
      tool: {
        name: "list",
        inputSchema: { type: "object" },
        outputSchema: true
      }
    })).toThrow(/output schema is invalid/);
    try {
      publicUpstreamMcpTool({
        service: { serviceId: "schema-service" },
        tool: {
          name: "list",
          inputSchema: { type: "object" },
          outputSchema: true
        }
      });
      throw new Error("expected output schema rejection");
    } catch (error: any) {
      expect(error).toMatchObject({
        code: "upstream_tool_output_schema_invalid",
        status: 502
      });
    }
  });

  it("keeps a $ref object root after allOf flattening", () : any => {
    const compiled: any = compileMcpToolJsonSchema({
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
    expect(compiled.validate({ value: "abc" }).ok).toBe(true);
    expect(compiled.validate("abc").ok).toBe(false);
  });

  it("keeps an explicit object root when the $ref target only has properties", () : any => {
    const compiled: any = compileMcpToolJsonSchema({
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
    expect(compiled.validate({ value: "abc" }).ok).toBe(true);
    expect(compiled.validate("abc").ok).toBe(false);
  });

  it("keeps an explicit object root when the $ref target is an empty schema", () : any => {
    const compiled: any = compileMcpToolJsonSchema({
      type: "object",
      $ref: "#/$defs/root",
      $defs: {
        root: {}
      }
    });
    expect(compiled.validate({}).ok).toBe(true);
    expect(compiled.validate("abc").ok).toBe(false);
  });

  it("does not infer an output-root type from string keywords", () : any => {
    const compiled: any = compileMcpToolJsonSchema({
      minLength: 3
    }, {
      requireTopLevelObject: false
    });
    expect(compiled.validate(null).ok).toBe(true);
    expect(compiled.validate("ab").ok).toBe(false);
    expect(compiled.validate("abc").ok).toBe(true);
  });

  it("ignores string keywords on an explicit null type", () : any => {
    const compiled: any = compileMcpToolJsonSchema({
      type: "object",
      properties: {
        value: { type: "null", minLength: 3 }
      }
    });
    expect(compiled.validate({ value: null }).ok).toBe(true);
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
