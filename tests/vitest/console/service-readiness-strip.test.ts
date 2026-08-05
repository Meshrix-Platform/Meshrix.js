import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { consoleMessages } from "../../../apps/console/i18n/console-messages";
import {
  buildServiceReadinessStages,
  SERVICE_READINESS_LABEL_KEYS,
  SERVICE_READINESS_STATE_LABEL_KEYS,
} from "../../../apps/console/views/admin/upstream-gateway/useServiceReadiness";

const SERVICE_ID = "inventory-api";

function serviceFixture(serviceId = SERVICE_ID) : any {
  return {
    serviceId,
    label: "Inventory",
    baseUrl: "https://inventory.example.invalid:8443",
    healthPath: "/health",
    disabled: false,
    operations: [{ operationKey: "inventory.get", method: "GET", path: "/inventory", risk: "read_only" }],
  };
}

function catalogFixture(tools: any[] = []) : any {
  return {
    schemaVersion: "v1",
    generatedAt: "2026-08-05T00:00:00.000Z",
    fingerprint: "fixture-fingerprint",
    scopes: [],
    toolsets: [],
    profiles: [],
    tools,
  };
}

function grantFixture(overrides: any = {}) : any {
  return {
    id: "grant-1",
    label: "Inventory readers",
    enabled: true,
    scopes: [],
    toolsets: [],
    toolAllow: [],
    tokenPrefix: "grt_fx",
    hasToken: true,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    lastUsedAt: "",
    ...overrides,
  };
}

function apiKeyFixture(serviceIds: string[] = [SERVICE_ID]) : any {
  return {
    keyId: "key-1",
    displayPrefix: "mx_fx",
    credentialFingerprint: "fp",
    workloadPrincipalId: "workload-1",
    workloadDisplayName: "Fixture workload",
    organizationNodeId: "org-1",
    policy: { serviceIds, capabilityIds: [], toolsetIds: [], allowedTools: [], deniedTools: [] },
    policyFingerprint: "fp",
    status: "active",
    lifecycleRevision: 1,
    useCount: 0,
    createdAt: "2026-08-05T00:00:00.000Z",
    rotatedAt: null,
    revokedAt: null,
    expiresAt: "2027-08-05T00:00:00.000Z",
  };
}

function auditFixture(eventType: string, serviceId = SERVICE_ID) : any {
  return { auditId: "audit-1", eventType, serviceId, status: "forwarded" };
}

function stagesFor(overrides: any = {}) : any {
  return buildServiceReadinessStages({
    service: serviceFixture(),
    services: [serviceFixture()],
    audit: [],
    catalog: null,
    grants: null,
    apiKeys: null,
    ...overrides,
  });
}

function stageById(stages: any[], id: string) : any {
  const found = stages.find((stage: any) : any => stage.id === id);
  expect(found, `expected stage ${id} to be present`).toBeDefined();
  return found;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value as any)) {
      deepFreeze((value as any)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe("service readiness strip", () : any => {
  it("derives all five stages done from a full journey fixture", () : any => {
    const stages: any = stagesFor({
      catalog: catalogFixture([
        { id: "inventory.get", serviceId: SERVICE_ID, toolsets: ["inventory-tools"] },
      ]),
      grants: [grantFixture({ toolsets: ["inventory-tools"] })],
      apiKeys: [apiKeyFixture()],
      audit: [auditFixture("upstream.forward.completed")],
    });

    expect(stages.map((stage: any) : any => stage.id)).toEqual([
      "published",
      "inToolCatalog",
      "grantExists",
      "keyIssued",
      "firstCallSeen",
    ]);
    for (const stage of stages) {
      expect(stage.state).toBe("done");
      expect(stage.link).toBeUndefined();
    }
  });

  it("derives pending stages with links to their owning surfaces when journey data is absent", () : any => {
    const stages: any = stagesFor({
      catalog: catalogFixture([]),
      grants: [],
      apiKeys: [],
      audit: [],
    });

    expect(stageById(stages, "published").state).toBe("done");
    expect(stageById(stages, "published").link).toBeUndefined();

    expect(stageById(stages, "inToolCatalog").state).toBe("pending");
    expect(stageById(stages, "inToolCatalog").link).toEqual({ path: "/admin/tool-list" });

    expect(stageById(stages, "grantExists").state).toBe("pending");
    expect(stageById(stages, "grantExists").link).toEqual({ path: "/admin/operation-permission" });

    expect(stageById(stages, "keyIssued").state).toBe("pending");
    expect(stageById(stages, "keyIssued").link).toEqual({ path: "/admin/api-key-distribution" });

    // First call seen is observed on this view's own audit panel — no off-view link.
    expect(stageById(stages, "firstCallSeen").state).toBe("pending");
    expect(stageById(stages, "firstCallSeen").link).toBeUndefined();
  });

  it("renders unknown for not-yet-loaded datasets and never fabricates done", () : any => {
    const stages: any = stagesFor({});

    expect(stageById(stages, "published").state).toBe("done");
    expect(stageById(stages, "inToolCatalog").state).toBe("unknown");
    expect(stageById(stages, "grantExists").state).toBe("unknown");
    expect(stageById(stages, "keyIssued").state).toBe("unknown");
    expect(stageById(stages, "firstCallSeen").state).toBe("pending");

    for (const stage of stages) {
      expect(["done", "pending", "unknown"]).toContain(stage.state);
    }
  });

  it("gives unknown stages links to their owning surfaces too", () : any => {
    const stages: any = stagesFor({});

    expect(stageById(stages, "inToolCatalog").link).toEqual({ path: "/admin/tool-list" });
    expect(stageById(stages, "grantExists").link).toEqual({ path: "/admin/operation-permission" });
    expect(stageById(stages, "keyIssued").link).toEqual({ path: "/admin/api-key-distribution" });
  });

  it("derives grant exists through toolAllow and honors disabled grants", () : any => {
    const catalog = catalogFixture([
      { id: "inventory.get", serviceId: SERVICE_ID, toolsets: ["inventory-tools"] },
    ]);

    const viaToolAllow: any = stagesFor({
      catalog,
      grants: [grantFixture({ toolAllow: ["inventory.get"] })],
    });
    expect(stageById(viaToolAllow, "grantExists").state).toBe("done");

    const disabledOnly: any = stagesFor({
      catalog,
      grants: [grantFixture({ enabled: false, toolAllow: ["inventory.get"] })],
    });
    expect(stageById(disabledOnly, "grantExists").state).toBe("pending");

    const unrelatedGrant: any = stagesFor({
      catalog,
      grants: [grantFixture({ toolsets: ["billing-tools"] })],
    });
    expect(stageById(unrelatedGrant, "grantExists").state).toBe("pending");
  });

  it("cannot resolve grant coverage while the tool catalog is not loaded", () : any => {
    const stages: any = stagesFor({
      catalog: null,
      grants: [grantFixture({ toolAllow: ["inventory.get"] })],
    });
    expect(stageById(stages, "inToolCatalog").state).toBe("unknown");
    expect(stageById(stages, "grantExists").state).toBe("unknown");
  });

  it("derives key issued from api-key policy serviceIds only", () : any => {
    const withKey: any = stagesFor({ apiKeys: [apiKeyFixture([SERVICE_ID])] });
    expect(stageById(withKey, "keyIssued").state).toBe("done");

    const otherServiceOnly: any = stagesFor({ apiKeys: [apiKeyFixture(["billing-api"])] });
    expect(stageById(otherServiceOnly, "keyIssued").state).toBe("pending");

    const withoutPolicy: any = stagesFor({ apiKeys: [{ keyId: "key-x" }] });
    expect(stageById(withoutPolicy, "keyIssued").state).toBe("pending");
  });

  it("derives first call seen from forward events only, for this service only", () : any => {
    const failedCall: any = stagesFor({ audit: [auditFixture("upstream.forward.failed")] });
    expect(stageById(failedCall, "firstCallSeen").state).toBe("done");

    const lifecycleEvent: any = stagesFor({ audit: [auditFixture("service.published")] });
    expect(stageById(lifecycleEvent, "firstCallSeen").state).toBe("pending");

    const otherServiceCall: any = stagesFor({ audit: [auditFixture("upstream.forward.completed", "billing-api")] });
    expect(stageById(otherServiceCall, "firstCallSeen").state).toBe("pending");
  });

  it("links a not-yet-published service to the publish surface with its serviceId", () : any => {
    const stages: any = stagesFor({ service: serviceFixture("draft-service"), services: [] });

    expect(stageById(stages, "published").state).toBe("pending");
    expect(stageById(stages, "published").link).toEqual({
      path: "/admin/publish-upstream-service",
      query: { serviceId: "draft-service" },
    });
  });

  it("returns no stages when no service is selected", () : any => {
    expect(buildServiceReadinessStages({
      service: null,
      services: [serviceFixture()],
      audit: [],
      catalog: catalogFixture([]),
      grants: [],
      apiKeys: [],
    })).toEqual([]);
  });

  it("is read-only: derivation never mutates its inputs", () : any => {
    const data: any = deepFreeze({
      service: serviceFixture(),
      services: [serviceFixture()],
      audit: [auditFixture("upstream.forward.completed")],
      catalog: catalogFixture([{ id: "inventory.get", serviceId: SERVICE_ID, toolsets: ["inventory-tools"] }]),
      grants: [grantFixture({ toolsets: ["inventory-tools"] })],
      apiKeys: [apiKeyFixture()],
    });
    const snapshot: any = JSON.parse(JSON.stringify(data));

    expect(() : any => buildServiceReadinessStages(data)).not.toThrow();
    expect(data).toEqual(snapshot);
    expect(Object.isFrozen(data)).toBe(true);
  });

  it("renders a read-only strip: no buttons or mutating handlers in the strip markup", () : any => {
    const viewSource: any = readFileSync(fileURLToPath(new URL(
      "../../../apps/console/views/admin/UpstreamGatewayView.vue",
      import.meta.url,
    )), "utf8");
    const stripStart: any = viewSource.indexOf('class="gateway-readiness"');
    expect(stripStart).toBeGreaterThan(-1);
    const stripRegion: any = viewSource.slice(stripStart, viewSource.indexOf("</template>", stripStart));

    expect(stripRegion).not.toMatch(/@click/u);
    expect(stripRegion).not.toMatch(/<button/u);
    expect(stripRegion).toContain("RouterLink");
    expect(stripRegion).toContain("gateway-readiness-segment");
  });

  it("keys all stage and state labels in the keyed dictionary with both locales", () : any => {
    const readinessKeys = [...Object.values(SERVICE_READINESS_LABEL_KEYS), ...Object.values(SERVICE_READINESS_STATE_LABEL_KEYS)];

    // The stage records carry dictionary KEYS (REQ-004), never literal copy.
    const stages: any = stagesFor({});
    for (const stage of stages) {
      expect(SERVICE_READINESS_LABEL_KEYS).toHaveProperty(stage.id);
      expect(stage.label).toBe(SERVICE_READINESS_LABEL_KEYS[stage.id]);
    }

    // Every key resolves to non-empty copy in BOTH locales.
    for (const locale of ["zh-CN", "en"] as const) {
      const group: any = consoleMessages[locale].readiness;
      expect(group.title.trim().length).toBeGreaterThan(0);
      for (const key of readinessKeys) {
        expect(group[key], `readiness.${key} missing in ${locale}`).toBeDefined();
        expect(String(group[key]).trim().length).toBeGreaterThan(0);
      }
    }
  });
});
