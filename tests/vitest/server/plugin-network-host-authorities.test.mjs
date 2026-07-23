import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createPluginLifecycleStatePort } from "../../../packages/foundation/src/module-system/plugin-lifecycle-state-port.mjs";
import { createPluginDownstreamClientAspectAuthority } from "../../../packages/server-runtime/src/composition/plugin-downstream-client-aspect-authority.mjs";
import { createPluginOutboundEgressAuthority } from "../../../packages/server-runtime/src/composition/plugin-outbound-egress-authority.mjs";

const roots = [];
const digest = (value) => value.repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function lifecycle() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-network-authority-"));
  roots.push(root);
  return createPluginLifecycleStatePort({ userDataPath: root, pluginId: "fixture" });
}

async function writeLedger(port, state, generation) {
  await port.runExclusive(() => port.writeRecord("ledger", {
    schemaVersion: "licomesh.plugin-lifecycle-ledger/1",
    pluginId: "fixture",
    state,
    operation: state === "active" ? "" : "disable",
    idempotencyKey: state === "active" ? "" : "retire-fixture",
    requestDigest: state === "active" ? "" : digest("c"),
    generation
  }));
}

describe("plugin network Host authorities", () => {
  it("fails closed when the lifecycle ledger is absent", async () => {
    const port = await lifecycle();
    const downstream = createPluginDownstreamClientAspectAuthority({
      createService: () => ({ start() {}, listCapabilities: () => [], listProtocolLayers: () => [], summary: () => ({}), translateInboundRequest: () => ({}), stop: () => ({}) })
    }).forOwner({
      ownerId: "fixture", ownerGenerationDigest: digest("a"), ownerGeneration: 1, lifecycleStatePort: port,
      configuration: { enabled: true, start: true, startOptions: {} }
    });
    const outbound = createPluginOutboundEgressAuthority().forOwner({
      ownerId: "fixture", ownerGenerationDigest: digest("a"), ownerGeneration: 1, lifecycleStatePort: port
    });
    await expect(downstream.create({})).rejects.toMatchObject({ code: "plugin_downstream_client_aspect_owner_retired" });
    await expect(outbound.classifyHost("127.0.0.1")).rejects.toMatchObject({ code: "plugin_outbound_egress_owner_retired" });
  });

  it("requires explicit downstream enablement and fences retirement and generation replacement", async () => {
    const port = await lifecycle();
    await writeLedger(port, "active", 1);
    const start = vi.fn(() => ({ ok: true }));
    const authority = createPluginDownstreamClientAspectAuthority({
      createService: () => ({
        started: false,
        start(input) { start(input); this.started = true; },
        listCapabilities: () => [],
        listProtocolLayers: () => [],
        summary: () => ({ ok: true }),
        translateInboundRequest: () => ({}),
        stop: () => ({ ok: true })
      })
    });
    expect(() => authority.forOwner({
      ownerId: "fixture", ownerGenerationDigest: digest("a"), ownerGeneration: 1, lifecycleStatePort: port,
      configuration: {}
    })).toThrow(/explicit enablement/u);
    const first = authority.forOwner({
      ownerId: "fixture", ownerGenerationDigest: digest("a"), ownerGeneration: 1, lifecycleStatePort: port,
      configuration: { enabled: true, start: true, startOptions: { mode: "explicit" } }
    });
    const service = await first.create({});
    await expect(service.isStarted()).resolves.toBe(true);
    expect(start).toHaveBeenCalledWith({ mode: "explicit" });
    await writeLedger(port, "active", 2);
    await expect(service.listCapabilities({})).rejects.toMatchObject({ code: "plugin_downstream_client_aspect_owner_retired" });
    await expect(service.summary()).rejects.toMatchObject({ code: "plugin_downstream_client_aspect_owner_retired" });
    await expect(service.translateInboundRequest({})).rejects.toMatchObject({ code: "plugin_downstream_client_aspect_owner_retired" });
    await expect(service.stop()).resolves.toMatchObject({ ok: true });
    await expect(first.create({})).rejects.toMatchObject({ code: "plugin_downstream_client_aspect_owner_retired" });
    const second = authority.forOwner({
      ownerId: "fixture", ownerGenerationDigest: digest("b"), ownerGeneration: 2, lifecycleStatePort: port,
      configuration: { enabled: true, start: true, startOptions: {} }
    });
    expect(second.ownerGenerationDigest).toBe(digest("b"));
    await writeLedger(port, "inactive", 2);
    await expect(second.create({})).rejects.toMatchObject({ code: "plugin_downstream_client_aspect_owner_retired" });
  });

  it("binds outbound classification to the exact active owner generation", async () => {
    const port = await lifecycle();
    await writeLedger(port, "active", 1);
    const authority = createPluginOutboundEgressAuthority();
    const first = authority.forOwner({
      ownerId: "fixture", ownerGenerationDigest: digest("a"), ownerGeneration: 1, lifecycleStatePort: port
    });
    await expect(first.classifyHost("127.0.0.1")).resolves.toMatchObject({ category: "loopback" });
    await writeLedger(port, "active", 2);
    await expect(first.classifyHost("127.0.0.1")).rejects.toMatchObject({ code: "plugin_outbound_egress_owner_retired" });
    const second = authority.forOwner({
      ownerId: "fixture", ownerGenerationDigest: digest("b"), ownerGeneration: 2, lifecycleStatePort: port
    });
    expect(second.ownerGenerationDigest).toBe(digest("b"));
    await writeLedger(port, "inactive", 2);
    await expect(second.classifyHost("127.0.0.1")).rejects.toMatchObject({ code: "plugin_outbound_egress_owner_retired" });
  });
});
