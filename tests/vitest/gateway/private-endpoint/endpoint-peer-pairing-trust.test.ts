import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EndpointPeerRuntime } from "../../../../apps/mcp-gateway-installer/src/private-endpoint/peer.ts";

describe("private endpoint peer pairing trust", () => {
  it("waits for durable Peer cleanup before returning from close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-endpoint-peer-"));
    const runtime = await EndpointPeerRuntime.create({
      peer: { storageDir: join(directory, "peer") },
      route: { tenantId: "tenant.peer.test", routeId: "route.peer.test", deviceId: "device.endpoint.test" },
      send: () => {}, sessionLive: () => false, resolvePeerIdentity: () => null
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dispose = runtime.client.dispose.bind(runtime.client);
    vi.spyOn(runtime.client, "dispose").mockImplementation(async () => { await gate; await dispose(); });
    let completed = false;
    const closing = runtime.close().then(() => { completed = true; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
    } finally {
      release();
      await closing;
      await rm(directory, { recursive: true, force: true });
    }
    expect(completed).toBe(true);
  });
  it("does not derive or learn a crypto identity when the authenticated pairing record is absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-endpoint-peer-"));
    const sent: Record<string, unknown>[] = [];
    const runtime = await EndpointPeerRuntime.create({
      peer: { storageDir: join(directory, "peer") },
      route: { tenantId: "tenant.peer.test", routeId: "route.peer.test", deviceId: "device.endpoint.test" },
      send: (message) => { sent.push(message); },
      sessionLive: () => true,
      resolvePeerIdentity: () => null,
    });
    try {
      await expect(runtime.sendMessage({ peerDeviceId: "device.entry.test", text: "hello" }))
        .rejects.toMatchObject({ code: "peer_client_unknown_peer" });
      expect(sent).toEqual([]);
      expect((await runtime.client.outbox.pendingPage()).items).toEqual([]);
      expect(await runtime.pairSafety("device.entry.test")).toEqual({
        peerDeviceId: "device.entry.test",
        peerId: null,
        safetyNumber: null,
      });
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
