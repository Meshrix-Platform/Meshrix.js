import { describe, expect, it } from "vitest";
import {
  draftToConfigDocument,
  parseApiKeyDraftConfig,
} from "../../../apps/console/lib/api-key-draft-config";

const context = {
  knownNodeIds: new Set(["organization:group", "group:team"]),
  knownToolsetIds: new Set(["toolset-a", "toolset-b"]),
  knownTargetIds: new Set(["codex", "openclaw"]),
  knownClientGuideIds: new Set(["generic", "codex", "openclaw"]),
  knownClassificationIds: new Set(["public", "internal"]),
  knownProfileIds: new Set(["profile-a"]),
  knownMcpToolIdentities: new Set(["service-a\0upstream.service-a.read"]),
};

describe("api-key draft config", () => {
  it("parses draft fields while filtering unknown capability ids", () => {
    const next = parseApiKeyDraftConfig({
      workloadDisplayName: "Worker",
      organizationNodeId: "organization:group",
      expiresAt: "2026-09-01T08:00:00.000Z",
      selectedClientGuide: "generic",
      maximumRisk: "medium",
      selectedToolsetIds: ["toolset-a", "missing"],
      selectedMcpTools: [{ serviceId: "service-a", publicName: "upstream.service-a.read" }],
      selectedTargetIds: ["codex"],
      resourcesUnrestricted: false,
      selectedDataClassifications: ["public", "secret"],
      workspaceIds: ["ws-1", "ws-2"],
      requestsPerMinute: null,
      maxConcurrentEffects: 4,
    }, context);

    expect(next.workloadDisplayName).toBe("Worker");
    expect(next.organizationNodeId).toBe("organization:group");
    expect(next.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(next.selectedClientGuide).toBe("generic");
    expect(next.maximumRisk).toBe("medium");
    expect(next.selectedToolsetIds).toEqual(["toolset-a"]);
    expect(next.selectedMcpTools).toEqual([{ serviceId: "service-a", publicName: "upstream.service-a.read" }]);
    expect(next.selectedTargetIds).toEqual(["codex"]);
    expect(next.resourcesUnrestricted).toBe(false);
    expect(next.selectedDataClassifications).toEqual(["public"]);
    expect(next.workspaceIds).toBe("ws-1\nws-2");
    expect(next.requestsPerMinute).toBeNull();
    expect(next.maxConcurrentEffects).toBe(4);
  });

  it("preserves explicit create-request audience restrictions and empty restrictions", () => {
    const next = parseApiKeyDraftConfig({
      workloadDisplayName: "From policy",
      organizationNodeId: "group:team",
      expiresAt: "2026-12-01T12:00",
      policy: {
        toolsetIds: ["toolset-b"],
        maximumRisk: "high",
        audience: { targetIds: ["openclaw"] },
        resources: { mode: "unrestricted" },
        limits: { requestsPerWindow: 120, windowSeconds: 60, maxConcurrentEffects: 2 },
      },
    }, context);

    expect(next.selectedToolsetIds).toEqual(["toolset-b"]);
    expect(next.maximumRisk).toBe("high");
    expect(next.selectedTargetIds).toEqual(["openclaw"]);
    expect(next.resourcesUnrestricted).toBe(true);
    expect(next.requestsPerMinute).toBe(120);
    expect(next.maxConcurrentEffects).toBe(2);

    const unrestricted = parseApiKeyDraftConfig({
      workloadDisplayName: "Generic client",
      selectedClientGuide: "codex",
      selectedTargetIds: [],
      policy: { audience: { targetIds: [] } },
    }, context);
    expect(unrestricted).toMatchObject({ selectedClientGuide: "codex", selectedTargetIds: [] });
  });

  it("rejects an unknown imported audience target instead of silently broadening the key", () => {
    expect(() => parseApiKeyDraftConfig({
      workloadDisplayName: "Imported restricted key",
      policy: { audience: { targetIds: ["retired-target"] } },
    }, context)).toThrow(/unknown audience restriction/u);
  });

  it("rejects imported MCP tools that are not in the current authorized discovery snapshot", () => {
    expect(() => parseApiKeyDraftConfig({
      selectedMcpTools: [{ serviceId: "service-a", publicName: "upstream.service-a.retired" }],
    }, context)).toThrow(/unavailable MCP tool selection/u);
    expect(() => parseApiKeyDraftConfig({
      selectedMcpTools: [{ serviceId: "service-a", publicName: "upstream.service-a.read", capabilityId: "arbitrary" }],
    }, context)).toThrow(/unsupported fields/u);
  });

  it("round-trips the current draft document shape", () => {
    const document = draftToConfigDocument({
      workloadDisplayName: "Round trip",
      organizationNodeId: "organization:group",
      expiresAt: "2026-09-01T08:00",
      selectedClientGuide: "generic",
      maximumRisk: "low",
      selectedProfileId: "",
      selectedToolsetIds: ["toolset-a"],
      selectedMcpTools: [{ serviceId: "service-a", publicName: "upstream.service-a.read" }],
      selectedTargetIds: [],
      resourcesUnrestricted: true,
      selectedDataClassifications: [],
      workspaceIds: "",
      requestsPerMinute: null,
      maxConcurrentEffects: null,
    });
    expect(parseApiKeyDraftConfig(document, context)).toMatchObject({
      workloadDisplayName: "Round trip",
      selectedClientGuide: "generic",
      selectedToolsetIds: ["toolset-a"],
      selectedMcpTools: [{ serviceId: "service-a", publicName: "upstream.service-a.read" }],
      selectedTargetIds: [],
      resourcesUnrestricted: true,
    });
  });
});
