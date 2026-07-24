// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  createUpstreamService: vi.fn(),
  replaceUpstreamService: vi.fn(),
  disableUpstreamService: vi.fn(),
  republishUpstreamService: vi.fn(),
  removeUpstreamService: vi.fn(),
  listPublishedServices: vi.fn(),
  getPublishedService: vi.fn(),
  waitForUpstreamServicePublication: vi.fn(),
  checkUpstreamServiceRuntimeHealth: vi.fn()
}));

vi.mock("../../../apps/console/lib/upstream-service-publish-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../apps/console/lib/upstream-service-publish-client")>(),
  ...client
}));

import UpstreamServicePublishView from "../../../apps/console/views/admin/UpstreamServicePublishView.vue";
import {
  registerConsoleConfirmHost,
  settleConsoleConfirm,
  unregisterConsoleConfirmHost,
} from "../../../apps/console/composables/console-confirm-controller";

function publication(revision: number, digest = "a".repeat(64)) {
  return {
    publicationRef: `urn:meshrix:upstream-publication:${revision}`,
    status: "publishing" as const,
    candidateRevision: revision,
    candidateDigest: digest
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  client.listPublishedServices.mockResolvedValue({ ok: true, setRevision: 0, services: [] });
  client.createUpstreamService.mockResolvedValue({
    ok: true,
    serviceId: "svc_fixture",
    state: "publishing",
    serviceRevision: 1,
    setRevision: 1,
    manifestDigest: "a".repeat(64),
    receiptRef: "urn:meshrix:receipt:fixture",
    publication: publication(1),
    replayed: false
  });
  client.waitForUpstreamServicePublication.mockResolvedValue({
    ok: true,
    setRevision: 1,
    service: {
      serviceId: "svc_fixture",
      state: "server_published",
      serviceRevision: 1,
      manifestDigest: "a".repeat(64),
      publication: { ...publication(1), status: "server_published" }
    }
  });
  client.checkUpstreamServiceRuntimeHealth.mockResolvedValue({ ok: true, status: "healthy" });
});

describe("UpstreamServicePublishView configuration truthfulness", () => {
  it("starts empty and submits only explicitly entered configuration", async () => {
    const wrapper = mount(UpstreamServicePublishView);
    await flushPromises();

    const protocol = wrapper.find('select');
    expect((protocol.element as HTMLSelectElement).value).toBe("");
    expect((protocol.element as HTMLSelectElement).selectedIndex).toBe(0);
    expect(wrapper.text()).not.toContain("MCP");

    const inputs = wrapper.findAll('.publish-form input');
    await inputs[0].setValue("inventory");
    await protocol.setValue("http");
    await inputs[3].setValue("https://service.invalid");
    await wrapper.find(".form-actions .primary").trigger("click");
    await flushPromises();

    expect(client.createUpstreamService).toHaveBeenCalledWith("inventory", {
      serviceProtocol: "http",
      baseUrl: "https://service.invalid",
      operations: [],
      references: []
    }, 0);
    const descriptor = client.createUpstreamService.mock.calls[0][1];
    expect(descriptor).not.toHaveProperty("visibility");
    expect(descriptor).not.toHaveProperty("trafficPolicy");
    expect(client.waitForUpstreamServicePublication).toHaveBeenCalledWith("svc_fixture");
    expect(client.checkUpstreamServiceRuntimeHealth).toHaveBeenCalledWith("svc_fixture");
    expect(wrapper.text()).toContain('"status": "healthy"');
  });

  it("imports a strict portable document without publishing and preserves the draft on errors", async () => {
    const wrapper = mount(UpstreamServicePublishView);
    await flushPromises();
    const serviceKey = wrapper.find('.publish-form input');
    await serviceKey.setValue("existing-draft");
    const importer = wrapper.findComponent({ name: "PortableServiceImportPanel" });
    const textarea = importer.find("textarea");

    await textarea.setValue('{"kind":"wrong","schemaVersion":"v0.0.1:upstream-service:portable-import-2","serviceKey":"replacement","descriptor":{}}');
    await importer.find("button").trigger("click");
    await flushPromises();
    expect((serviceKey.element as HTMLInputElement).value).toBe("existing-draft");
    expect(importer.text()).toContain('kind must be "meshrix.upstream-service"');

    await textarea.setValue(JSON.stringify({
      kind: "meshrix.upstream-service",
      schemaVersion: "v0.0.1:upstream-service:portable-import-2",
      serviceKey: "replacement",
      descriptor: {
        serviceProtocol: "http",
        baseUrl: "https://service.invalid:443",
        tags: ["portable"],
        operations: [{
          operationKey: "list", method: "GET", path: "/items",
          payloadTransport: {
            request: { mode: "structured_json", maxBytes: 1024, mediaTypes: ["application/json"] },
            response: { mode: "structured_json", maxBytes: 2048, mediaTypes: ["application/json"] }
          }
        }]
      }
    }));
    await importer.find("button").trigger("click");
    await flushPromises();
    expect((serviceKey.element as HTMLInputElement).value).toBe("replacement");
    expect(client.createUpstreamService).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Draft loaded. Review it, then select Publish.");
  });

  it("loads a selected local file without importing or publishing it", async () => {
    const wrapper = mount(UpstreamServicePublishView);
    await flushPromises();
    const importer = wrapper.findComponent({ name: "PortableServiceImportPanel" });
    const fileText = JSON.stringify({
      kind: "meshrix.upstream-service",
      schemaVersion: "v0.0.1:upstream-service:portable-import-2",
      serviceKey: "inventory",
      descriptor: {
        serviceProtocol: "http",
        baseUrl: "https://service.invalid:443",
        operations: [{
          operationKey: "list", method: "GET", path: "/items",
          payloadTransport: {
            request: { mode: "structured_json", maxBytes: 1024, mediaTypes: ["application/json"] },
            response: { mode: "structured_json", maxBytes: 2048, mediaTypes: ["application/json"] }
          }
        }]
      }
    });
    const file = new File([fileText], "service.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue(fileText) });
    const fileInput = importer.find('input[type="file"]');
    Object.defineProperty(fileInput.element, "files", { configurable: true, value: [file] });
    await fileInput.trigger("change");
    await flushPromises();

    expect((importer.find("textarea").element as HTMLTextAreaElement).value).toBe(fileText);
    expect(importer.text()).toContain("Loaded file: service.json");
    expect(client.createUpstreamService).not.toHaveBeenCalled();
    expect(wrapper.find('.publish-form input').element).toHaveProperty("value", "");
  });

  it("loads an imported draft before the single explicit publish action", async () => {
    const wrapper = mount(UpstreamServicePublishView);
    await flushPromises();
    const importer = wrapper.findComponent({ name: "PortableServiceImportPanel" });
    await importer.find("textarea").setValue(JSON.stringify({
      kind: "meshrix.upstream-service",
      schemaVersion: "v0.0.1:upstream-service:portable-import-2",
      serviceKey: "inventory",
      descriptor: {
        serviceProtocol: "http",
        baseUrl: "https://service.invalid:443",
        healthPath: "/healthz",
        operations: [{
          operationKey: "list", method: "GET", path: "/items",
          payloadTransport: {
            request: { mode: "structured_json", maxBytes: 1024, mediaTypes: ["application/json"] },
            response: { mode: "structured_json", maxBytes: 2048, mediaTypes: ["application/json"] }
          }
        }]
      }
    }));
    await importer.find("button").trigger("click");
    await flushPromises();

    expect(client.createUpstreamService).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Review it, then select Publish");

    await wrapper.find(".form-actions .primary").trigger("click");
    await flushPromises();

    expect(client.createUpstreamService).toHaveBeenCalledWith("inventory", {
      serviceProtocol: "http",
      baseUrl: "https://service.invalid:443",
      healthPath: "/healthz",
      operations: [{
        operationKey: "list", method: "GET", path: "/items",
        payloadTransport: {
          request: { mode: "structured_json", maxBytes: 1024, mediaTypes: ["application/json"] },
          response: { mode: "structured_json", maxBytes: 2048, mediaTypes: ["application/json"] }
        }
      }],
      references: []
    }, 0);
    expect(client.waitForUpstreamServicePublication).toHaveBeenCalledWith("svc_fixture");
    expect(client.checkUpstreamServiceRuntimeHealth).toHaveBeenCalledWith("svc_fixture");
  });

  it("labels operation fields, reports invalid drafts, and applies protocol-specific representation rules", async () => {
    const wrapper = mount(UpstreamServicePublishView);
    await flushPromises();

    await wrapper.find(".publish-form select").setValue("http");
    const operationsTab = wrapper.findAll('[role="tab"]').find((tab) => tab.text() === "Service operations");
    expect(operationsTab).toBeDefined();
    await operationsTab!.trigger("click");

    const fields = wrapper.findAll(".operation-builder .form-field");
    expect(fields.map((field) => field.find("span").text())).toEqual([
      "Operation key *",
      "Method *",
      "Path *",
      "Risk",
      "Representation *",
      "Maximum bytes *",
      "Media types *",
      "Representation *",
      "Maximum bytes *",
      "Media types *",
    ]);
    expect((fields[3].find("select").element as HTMLSelectElement).value).toBe("");
    expect((fields[1].find("select").element as HTMLSelectElement).selectedIndex).toBe(0);
    expect((fields[3].find("select").element as HTMLSelectElement).selectedIndex).toBe(0);

    await wrapper.find(".operation-builder .table-action").trigger("click");
    expect(wrapper.text()).toContain("Complete all required operation fields.");

    await fields[0].find("input").setValue("download");
    await fields[1].find("select").setValue("GET");
    await fields[2].find("input").setValue("/download");
    await fields[4].find("select").setValue("opaque_stream");
    await fields[5].find("input").setValue("1024");
    await fields[6].find("input").setValue("application/octet-stream");
    await fields[7].find("select").setValue("structured_json");
    await fields[8].find("input").setValue("2048");
    await fields[9].find("input").setValue("application/json");
    await wrapper.find(".operation-builder .table-action").trigger("click");

    expect(wrapper.findAll(".op-list > li")).toHaveLength(1);
    expect(wrapper.text()).toContain("opaque_stream → structured_json");

    const basicTab = wrapper.findAll('[role="tab"]').find((tab) => tab.text() === "Basic");
    await basicTab!.trigger("click");
    await wrapper.find(".publish-form select").setValue("json-rpc");
    await operationsTab!.trigger("click");
    const jsonRpcFields = wrapper.findAll(".operation-builder .form-field");
    await jsonRpcFields[0].find("input").setValue("rpc-download");
    await jsonRpcFields[1].find("select").setValue("POST");
    await jsonRpcFields[2].find("input").setValue("/rpc");
    await jsonRpcFields[4].find("select").setValue("opaque_stream");
    await jsonRpcFields[5].find("input").setValue("1024");
    await jsonRpcFields[6].find("input").setValue("application/octet-stream");
    await jsonRpcFields[7].find("select").setValue("structured_json");
    await jsonRpcFields[8].find("input").setValue("2048");
    await jsonRpcFields[9].find("input").setValue("application/json");
    await wrapper.find(".operation-builder .table-action").trigger("click");

    expect(wrapper.text()).toContain("JSON-RPC operations require Structured JSON for both request and response.");
    expect(wrapper.findAll(".op-list > li")).toHaveLength(1);
  });

  it("keeps publication evidence while reporting a failed runtime health result", async () => {
    client.checkUpstreamServiceRuntimeHealth.mockResolvedValue({ ok: false, status: "unhealthy" });
    const wrapper = mount(UpstreamServicePublishView);
    await flushPromises();
    const inputs = wrapper.findAll('.publish-form input');
    await inputs[0].setValue("inventory");
    await wrapper.find('.publish-form select').setValue("http");
    await inputs[3].setValue("https://service.invalid:443");
    await wrapper.find(".form-actions .primary").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("server-published, but runtime health did not pass");
    expect(wrapper.find(".tone-danger").exists()).toBe(true);
    expect(wrapper.text()).toContain('"status": "unhealthy"');
  });

  it("loads and replaces the complete descriptor with both current revisions", async () => {
    const descriptor = {
      serviceProtocol: "json-rpc" as const,
      label: "Catalog",
      baseUrl: "https://service.invalid/rpc",
      visibility: "organization",
      dataClass: "internal",
      tags: ["catalog"],
      interfaceSchemas: { request: { type: "object" } },
      permissions: { requiredScopes: ["catalog:read"] },
      approvalPolicy: { required: true },
      trafficPolicy: { perMinute: 20 },
      audience: { organizations: ["org-a"], teams: ["team-a"], roles: ["operator"], directGrants: ["grant-a"] },
      tagPolicy: { requiredTags: ["catalog"] },
      circuitBreaker: { enabled: true },
      operations: [{
        operationKey: "list",
        method: "POST",
        path: "/rpc",
        payloadTransport: {
          request: { mode: "structured_json", maxBytes: 1024, mediaTypes: ["application/json"] },
          response: { mode: "structured_json", maxBytes: 2048, mediaTypes: ["application/json"] }
        }
      }]
    };
    const references = [{
      type: "credential" as const,
      reference: "credential://vault/catalog",
      revision: 1,
      use: "request-auth"
    }];
    client.listPublishedServices.mockResolvedValue({
      ok: true,
      setRevision: 6,
      services: [{
        serviceId: "svc_fixture",
        state: "publishing",
        serviceRevision: 3,
        manifestDigest: "a".repeat(64),
        publication: publication(6)
      }]
    });
    client.getPublishedService.mockResolvedValue({
      ok: true,
      setRevision: 6,
      service: {
        serviceId: "svc_fixture",
        state: "publishing",
        serviceRevision: 3,
        manifestDigest: "a".repeat(64),
        publication: publication(6),
        descriptor,
        references
      }
    });
    client.replaceUpstreamService.mockResolvedValue({
      ok: true, serviceId: "svc_fixture", state: "publishing", serviceRevision: 4, setRevision: 7,
      manifestDigest: "b".repeat(64), receiptRef: "urn:meshrix:receipt:replace",
      publication: publication(7, "b".repeat(64)), replayed: false
    });

    const wrapper = mount(UpstreamServicePublishView);
    await flushPromises();
    await wrapper.find(".service-row").trigger("click");
    await flushPromises();
    await wrapper.find(".form-actions .primary").trigger("click");
    await flushPromises();

    expect(client.replaceUpstreamService).toHaveBeenCalledWith(
      "svc_fixture",
      { ...descriptor, references },
      3,
      6
    );
  });

  it("binds disable, republish, and remove controls to the selected revisions", async () => {
    client.listPublishedServices.mockResolvedValue({
      ok: true,
      setRevision: 8,
      services: [{
        serviceId: "svc_fixture",
        state: "publishing",
        serviceRevision: 5,
        manifestDigest: "a".repeat(64),
        publication: publication(8)
      }]
    });
    client.getPublishedService.mockResolvedValue({
      ok: true,
      setRevision: 8,
      service: {
        serviceId: "svc_fixture",
        state: "publishing",
        serviceRevision: 5,
        manifestDigest: "a".repeat(64),
        publication: publication(8),
        descriptor: { serviceProtocol: "http", baseUrl: "https://service.invalid" },
        references: []
      }
    });
    client.disableUpstreamService.mockResolvedValue({ ok: true });
    client.republishUpstreamService.mockResolvedValue({ ok: true });
    client.removeUpstreamService.mockResolvedValue({ ok: true });
    registerConsoleConfirmHost();
    try {
      const wrapper = mount(UpstreamServicePublishView);
      await flushPromises();
      await wrapper.find(".service-row").trigger("click");
      await flushPromises();
      const actions = wrapper.findAll(".form-actions button");
      await actions[1].trigger("click");
      await flushPromises();
      await actions[2].trigger("click");
      await flushPromises();
      await actions[3].trigger("click");
      await flushPromises();
      settleConsoleConfirm(true);
      await flushPromises();
      expect(client.disableUpstreamService).toHaveBeenCalledWith("svc_fixture", 5, 8);
      expect(client.republishUpstreamService).toHaveBeenCalledWith("svc_fixture", 5, 8);
      expect(client.removeUpstreamService).toHaveBeenCalledWith("svc_fixture", 5, 8);
    } finally {
      unregisterConsoleConfirmHost();
    }
  });
});
