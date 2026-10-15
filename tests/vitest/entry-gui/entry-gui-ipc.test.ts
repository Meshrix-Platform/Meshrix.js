/**
 * Entry product service API tests — the trusted backend composition,
 * exercised end-to-end through `dispatch` and over the real loopback HTTP
 * transport (`loopback-server.ts` + `loopback-client.ts`).
 *
 * These tests pin the security boundary the Tauri shell relies on:
 *   - every emitted snapshot passes the secret-free scan;
 *   - the one-shot recovery reveal contract;
 *   - relay credentials/device keys live only in custody;
 *   - revocation honestly distinguishes applied vs pending;
 *   - config persistence carries no secret material;
 *   - the loopback API enforces the closed op allowlist and the per-launch
 *     bearer token — off-allowlist ops and bad/missing auth never reach
 *     dispatch.
 */
import { mkdir, mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

import {
  FileCustodyAdapter,
  deriveRecoveryMaterial,
  deviceIdentityFromCustody,
  encodePairingInvite,
  parseRecoveryText,
  type CustodyAdapter,
  type RecoveryMaterial,
  type VaultTransport
} from "@meshrix/entry";
import {
  EntryConfigStore,
  EntryProductService,
  GUI_OPS,
  GuiLoopbackClient,
  assertGuiStateSecretFree,
  createEntryGuiLoopbackServer,
  guiBridgeConfig,
  managedMcpConfigPath,
  scanGuiStateForSecrets,
  type EntryGuiLoopbackServer,
  type GuiOp,
  type GuiState,
  type PairingChannelLike,
  type RecoveryChannelLike
} from "@meshrix/entry-gui";

import { FakeVault } from "../entry/helpers.ts";
import {
  FakePairingChannel,
  FakeSession,
  FakeTransport,
  PRINCIPAL,
  ROUTE,
  TENANT,
  VAULT_ID,
  GUI_TEST_RELAY_ADMISSION,
  pairingAccountFetch,
  serviceConfigFixture,
  seedGuiTestAccount,
  testOsCustody,
  inviteFixture,
  waitFor,
  type FakePairingBehavior
} from "./helpers.ts";

const dirs: string[] = [];
const liveServices: EntryProductService[] = [];
const liveServers: EntryGuiLoopbackServer[] = [];
afterEach(async () => {
  // Stop before teardown: service.stop() now drains the config write queue, and
  // fire-and-forget refreshes/publishes settle on the fake surfaces quickly.
  for (const server of liveServers.splice(0)) await server.close().catch(() => undefined);
  for (const service of liveServices.splice(0)) await service.stop().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 60));
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/** Serve one service over the real loopback transport with a fresh token. */
async function makeLoopback(service: EntryProductService): Promise<{ client: GuiLoopbackClient; server: EntryGuiLoopbackServer; token: string }> {
  const token = randomBytes(24).toString("hex");
  const server = createEntryGuiLoopbackServer({ service, token });
  await server.listen();
  liveServers.push(server);
  return { client: new GuiLoopbackClient(guiBridgeConfig({ port: server.port, token })), server, token };
}

function verifierOf(material: RecoveryMaterial) {
  return { keyId: material.signing.keyId, algorithm: "Ed25519" as const, publicKey: material.signing.publicKey };
}
function writerOf(material: RecoveryMaterial) {
  return { keyId: material.writer.keyId, algorithm: "Ed25519" as const, publicKey: material.writer.publicKey };
}

interface SeededService {
  service: EntryProductService;
  dir: string;
  custody: CustodyAdapter;
  channel: FakePairingChannel;
  vault: FakeVault;
  sessions: FakeSession[];
  transports: FakeTransport[];
  recoveryChannels: SilentRecoveryChannel[];
  nowRef: { now: number };
}

async function makeService(options: {
  behavior?: FakePairingBehavior;
  sessionConnect?: "establish" | "fail" | "hang";
  withVault?: boolean;
  dataDir?: string;
  wrapSecret?: Uint8Array;
  custodyTier?: "os" | "file";
  /** Share a vault across installs — snapshots outlive a lost device. */
  vault?: FakeVault;
} = {}): Promise<SeededService> {
  const dir = options.dataDir ?? await mkdtemp(path.join(tmpdir(), "entry-gui-ipc-"));
  dirs.push(dir);
  const wrapSecret = options.wrapSecret ?? randomBytes(32);
  const backingCustody = new FileCustodyAdapter({ dataDir: dir, wrapSecret });
  const custody: CustodyAdapter = options.custodyTier === "file"
    ? backingCustody
    : testOsCustody(backingCustody);
  const channel = new FakePairingChannel(options.behavior ?? { relayCredential: GUI_TEST_RELAY_ADMISSION });
  const vault = options.vault ?? new FakeVault({
    vaultId: VAULT_ID,
    verifier: { keyId: "rckey.unset", algorithm: "Ed25519", publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    writers: []
  });
  const sessions: FakeSession[] = [];
  const transports: FakeTransport[] = [];
  const recoveryChannels: SilentRecoveryChannel[] = [];
  const nowRef = { now: 1_800_000_000_000 };
  if (options.custodyTier !== "file") {
    await seedGuiTestAccount(dir, custody);
  }
  const service = new EntryProductService({
    dataDir: dir,
    appVersion: "1.2.3",
    appExePath: "meshrix-entry-test",
    custody,
    serviceConfig: serviceConfigFixture("https://account.gui.invalid"),
    accountFetch: pairingAccountFetch({
      accountOrigin: "https://account.gui.invalid",
      relayAdmission: options.behavior?.relayCredential,
      resolveDevicePublicKey: (deviceId) => channel.pairedTargets.get(deviceId)?.devicePublicKey ?? null,
      writerGeneration: () => vault.current ? vault.generation + 1 : vault.generation,
      onVaultWriterRotationComplete: (target) => {
        const rotation = target.vaultWriterRotation;
        if (!rotation) return;
        vault.recoveryVerifier = rotation.recoveryVerifier;
        vault.writers = [...rotation.writers];
        vault.generation = rotation.generation;
      },
      revokeEnforcement: options.behavior?.revoked ? "complete" : "pending",
      failDeviceRevoke: options.behavior?.throwOnRevoke === true
    }),
    now: () => nowRef.now,
    pairingChannelFactory: () => channel,
    pairingRelayChannelFactory: () => channel,
    vaultTransportFactory: (): VaultTransport => vault,
    recoveryChannelFactory: () => {
      const created = new SilentRecoveryChannel();
      recoveryChannels.push(created);
      return created;
    },
    sessionFactory: () => {
      const session = new FakeSession(options.sessionConnect ?? "establish");
      sessions.push(session);
      return session;
    },
    transportFactory: () => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    },
    connectTimeoutMs: 250
  });
  liveServices.push(service);
  return { service, dir, custody, channel, vault, sessions, transports, recoveryChannels, nowRef };
}

/**
 * A recovery channel whose endpoint stays silent: round trips never resolve
 * until the channel closes — mirroring the real contract where silence is a
 * pending exchange, never a fabricated failure.
 */
class SilentRecoveryChannel implements RecoveryChannelLike {
  readonly #pending = new Set<(error: unknown) => void>();
  #closed = false;
  get inflight(): number { return this.#pending.size; }
  async open(): Promise<void> {
    if (this.#closed) throw Object.assign(new Error("channel closed"), { code: "entry_session_closed" });
  }
  roundTrip(): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(Object.assign(new Error("channel closed"), { code: "entry_session_closed" }));
    }
    return new Promise<unknown>((_resolve, reject) => { this.#pending.add(reject); });
  }
  close(): void {
    this.#closed = true;
    const error = Object.assign(new Error("channel closed"), { code: "entry_session_closed" });
    for (const reject of this.#pending) reject(error);
    this.#pending.clear();
  }
}

const INVITE_TEXT = encodePairingInvite(inviteFixture());

/** Full seed: start → pairing submit+confirm → enrolled connection. */
async function seedConnection(seeded: SeededService): Promise<string> {
  await seeded.service.start();
  const submitted = await seeded.service.dispatch("pairing.submitInvite", { inviteText: INVITE_TEXT });
  expect(submitted).toMatchObject({ ok: true });
  const state = (submitted as { value: GuiState }).value;
  expect(state.pairing.phase).toBe("challenge_issued");
  const confirmed = await seeded.service.dispatch("pairing.confirm");
  expect(confirmed.ok).toBe(true);
  expect((confirmed as { value: GuiState }).value.pairing.phase).toBe("authorization_required");
  const completed = await seeded.service.dispatch("pairing.continue");
  expect(completed.ok).toBe(true);
  const done = (completed as { value: GuiState }).value;
  expect(done.pairing.phase).toBe("enrolled");
  const connectionId = done.pairing.enrolledConnectionId;
  expect(connectionId).toBeTruthy();
  return connectionId as string;
}

/** Seed + one-shot recovery key saved → vault writer wired → committed snapshot. */
async function seedRecovery(seeded: SeededService): Promise<{ recoveryText: string; material: RecoveryMaterial }> {
  const begun = await seeded.service.dispatch("recovery.beginSetup");
  expect(begun.ok).toBe(true);
  const revealed = await seeded.service.dispatch("recovery.revealKey");
  expect(revealed.ok).toBe(true);
  const reveal = (revealed as { value: { recoveryText: string; vaultId: string; keyId: string } }).value;
  const material = deriveRecoveryMaterial(parseRecoveryText(reveal.recoveryText).secret);
  seeded.vault.recoveryVerifier = verifierOf(material);
  seeded.vault.writers = [writerOf(material)];
  const saved = await seeded.service.dispatch("recovery.confirmSaved");
  expect(saved.ok, saved.ok ? "" : `${saved.error.code}: ${saved.error.message}`).toBe(true);
  const registered = await seeded.service.dispatch("account.checkTransaction");
  expect(registered.ok, registered.ok ? "" : `${registered.error.code}: ${registered.error.message}`).toBe(true);
  expect((registered as { value: GuiState }).value.recovery.state).toBe("ready");
  return { recoveryText: reveal.recoveryText, material };
}

describe("config store durability", () => {
  it("a failed write rejects for its caller but never poisons the queue", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "entry-gui-store-"));
    dirs.push(dir);
    const store = new EntryConfigStore({ dataDir: dir });
    await store.load();
    // Block rename by occupying the config path with a directory.
    await mkdir(store.filePath, { recursive: true });
    const failed = store.update((draft) => ({ ...draft, pairingServiceDefault: "https://a.invalid" }));
    await expect(failed).rejects.toThrow();
    await rmdir(store.filePath);
    // The next update still runs and persists — the queue survives failures.
    await store.update((draft) => ({ ...draft, pairingServiceDefault: "https://b.invalid" }));
    const reloaded = new EntryConfigStore({ dataDir: dir });
    expect((await reloaded.load()).pairingServiceDefault).toBe("https://b.invalid");
  });
});

describe("loopback api contract — auth and allowlist", () => {
  it("rejects requests without the per-launch bearer token before touching the service", async () => {
    const seeded = await makeService();
    await seeded.service.start();
    const { server, token } = await makeLoopback(seeded.service);
    const url = `http://127.0.0.1:${server.port}/meshrix-entry`;

    const noAuth = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "state.get" }) });
    expect(noAuth.status).toBe(401);
    const wrongAuth = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${"wrong-token-wrong-token"}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "state.get" })
    });
    expect(wrongAuth.status).toBe(401);
    // Authenticated but off-contract routes answer 404; GET is refused.
    const badRoute = await fetch(`http://127.0.0.1:${server.port}/meshrix-entry/other`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}"
    });
    expect(badRoute.status).toBe(404);
    const wrongMethod = await fetch(url, { method: "GET", headers: { authorization: `Bearer ${token}` } });
    expect(wrongMethod.status).toBe(405);
  });

  it("denies ops outside the contract allowlist over the wire", async () => {
    const seeded = await makeService();
    await seeded.service.start();
    const { client } = await makeLoopback(seeded.service);
    const denied = await client.invoke("not.an.op" as GuiOp);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("ipc_op_denied");
  });

  it("dispatches every allowlisted op over real HTTP to a structured result", async () => {
    const seeded = await makeService();
    await seeded.service.start();
    const { client } = await makeLoopback(seeded.service);
    for (const op of GUI_OPS) {
      const result = await client.invoke(op, {});
      expect(typeof result.ok).toBe("boolean");
      if (!result.ok) {
        expect(result.error.code).toMatch(/^[a-z_]+$/u);
        expect(result.error.code).not.toBe("unexpected");
      }
    }
  });

  it("pushes redacted snapshots through the long-poll state route", async () => {
    const seeded = await makeService();
    await seeded.service.start();
    const { client } = await makeLoopback(seeded.service);
    const seen: GuiState[] = [];
    const unsubscribe = client.subscribeState((state) => {
      seen.push(state);
    });
    try {
      // The first poll (after: 0) returns the current snapshot immediately.
      await waitFor(() => seen.length >= 1, 5_000);
      const baseline = seen.length;
      await seeded.service.dispatch("pairing.submitInvite", { inviteText: INVITE_TEXT });
      await waitFor(() => seen.length > baseline && seen[seen.length - 1].pairing.phase === "challenge_issued", 5_000);
      for (const state of seen) assertGuiStateSecretFree(state);
    } finally {
      unsubscribe();
    }
  });

  it("dispatches every allowlisted op to a structured result", async () => {
    const seeded = await makeService();
    await seeded.service.start();
    for (const op of GUI_OPS) {
      const result = await seeded.service.dispatch(op as GuiOp, {});
      expect(typeof result.ok).toBe("boolean");
      if (!result.ok) {
        expect(result.error.code).toMatch(/^[a-z_]+$/u);
        expect(result.error.code).not.toBe("unexpected");
      }
    }
  });

  it("returns an ipc-shaped error for an unknown op", async () => {
    const seeded = await makeService();
    await seeded.service.start();
    const result = await seeded.service.dispatch("not.an.op" as GuiOp);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unexpected");
  });
});

describe("product service — start/stop honesty", () => {
  it("starts with file custody tier reported honestly, lifecycle ready", async () => {
    const seeded = await makeService({ custodyTier: "file" });
    const state = await seeded.service.start();
    expect(state.appVersion).toBe("1.2.3");
    expect(state.custody.available).toBe(true);
    expect(state.custody.tier).toBe("file");
    expect(state.lifecycle.state).toBe("ready");
    expect(state.lifecycle.dataDir).toBe(seeded.dir);
    expect(state.lifecycle.configPath).toBe(path.join(seeded.dir, "entry-gui.config.json"));
    expect(state.lifecycle.ownedPaths).toContain(seeded.dir);
    expect(state.recovery.state).toBe("not_configured");
    assertGuiStateSecretFree(state);
    await seeded.service.stop();
    expect(seeded.service.snapshot().lifecycle.state).toBe("stopped");
  });

  it("refuses ops before start with a typed state error", async () => {
    const seeded = await makeService();
    const result = await seeded.service.dispatch("pairing.submitInvite", { inviteText: INVITE_TEXT });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("recovery_state_invalid");
  });
});

describe("pairing", () => {
  it("submits a valid invite → challenge_issued with the device fingerprint; invite fields verbatim", async () => {
    const seeded = await makeService();
    await seeded.service.start();
    const result = await seeded.service.dispatch("pairing.submitInvite", { inviteText: INVITE_TEXT });
    expect(result.ok).toBe(true);
    const state = (result as { value: GuiState }).value;
    expect(state.pairing.phase).toBe("challenge_issued");
    expect(state.pairing.deviceFingerprint).toMatch(/^fp\./u);
    expect(state.pairing.invite?.endpointPrincipalRef).toBe(PRINCIPAL);
    expect(state.pairing.invite?.endpointSpkiPin).toBe("spki.gui.endpoint.pin");
    expect(state.pairing.invite?.endpointRouteId).toBe(ROUTE);
  });

  it("enrolls on explicit confirm: connection + trust display + custody-held credential", async () => {
    const seeded = await makeService();
    const connectionId = await seedConnection(seeded);
    const state = seeded.service.snapshot();
    const connection = state.connections.find((c) => c.connectionId === connectionId);
    expect(connection).toBeTruthy();
    expect(connection!.endpointPrincipalRef).toBe(PRINCIPAL);
    expect(connection!.endpointSpkiPin).toBe("spki.gui.endpoint.pin");
    expect(connection!.deviceFingerprint).toMatch(/^fp\./u);
    expect(connection!.routeId).toBe(ROUTE);
    expect(connection!.vaultId).toBe(VAULT_ID);

    // The relay credential and device key are in custody — never in state/config.
    const storedSecret = await seeded.custody.loadSecret({ ref: `entry-gui.relay.${connectionId}` });
    expect(storedSecret).not.toBeNull();
    expect(new TextDecoder().decode(storedSecret!)).toBe(GUI_TEST_RELAY_ADMISSION);
    const configText = await readFile(path.join(seeded.dir, "entry-gui.config.json"), "utf8");
    expect(configText).not.toContain(GUI_TEST_RELAY_ADMISSION);
    expect(configText).not.toContain("mrk1-");
    expect(configText).not.toContain("MC4CAQAwBQYDK2Vw");
    expect(configText).not.toContain("pt.gui.one-time");
    assertGuiStateSecretFree(state);
  });

  it("pairing.refused at begin projects refused; offline projects offline", async () => {
    const refused = await makeService({ behavior: { failBegin: "refused", refuseBegin: "invite_token_invalid" } });
    await refused.service.start();
    let result = await refused.service.dispatch("pairing.submitInvite", { inviteText: INVITE_TEXT });
    expect(result.ok).toBe(true);
    let state = (result as { value: GuiState }).value;
    expect(state.pairing.phase).toBe("refused");
    expect(state.pairing.refusal).toBe("invite_token_invalid");

    const offline = await makeService({ behavior: { failBegin: "unreachable" } });
    await offline.service.start();
    result = await offline.service.dispatch("pairing.submitInvite", { inviteText: INVITE_TEXT });
    expect(result.ok).toBe(true);
    state = (result as { value: GuiState }).value;
    expect(state.pairing.phase).toBe("offline");
    expect(state.connections).toHaveLength(0);
  });

  it("rejects malformed and expired invites distinctly", async () => {
    const seeded = await makeService();
    await seeded.service.start();
    let result = await seeded.service.dispatch("pairing.submitInvite", { inviteText: "not an invite" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("pairing_invite_invalid");
    result = await seeded.service.dispatch("pairing.submitInvite", {
      inviteText: encodePairingInvite(inviteFixture({ issuedAt: "2020-01-01T00:00:00Z", expiresAt: "2020-06-01T00:00:00Z" }))
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("pairing_expired");
  });

  it("confirm without a pending session is a typed state error; cancel and reset work", async () => {
    const seeded = await makeService();
    await seeded.service.start();
    const noSession = await seeded.service.dispatch("pairing.confirm");
    expect(noSession.ok).toBe(false);
    if (!noSession.ok) expect(noSession.error.code).toBe("pairing_state_invalid");

    await seeded.service.dispatch("pairing.submitInvite", { inviteText: INVITE_TEXT });
    const cancelled = await seeded.service.dispatch("pairing.cancel");
    expect(cancelled.ok).toBe(true);
    expect((cancelled as { value: GuiState }).value.pairing.phase).toBe("cancelled");

    await seeded.service.dispatch("pairing.submitInvite", { inviteText: INVITE_TEXT });
    const reset = await seeded.service.dispatch("pairing.reset");
    expect(reset.ok).toBe(true);
    expect((reset as { value: GuiState }).value.pairing.phase).toBe("idle");
  });
});

describe("recovery — one-shot reveal and encrypted backup", () => {
  it("generates, reveals exactly once, and commits the first snapshot", async () => {
    const seeded = await makeService();
    await seedConnection(seeded);
    const { recoveryText, material } = await seedRecovery(seeded);

    const state = seeded.service.snapshot();
    expect(state.recovery.state).toBe("ready");
    expect(state.recovery.vaultId).toBe(VAULT_ID);
    expect(state.recovery.keyId).toBe(material.signing.keyId);
    expect(state.recovery.generation).toBe(1);
    // The one-time confirmation clears the transient reveal indicator after
    // saving the account-managed writer; the recovery secret is never retained in UI state.
    expect(state.recovery.keyRevealed).toBe(false);
    // The vault accepted and committed the signed/encrypted snapshot.
    expect(seeded.vault.current?.revision).toBe(1);
    expect(state.recovery.backup.lastCommittedRevision).toBe(1);
    expect(state.recovery.backup.lastError).toBeNull();
    // The recovery text itself never lands in config.
    const configText = await readFile(path.join(seeded.dir, "entry-gui.config.json"), "utf8");
    expect(configText).not.toContain(recoveryText);
    expect(configText).not.toContain("mrk1-");
    assertGuiStateSecretFree(state);
  });

  it("revealing twice and confirming before reveal are typed state errors", async () => {
    const seeded = await makeService();
    await seedConnection(seeded);
    await seeded.service.dispatch("recovery.beginSetup");
    const premature = await seeded.service.dispatch("recovery.confirmSaved");
    expect(premature.ok).toBe(false);
    if (!premature.ok) expect(premature.error.code).toBe("recovery_state_invalid");

    const first = await seeded.service.dispatch("recovery.revealKey");
    expect(first.ok).toBe(true);
    const second = await seeded.service.dispatch("recovery.revealKey");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("recovery_state_invalid");
    // Still confirmable — the window stays open after reveal.
    const saved = await seeded.service.dispatch("recovery.confirmSaved");
    expect(saved.ok).toBe(true);
  });

  it("expires the pending save window honestly", async () => {
    const seeded = await makeService();
    await seedConnection(seeded);
    await seeded.service.dispatch("recovery.beginSetup");
    seeded.nowRef.now += 11 * 60_000; // past the 10-minute save window
    const result = await seeded.service.dispatch("recovery.revealKey");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("recovery_state_invalid");
    // A fresh key can be generated after expiry.
    const again = await seeded.service.dispatch("recovery.beginSetup");
    expect(again.ok).toBe(true);
    expect((again as { value: GuiState }).value.recovery.state).toBe("awaiting_save");
  });

  it("refuses a second setup once a key is configured — rotation is the path", async () => {
    const seeded = await makeService();
    await seedConnection(seeded);
    await seedRecovery(seeded);
    const again = await seeded.service.dispatch("recovery.beginSetup");
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("recovery_state_invalid");
  });
});

describe("recovery rotation lifecycle", () => {
  it("keeps a confirmed account-managed writer registration exclusive until approval", async () => {
    const seeded = await makeService();
    await seedConnection(seeded);
    const { material: incumbent } = await seedRecovery(seeded);
    const begun = await seeded.service.dispatch("recovery.beginRotation");
    expect(begun.ok).toBe(true);
    let state = (begun as { value: GuiState }).value;
    expect(state.recovery.state).toBe("awaiting_save");
    expect(state.recovery.generation).toBe(2);
    expect(state.recovery.rotation).toBeNull();

    const revealed = await seeded.service.dispatch("recovery.revealKey");
    expect(revealed.ok).toBe(true);
    const recoveryText = (revealed as { value: { recoveryText: string } }).value.recoveryText;
    const candidate = deriveRecoveryMaterial(parseRecoveryText(recoveryText).secret);
    const confirmed = await seeded.service.dispatch("recovery.confirmSaved");
    expect(confirmed.ok).toBe(true);
    state = (confirmed as { value: GuiState }).value;
    expect(state.recovery.state).toBe("account_authorization_required");
    expect(state.recovery.writerRegistration.state).toBe("authorization_required");
    expect(state.recovery.writerRegistration.candidateGeneration).toBe(2);
    expect(seeded.vault.generation).toBe(1);
    expect(seeded.vault.writers.map((writer) => writer.keyId)).toContain(incumbent.writer.keyId);
    expect(seeded.vault.writers.map((writer) => writer.keyId)).not.toContain(candidate.writer.keyId);

    const blocked = await seeded.service.dispatch("recovery.beginRotation");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("account_transaction_pending");

    const approved = await seeded.service.dispatch("account.checkTransaction");
    expect(approved.ok).toBe(true);
    state = (approved as { value: GuiState }).value;
    expect(state.recovery.state).toBe("ready");
    expect(state.recovery.keyId).toBe(candidate.signing.keyId);
    expect(state.recovery.generation).toBe(2);
    expect(state.recovery.writerRegistration.state).toBe("complete");
    expect(seeded.vault.generation).toBe(2);
  });

  it("abortRotation is a typed error when nothing is in flight", async () => {
    const seeded = await makeService();
    await seedConnection(seeded);
    await seedRecovery(seeded);
    const result = await seeded.service.dispatch("recovery.abortRotation");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("rotation_state_invalid");
  });

  it("an expired save window aborts the bound rotation instead of deadlocking", async () => {
    const seeded = await makeService();
    await seedConnection(seeded);
    await seedRecovery(seeded);
    const begun = await seeded.service.dispatch("recovery.beginRotation");
    expect(begun.ok).toBe(true);
    seeded.nowRef.now += 11 * 60_000; // past the 10-minute save window
    const revealed = await seeded.service.dispatch("recovery.revealKey");
    expect(revealed.ok).toBe(false);
    if (!revealed.ok) expect(revealed.error.code).toBe("recovery_state_invalid");
    // The expired candidate is gone — the rotation record is aborted, not stuck.
    const restarted = await seeded.service.dispatch("recovery.beginRotation");
    expect(restarted.ok).toBe(true);
  });

  it("a restart drops an unsaved account-managed candidate and keeps the active recovery", async () => {
    const wrapSecret = randomBytes(32);
    const seeded = await makeService({ wrapSecret });
    await seedConnection(seeded);
    const { material: incumbent } = await seedRecovery(seeded);
    const begun = await seeded.service.dispatch("recovery.beginRotation");
    expect(begun.ok).toBe(true);
    const candidate = (begun as { value: GuiState }).value.recovery;
    expect(candidate.state).toBe("awaiting_save");
    expect(candidate.generation).toBe(2);
    expect(candidate.keyId).not.toBe(incumbent.signing.keyId);
    await seeded.service.stop();

    // The account-managed candidate is memory-only until it is saved and the
    // exact writer operation is persisted. Restart keeps the active recovery
    // material and vault contents, then permits a fresh candidate.
    const restored = await makeService({ dataDir: seeded.dir, wrapSecret, vault: seeded.vault });
    const state = await restored.service.start();
    expect(state.recovery.state).toBe("ready");
    expect(state.recovery.keyId).toBe(incumbent.signing.keyId);
    expect(state.recovery.generation).toBe(1);
    expect(state.recovery.rotation).toBeNull();
    const restarted = await restored.service.dispatch("recovery.beginRotation");
    expect(restarted.ok).toBe(true);
    const rotating = (restarted as { value: GuiState }).value;
    expect(rotating.recovery.state).toBe("awaiting_save");
    expect(rotating.recovery.rotation).toBeNull();
    expect(rotating.recovery.generation).toBe(2);
    expect(rotating.recovery.keyId).not.toBe(candidate.keyId);
    expect(seeded.vault.current?.generation).toBe(1);
  });
});

describe("fresh-install recovery import", () => {
  it("rejects junk recovery text without endpoint contact", async () => {
    const seeded = await makeService();
    await seeded.service.start();
    const result = await seeded.service.dispatch("recovery.importText", { recoveryText: "mrk1-aaaaa" });
    expect(result.ok).toBe(true);
    expect((result as { value: GuiState }).value.recoveryImport.phase).toBe("error");
  });

  it("needs a service locator on a cold profile", async () => {
    const seeded = await makeService();
    await seeded.service.start();
    const { generateRecoveryKey, formatRecoveryText } = await import("@meshrix/entry");
    const text = formatRecoveryText(generateRecoveryKey({ vaultId: VAULT_ID }));
    const result = await seeded.service.dispatch("recovery.importText", { recoveryText: text });
    expect(result.ok).toBe(true);
    const state = (result as { value: GuiState }).value;
    expect(state.recoveryImport.phase).toBe("error");
    expect(state.recoveryImport.detail).toBe("recovery_locator_missing");
  });

  it("reports snapshot_missing when the vault has nothing", async () => {
    // Seed a vault on service A so the locator + channel exist, then import on
    // a FRESH install (service B) — empty vault → snapshot_missing.
    const seededA = await makeService({ behavior: { relayCredential: GUI_TEST_RELAY_ADMISSION } });
    await seedConnection(seededA);
    const { recoveryText } = await seedRecovery(seededA);
    seededA.vault.current = null; // simulates a wiped/missing snapshot

    const seededB = await makeService({
      vault: seededA.vault,
      behavior: {
        relayCredential: "relay.cred.fresh",
        recoveryAccess: {
          deviceId: "dev.entry.fresh.1",
          relayCredential: "relay.cred.fresh",
          tenantId: TENANT,
          routeId: ROUTE,
          admissionGeneration: 1,
          revocationRevision: 0
        }
      }
    });
    await seededB.service.start();
    const result = await seededB.service.dispatch("recovery.importText", {
      recoveryText,
      serviceUrl: "https://endpoint.gui.invalid"
    });
    expect(result.ok).toBe(true);
    expect((result as { value: GuiState }).value.recoveryImport.phase).toBe("snapshot_missing");
    expect(seededB.channel.recoveryAccessCalls).toEqual([VAULT_ID]);
  });

  it("reports endpoint silence as an error, never as success", async () => {
    const seededA = await makeService();
    await seedConnection(seededA);
    const { recoveryText } = await seedRecovery(seededA);

    const seededB = await makeService({
      vault: seededA.vault,
      behavior: {
        recoveryAccess: {
          deviceId: "dev.entry.fresh.1",
          relayCredential: "relay.cred.fresh",
          tenantId: TENANT,
          routeId: ROUTE,
          admissionGeneration: 1,
          revocationRevision: 0
        }
      }
    });
    await seededB.service.start();
    // The injected recoveryChannelFactory returns a silent channel — silence
    // is never proof of failure, so the import stays honestly "working" while
    // the exchange is in flight; it settles only when the channel dies.
    const inflight = seededB.service.dispatch("recovery.importText", {
      recoveryText,
      serviceUrl: "https://endpoint.gui.invalid"
    });
    await waitFor(() => seededB.service.snapshot().recoveryImport.phase === "working", 5_000);
    // Wait until the exchange is genuinely in-flight on the channel, so the
    // shutdown exercises the settle-on-close path deterministically.
    await waitFor(() => seededB.recoveryChannels.some((c) => c.inflight > 0), 5_000);
    await seededB.service.stop();
    const result = await inflight;
    expect(result.ok).toBe(true);
    const state = (result as { value: GuiState }).value;
    expect(state.recoveryImport.phase).toBe("error");
    expect(state.recoveryImport.detail).toBe("entry_session_closed");
    expect(state.connections).toHaveLength(0);
  });
});

describe("connection lifecycle and revocation", () => {
  it("refreshConnection reports the live session's channel honestly", async () => {
    const seeded = await makeService();
    const connectionId = await seedConnection(seeded);
    await waitFor(() =>
      seeded.service.snapshot().connections[0]?.channelEstablished === true, 5_000);
    const state = seeded.service.snapshot();
    expect(state.connections[0]?.routeState).toBe("reachable");
    expect(state.connections[0]?.acceptsNewWork).toBe(true);
    await seeded.service.dispatch("connection.refresh", { connectionId });
    await waitFor(() => seeded.sessions.length >= 2, 5_000);
    await waitFor(() => seeded.service.snapshot().connections[0]?.channelEstablished === true, 5_000);
  });

  it("a failed connect never claims an established channel", async () => {
    const seeded = await makeService({ sessionConnect: "fail" });
    const connectionId = await seedConnection(seeded);
    await waitFor(() =>
      seeded.service.snapshot().notices.some((note) => note.includes("did not establish")), 5_000);
    const state = seeded.service.snapshot();
    expect(state.connections[0]?.channelEstablished).toBe(false);
    expect(state.connections[0]?.acceptsNewWork).toBe(false);
    await seeded.service.dispatch("connection.refresh", { connectionId });
    await waitFor(() => seeded.service.snapshot().notices.filter((n) => n.includes("did not establish")).length >= 2, 5_000);
  });

  it("rejects an account bootstrap without relay admission before creating a connection", async () => {
    const seeded = await makeService({ behavior: { relayCredential: null } });
    await seeded.service.start();
    const result = await seeded.service.dispatch("pairing.submitInvite", { inviteText: INVITE_TEXT });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("account_bootstrap_invalid");
    expect(seeded.service.snapshot().connections).toHaveLength(0);
  });

  it("remote revocation reports applied only after the account authority commits it", async () => {
    const applied = await makeService({ behavior: { relayCredential: GUI_TEST_RELAY_ADMISSION, revoked: true } });
    const connectionId = await seedConnection(applied);
    const deviceId = applied.service.snapshot().connections[0]!.deviceId;
    // Custody held the credential + device key before revocation.
    expect(await applied.custody.loadSecret({ ref: `entry-gui.relay.${connectionId}` })).not.toBeNull();
    expect(await deviceIdentityFromCustody({ custody: applied.custody, deviceId })).not.toBeNull();

    const result = await applied.service.dispatch("connection.revoke", { connectionId, remote: true });
    expect(result.ok).toBe(true);
    const state = (result as { value: GuiState }).value;
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0]?.revocation).toBe("remote_applied");
    expect(state.connections[0]?.rePairRequired).toBe(true);
    expect(applied.channel.revokeCalls).toEqual([]);
    // Local task history, pairing details and custody keys remain available for recovery.
    expect(await applied.custody.loadSecret({ ref: `entry-gui.relay.${connectionId}` })).not.toBeNull();
    expect(await deviceIdentityFromCustody({ custody: applied.custody, deviceId })).not.toBeNull();
    expect(JSON.parse(await readFile(path.join(applied.dir, "entry-gui.config.json"), "utf8"))
      .connections[0].routeRevocation.authorityRevoked).toBe(true);
  });

  it("remote revocation stays honestly pending on silence or transport failure", async () => {
    const pending = await makeService({ behavior: { relayCredential: GUI_TEST_RELAY_ADMISSION, revoked: false } });
    const connectionId = await seedConnection(pending);
    const result = await pending.service.dispatch("connection.revoke", { connectionId, remote: true });
    expect(result.ok).toBe(true);
    expect((result as { value: GuiState }).value.connections[0]?.revocation).toBe("enforcement_pending");

    const unreachable = await makeService({ behavior: { relayCredential: GUI_TEST_RELAY_ADMISSION, throwOnRevoke: true } });
    const otherId = await seedConnection(unreachable);
    const second = await unreachable.service.dispatch("connection.revoke", { connectionId: otherId, remote: true });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("account_service_unreachable");
    expect(unreachable.service.snapshot().connections[0]?.revocation).toBe("authority_pending");
  });

  it("revoking an unknown connection is a typed error", async () => {
    const seeded = await makeService();
    await seeded.service.start();
    const result = await seeded.service.dispatch("connection.revoke", { connectionId: "conn.ghost" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("device_record_invalid");
  });
});

describe("mcp setup", () => {
  it("emits a standard stdio mcpServers snippet and writes it only under the data dir", async () => {
    const seeded = await makeService();
    await seeded.service.start();
    const snippetResult = await seeded.service.dispatch("mcp.snippet");
    expect(snippetResult.ok).toBe(true);
    const snippet = (snippetResult as { value: { snippet: string } }).value.snippet;
    const parsed = JSON.parse(snippet) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(parsed.mcpServers["meshrix-entry"].command).toBe("meshrix-entry-test");
    expect(parsed.mcpServers["meshrix-entry"].args).toContain("--mcp-stdio");

    const written = await seeded.service.dispatch("mcp.writeConfig");
    expect(written.ok).toBe(true);
    const managedPath = (written as { value: { managedPath: string } }).value.managedPath;
    expect(managedPath).toBe(managedMcpConfigPath(seeded.dir));
    expect(managedPath.startsWith(seeded.dir)).toBe(true);
    const fileText = await readFile(managedPath, "utf8");
    expect(JSON.parse(fileText)).toEqual(parsed);
    // The managed file appears in ownedPaths — uninstall removes it.
    const owned = await seeded.service.dispatch("lifecycle.ownedPaths");
    expect(owned.ok).toBe(true);
    const paths = (owned as { value: { ownedPaths: string[] } }).value.ownedPaths;
    expect(paths).toContain(seeded.dir);
    expect(paths).toContain(managedPath);
  });
});

describe("restart persistence", () => {
  it("restores connections and recovery bookkeeping on a fresh service start", async () => {
    const wrapSecret = randomBytes(32);
    const seededA = await makeService({ wrapSecret });
    const connectionId = await seedConnection(seededA);
    const { material } = await seedRecovery(seededA);
    await seededA.service.stop();

    const seededB = await makeService({ dataDir: seededA.dir, wrapSecret });
    const restored = await seededB.service.start();
    expect(restored.connections).toHaveLength(1);
    expect(restored.connections[0]?.connectionId).toBe(connectionId);
    expect(restored.connections[0]?.routeState).toBe("unknown");
    expect(restored.connections[0]?.channelEstablished).toBe(false);
    expect(restored.recovery.state).toBe("ready");
    expect(restored.recovery.keyId).toBe(material.signing.keyId);
    expect(restored.recovery.backup.lastCommittedRevision).toBe(1);
    assertGuiStateSecretFree(restored);
  });
});

describe("subscriber emissions", () => {
  it("every pushed snapshot is secret-free", async () => {
    const seeded = await makeService();
    const seen: GuiState[] = [];
    seeded.service.subscribe((state) => {
      seen.push(state);
      assertGuiStateSecretFree(state);
    });
    await seedConnection(seeded);
    await seedRecovery(seeded);
    expect(seen.length).toBeGreaterThan(4);
    for (const state of seen) expect(scanGuiStateForSecrets(state)).toHaveLength(0);
  });
});
