import { describe, expect, it } from "vitest";
import { createModernDownstreamAdapter } from "@meshrix/protocols/mcp/modern-downstream";
import { context, createTestGateway, descriptor, key, QueueUpstream, response, route } from "../support";

describe("tools, resources and prompts over the modern downstream network boundary", () => {
  for (const scenario of [
    { method: "resources/read", kind: "resource" as const, route: "read-resource", name: "meshrix://fixture/resource", params: { uri: "meshrix://fixture/resource" }, result: { contents: [{ uri: "meshrix://fixture/resource", text: "peer text" }] } },
    { method: "prompts/get", kind: "prompt" as const, route: "get-prompt", name: "fixture-prompt", params: { name: "fixture-prompt", arguments: { label: "demo" } }, result: { messages: [{ role: "user", content: { type: "text", text: "peer text" } }] } },
    { method: "tools/call", kind: "tool" as const, route: "call-tool", name: "fixture-tool", params: { name: "fixture-tool", arguments: { label: "demo" } }, result: { content: [{ type: "text", text: "peer text" }] } }
  ]) {
    it(`[GC-021] ${scenario.method} preserves method fields and continuation answers`, async () => {
      const upstream = new QueueUpstream([response({ resultType: "input_required", requestState: "", inputRequests: { confirm: { required: true } } }), response({ resultType: "complete", ...scenario.result })]);
      const descriptorValue = descriptor({ kind: scenario.kind, route: route({ logicalRoute: scenario.route, effectClass: "read", operation: scenario.method, upstreamUri: scenario.kind === "resource" ? scenario.name : undefined }), ...(scenario.kind === "resource" ? { publicUri: scenario.name, upstreamUri: scenario.name } : { publicName: scenario.name, upstreamName: scenario.name }) });
      const gateway = createTestGateway({ descriptors: [descriptorValue], upstream, continuationKey: key() });
      await gateway.start();
      try {
        const adapter = createModernDownstreamAdapter({ gateway, authenticate: () => context });
        const send = async (params: Record<string, unknown>) => (await adapter.handle({ method: "POST", headers: { "content-type": "application/json" }, body: { jsonrpc: "2.0", id: scenario.method, method: scenario.method, params } })).body as Record<string, any>;
        const first = await send(scenario.params);
        expect(first.result).toMatchObject({ resultType: "input_required", requestState: expect.any(String) });
        const second = await send({ ...scenario.params, requestState: first.result.requestState, inputResponses: { confirm: { accepted: true } } });
        expect(second.result).toMatchObject({ resultType: "complete", ...scenario.result });
        expect(second.result).not.toHaveProperty("value");
        expect(upstream.requests[1].request).toMatchObject({ requestState: "", params: { inputResponses: { confirm: { accepted: true } } } });
      } finally { await gateway.close(); }
    });
  }
});
