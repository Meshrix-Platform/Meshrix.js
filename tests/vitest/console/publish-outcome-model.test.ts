// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { createWebHashHistory, createRouter } from "vue-router";
import {
  createPublishOutcomeModel,
  interpretUpstreamHealth,
  PUBLISH_REMEDIATION_ROUTES,
  type InterpretedHealth,
} from "../../../apps/console/composables/console-publish-outcome-model";
import UpstreamServicePublishView from "../../../apps/console/views/admin/UpstreamServicePublishView.vue";
import { consoleMessages, currentConsoleLocale } from "../../../apps/console/i18n/console";

const client: any = vi.hoisted(() : any => ({
  createUpstreamService: vi.fn(),
  replaceUpstreamService: vi.fn(),
  disableUpstreamService: vi.fn(),
  republishUpstreamService: vi.fn(),
  removeUpstreamService: vi.fn(),
  listPublishedServices: vi.fn(),
  getPublishedService: vi.fn(),
  observeUpstreamServicePublication: vi.fn(),
  checkUpstreamServiceRuntimeHealth: vi.fn(),
}));
const pageRefreshHandler: any = vi.hoisted(() : any => vi.fn());

vi.mock("../../../apps/console/lib/upstream-service-publish-client", async (importOriginal?: any) : Promise<any> => ({
  ...await importOriginal<typeof import("../../../apps/console/lib/upstream-service-publish-client")>(),
  ...client,
}));
vi.mock("@meshrix/ui-console/page-refresh", async (importOriginal?: any) : Promise<any> => ({
  ...await importOriginal(),
  usePageRefreshHandler: pageRefreshHandler,
}));

function publication(revision: number, digest: any = "a".repeat(64)) : any {
  return {
    publicationRef: `urn:meshrix:upstream-publication:${revision}`,
    status: "server_published" as const,
    candidateRevision: revision,
    candidateDigest: digest,
  };
}

const VERIFIED_ROUTES: Set<string> = new Set(Object.values(PUBLISH_REMEDIATION_ROUTES));

async function mountView() : Promise<any> {
  const router: any = createRouter({
    history: createWebHashHistory(),
    routes: [{ path: "/", component: { render: () : any => null } }],
  });
  await router.push("/");
  await router.isReady();
  const wrapper: any = mount(UpstreamServicePublishView, {
    attachTo: document.body,
    global: { plugins: [router] },
  });
  await flushPromises();
  return { wrapper, router };
}

beforeEach(() : any => {
  vi.clearAllMocks();
  pageRefreshHandler.mockClear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  client.listPublishedServices.mockResolvedValue({ ok: true, setRevision: 0, services: [] });
  client.createUpstreamService.mockResolvedValue({
    ok: true,
    serviceId: "svc_fixture",
    state: "server_published",
    serviceRevision: 1,
    setRevision: 1,
    manifestDigest: "a".repeat(64),
    receiptRef: "urn:meshrix:receipt:fixture",
    publication: publication(1),
    replayed: false,
  });
  client.observeUpstreamServicePublication.mockResolvedValue({
    ok: true,
    setRevision: 1,
    service: {
      serviceId: "svc_fixture",
      state: "server_published",
      serviceRevision: 1,
      manifestDigest: "a".repeat(64),
      publication: publication(1),
    },
  });
  client.checkUpstreamServiceRuntimeHealth.mockResolvedValue({ ok: true, status: "healthy" });
});

afterEach(() : any => {
  window.history.replaceState(null, "", "/");
  document.body.innerHTML = "";
});

describe("createPublishOutcomeModel stage transitions", () : any => {
  it("advances pending → active → done across the three derivable stages", () : any => {
    const model: any = createPublishOutcomeModel({ serviceId: () : string => "svc_fixture" });
    const states = () : string[] => model.stages.value.map((stage: any) : string => stage.state);

    expect(states()).toEqual(["pending", "pending", "pending"]);
    expect(model.done.value).toBe(false);

    model.begin("publish-request");
    expect(states()).toEqual(["active", "pending", "pending"]);

    model.advance();
    expect(states()).toEqual(["done", "active", "pending"]);

    model.advance();
    expect(states()).toEqual(["done", "done", "active"]);

    model.complete("runtime-health");
    expect(states()).toEqual(["done", "done", "done"]);
    expect(model.done.value).toBe(true);
  });

  it("carries dictionary label keys on every stage record", () : any => {
    const model: any = createPublishOutcomeModel({ serviceId: () : string => "" });
    expect(model.stages.value.map((stage: any) : string => stage.label)).toEqual([
      "stagePublishRequest",
      "stageGatewayPublication",
      "stageRuntimeHealth",
    ]);
  });

  it("failed short-circuits later stages and a fresh begin resets the run", () : any => {
    const model: any = createPublishOutcomeModel({ serviceId: () : string => "svc_fixture" });
    model.begin("publish-request");
    model.advance();
    model.fail("gateway-publication");

    expect(model.stages.value.map((stage: any) : string => stage.state)).toEqual(["done", "failed", "pending"]);
    expect(model.done.value).toBe(false);

    // advance() after a failure has no active stage — a no-op.
    model.advance();
    expect(model.stages.value.map((stage: any) : string => stage.state)).toEqual(["done", "failed", "pending"]);

    // A new run begins from a clean slate, health included.
    model.complete("runtime-health", { ok: false });
    expect(model.health.value).not.toBe(null);
    model.begin("publish-request");
    expect(model.stages.value.map((stage: any) : string => stage.state)).toEqual(["active", "pending", "pending"]);
    expect(model.health.value).toBe(null);
  });

  it("ignores unknown stage ids", () : any => {
    const model: any = createPublishOutcomeModel({ serviceId: () : string => "" });
    model.begin("not-a-stage");
    expect(model.stages.value.map((stage: any) : string => stage.state)).toEqual(["pending", "pending", "pending"]);
  });
});

describe("createPublishOutcomeModel publication observation projection", () : any => {
  it("retains the accepted publication across observer interruption and stop", () : any => {
    const model: any = createPublishOutcomeModel({ serviceId: () : string => "svc_fixture" });
    model.begin("publish-request");
    model.advance();
    model.acceptPublication({ serviceId: "svc_fixture", serviceRevision: 4, setRevision: 6 });

    expect(model.acceptedPublication.value).toEqual({ serviceId: "svc_fixture", serviceRevision: 4, setRevision: 6 });
    expect(model.observation.value).toBe("observing");

    model.interruptObservation();
    expect(model.observation.value).toBe("interrupted");
    expect(model.acceptedPublication.value).toEqual({ serviceId: "svc_fixture", serviceRevision: 4, setRevision: 6 });
    // An interruption is not a stage failure: the publication stage stays active.
    expect(model.stages.value.map((stage: any) : string => stage.state)).toEqual(["done", "active", "pending"]);

    model.beginObservation();
    expect(model.observation.value).toBe("observing");

    model.stopObservation();
    expect(model.observation.value).toBe("stopped");
    expect(model.acceptedPublication.value).not.toBe(null);

    model.clearPublication();
    expect(model.observation.value).toBe("idle");
    expect(model.acceptedPublication.value).toBe(null);
  });

  it("clears a retained acceptance when a new run begins or the run resets", () : any => {
    const model: any = createPublishOutcomeModel({ serviceId: () : string => "svc_fixture" });
    model.begin("publish-request");
    model.advance();
    model.acceptPublication({ serviceId: "svc_fixture", serviceRevision: 1, setRevision: 1 });
    model.interruptObservation();

    model.begin("publish-request");
    expect(model.acceptedPublication.value).toBe(null);
    expect(model.observation.value).toBe("idle");

    model.acceptPublication({ serviceId: "svc_fixture", serviceRevision: 2, setRevision: 2 });
    model.resetRun();
    expect(model.acceptedPublication.value).toBe(null);
    expect(model.observation.value).toBe("idle");
    expect(model.stages.value.map((stage: any) : string => stage.state)).toEqual(["pending", "pending", "pending"]);
  });

  it("projects an authoritative publication failure separately from a runtime-health failure", () : any => {
    const failed: any = createPublishOutcomeModel({ serviceId: () : string => "svc_fixture" });
    failed.begin("publish-request");
    failed.advance();
    failed.fail("gateway-publication");
    expect(failed.stages.value.map((stage: any) : string => stage.state)).toEqual(["done", "failed", "pending"]);
    expect(failed.health.value).toBe(null);

    const unhealthy: any = createPublishOutcomeModel({ serviceId: () : string => "svc_fixture" });
    unhealthy.begin("publish-request");
    unhealthy.advance();
    unhealthy.advance();
    unhealthy.complete("runtime-health", { ok: false, endpoints: [{ endpoint: "x", ok: false, status: 0 }] });
    // The publication stage is done; only the interpreted health carries the failure.
    expect(unhealthy.stages.value.map((stage: any) : string => stage.state)).toEqual(["done", "done", "done"]);
    expect(unhealthy.health.value.ok).toBe(false);
    expect(unhealthy.health.value.checks[0].status).toBe("fail");
  });
});

describe("interpretUpstreamHealth payload mapping", () : any => {
  it("maps each real endpoint record onto a per-check pass/fail record", () : any => {
    const payload: any = {
      ok: false,
      serviceId: "svc_fixture",
      status: 503,
      endpointCount: 2,
      healthyEndpointCount: 1,
      endpoints: [
        { endpoint: { endpointId: "primary", weight: 1 }, ok: true, status: 200 },
        { endpoint: { endpointId: "secondary", weight: 1 }, ok: false, status: 404 },
      ],
      latencyMs: 12,
      checkedAt: "2026-08-05T00:00:00.000Z",
    };
    const interpreted: InterpretedHealth = interpretUpstreamHealth(payload, "svc_fixture");

    expect(interpreted.ok).toBe(false);
    expect(interpreted.checks).toHaveLength(2);
    expect(interpreted.checks[0]).toMatchObject({
      id: "primary",
      label: "checkEndpoint",
      status: "pass",
      statusCode: 200,
    });
    expect(interpreted.checks[1]).toMatchObject({
      id: "secondary",
      label: "checkEndpoint",
      status: "fail",
      statusCode: 404,
    });
    // The failed endpoint carries a gateway-detail remediation with the service.
    expect(interpreted.checks[1].remediation).toEqual({
      route: PUBLISH_REMEDIATION_ROUTES.gatewayDetail,
      query: { serviceId: "svc_fixture" },
    });
    // Raw payload retained for the disclosure.
    expect(interpreted.raw).toBe(payload);
  });

  it("maps the MCP payload onto an mcp-tools check", () : any => {
    const healthy: InterpretedHealth = interpretUpstreamHealth(
      { ok: true, serviceId: "svc_mcp", status: 200, protocol: "mcp", toolCount: 7, latencyMs: 5, checkedAt: "2026-08-05T00:00:00.000Z" },
      "svc_mcp",
    );
    expect(healthy.checks).toEqual([
      expect.objectContaining({ id: "mcp-tools", label: "checkMcpTools", status: "pass" }),
    ]);
    expect(healthy.checks[0].remediation).toBeUndefined();

    const failing: InterpretedHealth = interpretUpstreamHealth(
      { ok: false, serviceId: "svc_mcp", status: 0, protocol: "mcp", latencyMs: 5, checkedAt: "2026-08-05T00:00:00.000Z" },
      "svc_mcp",
    );
    expect(failing.checks[0]).toMatchObject({ id: "mcp-tools", status: "fail" });
    expect(failing.checks[0].remediation).toEqual({ route: PUBLISH_REMEDIATION_ROUTES.logs });
  });

  it("degrades unknown or absent checks to a warn record with generic copy", () : any => {
    const degraded: InterpretedHealth = interpretUpstreamHealth(
      { ok: false, serviceId: "svc_fixture", status: 0, error: "health_failed" },
      "svc_fixture",
    );
    expect(degraded.checks).toEqual([
      expect.objectContaining({ id: "summary", label: "checkSummary", status: "warn" }),
    ]);
    expect(degraded.checks[0].remediation).toEqual({ route: PUBLISH_REMEDIATION_ROUTES.logs });

    const notObject: InterpretedHealth = interpretUpstreamHealth("not-a-payload", "svc_fixture");
    expect(notObject.ok).toBe(false);
    expect(notObject.checks[0]).toMatchObject({ id: "summary", status: "warn" });

    const healthyWithoutChecks: InterpretedHealth = interpretUpstreamHealth({ ok: true }, "svc_fixture");
    expect(healthyWithoutChecks.ok).toBe(true);
    expect(healthyWithoutChecks.checks[0]).toMatchObject({ id: "summary", status: "pass" });
    expect(healthyWithoutChecks.checks[0].remediation).toBeUndefined();
  });

  it("carries verified routes only and falls back to the publish page without a service id", () : any => {
    const payload: any = {
      ok: false,
      endpoints: [{ endpoint: "https://a.invalid:443", ok: false, status: 503 }],
    };
    const withId: InterpretedHealth = interpretUpstreamHealth(payload, "svc_fixture");
    const withoutId: InterpretedHealth = interpretUpstreamHealth(payload, "");

    for (const check of [...withId.checks, ...withoutId.checks]) {
      if (check.remediation) {
        expect(VERIFIED_ROUTES.has(check.remediation.route)).toBe(true);
      }
    }
    expect(withId.checks[0].remediation).toEqual({
      route: PUBLISH_REMEDIATION_ROUTES.gatewayDetail,
      query: { serviceId: "svc_fixture" },
    });
    expect(withoutId.checks[0].remediation).toEqual({ route: PUBLISH_REMEDIATION_ROUTES.publish });
  });

  it("resolves every emitted label and stage key in both locales", () : any => {
    const interpreted: InterpretedHealth = interpretUpstreamHealth(
      { ok: false, protocol: "mcp", endpoints: [{ endpoint: "x", ok: false, status: 0 }] },
      "svc_fixture",
    );
    for (const locale of ["zh-CN", "en"] as const) {
      const group: any = consoleMessages[locale].publishOutcome;
      for (const stage of [
        "stagePublishRequest",
        "stageGatewayPublication",
        "stageRuntimeHealth",
        "observationWaiting",
        "observationInterrupted",
        "observationStopped",
        "observationStop",
        "observationResume",
        "observationPublished",
        "publicationSuperseded",
        "healthPassed",
        "healthNotPassed",
      ]) {
        expect(group[stage]).toBeTruthy();
      }
      for (const check of interpreted.checks) {
        expect(group[check.label]).toBeTruthy();
      }
      expect(group.statusPass).toBeTruthy();
      expect(group.statusWarn).toBeTruthy();
      expect(group.statusFail).toBeTruthy();
      expect(group.rawJsonSummary).toBeTruthy();
      expect(group.remediateGatewayDetail).toBeTruthy();
      expect(group.remediateLogs).toBeTruthy();
      expect(group.remediatePublish).toBeTruthy();
    }
  });

  it("sets the interpreted health from the runtime-health stage payload", () : any => {
    const model: any = createPublishOutcomeModel({ serviceId: () : string => "svc_fixture" });
    const payload: any = { ok: false, endpoints: [{ endpoint: "https://a.invalid:443", ok: false, status: 503 }] };
    model.begin("publish-request");
    model.advance();
    model.advance();
    model.complete("runtime-health", payload);
    expect(model.health.value.ok).toBe(false);
    expect(model.health.value.checks[0].status).toBe("fail");
    expect(model.health.value.raw).toEqual(payload);
  });
});

describe("view-level outcome rendering", () : any => {
  it("renders staged progress and a failed health check with remediation links and collapsed raw JSON", async () : Promise<any> => {
    client.checkUpstreamServiceRuntimeHealth.mockResolvedValue({
      ok: false,
      serviceId: "svc_fixture",
      status: 503,
      endpointCount: 1,
      healthyEndpointCount: 0,
      endpoints: [{ endpoint: { endpointId: "primary", weight: 1 }, ok: false, status: 404 }],
      latencyMs: 15,
      checkedAt: "2026-08-05T00:00:00.000Z",
    });
    const { wrapper } = await mountView();
    const outcomeMessages: any = consoleMessages[currentConsoleLocale.value].publishOutcome;

    await wrapper.find("#upstream-service-key").setValue("inventory");
    await wrapper.find("#upstream-service-protocol").setValue("http");
    await wrapper.find(".form-actions .primary").trigger("click");
    await flushPromises();
    await flushPromises();

    // All three derivable stages completed.
    const stages: any[] = wrapper.findAll(".publish-stage");
    expect(stages).toHaveLength(3);
    expect(stages.map((stage: any) : string[] => stage.classes())).toEqual([
      ["publish-stage", "publish-stage--done"],
      ["publish-stage", "publish-stage--done"],
      ["publish-stage", "publish-stage--done"],
    ]);

    // Per-check status with the failed endpoint carrying remediation.
    const failCheck: any = wrapper.find(".health-check--fail");
    expect(failCheck.exists()).toBe(true);
    expect(failCheck.text()).toContain(outcomeMessages.checkEndpoint);
    expect(failCheck.text()).toContain(outcomeMessages.statusFail);
    expect(failCheck.text()).toContain("primary");
    expect(failCheck.text()).toContain("HTTP 404");
    expect(failCheck.text()).not.toContain("[object Object]");
    const link: any = failCheck.find("a.health-check-remediation");
    expect(link.exists()).toBe(true);
    expect(link.text()).toBe(outcomeMessages.remediateGatewayDetail);
    expect(link.attributes("href")).toContain("/admin/upstream-services");
    expect(link.attributes("href")).toContain("serviceId=svc_fixture");

    // Raw JSON stays behind a collapsed disclosure.
    const details: any = wrapper.find("details.health-raw-json");
    expect(details.exists()).toBe(true);
    expect(details.attributes("open")).toBeUndefined();
    expect(details.find("summary").text()).toBe(outcomeMessages.rawJsonSummary);
    expect(details.find("pre").text()).toContain('"healthyEndpointCount": 0');
    expect(details.find("pre").text()).toContain('"status": 503');
    wrapper.unmount();
  });

  it("renders a failed publish request as a failed stage without fabricating progress", async () : Promise<any> => {
    client.createUpstreamService.mockRejectedValue(new Error("gateway rejected the request"));
    const { wrapper } = await mountView();

    await wrapper.find("#upstream-service-key").setValue("inventory");
    await wrapper.find("#upstream-service-protocol").setValue("http");
    await wrapper.find(".form-actions .primary").trigger("click");
    await flushPromises();

    expect(wrapper.find(".upstream-publish-layout > .console-inline-alert").text()).toContain(
      "gateway rejected the request",
    );
    const stages: any[] = wrapper.findAll(".publish-stage");
    expect(stages.map((stage: any) : string[] => stage.classes())).toEqual([
      ["publish-stage", "publish-stage--failed"],
      ["publish-stage", "publish-stage--pending"],
      ["publish-stage", "publish-stage--pending"],
    ]);
    expect(wrapper.find(".health-result").exists()).toBe(false);
    wrapper.unmount();
  });
});
