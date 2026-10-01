// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge: any = vi.hoisted(() : any => ({ getJson: vi.fn(), sendJson: vi.fn() }));

vi.mock("@meshrix/ui-console/bridge-http", () : any => bridge);

import {
  createUpstreamService,
  removeUpstreamService,
  replaceUpstreamService,
  checkUpstreamServiceRuntimeHealth,
  observeUpstreamServicePublication,
  UpstreamPublicationObservationError,
  UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION
} from "../../../apps/console/lib/upstream-service-publish-client";
import type {
  UpstreamServiceCreateCommand,
  UpstreamServiceRemoveCommand,
  UpstreamServiceReplaceCommand,
} from "@meshrix/contracts/upstream-service-publishing";

beforeEach(() : any => {
  vi.clearAllMocks();
  bridge.sendJson.mockResolvedValue({ ok: true });
});

describe("upstream service publishing client contract", () : any => {
  it("sends an explicit create command without synthesizing omitted configuration", async () : Promise<any> => {
    await createUpstreamService("inventory", {
      serviceProtocol: "http",
      references: [],
      operations: []
    }, 4);

    expect(bridge.sendJson).toHaveBeenCalledWith(
      "/api/gateway/v1/services",
      "POST",
      expect.objectContaining({
        schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
        action: "create",
        serviceKey: "inventory",
        expectedServiceRevision: 0,
        expectedSetRevision: 4,
        descriptor: { serviceProtocol: "http", references: [], operations: [] }
      })
    );
    const payload = bridge.sendJson.mock.calls[0][2] as UpstreamServiceCreateCommand;
    expect(payload.action).toBe("create");
    expect(payload.serviceKey).toBe("inventory");
    expect(payload).not.toHaveProperty("ownerSubjectId");
    expect(payload.descriptor).not.toHaveProperty("visibility");
    expect(payload.descriptor).not.toHaveProperty("trafficPolicy");
  });

  it("passes a remote MCP HTTP descriptor through the existing authenticated create command", async () : Promise<any> => {
    const descriptor = {
      serviceProtocol: "mcp" as const,
      mcp: {
        transport: "http" as const,
        url: "https://service.example:443/mcp",
        protocolVersion: "2026-07-28" as const,
      },
      references: [],
    };
    await createUpstreamService("inventory-mcp", descriptor, 9);

    expect(bridge.sendJson).toHaveBeenCalledWith(
      "/api/gateway/v1/services",
      "POST",
      expect.objectContaining({
        action: "create",
        serviceKey: "inventory-mcp",
        expectedSetRevision: 9,
        descriptor,
      })
    );
  });

  it("binds replacement and removal to the server service id and both expected revisions", async () : Promise<any> => {
    await replaceUpstreamService("svc_fixture", { serviceProtocol: "json-rpc" }, 2, 7);
    expect(bridge.sendJson.mock.calls[0].slice(0, 2)).toEqual([
      "/api/gateway/v1/services/svc_fixture",
      "PUT"
    ]);
    const replacePayload = bridge.sendJson.mock.calls[0][2] as UpstreamServiceReplaceCommand;
    expect(replacePayload).toMatchObject({
      action: "replace",
      serviceId: "svc_fixture",
      expectedServiceRevision: 2,
      expectedSetRevision: 7
    });

    await removeUpstreamService("svc_fixture", 3, 8);
    const removePayload = bridge.sendJson.mock.calls[1][2] as UpstreamServiceRemoveCommand;
    expect(removePayload).toMatchObject({
      action: "remove",
      serviceId: "svc_fixture"
    });
    expect(bridge.sendJson.mock.calls[1]).toEqual([
      "/api/gateway/v1/services/svc_fixture",
      "DELETE",
      expect.objectContaining({
        action: "remove",
        serviceId: "svc_fixture",
        expectedServiceRevision: 3,
        expectedSetRevision: 8
      }),
      { safetyConfirm: true }
    ]);
  });

  it("observes an accepted publication past the former fixed-attempt bound until the server publishes it", async () : Promise<any> => {
    const publishingDetail: any = {
      ok: true,
      setRevision: 6,
      service: {
        serviceId: "svc/slow",
        state: "publishing",
        serviceRevision: 4,
        manifestDigest: "a".repeat(64),
        publication: {
          publicationRef: "urn:meshrix:upstream-publication:4",
          status: "publishing",
          candidateRevision: 6,
          candidateDigest: "a".repeat(64),
        },
      },
    };
    const publishedDetail: any = {
      ...publishingDetail,
      service: {
        ...publishingDetail.service,
        state: "server_published",
        publication: { ...publishingDetail.service.publication, status: "server_published" },
      },
    };
    let calls: number = 0;
    bridge.getJson.mockImplementation(async () : Promise<any> => {
      calls += 1;
      return calls <= 25 ? publishingDetail : publishedDetail;
    });
    const delay: any = vi.fn().mockResolvedValue(undefined);
    const controller: AbortController = new AbortController();

    await expect(observeUpstreamServicePublication(
      { serviceId: "svc/slow", serviceRevision: 4 },
      { signal: controller.signal, delay },
    )).resolves.toBe(publishedDetail);

    // 25 publishing attempts exceed the retired 20-attempt bound; the observer
    // keeps waiting and settles only on the authoritative server fact.
    expect(calls).toBe(26);
    expect(delay).toHaveBeenCalledTimes(25);
    expect(bridge.getJson).toHaveBeenNthCalledWith(1, "/api/gateway/v1/services/svc%2Fslow", {
      signal: controller.signal,
    });
  });

  it("disposes the owned interval timer and issues no further query when observation is stopped", async () : Promise<any> => {
    vi.useFakeTimers();
    try {
      bridge.getJson.mockResolvedValue({
        ok: true,
        setRevision: 1,
        service: { serviceId: "svc/slow", state: "publishing", serviceRevision: 1, publication: { status: "publishing" } },
      });
      const controller: AbortController = new AbortController();
      const settled: Promise<any> = observeUpstreamServicePublication(
        { serviceId: "svc/slow", serviceRevision: 1 },
        { signal: controller.signal, intervalMs: 500 },
      ).catch((error: unknown) : any => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(bridge.getJson).toHaveBeenCalledTimes(1);

      controller.abort();
      const failure: any = await settled;
      expect(failure?.name).toBe("AbortError");

      await vi.advanceTimersByTimeAsync(5_000);
      expect(bridge.getJson).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an interrupted observation when a status query fails, without asserting a server failure", async () : Promise<any> => {
    const networkFailure: Error = new Error("network unavailable");
    bridge.getJson.mockRejectedValue(networkFailure);
    const delay: any = vi.fn().mockResolvedValue(undefined);

    const failure: any = await observeUpstreamServicePublication(
      { serviceId: "svc/slow", serviceRevision: 4 },
      { delay },
    ).catch((error: unknown) : any => error);

    expect(failure).toBeInstanceOf(UpstreamPublicationObservationError);
    expect(failure.reason).toBe("interrupted");
    expect(failure.cause).toBe(networkFailure);
    expect(failure.observedRevision).toBe(4);
    expect(delay).not.toHaveBeenCalled();
  });

  it("distinguishes an authoritative superseded revision from an observation interruption", async () : Promise<any> => {
    bridge.getJson.mockResolvedValue({
      ok: true,
      setRevision: 9,
      service: { serviceId: "svc/slow", state: "publishing", serviceRevision: 5, publication: { status: "publishing" } },
    });
    const delay: any = vi.fn().mockResolvedValue(undefined);

    const superseded: any = await observeUpstreamServicePublication(
      { serviceId: "svc/slow", serviceRevision: 4 },
      { delay },
    ).catch((error: unknown) : any => error);
    expect(superseded).toBeInstanceOf(UpstreamPublicationObservationError);
    expect(superseded.reason).toBe("superseded");
    expect(superseded.observedRevision).toBe(4);
    expect(superseded.currentRevision).toBe(5);
    expect(delay).not.toHaveBeenCalled();

    bridge.getJson.mockResolvedValue({
      ok: true,
      setRevision: 9,
      service: { serviceId: "svc/slow", state: "removed", serviceRevision: 4, publication: { status: "publishing" } },
    });
    const removed: any = await observeUpstreamServicePublication(
      { serviceId: "svc/slow", serviceRevision: 4 },
      { delay },
    ).catch((error: unknown) : any => error);
    expect(removed).toBeInstanceOf(UpstreamPublicationObservationError);
    expect(removed.reason).toBe("superseded");
  });

  it("resolves the retained revision without polling when it is already server-published", async () : Promise<any> => {
    const published: any = {
      ok: true,
      setRevision: 6,
      service: {
        serviceId: "svc/done",
        state: "server_published",
        serviceRevision: 4,
        publication: { status: "server_published" },
      },
    };
    bridge.getJson.mockResolvedValue(published);
    const delay: any = vi.fn().mockResolvedValue(undefined);

    await expect(observeUpstreamServicePublication(
      { serviceId: "svc/done", serviceRevision: 4 },
      { delay },
    )).resolves.toBe(published);
    expect(delay).not.toHaveBeenCalled();
  });

  it("exposes runtime health for the published service id", async () : Promise<any> => {
    bridge.getJson.mockResolvedValue({ status: "healthy" });
    await checkUpstreamServiceRuntimeHealth("svc/a");
    expect(bridge.getJson).toHaveBeenCalledWith("/api/gateway/v1/external-services/svc%2Fa/health");
  });
});
