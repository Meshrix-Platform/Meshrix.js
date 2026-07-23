import { describe, expect, it, vi } from "vitest";
import { createUpstreamManifestObserver } from "../../../packages/agents/src/upstream-gateway/manifest-observer.mjs";
import { structuredJsonPayloadTransport } from "../../helpers/upstream-runtime-snapshot.mjs";

function record({
  revision = 1,
  state = "publishing",
  serviceProtocol = "http",
  operations = [{
    operationKey: "read",
    method: "GET",
    path: "/read",
    payloadTransport: structuredJsonPayloadTransport()
  }],
  mcp = null,
  references = []
} = {}) {
  return Object.freeze({
    serviceId: "svc_01J0000000000000000000000",
    serviceRevision: revision,
    manifestDigest: String(revision).repeat(64).slice(0, 64),
    manifest: Object.freeze({
      references: Object.freeze(references),
      payload: Object.freeze({
        state,
        ...(state === "removed" ? {} : {
          descriptor: Object.freeze({
            serviceProtocol,
            ...(serviceProtocol === "mcp"
              ? { mcp: Object.freeze(mcp || { transport: "streamable-http", url: "https://service.invalid:443/mcp" }) }
              : { baseUrl: "https://service.invalid:443" }),
            ...(operations == null ? {} : {
              operations: Object.freeze(operations.map((operation) => Object.freeze({
                ...operation,
                ...(serviceProtocol === "mcp" || operation.payloadTransport
                  ? {}
                  : { payloadTransport: structuredJsonPayloadTransport() })
              })))
            })
          })
        })
      })
    })
  });
}

function snapshot(setRevision, records) {
  return Object.freeze({
    setRevision,
    setDigest: String(setRevision).padStart(64, "0"),
    serviceCount: records.length,
    listServices: () => Object.freeze(records)
  });
}

describe("upstream manifest observer", () => {
  it("accepts one immutable full snapshot and skips unchanged generations", async () => {
    const onSnapshot = vi.fn();
    const observer = createUpstreamManifestObserver({
      readerPort: { getSnapshot: async () => snapshot(1, [record({
        references: [Object.freeze({
          type: "credential",
          reference: "secret://vault/read",
          revision: 3,
          use: "request-auth",
          operationKey: "read",
          host: "service.invalid",
          protocol: "https",
          scopes: Object.freeze(["gateway:read"])
        })]
      })]) },
      onSnapshot,
      pollIntervalMs: 60_000
    });
    expect(await observer.start()).toEqual({ outcome: "accepted", setRevision: 1 });
    expect(await observer.scan()).toEqual({ outcome: "unchanged", setRevision: 1 });
    const accepted = onSnapshot.mock.calls[0][0];
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(accepted.serviceEntries)).toBe(true);
    expect(Object.isFrozen(accepted.serviceEntries[0])).toBe(true);
    expect(accepted.serviceEntries[0][1]).toMatchObject({
      serviceRevision: 1,
      operations: [{ operationKey: "read", method: "GET", path: "/read" }],
      credentialReferences: [{
        reference: "secret://vault/read",
        revision: 3,
        operationKey: "read",
        host: "service.invalid",
        protocol: "https",
        scopes: ["gateway:read"]
      }]
    });
    expect(Object.isFrozen(accepted.serviceEntries[0][1].credentialReferences)).toBe(true);
    expect(Object.isFrozen(accepted.serviceEntries[0][1].credentialReferences[0].scopes)).toBe(true);
    await observer.close();
  });

  it("rejects duplicate operation identities without publishing a partial candidate", async () => {
    const onSnapshot = vi.fn();
    const onError = vi.fn();
    const observer = createUpstreamManifestObserver({
      readerPort: {
        getSnapshot: async () => snapshot(1, [record({
          operations: [
            { operationKey: "read", method: "GET", path: "/first" },
            { operationKey: "read", method: "GET", path: "/second" }
          ]
        })])
      },
      onSnapshot,
      onError,
      pollIntervalMs: 60_000
    });
    expect(await observer.start()).toEqual({ outcome: "rejected", setRevision: -1 });
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith({
      reasonCode: "manifest_candidate_rejected",
      errorCode: "manifest_observation_failed"
    });
    await observer.close();
  });

  it("compiles the sole governed tools/call operation for a remote MCP descriptor", async () => {
    const onSnapshot = vi.fn();
    const observer = createUpstreamManifestObserver({
      readerPort: {
        getSnapshot: async () => snapshot(1, [record({
          serviceProtocol: "mcp",
          operations: null
        })])
      },
      onSnapshot,
      pollIntervalMs: 60_000
    });
    expect(await observer.start()).toEqual({ outcome: "accepted", setRevision: 1 });
    expect(onSnapshot.mock.calls[0][0].serviceEntries[0][1]).toMatchObject({
      serviceProtocol: "mcp",
      mcp: { transport: "http" },
      operations: [{
        operationKey: "tools/call",
        protocol: "mcp"
      }]
    });
    await observer.close();
  });

  it("rejects revision rollback and same-revision digest conflicts", async () => {
    let current = snapshot(2, [record({ revision: 2 })]);
    const accepted = [];
    const errors = [];
    const observer = createUpstreamManifestObserver({
      readerPort: { getSnapshot: async () => current },
      onSnapshot: (candidate) => accepted.push(candidate.setRevision),
      onError: (event) => errors.push(event),
      pollIntervalMs: 60_000
    });
    expect(await observer.start()).toEqual({ outcome: "accepted", setRevision: 2 });
    current = snapshot(1, [record()]);
    expect(await observer.scan()).toEqual({ outcome: "rejected", setRevision: 2 });
    current = Object.freeze({ ...snapshot(2, [record({ revision: 2 })]), setDigest: "f".repeat(64) });
    expect(await observer.scan()).toEqual({ outcome: "rejected", setRevision: 2 });
    expect(await observer.reapplyAccepted()).toEqual({ outcome: "rejected", setRevision: 2 });
    expect(accepted).toEqual([2]);
    expect(errors).toHaveLength(3);
    await observer.close();
  });

  it("does not publish a reader result that completes after shutdown", async () => {
    let release;
    const pendingSnapshot = new Promise((resolve) => { release = resolve; });
    const onSnapshot = vi.fn();
    const observer = createUpstreamManifestObserver({
      readerPort: { getSnapshot: () => pendingSnapshot },
      onSnapshot,
      pollIntervalMs: 60_000
    });
    const scanning = observer.scan();
    let closed = false;
    const closing = observer.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release(snapshot(1, [record()]));
    expect(await scanning).toEqual({ outcome: "closed", setRevision: -1 });
    await closing;
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("retains the last accepted revision when candidate validation or callback fails, then retries", async () => {
    let current = snapshot(1, [record()]);
    let failCallback = false;
    const accepted = [];
    const errors = [];
    const observer = createUpstreamManifestObserver({
      readerPort: { getSnapshot: async () => current },
      onSnapshot(candidate) {
        if (failCallback) throw new Error("callback failed");
        accepted.push(candidate.setRevision);
      },
      onError: (event) => errors.push(event),
      pollIntervalMs: 60_000
    });
    await observer.start();
    current = snapshot(2, [record({ revision: 2, operations: [] })]);
    expect(await observer.scan()).toEqual({ outcome: "rejected", setRevision: 1 });
    expect(observer.state().acceptedSetRevision).toBe(1);

    current = snapshot(2, [record({ revision: 2 })]);
    failCallback = true;
    expect(await observer.scan()).toEqual({ outcome: "rejected", setRevision: 1 });
    failCallback = false;
    expect(await observer.scan()).toEqual({ outcome: "accepted", setRevision: 2 });
    expect(accepted).toEqual([1, 2]);
    expect(errors).toHaveLength(2);
    await observer.close();
  });

  it("coalesces overlapping scans and projects removal tombstones without a service", async () => {
    let release;
    const pendingSnapshot = new Promise((resolve) => { release = resolve; });
    const onSnapshot = vi.fn();
    const observer = createUpstreamManifestObserver({
      readerPort: { getSnapshot: () => pendingSnapshot },
      onSnapshot,
      pollIntervalMs: 60_000
    });
    const first = observer.scan();
    expect(await observer.scan()).toEqual({ outcome: "coalesced", setRevision: -1 });
    expect(observer.state()).toMatchObject({ building: true, pending: true });
    release(snapshot(1, [record({ state: "removed" })]));
    expect(await first).toEqual({ outcome: "accepted", setRevision: 1 });
    expect(onSnapshot.mock.calls[0][0]).toMatchObject({ serviceCount: 0 });
    await observer.close();
  });

  it("rejects duplicate service identities and a mismatched declared service count", async () => {
    let current = snapshot(1, [record(), record()]);
    const onSnapshot = vi.fn();
    const onError = vi.fn();
    const observer = createUpstreamManifestObserver({
      readerPort: { getSnapshot: async () => current },
      onSnapshot,
      onError,
      pollIntervalMs: 60_000
    });

    expect(await observer.start()).toEqual({ outcome: "rejected", setRevision: -1 });
    current = Object.freeze({ ...snapshot(2, [record({ revision: 2 })]), serviceCount: 2 });
    expect(await observer.scan()).toEqual({ outcome: "rejected", setRevision: -1 });
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(2);
    await observer.close();
  });

  it("deep-freezes deterministic runtime snapshots across an accepted replay", async () => {
    const candidates = [];
    const current = snapshot(1, [record({
      operations: [{
        operationKey: "read",
        method: "POST",
        path: "/read",
        requestSchema: { type: "object", properties: { query: { type: "string" } } },
        requiredApproval: { approvalLayers: ["team"] }
      }]
    })]);
    const observer = createUpstreamManifestObserver({
      readerPort: { getSnapshot: async () => current },
      onSnapshot: (candidate) => candidates.push(candidate),
      pollIntervalMs: 60_000
    });

    expect(await observer.start()).toEqual({ outcome: "accepted", setRevision: 1 });
    expect(await observer.reapplyAccepted()).toEqual({ outcome: "reapplied", setRevision: 1 });
    expect(candidates[1]).toEqual(candidates[0]);
    const service = candidates[0].serviceEntries[0][1];
    expect(service.createdAt).toBe("revision-1");
    expect(service.updatedAt).toBe("revision-1");
    expect(Object.isFrozen(service.operations)).toBe(true);
    expect(Object.isFrozen(service.operations[0].requestSchema.properties.query)).toBe(true);
    await observer.close();
  });

  it("waits for an active snapshot callback before close resolves and commits no observer state", async () => {
    let release;
    const callbackPending = new Promise((resolve) => { release = resolve; });
    const observer = createUpstreamManifestObserver({
      readerPort: { getSnapshot: async () => snapshot(1, [record()]) },
      onSnapshot: () => callbackPending,
      pollIntervalMs: 60_000
    });
    const scanning = observer.scan();
    await Promise.resolve();
    let closed = false;
    const closing = observer.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    expect(await scanning).toEqual({ outcome: "closed", setRevision: -1 });
    await closing;
    expect(observer.state()).toMatchObject({ acceptedSetRevision: -1, building: false, closed: true });
  });

  it("runs a pending invalidation immediately instead of waiting for the periodic poll", async () => {
    vi.useFakeTimers();
    try {
      let release;
      let reads = 0;
      const delayed = new Promise((resolve) => { release = resolve; });
      const observer = createUpstreamManifestObserver({
        readerPort: {
          getSnapshot() {
            reads += 1;
            return reads === 2 ? delayed : Promise.resolve(snapshot(1, [record()]));
          }
        },
        onSnapshot: async () => {},
        pollIntervalMs: 60_000
      });
      await observer.start();
      const scanning = observer.scan();
      expect(observer.invalidate()).toBe(true);
      release(snapshot(1, [record()]));
      await scanning;
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(3);
      await observer.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
