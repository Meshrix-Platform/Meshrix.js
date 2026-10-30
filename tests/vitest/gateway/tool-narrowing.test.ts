import { describe, expect, it } from "vitest";
import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { evaluateAudienceDecision } from "../../../packages/agents/src/upstream-gateway/audience-projection.ts";
import { installUpstreamRuntimeServices } from "../../helpers/upstream-runtime-snapshot.ts";
import { createGatewaySchemaPort } from "@meshrix/server-runtime/composition/gateway-schema-port";
const canned1 = "tools/call";




function mcpRegistry(tools: any[]) : any {
  return createUpstreamGatewayRegistry({
    schemaPort: createGatewaySchemaPort(),
    mcpSessionManager: {
      listTools: async () => ({ tools }),
      invokeGateway: async () => ({ result: { content: [] } }),
      retireScope: async () => ({ retired: 0 }),
      close: async () => {}
    }
  });
}

function service() : any {
  return {
    serviceId: "vault",
    serviceProtocol: "mcp",
    label: "vault",
    allowLocalNetwork: true,
    operations: [{ operationKey: canned1, protocol: "mcp", risk: "read_only", requiredScopes: ["gateway:read"] }],
    mcp: { transport: "http", url: "http://127.0.0.1:9/mcp", protocolVersion: "2025-06-18" }
  };
}

const TOOL_OPERATION = {
  id: "upstream.vault.kv_store",
  toolId: "upstream.vault.kv_store",
  requiredScopes: ["gateway:read"],
  safety: { risk: "read_only" },
  _meta: { upstreamMcp: true, serviceId: "vault", risk: "read_only" }
};

const BASE_GRANT = {
  id: "grant",
  subjectId: "operator",
  scopes: ["gateway:read"],
  allowedServiceIds: ["vault"],
  capabilities: ["cap:upstream:vault:tools-call-store"]
};

describe("Grant-time tool narrowing and catalog search", () => {
  it("narrows an admitted audience to the grant's allowedTools, exact or prefix", () => {
    const narrowed = evaluateAudienceDecision({
      grant: { ...BASE_GRANT, allowedTools: ["upstream.vault.kv_*"] },
      tool: null,
      operation: TOOL_OPERATION,
      service: { serviceId: "vault" },
      purpose: "discovery"
    });
    expect(narrowed.allowed).toBe(true);
    const denied = evaluateAudienceDecision({
      grant: { ...BASE_GRANT, allowedTools: ["upstream.vault.other_*"] },
      operation: TOOL_OPERATION,
      service: { serviceId: "vault" },
      purpose: "discovery"
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reasonCode).toBe("audience_tool_not_granted");
    // Discovery and execution share the decision — the narrowing cannot
    // expose a tool that execution would refuse.
    const execution = evaluateAudienceDecision({
      grant: { ...BASE_GRANT, allowedTools: ["upstream.vault.other_*"] },
      operation: TOOL_OPERATION,
      service: { serviceId: "vault" },
      purpose: "execution"
    });
    expect(execution.allowed).toBe(false);
    expect(execution.reasonCode).toBe("audience_tool_not_granted");
  });

  it("treats interior wildcards literally and honors metadata placement", () => {
    const literal = evaluateAudienceDecision({
      grant: { ...BASE_GRANT, allowedTools: ["upstream.*.kv_store"] },
      operation: TOOL_OPERATION,
      service: { serviceId: "vault" }
    });
    expect(literal.allowed).toBe(false);
    const viaMetadata = evaluateAudienceDecision({
      grant: { ...BASE_GRANT, metadata: { allowedTools: ["upstream.vault.kv_store"] } },
      operation: TOOL_OPERATION,
      service: { serviceId: "vault" }
    });
    expect(viaMetadata.allowed).toBe(true);
  });

  it("filters listed tools by a bounded case-insensitive query", async () => {
    const registry = mcpRegistry([
      { name: "store", inputSchema: { type: "object" }, description: "Persist key-value pairs" },
      { name: "fetch", inputSchema: { type: "object" }, title: "Remote fetcher" }
    ]);
    installUpstreamRuntimeServices(registry, [service()]);
    try {
      const all = await registry.listMcpTools({ serviceId: "vault" });
      expect(all.count).toBe(2);
      const byName = await registry.listMcpTools({ serviceId: "vault", query: "KV_" });
      expect(byName.items.map((tool: any) => tool.name)).toEqual([]);
      const byTitle = await registry.listMcpTools({ serviceId: "vault", query: "fetcher" });
      expect(byTitle.items.map((tool: any) => tool.name)).toEqual(["upstream.vault.fetch"]);
      const byDescription = await registry.listMcpTools({ serviceId: "vault", query: "key-value" });
      expect(byDescription.items.map((tool: any) => tool.name)).toEqual(["upstream.vault.store"]);
      const huge = await registry.listMcpTools({ serviceId: "vault", query: "x".repeat(500) });
      expect(huge.count).toBe(0);
    } finally {
      await registry.close();
    }
  });
});
