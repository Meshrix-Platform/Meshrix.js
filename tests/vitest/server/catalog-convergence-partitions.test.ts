import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MCP_SSE_CONNECTION_LIMITS,
  bindMcpSseConnectionPartitions,
  acknowledgeMcpCatalogConvergence,
  broadcastMcpNotification,
  disconnectMcpSseConnectionsByGrant,
  getMcpCatalogConvergenceCohort,
  getMcpSseConnectionState,
  registerMcpSseConnection,
  resetMcpSseConnectionStateForTests
} from "../../../packages/server-runtime/src/state/sse-connection-state.ts";
import {
  broadcastAudienceCatalogInvalidation,
  broadcastMcpToolListChanged
} from "../../../packages/protocols/mcp/adapter/http-mcp-adapter-replies.ts";
import { configureMcpNotificationBus } from "../../../packages/protocols/mcp/adapter/mcp-notification-bus.ts";
import { broadcastMcpNotification as sseBroadcast } from "../../../packages/server-runtime/src/state/sse-connection-state.ts";

function responseFixture({ writeResult = true }: Record<string, any> = {}) : any {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    write: vi.fn(function write(chunk?: any) : any {
      this.chunks.push(String(chunk));
      return writeResult;
    }),
    end(chunk: any = "") : any {
      if (chunk) this.chunks.push(String(chunk));
      this.writableEnded = true;
    },
    destroy: vi.fn(function destroy() : any {
      this.destroyed = true;
    })
  };
}

function connectionFixture({
  grantId,
  remoteAddress,
  partitionKeys = [],
  negotiatedCapabilities = ["notifications/tools/list_changed"],
  proxySessionId = "abcdefghijklmnopqrstuvwx",
  writeResult = true
}: Record<string, any>) : any {
  const request: any = new EventEmitter();
  request.socket = { remoteAddress };
  const response: any = responseFixture({ writeResult });
  const registration: any = registerMcpSseConnection({
    request,
    response,
    grantId,
    grant: { id: grantId },
    privateOnly: true,
    partitionKeys,
    negotiatedCapabilities,
    proxySessionId
  });
  return { request, response, registration };
}

function grantDigest(grantId?: any) : any {
  return createHash("sha256").update(String(grantId)).digest("base64url");
}

afterEach(() : any => {
  vi.useRealTimers();
  configureMcpNotificationBus();
  resetMcpSseConnectionStateForTests();
});

describe("MCP catalog convergence partitions", () : any => {
  it("delivers revision-only invalidation only to affected partitions and digests", () : any => {
    configureMcpNotificationBus({ broadcastNotification: sseBroadcast });
    const affected: any = connectionFixture({
      grantId: "grant-affected",
      remoteAddress: "10.0.0.1",
      partitionKeys: ["part-a"]
    });
    const other: any = connectionFixture({
      grantId: "grant-other",
      remoteAddress: "10.0.0.2",
      partitionKeys: ["part-b"]
    });
    expect(affected.registration.ok).toBe(true);
    expect(other.registration.ok).toBe(true);

    const delivery: any = broadcastAudienceCatalogInvalidation({
      sourceRevision: 3,
      catalogRevision: "catalog-3",
      audienceRevision: 7,
      affectedPartitions: ["part-a"],
      partitions: new Map<any, any>([
        ["part-a", { grantIdDigest: grantDigest("grant-affected"), audienceDigest: "ad-a" }],
        ["part-b", { grantIdDigest: grantDigest("grant-other"), audienceDigest: "ad-b" }]
      ]),
      reasonCode: "upstream_audiences_published"
    });

    expect(delivery).toMatchObject({
      ok: true,
      sourceRevision: 3,
      audienceRevision: 7,
      matchedConnectionCount: 1,
      deliveredConnectionCount: 1
    });
    expect(affected.response.chunks.join("")).toContain("notifications/tools/list_changed");
    expect(affected.response.chunks.join("")).toContain("\"audienceRevision\":7");
    expect(affected.response.chunks.join("")).toContain("part-a");
    expect(affected.response.chunks.join("")).not.toMatch(/tools\"\s*:/);
    expect(other.response.chunks.join("")).toBe("");
  });

  it("binds partition keys after registration and scopes grant-digest fan-out", () : any => {
    const fixture: any = connectionFixture({
      grantId: "grant-bind",
      remoteAddress: "10.0.0.3"
    });
    expect(bindMcpSseConnectionPartitions(fixture.registration.connection, ["part-x", "part-y"])).toBe(true);
    expect(getMcpSseConnectionState().partitionCount).toBe(2);

    const delivery: any = broadcastMcpNotification(
      { jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { change: { audienceRevision: 1 } } },
      { grantIdDigests: [grantDigest("grant-bind")] }
    );
    expect(delivery.matchedConnectionCount).toBe(1);
    expect(delivery.deliveredConnectionCount).toBe(1);
  });

  it("keeps list_changed change payload free of catalog tool arrays", () : any => {
    let deliveredPayload: any = null;
    configureMcpNotificationBus({
      broadcastNotification: (payload?: any) : any => {
        deliveredPayload = payload;
        return {
        activeConnectionCount: 0,
        matchedConnectionCount: 0,
        deliveredConnectionCount: 0
        };
      }
    });
    const result: any = broadcastMcpToolListChanged({
      sourceRevision: 1,
      catalogRevision: "fp-1",
      audienceRevision: 2,
      partitionKeys: ["p1"],
      details: { tools: [{ name: "secret.tool" }] }
    });
    expect(result.sourceRevision).toBe(1);
    expect(result.audienceRevision).toBe(2);
    expect(deliveredPayload.params.change).not.toHaveProperty("tools");
    expect(deliveredPayload.params.change).not.toHaveProperty("details");
    expect(deliveredPayload.params.change).not.toHaveProperty("grantId");
    expect(deliveredPayload.params.change).not.toHaveProperty("changedAt");
    expect(Object.keys(deliveredPayload.params)).toEqual(["change"]);
  });

  it("does not deliver list changes to clients that did not negotiate the capability", () : any => {
    const unsupported: any = connectionFixture({
      grantId: "grant-unsupported",
      remoteAddress: "10.0.0.4",
      partitionKeys: ["part-a"],
      negotiatedCapabilities: []
    });
    const delivery: any = broadcastMcpNotification(
      {
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
        params: { change: { audienceRevision: 2 } }
      },
      { partitionKeys: ["part-a"] }
    );
    expect(delivery.matchedConnectionCount).toBe(0);
    expect(delivery.deliveredConnectionCount).toBe(0);
    expect(unsupported.response.chunks).toEqual([]);
  });

  it("projects only each connection's affected opaque partitions into its notification", () : any => {
    const first: any = connectionFixture({
      grantId: "grant-first",
      remoteAddress: "10.0.0.9",
      partitionKeys: ["part-first"]
    });
    const second: any = connectionFixture({
      grantId: "grant-second",
      remoteAddress: "10.0.0.10",
      partitionKeys: ["part-second"]
    });
    const delivery: any = broadcastMcpNotification({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
      params: {
        change: {
          sourceRevision: 2,
          catalogRevision: "catalog-2",
          audienceRevision: 2,
          affectedPartitions: ["part-first", "part-second"]
        }
      }
    }, { partitionKeys: ["part-first", "part-second"] });
    expect(delivery.deliveredConnectionCount).toBe(2);
    expect(first.response.chunks.join("")).toContain("part-first");
    expect(first.response.chunks.join("")).not.toContain("part-second");
    expect(second.response.chunks.join("")).toContain("part-second");
    expect(second.response.chunks.join("")).not.toContain("part-first");
    first.request.emit("close");
    second.request.emit("close");
  });

  it("tracks applied cohort acknowledgement against grant, session, revisions, and partitions", () : any => {
    const fixture: any = connectionFixture({
      grantId: "grant-ack",
      remoteAddress: "10.0.0.5",
      partitionKeys: ["part-a"]
    });
    const payload: Record<string, any> = {
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
      params: {
        change: {
          sourceRevision: 3,
          catalogRevision: "catalog-3",
          audienceRevision: 7,
          affectedPartitions: ["part-a"]
        }
      }
    };
    expect(broadcastMcpNotification(payload, { partitionKeys: ["part-a"] }))
      .toMatchObject({ deliveredConnectionCount: 1 });
    expect(getMcpCatalogConvergenceCohort()).toEqual([
      expect.objectContaining({ outcome: "pending", sourceRevision: 3, partitionCount: 1 })
    ]);
    expect(acknowledgeMcpCatalogConvergence({
      grantId: "grant-other",
      proxySessionId: "abcdefghijklmnopqrstuvwx",
      sourceRevision: 3,
      catalogRevision: "catalog-3",
      audienceRevision: 7,
      partitionKeys: ["part-a"]
    }).ok).toBe(false);
    expect(acknowledgeMcpCatalogConvergence({
      grantId: "grant-ack",
      proxySessionId: "abcdefghijklmnopqrstuvwx",
      sourceRevision: 3,
      catalogRevision: "catalog-3",
      audienceRevision: 7,
      partitionKeys: ["part-a"]
    })).toEqual({ ok: true, appliedConnectionCount: 1 });
    expect(getMcpCatalogConvergenceCohort()).toEqual([
      expect.objectContaining({ outcome: "applied", audienceRevision: 7 })
    ]);
    fixture.request.emit("close");
  });

  it("requires an exact partition set and keeps the latest revision timeout after an older acknowledgement", async () : Promise<any> => {
    vi.useFakeTimers();
    const fixture: any = connectionFixture({
      grantId: "grant-exact",
      remoteAddress: "10.0.0.11",
      partitionKeys: ["part-a", "part-b"]
    });
    const notify: any = (sourceRevision?: any, audienceRevision?: any, affectedPartitions?: any) : any => broadcastMcpNotification({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
      params: { change: {
        sourceRevision,
        catalogRevision: `catalog-${sourceRevision}`,
        audienceRevision,
        affectedPartitions
      } }
    }, { partitionKeys: affectedPartitions });
    notify(1, 1, ["part-a"]);
    notify(2, 2, ["part-b"]);

    expect(acknowledgeMcpCatalogConvergence({
      grantId: "grant-exact",
      proxySessionId: "abcdefghijklmnopqrstuvwx",
      sourceRevision: 1,
      catalogRevision: "catalog-1",
      audienceRevision: 1,
      partitionKeys: ["part-a", "part-b"]
    }).ok).toBe(false);
    expect(acknowledgeMcpCatalogConvergence({
      grantId: "grant-exact",
      proxySessionId: "abcdefghijklmnopqrstuvwx",
      sourceRevision: 1,
      catalogRevision: "catalog-1",
      audienceRevision: 1,
      partitionKeys: ["part-a"]
    }).ok).toBe(true);

    await vi.advanceTimersByTimeAsync(MCP_SSE_CONNECTION_LIMITS.acknowledgementTimeoutMs);
    expect(fixture.response.destroy).toHaveBeenCalledOnce();
    expect(getMcpCatalogConvergenceCohort()).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: "fenced", sourceRevision: 2 })
    ]));
  });

  it("disconnects all active streams when their grant is retired", () : any => {
    const first: any = connectionFixture({
      grantId: "grant-retired",
      remoteAddress: "10.0.0.7",
      partitionKeys: ["part-a"]
    });
    const second: any = connectionFixture({
      grantId: "grant-other",
      remoteAddress: "10.0.0.8",
      partitionKeys: ["part-b"]
    });
    expect(disconnectMcpSseConnectionsByGrant("grant-retired"))
      .toEqual({ disconnectedConnectionCount: 1 });
    expect(first.response.destroy).toHaveBeenCalledOnce();
    expect(second.response.destroy).not.toHaveBeenCalled();
    expect(getMcpSseConnectionState().activeConnectionCount).toBe(1);
    second.request.emit("close");
  });

  it("disconnects and fences a cohort that misses its acknowledgement deadline", async () : Promise<any> => {
    vi.useFakeTimers();
    const fixture: any = connectionFixture({
      grantId: "grant-timeout",
      remoteAddress: "10.0.0.6",
      partitionKeys: ["part-timeout"]
    });
    broadcastMcpNotification({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
      params: {
        change: {
          sourceRevision: 4,
          catalogRevision: "catalog-4",
          audienceRevision: 8,
          affectedPartitions: ["part-timeout"]
        }
      }
    }, { partitionKeys: ["part-timeout"] });
    await vi.advanceTimersByTimeAsync(MCP_SSE_CONNECTION_LIMITS.acknowledgementTimeoutMs);
    expect(fixture.response.destroy).toHaveBeenCalledOnce();
    expect(getMcpSseConnectionState().activeConnectionCount).toBe(0);
    expect(getMcpCatalogConvergenceCohort()).toEqual([
      expect.objectContaining({ outcome: "fenced", sourceRevision: 4 })
    ]);
    expect(connectionFixture({
      grantId: "grant-timeout",
      remoteAddress: "10.0.0.12",
      partitionKeys: ["part-timeout"]
    }).registration).toMatchObject({
      ok: false,
      status: 409,
      code: "mcp_sse_convergence_session_fenced"
    });
    const freshSession: any = connectionFixture({
      grantId: "grant-timeout",
      remoteAddress: "10.0.0.13",
      partitionKeys: ["part-timeout"],
      proxySessionId: "zyxwvutsrqponmlkjihgfedc"
    });
    expect(freshSession.registration.ok).toBe(true);
    freshSession.request.emit("close");
  });
});
