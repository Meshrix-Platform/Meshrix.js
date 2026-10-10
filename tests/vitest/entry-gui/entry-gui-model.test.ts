/**
 * Pure reducer + secret-scan tests for the entry GUI state model.
 *
 * No shell, no filesystem: the model is the same code the trusted backend
 * process drives and the sandboxed renderer consumes, so every honesty rule
 * is exercisable here — pairing phases, endpoint trust fields carried
 * verbatim, reachability that never fabricates a channel, one-shot reveal
 * state, per-endpoint rotation, and the secret-free emission barrier.
 */
import { describe, expect, it } from "vitest";

import {
  EntryGuiModel,
  GUI_STATE_SCHEMA_VERSION,
  assertGuiStateSecretFree,
  restoreGuiState,
  scanGuiStateForSecrets,
  type GuiConnectionView,
  type GuiState
} from "@meshrix/entry-gui";

function connectionFixture(overrides: Partial<GuiConnectionView> = {}): GuiConnectionView {
  return {
    connectionId: "conn.dev.entry.1",
    displayLabel: "prin.gui.1 @ route.gui.1",
    tenantId: "tenant.gui.1",
    routeId: "route.gui.1",
    mode: "personal",
    endpointPrincipalRef: "prin.gui.1",
    endpointSpkiPin: "spki.gui.pin",
    deviceId: "dev.entry.1",
    deviceFingerprint: "fp.device.1",
    routeState: "unknown",
    channelEstablished: false,
    acceptsNewWork: false,
    boundRecoveryKeyId: null,
    revocation: "none",
    vaultId: "vault.gui.1",
    capabilityGrantRef: "grant.gui.1",
    ...overrides
  };
}

const INVITE = {
  inviteId: "inv.gui.1",
  endpointRouteId: "route.gui.1",
  tenantId: "tenant.gui.1",
  mode: "personal" as const,
  endpointPrincipalRef: "prin.gui.1",
  endpointSpkiPin: "spki.gui.pin",
  relayService: "https://relay.gui.invalid",
  vaultId: "vault.gui.1",
  expiresAt: "2099-01-01T00:00:00Z"
};

describe("gui model — initial state", () => {
  it("emits a versioned, secret-free snapshot with no connections", () => {
    const model = new EntryGuiModel();
    const state = model.snapshot();
    expect(state.schemaVersion).toBe(GUI_STATE_SCHEMA_VERSION);
    expect(state.lifecycle.state).toBe("starting");
    expect(state.pairing.phase).toBe("idle");
    expect(state.recovery.state).toBe("not_configured");
    expect(state.recoveryImport.phase).toBe("idle");
    expect(state.connections).toHaveLength(0);
    expect(scanGuiStateForSecrets(state)).toHaveLength(0);
  });
});

describe("gui model — pairing", () => {
  it("moves idle → invite_ready → challenge_issued → enrolled with trust fields verbatim", () => {
    const model = new EntryGuiModel();
    let state = model.apply({
      type: "pairing.invite_ready",
      sessionId: "pair.session.1",
      invite: INVITE
    });
    expect(state.pairing.phase).toBe("invite_ready");
    expect(state.pairing.sessionId).toBe("pair.session.1");
    // The decrypting party is displayed verbatim — principal + SPKI pin.
    expect(state.pairing.invite?.endpointPrincipalRef).toBe("prin.gui.1");
    expect(state.pairing.invite?.endpointSpkiPin).toBe("spki.gui.pin");

    state = model.apply({ type: "pairing.challenge_issued", deviceFingerprint: "fp.device.1" });
    expect(state.pairing.phase).toBe("challenge_issued");
    expect(state.pairing.deviceFingerprint).toBe("fp.device.1");

    state = model.apply({ type: "pairing.enrolled", connection: connectionFixture() });
    expect(state.pairing.phase).toBe("enrolled");
    expect(state.pairing.enrolledConnectionId).toBe("conn.dev.entry.1");
    expect(state.connections[0]?.endpointSpkiPin).toBe("spki.gui.pin");
    expect(state.connections[0]?.endpointPrincipalRef).toBe("prin.gui.1");
  });

  it("records refused/offline/expired/cancelled outcomes without fabricating a connection", () => {
    for (const phase of ["refused", "offline", "expired", "retry_required"] as const) {
      const model = new EntryGuiModel();
      model.apply({ type: "pairing.invite_ready", sessionId: "s1", invite: INVITE });
      const state = model.apply({ type: "pairing.outcome", phase, refusal: phase === "refused" ? "invite_token_invalid" : null });
      expect(state.pairing.phase).toBe(phase);
      expect(state.pairing.refusal).toBe(phase === "refused" ? "invite_token_invalid" : null);
      expect(state.connections).toHaveLength(0);
    }
    const model = new EntryGuiModel();
    model.apply({ type: "pairing.invite_ready", sessionId: "s1", invite: INVITE });
    const cancelled = model.apply({ type: "pairing.outcome", phase: "cancelled" });
    expect(cancelled.pairing.phase).toBe("cancelled");
    expect(cancelled.connections).toHaveLength(0);
  });

  it("reset returns pairing to a clean idle", () => {
    const model = new EntryGuiModel();
    model.apply({ type: "pairing.invite_ready", sessionId: "s1", invite: INVITE });
    model.apply({ type: "pairing.challenge_issued", deviceFingerprint: "fp.x" });
    const state = model.apply({ type: "pairing.reset" });
    expect(state.pairing.phase).toBe("idle");
    expect(state.pairing.sessionId).toBeNull();
    expect(state.pairing.invite).toBeNull();
    expect(state.pairing.deviceFingerprint).toBeNull();
  });
});

describe("gui model — connection honesty", () => {
  it("updates only the named connection's fields and supports removal", () => {
    const model = new EntryGuiModel();
    model.apply({ type: "connection.upsert", connection: connectionFixture() });
    model.apply({ type: "connection.upsert", connection: connectionFixture({ connectionId: "conn.dev.entry.2", deviceId: "dev.entry.2" }) });

    let state = model.apply({
      type: "connection.state",
      connectionId: "conn.dev.entry.1",
      routeState: "reachable",
      channelEstablished: true,
      acceptsNewWork: true
    });
    expect(state.connections[0]?.routeState).toBe("reachable");
    expect(state.connections[0]?.acceptsNewWork).toBe(true);
    expect(state.connections[1]?.routeState).toBe("unknown");
    expect(state.connections[1]?.channelEstablished).toBe(false);

    // Revocation flags project honestly: pending is distinct from applied.
    state = model.apply({ type: "connection.state", connectionId: "conn.dev.entry.2", revocation: "remote_pending" });
    expect(state.connections[1]?.revocation).toBe("remote_pending");
    state = model.apply({ type: "connection.removed", connectionId: "conn.dev.entry.2" });
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0]?.connectionId).toBe("conn.dev.entry.1");
  });

  it("never shows acceptsNewWork without an established channel event", () => {
    const model = new EntryGuiModel();
    model.apply({ type: "connection.upsert", connection: connectionFixture() });
    const state = model.apply({
      type: "connection.state",
      connectionId: "conn.dev.entry.1",
      routeState: "reachable"
    });
    // Route reachable alone does not imply usable work — channel state is separate.
    expect(state.connections[0]?.routeState).toBe("reachable");
    expect(state.connections[0]?.channelEstablished).toBe(false);
    expect(state.connections[0]?.acceptsNewWork).toBe(false);
  });
});

describe("gui model — recovery", () => {
  it("generated → revealed → confirmed; the key text never enters state", () => {
    const model = new EntryGuiModel();
    let state = model.apply({ type: "recovery.generated", vaultId: "vault.gui.1", keyId: "rckey.gui.1", generation: 1 });
    expect(state.recovery.state).toBe("awaiting_save");
    expect(state.recovery.keyRevealed).toBe(false);
    expect(state.recovery.keyId).toBe("rckey.gui.1");

    state = model.apply({ type: "recovery.revealed" });
    expect(state.recovery.keyRevealed).toBe(true);
    expect(state.recovery.state).toBe("awaiting_save");

    state = model.apply({ type: "recovery.confirmed" });
    expect(state.recovery.state).toBe("ready");
    expect(scanGuiStateForSecrets(state)).toHaveLength(0);
  });

  it("imported recovery lands ready with the recovered connection", () => {
    const model = new EntryGuiModel();
    const state = model.apply({
      type: "recovery.imported",
      vaultId: "vault.gui.1",
      keyId: "rckey.gui.9",
      generation: 4,
      connection: connectionFixture({ connectionId: "conn.dev.entry.fresh" })
    });
    expect(state.recovery.state).toBe("ready");
    expect(state.recovery.generation).toBe(4);
    expect(state.recovery.keyRevealed).toBe(false);
    expect(state.connections.some((c) => c.connectionId === "conn.dev.entry.fresh")).toBe(true);
  });

  it("backup outcomes update honestly: committed revision or unreadable", () => {
    const model = new EntryGuiModel();
    model.apply({ type: "recovery.generated", vaultId: "v", keyId: "k", generation: 1 });
    model.apply({ type: "recovery.revealed" });
    model.apply({ type: "recovery.confirmed" });
    let state = model.apply({ type: "recovery.backup", lastSuccessAt: "2026-01-02T00:00:00Z", lastCommittedRevision: 3, lastError: null });
    expect(state.recovery.state).toBe("ready");
    expect(state.recovery.backup.lastCommittedRevision).toBe(3);
    expect(state.recovery.backup.lastError).toBeNull();

    state = model.apply({ type: "recovery.backup", lastError: "vault conflict at revision 4" });
    expect(state.recovery.state).toBe("backup_unreadable");
    expect(state.recovery.backup.lastError).toMatch(/conflict/);
    // A later success restores readiness.
    state = model.apply({ type: "recovery.backup", lastSuccessAt: "2026-01-03T00:00:00Z", lastCommittedRevision: 5, lastError: null });
    expect(state.recovery.state).toBe("ready");
    expect(state.recovery.backup.lastCommittedRevision).toBe(5);
  });

  it("rotation holds the recovery state at rotation_pending until terminal", () => {
    const model = new EntryGuiModel();
    model.apply({ type: "recovery.generated", vaultId: "v", keyId: "k1", generation: 1 });
    model.apply({ type: "recovery.revealed" });
    model.apply({ type: "recovery.confirmed" });
    let state = model.apply({
      type: "recovery.rotation",
      rotation: {
        rotationId: "rot.1",
        state: "staged",
        candidateGeneration: 2,
        endpoints: [{ endpointRouteId: "route.gui.1", state: "pending" }]
      }
    });
    expect(state.recovery.state).toBe("rotation_pending");
    expect(state.recovery.rotation?.endpoints[0]?.state).toBe("pending");

    state = model.apply({
      type: "recovery.rotation",
      rotation: {
        rotationId: "rot.1",
        state: "published",
        candidateGeneration: 2,
        endpoints: [{ endpointRouteId: "route.gui.1", state: "unreachable" }]
      }
    });
    // Still not complete — an unreachable endpoint keeps the rotation pending.
    expect(state.recovery.state).toBe("rotation_pending");

    state = model.apply({
      type: "recovery.rotation",
      rotation: {
        rotationId: "rot.1",
        state: "completed",
        candidateGeneration: 2,
        endpoints: [{ endpointRouteId: "route.gui.1", state: "acknowledged" }]
      }
    });
    expect(state.recovery.state).toBe("ready");
    expect(state.recovery.rotation?.state).toBe("completed");
  });

  it("recoveryImport phases carry honest detail without secrets", () => {
    const model = new EntryGuiModel();
    model.apply({ type: "recoveryImport.phase", phase: "working" });
    let state = model.apply({ type: "recoveryImport.phase", phase: "snapshot_missing" });
    expect(state.recoveryImport.phase).toBe("snapshot_missing");
    state = model.apply({ type: "recoveryImport.phase", phase: "enrolled", enrolledConnectionId: "conn.x" });
    expect(state.recoveryImport.enrolledConnectionId).toBe("conn.x");
    state = model.apply({ type: "recoveryImport.phase", phase: "error", detail: "endpoint_unreachable" });
    expect(state.recoveryImport.detail).toBe("endpoint_unreachable");
    expect(state.recoveryImport.enrolledConnectionId).toBe("conn.x");
  });
});

describe("gui model — notices, mcp, lifecycle", () => {
  it("bounds notices at 20 and keeps the newest", () => {
    const model = new EntryGuiModel();
    for (let i = 0; i < 30; i += 1) model.apply({ type: "notice", text: `n${i}` });
    const state = model.snapshot();
    expect(state.notices).toHaveLength(20);
    expect(state.notices[19]).toBe("n29");
    expect(state.notices[0]).toBe("n10");
  });

  it("mcp.configured stores snippet + managed path; lifecycle states advance", () => {
    const model = new EntryGuiModel();
    let state = model.apply({ type: "mcp.configured", snippet: "{\"mcpServers\":{}}", configuredPath: "/data/mcp/x.json" });
    expect(state.mcp.transport).toBe("stdio");
    expect(state.mcp.configuredPath).toBe("/data/mcp/x.json");
    state = model.apply({ type: "lifecycle.state", state: "stopping" });
    expect(state.lifecycle.state).toBe("stopping");
    state = model.apply({ type: "lifecycle.state", state: "stopped" });
    expect(state.lifecycle.state).toBe("stopped");
  });
});

describe("gui model — secret-free emission barrier", () => {
  it("scanGuiStateForSecrets flags recovery text, pkcs8 material and secret-named keys", () => {
    expect(scanGuiStateForSecrets({ recoveryText: "mrk1-aaaaa-bbbbb" })).not.toHaveLength(0);
    expect(scanGuiStateForSecrets({ blob: "xxMC4CAQAwBQYDK2Vwyy" })).not.toHaveLength(0);
    expect(scanGuiStateForSecrets({ nested: { privateKey: "x" } })).not.toHaveLength(0);
    expect(scanGuiStateForSecrets({ nested: { pairingToken: "x" } })).not.toHaveLength(0);
    expect(scanGuiStateForSecrets({ deep: [{ list: [{ relayCredential: "x" }] }] })).not.toHaveLength(0);
    // Reference-shaped names are not secrets.
    expect(scanGuiStateForSecrets({ relayCredentialRef: "entry-gui.relay.conn.1", keyId: "rckey.1", publicKey: "pub", endpointSpkiPin: "p" })).toHaveLength(0);
  });

  it("assertGuiStateSecretFree throws before a poisoned snapshot could be emitted", () => {
    const poisoned = {
      schemaVersion: GUI_STATE_SCHEMA_VERSION,
      recoveryText: "mrk1-aaaaa-bbbbb"
    };
    expect(() => assertGuiStateSecretFree(poisoned as unknown as GuiState)).toThrow(/secret/i);
  });
});

describe("restoreGuiState", () => {
  it("rebuilds connections + recovery from persisted non-secret config", () => {
    const model = new EntryGuiModel();
    const state = restoreGuiState(model, {
      appVersion: "9.9.9",
      custody: { tier: "file", available: true, reason: "test" },
      lifecycle: {
        state: "ready",
        dataDir: "/data",
        configPath: "/data/entry-gui.config.json",
        ownedPaths: ["/data"],
        updatePolicy: "manual"
      },
      connections: [connectionFixture()],
      recovery: {
        vaultId: "vault.gui.1",
        keyId: "rckey.gui.1",
        generation: 2,
        backup: { lastSuccessAt: "2026-01-02T00:00:00Z", lastCommittedRevision: 7, lastError: null }
      },
      mcp: { snippet: "{\"mcpServers\":{}}", configuredPath: "/data/mcp/meshrix-entry.mcp.json" }
    });
    expect(state.appVersion).toBe("9.9.9");
    expect(state.custody.tier).toBe("file");
    expect(state.connections).toHaveLength(1);
    expect(state.recovery.state).toBe("ready");
    // A restored key was already saved — it is never re-shown.
    expect(state.recovery.keyRevealed).toBe(false);
    expect(state.recovery.backup.lastCommittedRevision).toBe(7);
    expect(state.mcp.configuredPath).toBe("/data/mcp/meshrix-entry.mcp.json");
    expect(scanGuiStateForSecrets(state)).toHaveLength(0);
  });

  it("restores an in-flight rotation as pending", () => {
    const model = new EntryGuiModel();
    const state = restoreGuiState(model, {
      appVersion: "9.9.9",
      custody: { tier: "file", available: true, reason: "test" },
      lifecycle: { state: "ready", dataDir: "/d", configPath: "/d/c.json", ownedPaths: [], updatePolicy: "manual" },
      connections: [],
      recovery: {
        vaultId: "v", keyId: "k", generation: 1,
        rotation: {
          rotationId: "rot.1", state: "published", candidateGeneration: 2,
          endpoints: [{ endpointRouteId: "route.gui.1", state: "pending" }]
        }
      }
    });
    expect(state.recovery.state).toBe("rotation_pending");
    expect(state.recovery.rotation?.rotationId).toBe("rot.1");
  });
});
