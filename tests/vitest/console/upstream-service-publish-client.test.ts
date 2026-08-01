// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge: any = vi.hoisted(() : any => ({ getJson: vi.fn(), sendJson: vi.fn() }));

vi.mock("@meshrix/ui-console/bridge-http", () : any => bridge);

import {
  createUpstreamService,
  removeUpstreamService,
  replaceUpstreamService,
  checkUpstreamServiceRuntimeHealth,
  waitForUpstreamServicePublication,
  UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION
} from "../../../apps/console/lib/upstream-service-publish-client";

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
    const payload: any = bridge.sendJson.mock.calls[0][2];
    expect(payload).not.toHaveProperty("ownerSubjectId");
    expect(payload.descriptor).not.toHaveProperty("visibility");
    expect(payload.descriptor).not.toHaveProperty("trafficPolicy");
  });

  it("binds replacement and removal to the server service id and both expected revisions", async () : Promise<any> => {
    await replaceUpstreamService("svc_fixture", { serviceProtocol: "json-rpc" }, 2, 7);
    expect(bridge.sendJson.mock.calls[0].slice(0, 2)).toEqual([
      "/api/gateway/v1/services/svc_fixture",
      "PUT"
    ]);
    expect(bridge.sendJson.mock.calls[0][2]).toMatchObject({
      action: "replace",
      serviceId: "svc_fixture",
      expectedServiceRevision: 2,
      expectedSetRevision: 7
    });

    await removeUpstreamService("svc_fixture", 3, 8);
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

  it("waits for a terminal publication with a bounded poll and then exposes runtime health", async () : Promise<any> => {
    bridge.getJson
      .mockResolvedValueOnce({ service: { state: "publishing", publication: { status: "publishing" } } })
      .mockResolvedValueOnce({ service: { state: "server_published", publication: { status: "server_published" } } })
      .mockResolvedValueOnce({ status: "healthy" });
    const delay: any = vi.fn().mockResolvedValue(undefined);

    await waitForUpstreamServicePublication("svc/a", { maxAttempts: 2, intervalMs: 1, delay });
    expect(delay).toHaveBeenCalledOnce();
    expect(bridge.getJson).toHaveBeenNthCalledWith(1, "/api/gateway/v1/services/svc%2Fa");
    expect(bridge.getJson).toHaveBeenNthCalledWith(2, "/api/gateway/v1/services/svc%2Fa");
    await checkUpstreamServiceRuntimeHealth("svc/a");
    expect(bridge.getJson).toHaveBeenNthCalledWith(3, "/api/gateway/v1/external-services/svc%2Fa/health");
  });

  it("fails after the configured publication poll bound", async () : Promise<any> => {
    bridge.getJson.mockResolvedValue({ service: { state: "publishing", publication: { status: "publishing" } } });
    await expect(waitForUpstreamServicePublication("svc", {
      maxAttempts: 2,
      intervalMs: 0,
      delay: async () : Promise<any> => undefined
    })).rejects.toThrow("after 2 attempts");
    expect(bridge.getJson).toHaveBeenCalledTimes(2);
  });
});
