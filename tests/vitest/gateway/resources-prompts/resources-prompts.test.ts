import { describe, expect, it } from "vitest";
import { context, descriptor, response, route, createTestGateway as createGateway } from "../support";

describe("resource and prompt proxy ports", () => {
  it("re-authenticates resource and prompt operations through published routes", async () => {
    const resourceCalls: string[] = [];
    const promptCalls: string[] = [];
    const gateway = createGateway({
      descriptors: [
        descriptor({ kind: "resource", publicName: "document", publicUri: "meshrix://public/document", upstreamUri: "file://upstream/document", route: route({ logicalRoute: "resource.read", operation: "resources/read" }) }),
        descriptor({ kind: "prompt", publicName: "summarize", upstreamName: "summarize", route: route({ logicalRoute: "prompt.get", operation: "prompts/get" }) })
      ],
      resources: { read: async (input) => { resourceCalls.push(input.uri); return { contents: [{ uri: input.uri, text: "document" }] }; } },
      prompts: { get: async (input) => { promptCalls.push(input.name); return { description: input.name }; }, complete: async () => ({ values: ["a"] }) }
    });
    await gateway.start();
    try {
      expect(await gateway.readResource(context, "meshrix://public/document")).toMatchObject({ kind: "complete", value: { contents: [{ text: "document" }] } });
      expect(await gateway.getPrompt(context, "summarize", { traceId: "business" })).toMatchObject({ kind: "complete", value: { description: "summarize" } });
      expect(await gateway.completePrompt({ ...context, grant: { ...context.grant, methods: ["completion/complete"] } }, { name: "summarize", argument: "x" })).toMatchObject({ kind: "complete", value: { values: ["a"] } });
      expect(resourceCalls).toEqual(["file://upstream/document"]);
      expect(promptCalls).toEqual(["summarize"]);
    } finally {
      await gateway.close();
    }
  });

  it("does not call an injected resource port when policy denies the protected route", async () => {
    let reads = 0;
    const gateway = createGateway({
      descriptors: [descriptor({ kind: "resource", publicUri: "meshrix://public/secret", route: route({ logicalRoute: "resource.secret", operation: "resources/read" }) })],
      policy: { decide: () => ({ allowed: false, reasonCode: "always_deny", message: "denied" }) },
      resources: { read: async () => { reads += 1; return "secret"; } }
    });
    await gateway.start();
    try {
      expect(await gateway.readResource(context, "meshrix://public/secret")).toMatchObject({ kind: "failure", code: "always_deny" });
      expect(reads).toBe(0);
    } finally {
      await gateway.close();
    }
  });

  it("does not call injected prompt ports when policy denies the protected route", async () => {
    let gets = 0;
    let completions = 0;
    const gateway = createGateway({
      descriptors: [descriptor({ kind: "prompt", publicName: "secret", upstreamName: "secret", route: route({ logicalRoute: "prompt.secret", operation: "prompts/get" }) })],
      policy: { decide: () => ({ allowed: false, reasonCode: "always_deny", message: "denied" }) },
      prompts: {
        get: async () => { gets += 1; return "secret"; },
        complete: async () => { completions += 1; return { values: ["secret"] }; }
      }
    });
    await gateway.start();
    try {
      expect(await gateway.getPrompt(context, "secret", {})).toMatchObject({ kind: "failure", code: "always_deny" });
      expect(await gateway.completePrompt(context, { name: "secret", argument: "value" })).toMatchObject({ kind: "failure", code: "always_deny" });
      expect({ gets, completions }).toEqual({ gets: 0, completions: 0 });
    } finally {
      await gateway.close();
    }
  });
});
