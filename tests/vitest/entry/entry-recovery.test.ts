import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
  assertRotationNotGlobal,
  assertSnapshotServiceVisibility,
  containsForbiddenSnapshotKeys,
  parsePrivateRelayRecoveryMessage,
  parseRecoveryProof,
  parseRotationBegin
} from "@meshrix/contracts/private-relay";
import {
  createEndpointIdentityStore,
  createRecoveryAuthorityService,
  type EndpointIdentityStore,
  type RecoveryAuthorityService,
  type RecoverySigner
} from "@meshrix/gateway/private-endpoint";

import {
  ENTRY_SNAPSHOT_FORMAT_VERSION,
  EntryRecoveryService,
  EntryRecoverySession,
  FileCustodyAdapter,
  InMemorySnapshotJournal,
  RecoveryRotationManager,
  RecoveryVaultClient,
  SnapshotSynchronizer,
  buildEntryRecoveryBundle,
  deriveRecoveryMaterial,
  formatRecoveryText,
  generateRecoveryKey,
  mergeRecoveryBundles,
  openRecoverySnapshot,
  parseEntryRecoveryBundle,
  parseRecoveryText,
  sealRecoverySnapshot,
  verifyEd25519,
  vaultFetchTranscript,
  type BundleConnection,
  type CustodyAdapter,
  type RecoveryMaterial
} from "@meshrix/entry";
import type { RecoveryEndpointPort } from "@meshrix/entry";
import { FakeVault } from "./helpers.ts";

const VAULT_ID = "vault.pr.test1";
const ROUTE = "route.pr.test1";
const PRINCIPAL = "prin.pr.test1";
const TENANT = "tenant.pr.test1";

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function fileCustody(): Promise<CustodyAdapter> {
  dir = await mkdtemp(path.join(tmpdir(), "entry-recovery-"));
  return new FileCustodyAdapter({ dataDir: dir, wrapSecret: randomBytes(32) });
}

function verifierOf(material: RecoveryMaterial) {
  return {
    keyId: material.signing.keyId,
    algorithm: "Ed25519" as const,
    publicKey: material.signing.publicKey
  };
}
function writerOf(material: RecoveryMaterial) {
  return {
    keyId: material.writer.keyId,
    algorithm: "Ed25519" as const,
    publicKey: material.writer.publicKey
  };
}

function connectionFixture(overrides: Partial<BundleConnection> = {}): BundleConnection {
  return Object.freeze({
    connectionId: "conn.test.1",
    displayLabel: "Test connection",
    routeId: ROUTE,
    tenantId: TENANT,
    mode: "personal",
    endpointSpkiPin: "spki.test.pin",
    principalRef: PRINCIPAL,
    relayService: "https://relay.example.invalid",
    vaultId: VAULT_ID,
    trustGeneration: 3,
    admissionGeneration: 1,
    revocationRevision: 0,
    recoveryAuthority: null,
    ...overrides
  });
}

function bundleFixture(material: RecoveryMaterial, overrides: Partial<BundleConnection> = {}) {
  return buildEntryRecoveryBundle({
    profileRef: "prof.test.1",
    displayLabel: "Test profile",
    connections: [connectionFixture({
      recoveryAuthority: { keyId: material.signing.keyId, generation: 3 },
      ...overrides
    })]
  });
}

/** Endpoint recovery peer driven by the real gateway authority service. */
function recoveryEndpoint(store: EndpointIdentityStore, options: {
  mutateChallenge?: (challenge: Record<string, unknown>) => Record<string, unknown>;
  afterChallenge?: () => void;
} = {}) {
  const signer: RecoverySigner = {
    sign: () => "endpoint-unused",
    verify: (input) => verifyEd25519({
      publicKey: input.publicKey,
      signature: input.signature,
      transcript: String(input.transcript)
    })
  };
  const service: RecoveryAuthorityService = createRecoveryAuthorityService({
    identity: store,
    signer
  });
  const endpoint: RecoveryEndpointPort = {
    async roundTrip({ message }) {
      const parsed = parsePrivateRelayRecoveryMessage(message);
      if (parsed?.kind === "recovery-request") {
        let challenge = service.beginRecovery(message) as Record<string, unknown> | null;
        if (challenge && options.mutateChallenge) challenge = options.mutateChallenge(challenge);
        options.afterChallenge?.();
        return challenge ?? undefined;
      }
      if (parsed?.kind === "recovery-proof") {
        return service.completeRecovery(message) ?? undefined;
      }
      return undefined;
    }
  };
  return { endpoint, service };
}

describe("recovery key text", () => {
  it("round-trips generate → format → parse", () => {
    const key = generateRecoveryKey({ vaultId: VAULT_ID });
    const text = formatRecoveryText(key);
    expect(text.startsWith("mrk1-")).toBe(true);
    expect(text).toMatch(/^mrk1-([a-z2-7]{5}-)*[a-z2-7]+$/u);
    const parsed = parseRecoveryText(text);
    expect(Buffer.from(parsed.secret).equals(Buffer.from(key.secret))).toBe(true);
    expect(parsed.vaultId).toBe(VAULT_ID);
    expect(parsed.formatVersion).toBe(1);
  });

  it("tolerates whitespace, spacing regrouping and case", () => {
    const text = formatRecoveryText(generateRecoveryKey({ vaultId: VAULT_ID }));
    const mangled = `  ${text.toUpperCase().replace(/-/gu, " ")}\n`;
    const parsed = parseRecoveryText(mangled);
    expect(parsed.vaultId).toBe(VAULT_ID);
  });

  it("rejects a mistyped character via the checksum", () => {
    const text = formatRecoveryText(generateRecoveryKey({ vaultId: VAULT_ID }));
    const chars = text.split("");
    const idx = chars.findIndex((c, i) => i > 5 && /[a-z2-7]/u.test(c));
    chars[idx] = chars[idx] === "a" ? "b" : "a";
    expect(() => parseRecoveryText(chars.join("")))
      .toThrowError(expect.objectContaining({ code: "recovery_key_invalid" }));
  });

  it("rejects wrong prefix, bad charset and truncation", () => {
    const text = formatRecoveryText(generateRecoveryKey({ vaultId: VAULT_ID }));
    expect(() => parseRecoveryText(`xrk1-${text.slice(5)}`))
      .toThrowError(expect.objectContaining({ code: "recovery_key_invalid" }));
    expect(() => parseRecoveryText(text.slice(0, -8)))
      .toThrowError(expect.objectContaining({ code: "recovery_key_invalid" }));
    expect(() => parseRecoveryText("mrk1-0189"))
      .toThrowError(expect.objectContaining({ code: "recovery_key_invalid" }));
    expect(() => parseRecoveryText(42))
      .toThrowError(expect.objectContaining({ code: "recovery_key_invalid" }));
  });

  it("produces deterministic material from the same secret", () => {
    const key = generateRecoveryKey({ vaultId: VAULT_ID });
    const a = deriveRecoveryMaterial(key.secret);
    const b = deriveRecoveryMaterial(parseRecoveryText(formatRecoveryText(key)).secret);
    expect(a.signing.keyId).toBe(b.signing.keyId);
    expect(a.writer.keyId).toBe(b.writer.keyId);
    expect(a.backupKey.equals(b.backupKey)).toBe(true);
    // A different secret must never collide.
    const c = deriveRecoveryMaterial(generateRecoveryKey().secret);
    expect(c.signing.keyId).not.toBe(a.signing.keyId);
  });
});

describe("snapshot crypto", () => {
  const material = deriveRecoveryMaterial(generateRecoveryKey({ vaultId: VAULT_ID }).secret);
  const aad = { vaultId: VAULT_ID, formatVersion: 1, generation: 3, revision: 7 };

  it("seals and opens a snapshot envelope", () => {
    const plaintext = new TextEncoder().encode("bundle-bytes");
    const sealed = sealRecoverySnapshot({ plaintext, backupKey: material.backupKey, ...aad });
    expect(sealed.algorithm).toBe("AES-256-GCM");
    expect(sealed.nonce.startsWith("sn.")).toBe(true);
    const opened = openRecoverySnapshot({ envelope: sealed, backupKey: material.backupKey, ...aad });
    expect(Buffer.from(opened).toString()).toBe("bundle-bytes");
  });

  it("fails closed under a wrong recovery key", () => {
    const sealed = sealRecoverySnapshot({ plaintext: new Uint8Array([1, 2, 3]), backupKey: material.backupKey, ...aad });
    const wrong = deriveRecoveryMaterial(generateRecoveryKey().secret);
    expect(() => openRecoverySnapshot({ envelope: sealed, backupKey: wrong.backupKey, ...aad }))
      .toThrowError(expect.objectContaining({ code: "snapshot_decrypt_failed" }));
  });

  it("fails closed on tampered ciphertext and tampered AAD fields", () => {
    const sealed = sealRecoverySnapshot({ plaintext: new Uint8Array([1, 2, 3]), backupKey: material.backupKey, ...aad });
    const raw = Buffer.from(sealed.ciphertext, "base64url");
    raw[13] ^= 0xff;
    const tampered = { ...sealed, ciphertext: raw.toString("base64url") };
    expect(() => openRecoverySnapshot({ envelope: tampered, backupKey: material.backupKey, ...aad }))
      .toThrowError(expect.objectContaining({ code: "snapshot_decrypt_failed" }));
    // Revision/generation/vault are authenticated — replaying under another
    // revision must not open.
    expect(() => openRecoverySnapshot({ envelope: sealed, backupKey: material.backupKey, ...aad, revision: 8 }))
      .toThrowError(expect.objectContaining({ code: "snapshot_decrypt_failed" }));
    expect(() => openRecoverySnapshot({ envelope: sealed, backupKey: material.backupKey, ...aad, vaultId: "vault.other" }))
      .toThrowError(expect.objectContaining({ code: "snapshot_decrypt_failed" }));
  });
});

describe("recovery bundle schema", () => {
  it("round-trips a built bundle", () => {
    const material = deriveRecoveryMaterial(generateRecoveryKey().secret);
    const bundle = bundleFixture(material);
    const parsed = parseEntryRecoveryBundle(JSON.parse(JSON.stringify(bundle)));
    expect(parsed).not.toBeNull();
    expect(parsed?.connections[0]?.routeId).toBe(ROUTE);
    expect(parsed?.connections[0]?.recoveryAuthority?.generation).toBe(3);
  });

  it("rejects forbidden secret-bearing fields structurally", () => {
    const material = deriveRecoveryMaterial(generateRecoveryKey().secret);
    const bundle = bundleFixture(material) as unknown as Record<string, unknown>;
    const poisoned = { ...bundle, privateKey: "AAAA" };
    expect(parseEntryRecoveryBundle(poisoned)).toBeNull();
    expect(containsForbiddenSnapshotKeys(poisoned)).toBe(true);
    const clean = JSON.parse(JSON.stringify(bundleFixture(material)));
    expect(containsForbiddenSnapshotKeys(clean)).toBe(false);
    // Nothing secret-shaped appears anywhere in a serialized bundle.
    const serialized = canonicalJson(clean);
    for (const key of ["privateKey", "grant", "credentials", "secret", "token", "apiKey"]) {
      expect(serialized.includes(`"${key}"`)).toBe(false);
    }
  });

  it("merges concurrent bundles as a union keyed by connection", () => {
    const material = deriveRecoveryMaterial(generateRecoveryKey().secret);
    const a = bundleFixture(material);
    const b = buildEntryRecoveryBundle({
      profileRef: "prof.test.1",
      displayLabel: "Other",
      connections: [connectionFixture({ connectionId: "conn.test.2", routeId: "route.pr.test2" })]
    });
    const merged = mergeRecoveryBundles(a, b);
    expect(merged.connections.map((c) => c.connectionId).sort()).toEqual(["conn.test.1", "conn.test.2"]);
  });
});

describe("vault client + snapshot sync", () => {
  function materialAndVault() {
    const material = deriveRecoveryMaterial(generateRecoveryKey({ vaultId: VAULT_ID }).secret);
    const vault = new FakeVault({
      vaultId: VAULT_ID,
      verifier: verifierOf(material),
      writers: [writerOf(material)],
      generation: 3
    });
    const client = new RecoveryVaultClient({ transport: vault });
    return { material, vault, client };
  }

  it("publishes an encrypted snapshot and fetches it back", async () => {
    const { material, vault } = materialAndVault();
    const sync = new SnapshotSynchronizer({ vault: new RecoveryVaultClient({ transport: vault }) });
    const published = await sync.publish({ vaultId: VAULT_ID, bundle: bundleFixture(material), material, generation: 3 });
    expect(published.outcome).toBe("committed");
    expect(vault.current?.revision).toBe(1);
    // The vault only ever holds the opaque envelope + public verifier.
    expect(assertSnapshotServiceVisibility({
      schemaVersion: PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
      kind: "encrypted-recovery-snapshot",
      vaultId: VAULT_ID,
      formatVersion: ENTRY_SNAPSHOT_FORMAT_VERSION,
      generation: vault.current!.generation,
      revision: vault.current!.revision,
      snapshot: vault.current!.snapshot,
      publicVerifier: vault.current!.publicVerifier
    })).toBe(true);
    const fetched = await sync.fetchSnapshot({ vaultId: VAULT_ID, material });
    expect(fetched.outcome).toBe("snapshot");
    if (fetched.outcome === "snapshot") {
      expect(fetched.bundle.connections[0]?.routeId).toBe(ROUTE);
      expect(fetched.revision).toBe(1);
      expect(fetched.generation).toBe(3);
    }
  });

  it("fetches fail for a wrong recovery key (proof_invalid)", async () => {
    const { material, vault } = materialAndVault();
    const sync = new SnapshotSynchronizer({ vault: new RecoveryVaultClient({ transport: vault }) });
    await sync.publish({ vaultId: VAULT_ID, bundle: bundleFixture(material), material, generation: 3 });
    const wrong = deriveRecoveryMaterial(generateRecoveryKey().secret);
    const fetched = await sync.fetchSnapshot({ vaultId: VAULT_ID, material: wrong });
    expect(fetched.outcome).toBe("refused");
    if (fetched.outcome === "refused") expect(fetched.refusal).toBe("proof_invalid");
  });

  it("refuses a replayed vault-fetch proof nonce", async () => {
    const { material, vault } = materialAndVault();
    const sync = new SnapshotSynchronizer({ vault: new RecoveryVaultClient({ transport: vault }) });
    await sync.publish({ vaultId: VAULT_ID, bundle: bundleFixture(material), material, generation: 3 });
    const client = new RecoveryVaultClient({ transport: vault, nonceFactory: () => "n.fixed.replay.nonce.01" });
    const first = await client.fetchSnapshot({ vaultId: VAULT_ID, recoveryKey: material.signing });
    expect(first.outcome).toBe("snapshot");
    const replay = await client.fetchSnapshot({ vaultId: VAULT_ID, recoveryKey: material.signing });
    expect(replay.outcome).toBe("refused");
    if (replay.outcome === "refused") expect(replay.refusal).toBe("proof_invalid");
  });

  it("refuses a replayed vault-write nonce on a divergent write", async () => {
    const { material, vault } = materialAndVault();
    const sync = new SnapshotSynchronizer({ vault: new RecoveryVaultClient({ transport: vault }) });
    await sync.publish({ vaultId: VAULT_ID, bundle: bundleFixture(material), material, generation: 3 });
    const client = new RecoveryVaultClient({ transport: vault, nonceFactory: () => "n.fixed.replay.nonce.02" });
    const envelope = vault.current!;
    const snapshot = {
      schemaVersion: PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
      kind: "encrypted-recovery-snapshot",
      vaultId: VAULT_ID,
      formatVersion: ENTRY_SNAPSHOT_FORMAT_VERSION,
      generation: 4,
      revision: 2,
      snapshot: { ...envelope.snapshot },
      publicVerifier: { ...envelope.publicVerifier }
    };
    const first = await client.writeSnapshot({
      vaultId: VAULT_ID, expectedRevision: 1, snapshot, writerKey: material.writer
    });
    expect(first.outcome).toBe("committed");
    // Same nonce on a different write must be refused, never silently committed.
    const tamperedSnapshot = { ...snapshot, generation: 5, revision: 3, snapshot: { ...envelope.snapshot, nonce: "sn.other.snapshot.nonce" } };
    const second = await client.writeSnapshot({
      vaultId: VAULT_ID, expectedRevision: 2, snapshot: tamperedSnapshot, writerKey: material.writer
    });
    expect(second.outcome).toBe("refused");
  });

  it("reconciles a CAS conflict as a merge, not an overwrite", async () => {
    const { material, vault } = materialAndVault();
    const syncA = new SnapshotSynchronizer({ vault: new RecoveryVaultClient({ transport: vault }) });
    const syncB = new SnapshotSynchronizer({
      vault: new RecoveryVaultClient({ transport: vault }),
      journal: new InMemorySnapshotJournal()
    });
    await syncA.publish({ vaultId: VAULT_ID, bundle: bundleFixture(material), material, generation: 3 });
    const bundleB = buildEntryRecoveryBundle({
      profileRef: "prof.test.1",
      displayLabel: "B",
      connections: [connectionFixture({ connectionId: "conn.test.2", routeId: "route.pr.test2" })]
    });
    const outcome = await syncB.publish({ vaultId: VAULT_ID, bundle: bundleB, material, generation: 3 });
    expect(outcome.outcome).toBe("committed");
    if (outcome.outcome === "committed") expect(outcome.revision).toBe(2);
    const fetched = await syncA.fetchSnapshot({ vaultId: VAULT_ID, material });
    if (fetched.outcome !== "snapshot") throw new Error("expected snapshot");
    expect(fetched.bundle.connections.map((c) => c.connectionId).sort())
      .toEqual(["conn.test.1", "conn.test.2"]);
  });

  it("survives an interrupted write: the last committed snapshot is retained and the retry reconciles", async () => {
    const { material, vault } = materialAndVault();
    const journal = new InMemorySnapshotJournal();
    const sync = new SnapshotSynchronizer({
      vault: new RecoveryVaultClient({ transport: vault }),
      journal
    });
    await sync.publish({ vaultId: VAULT_ID, bundle: bundleFixture(material), material, generation: 3 });
    const committedDigest = vault.current!.digest;
    // The vault commits rev2 but the response is lost mid-flight.
    vault.dropNextWriteResponse = true;
    const interrupted = await sync.publish({ vaultId: VAULT_ID, bundle: bundleFixture(material), material, generation: 3 });
    expect(interrupted.outcome).toBe("invalid_response");
    // The vault still holds the committed rev2; the digest the client knows is rev1's.
    expect(vault.current?.revision).toBe(2);
    // Idempotent retry reuses the same ciphertext — the vault reports committed.
    const retried = await sync.publish({ vaultId: VAULT_ID, bundle: bundleFixture(material), material, generation: 3 });
    expect(retried.outcome).toBe("committed");
    if (retried.outcome === "committed") expect(retried.revision).toBe(2);
    expect(committedDigest).not.toBe(vault.current!.digest);
  });

  it("reports a superseded generation instead of rolling the vault back", async () => {
    const { material, vault } = materialAndVault();
    // Another device committed at generation 5 under this recovery root.
    const future = new SnapshotSynchronizer({
      vault: new RecoveryVaultClient({ transport: vault }),
      journal: { load: () => ({ lastCommitted: null, highestSeen: { revision: 0, generation: 5 }, lastSuccessAt: null, lastError: null }), save() {} }
    });
    await future.publish({ vaultId: VAULT_ID, bundle: bundleFixture(material), material, generation: 5 });
    expect(vault.generation).toBe(5);
    // A stale device (gen 3 authority view) is refused, then learns the
    // committed generation through the probe — reported as superseded.
    const stale = new SnapshotSynchronizer({
      vault: new RecoveryVaultClient({ transport: vault }),
      journal: { load: () => ({ lastCommitted: { revision: 0, generation: 3, digest: "sha256:none" }, highestSeen: { revision: 0, generation: 3 }, lastSuccessAt: null, lastError: null }), save() {} }
    });
    const outcome = await stale.publish({ vaultId: VAULT_ID, bundle: bundleFixture(material), material, generation: 3 });
    expect(outcome.outcome).toBe("superseded");
    if (outcome.outcome === "superseded") expect(outcome.generation).toBe(5);
    // And the vault is untouched.
    expect(vault.current?.generation).toBe(5);
  });

  it("flags a vault response signed by a foreign verifier as authority_mismatch", async () => {
    const { material, vault } = materialAndVault();
    const sync = new SnapshotSynchronizer({ vault: new RecoveryVaultClient({ transport: vault }) });
    await sync.publish({ vaultId: VAULT_ID, bundle: bundleFixture(material), material, generation: 3 });
    // Swap the stored verifier for a foreign key.
    vault.current!.publicVerifier = { keyId: "rckey.foreign", algorithm: "Ed25519", publicKey: material.writer.publicKey };
    const fetched = await sync.fetchSnapshot({ vaultId: VAULT_ID, material });
    expect(fetched.outcome).toBe("authority_mismatch");
  });

  it("flags a snapshot older than the local high-water mark as stale", async () => {
    const { material, vault } = materialAndVault();
    const journal = new InMemorySnapshotJournal();
    const sync = new SnapshotSynchronizer({
      vault: new RecoveryVaultClient({ transport: vault }),
      journal
    });
    await sync.publish({ vaultId: VAULT_ID, bundle: bundleFixture(material), material, generation: 3 });
    // Simulate a restored/rolled-back vault (older committed revision).
    const current = vault.current!;
    vault.current = { ...current, revision: 1 };
    journal.save({
      lastCommitted: { revision: 9, generation: 3, digest: "sha256:none" },
      highestSeen: { revision: 9, generation: 3 },
      lastSuccessAt: null,
      lastError: null
    });
    const fetched = await sync.fetchSnapshot({ vaultId: VAULT_ID, material });
    expect(fetched.outcome).toBe("stale");
  });
});

describe("recovery session against the real endpoint authority", () => {
  function endpointStore(material: RecoveryMaterial, generation = 3) {
    const store = createEndpointIdentityStore();
    store.enrollRecoveryAuthority({
      recoveryKeyId: material.signing.keyId,
      principalRef: PRINCIPAL,
      publicKey: material.signing.publicKey,
      generation
    });
    return store;
  }

  async function recoverOnce(options: {
    mutateChallenge?: (challenge: Record<string, unknown>) => Record<string, unknown>;
    afterChallenge?: () => void;
    store?: EndpointIdentityStore;
    custody?: CustodyAdapter;
  } = {}) {
    const material = deriveRecoveryMaterial(generateRecoveryKey({ vaultId: VAULT_ID }).secret);
    const store = options.store ?? endpointStore(material);
    const { endpoint } = recoveryEndpoint(store, options);
    const session = new EntryRecoverySession({ endpoint });
    const custody = options.custody ?? await fileCustody();
    return session.recover({
      material,
      bundle: bundleFixture(material),
      connection: connectionFixture({
        recoveryAuthority: { keyId: material.signing.keyId, generation: 3 }
      }),
      custody
    });
  }

  it("enrolls a fresh device under current endpoint authority", async () => {
    const outcome = await recoverOnce();
    expect(outcome.outcome).toBe("enrolled");
    if (outcome.outcome === "enrolled") {
      expect(outcome.device.deviceId.startsWith("dev.entry.")).toBe(true);
      expect(outcome.admission.requiresMutualTlsRebind).toBe(true);
      expect(outcome.admission.admissionGeneration).toBe(1);
      expect(outcome.principalRef).toBe(PRINCIPAL);
    }
  });

  it("lands the enrolled device in the endpoint store bound to the authority", async () => {
    const material = deriveRecoveryMaterial(generateRecoveryKey({ vaultId: VAULT_ID }).secret);
    const store = endpointStore(material);
    const { endpoint } = recoveryEndpoint(store);
    const session = new EntryRecoverySession({ endpoint });
    const custody = await fileCustody();
    const outcome = await session.recover({
      material, bundle: bundleFixture(material),
      connection: connectionFixture({ recoveryAuthority: { keyId: material.signing.keyId, generation: 3 } }),
      custody
    });
    expect(outcome.outcome).toBe("enrolled");
    const record = store.device(outcome.outcome === "enrolled" ? outcome.device.deviceId : "none");
    expect(record?.pairedIdentityKey).toBe(outcome.outcome === "enrolled" ? outcome.device.publicKey : "");
    expect(record?.boundRecoveryKeyId).toBe(material.signing.keyId);
    expect(record?.revoked).toBe(false);
  });

  it("refuses a challenge bound to a different endpoint route", async () => {
    await expect(recoverOnce({
      mutateChallenge: (c) => ({ ...c, endpointRouteId: "route.evil" })
    })).rejects.toMatchObject({ code: "endpoint_refused" });
  });

  it("refuses a challenge bound to a different fresh device key", async () => {
    await expect(recoverOnce({
      mutateChallenge: (c) => ({ ...c, freshDevicePublicKey: "A".padEnd(43, "x") })
    })).rejects.toMatchObject({ code: "endpoint_refused" });
  });

  it("refuses a challenge from an unexpected principal", async () => {
    await expect(recoverOnce({
      mutateChallenge: (c) => ({ ...c, principalRef: "prin.other" })
    })).rejects.toMatchObject({ code: "endpoint_refused" });
  });

  it("refuses a stale challenge generation", async () => {
    await expect(recoverOnce({
      mutateChallenge: (c) => ({ ...c, generation: 2 })
    })).rejects.toMatchObject({ code: "endpoint_refused" });
  });

  it("refuses an already-expired challenge", async () => {
    await expect(recoverOnce({
      mutateChallenge: (c) => ({
        ...c,
        issuedAt: "2020-01-01T00:00:00Z",
        expiresAt: "2020-01-01T00:00:05Z"
      })
    })).rejects.toMatchObject({ code: "endpoint_refused" });
  });

  it("refuses a challenge mangled into a different purpose", async () => {
    await expect(recoverOnce({
      mutateChallenge: (c) => ({ ...c, purpose: "vault_fetch" })
    })).rejects.toMatchObject({ code: "endpoint_unexpected_response" });
  });

  it("surfaces authority revocation between challenge and proof", async () => {
    const material = deriveRecoveryMaterial(generateRecoveryKey({ vaultId: VAULT_ID }).secret);
    const store = endpointStore(material);
    const outcome = await recoverOnce({
      store,
      afterChallenge: () => store.setRecoveryAuthorityState(material.signing.keyId, "revoked")
    });
    expect(outcome).toEqual({ outcome: "refused", refusal: "authority_revoked" });
  });

  it("surfaces a stale authority generation mid-recovery", async () => {
    const material = deriveRecoveryMaterial(generateRecoveryKey({ vaultId: VAULT_ID }).secret);
    const store = endpointStore(material, 3);
    const outcome = await recoverOnce({
      store,
      // The authority rotated to generation 9 after the challenge was issued.
      afterChallenge: () => store.enrollRecoveryAuthority({
        recoveryKeyId: material.signing.keyId,
        principalRef: PRINCIPAL,
        publicKey: material.signing.publicKey,
        generation: 9
      })
    });
    expect(outcome).toEqual({ outcome: "refused", refusal: "stale_generation" });
  });

  it("treats a lost/absent authority as unreachable, never as success", async () => {
    const store = createEndpointIdentityStore(); // no authority enrolled
    await expect(recoverOnce({ store }))
      .rejects.toMatchObject({ code: "endpoint_unreachable" });
  });

  it("consumes a challenge once — replayed proof is refused", async () => {
    const material = deriveRecoveryMaterial(generateRecoveryKey({ vaultId: VAULT_ID }).secret);
    const store = endpointStore(material);
    const { endpoint, service } = recoveryEndpoint(store);
    let capturedProof: unknown;
    const spying: RecoveryEndpointPort = {
      async roundTrip(input) {
        const result = await endpoint.roundTrip(input);
        if ((input.message as { kind?: string }).kind === "recovery-proof") capturedProof = input.message;
        return result;
      }
    };
    const session = new EntryRecoverySession({ endpoint: spying });
    const outcome = await session.recover({
      material, bundle: bundleFixture(material),
      connection: connectionFixture({ recoveryAuthority: { keyId: material.signing.keyId, generation: 3 } }),
      custody: await fileCustody()
    });
    expect(outcome.outcome).toBe("enrolled");
    expect(parseRecoveryProof(capturedProof)).not.toBeNull();
    // Replaying the exact proof message is refused by the endpoint.
    const replayed = service.completeRecovery(capturedProof) as { outcome: string; refusal: string };
    expect(replayed.outcome).toBe("refused");
    expect(["challenge_expired", "challenge_consumed"]).toContain(replayed.refusal);
  });
});

describe("fresh-profile recovery service (text only)", () => {
  async function publishFixture() {
    const key = generateRecoveryKey({ vaultId: VAULT_ID });
    const material = deriveRecoveryMaterial(key.secret);
    const vault = new FakeVault({ vaultId: VAULT_ID, verifier: verifierOf(material), writers: [writerOf(material)], generation: 3 });
    const writer = new SnapshotSynchronizer({ vault: new RecoveryVaultClient({ transport: vault }) });
    await writer.publish({ vaultId: VAULT_ID, bundle: bundleFixture(material), material, generation: 3 });
    const store = createEndpointIdentityStore();
    store.enrollRecoveryAuthority({
      recoveryKeyId: material.signing.keyId,
      principalRef: PRINCIPAL,
      publicKey: material.signing.publicKey,
      generation: 3
    });
    const { endpoint } = recoveryEndpoint(store);
    return { key, material, vault, store, endpoint };
  }

  function freshService(endpoint: RecoveryEndpointPort, vault: FakeVault) {
    return new EntryRecoveryService({
      synchronizer: new SnapshotSynchronizer({ vault: new RecoveryVaultClient({ transport: vault }) }),
      endpoint,
      custody: null as never
    });
  }

  it("recovers end-to-end from the recovery text alone", async () => {
    const { key, vault, endpoint, store } = await publishFixture();
    const service = freshService(endpoint, vault);
    const outcome = await service.recoverFreshProfile({
      recoveryText: formatRecoveryText(key),
      custody: await fileCustody(),
      routeId: ROUTE
    });
    expect(outcome.outcome).toBe("enrolled");
    if (outcome.outcome === "enrolled") {
      const enrolled = store.device(outcome.device.deviceId);
      expect(enrolled?.boundRecoveryKeyId).toBe(deriveRecoveryMaterial(key.secret).signing.keyId);
      expect(outcome.bundle.connections[0]?.routeId).toBe(ROUTE);
      expect(outcome.requiresMutualTlsRebind).toBe(true);
    }
  });

  it("wrong recovery text cannot fetch the snapshot", async () => {
    const { vault, endpoint } = await publishFixture();
    const service = freshService(endpoint, vault);
    const wrong = generateRecoveryKey({ vaultId: VAULT_ID });
    const outcome = await service.recoverFreshProfile({
      recoveryText: formatRecoveryText(wrong),
      custody: await fileCustody(),
      routeId: ROUTE
    });
    expect(outcome.outcome).toBe("snapshot_unusable");
  });

  it("a tampered committed snapshot fails closed", async () => {
    const { key, vault, endpoint } = await publishFixture();
    // Flip a ciphertext byte inside the committed envelope.
    const raw = Buffer.from(vault.current!.snapshot.ciphertext, "base64url");
    raw[20] ^= 0xff;
    vault.current!.snapshot.ciphertext = raw.toString("base64url");
    const service = freshService(endpoint, vault);
    const outcome = await service.recoverFreshProfile({
      recoveryText: formatRecoveryText(key),
      custody: await fileCustody(),
      routeId: ROUTE
    });
    expect(outcome).toEqual({ outcome: "snapshot_unusable", reason: "decrypt_failed" });
  });

  it("a missing snapshot is reported without endpoint contact", async () => {
    const { key, endpoint } = await publishFixture();
    const material = deriveRecoveryMaterial(key.secret);
    const emptyVault = new FakeVault({ vaultId: VAULT_ID, verifier: verifierOf(material), writers: [writerOf(material)] });
    const service = freshService(endpoint, emptyVault);
    const outcome = await service.recoverFreshProfile({
      recoveryText: formatRecoveryText(key),
      custody: await fileCustody(),
      routeId: ROUTE
    });
    expect(outcome.outcome).toBe("snapshot_missing");
  });

  it("refuses recovery text that carries no vault locator", async () => {
    const { vault, endpoint } = await publishFixture();
    const service = freshService(endpoint, vault);
    const bare = generateRecoveryKey(); // no vaultId
    await expect(service.recoverFreshProfile({
      recoveryText: formatRecoveryText(bare),
      custody: await fileCustody(),
      routeId: ROUTE
    })).rejects.toMatchObject({ code: "recovery_locator_missing" });
  });
});

describe("recovery-key rotation model", () => {
  function fixture() {
    const material = deriveRecoveryMaterial(generateRecoveryKey({ vaultId: VAULT_ID }).secret);
    const manager = new RecoveryRotationManager({ now: () => Date.parse("2026-01-02T00:00:00Z") });
    return { material, manager };
  }

  it("stages a candidate and emits contract-valid rotation-begin per endpoint", () => {
    const { material, manager } = fixture();
    const { rotation, messages, candidate } = manager.begin({
      incumbent: material,
      incumbentGeneration: 3,
      principalRef: PRINCIPAL,
      vaultId: VAULT_ID,
      endpointRouteIds: [ROUTE, "route.pr.test2"]
    });
    expect(rotation.state).toBe("staged");
    expect(rotation.candidateGeneration).toBe(4);
    expect(rotation.endpoints.every((e) => e.state === "pending")).toBe(true);
    expect(candidate.vaultId).toBe(VAULT_ID);
    for (const message of messages) {
      const parsed = parseRotationBegin(message);
      expect(parsed).not.toBeNull();
      expect(parsed?.candidateGeneration).toBe(4);
      // The admin proof verifies under the incumbent signing key.
      const proof = parsed!.administrationProof;
      expect(verifyEd25519({
        publicKey: material.signing.publicKey,
        signature: String(proof.signature),
        transcript: vaultFetchTranscript(VAULT_ID, {
          keyId: String(proof.keyId), nonce: String(proof.nonce), issuedAt: String(proof.issuedAt)
        })
      })).toBe(true);
    }
  });

  it("tracks per-endpoint acknowledgement and never overclaims completion", () => {
    const { material, manager } = fixture();
    const { rotation } = manager.begin({
      incumbent: material, incumbentGeneration: 3, principalRef: PRINCIPAL,
      vaultId: VAULT_ID, endpointRouteIds: [ROUTE, "route.pr.test2"]
    });
    manager.markPublished(rotation.rotationId);
    const afterOne = manager.markEndpoint(rotation.rotationId, ROUTE, "acknowledged");
    expect(afterOne.state).toBe("acknowledging");
    const wire = manager.wireState(rotation.rotationId);
    expect(wire.globalComplete).toBe(false);
    expect(wire.pending).toEqual(["route.pr.test2"]);
    expect(assertRotationNotGlobal(wire)).toBe(true);
    const done = manager.markEndpoint(rotation.rotationId, "route.pr.test2", "acknowledged");
    expect(done.state).toBe("completed");
    expect(manager.wireState(rotation.rotationId).pending).toEqual([]);
  });

  it("keeps offline endpoints pending honestly", () => {
    const { material, manager } = fixture();
    const { rotation } = manager.begin({
      incumbent: material, incumbentGeneration: 3, principalRef: PRINCIPAL,
      vaultId: VAULT_ID, endpointRouteIds: [ROUTE, "route.offline"]
    });
    manager.markPublished(rotation.rotationId);
    manager.markEndpoint(rotation.rotationId, ROUTE, "acknowledged");
    const current = manager.markEndpoint(rotation.rotationId, "route.offline", "unreachable");
    expect(current.state).toBe("acknowledging");
    const wire = manager.wireState(rotation.rotationId);
    expect(wire.pending).toEqual(["route.offline"]);
    expect(wire.globalComplete).toBe(false);
  });

  it("abort preserves the incumbent and the last committed snapshot", async () => {
    const { material, manager } = fixture();
    const vault = new FakeVault({ vaultId: VAULT_ID, verifier: verifierOf(material), writers: [writerOf(material)], generation: 3 });
    const sync = new SnapshotSynchronizer({ vault: new RecoveryVaultClient({ transport: vault }) });
    await sync.publish({ vaultId: VAULT_ID, bundle: bundleFixture(material), material, generation: 3 });
    const { rotation } = manager.begin({
      incumbent: material, incumbentGeneration: 3, principalRef: PRINCIPAL,
      vaultId: VAULT_ID, endpointRouteIds: [ROUTE]
    });
    const aborted = manager.abort(rotation.rotationId);
    expect(aborted.state).toBe("aborted");
    // Incumbent still decrypts the committed snapshot; nothing was discarded.
    const fetched = await sync.fetchSnapshot({ vaultId: VAULT_ID, material });
    expect(fetched.outcome).toBe("snapshot");
  });

  it("a compromised cached incumbent cannot roll the vault back after rotation", async () => {
    const material = deriveRecoveryMaterial(generateRecoveryKey({ vaultId: VAULT_ID }).secret);
    const candidateSecret = generateRecoveryKey({ vaultId: VAULT_ID });
    const candidate = deriveRecoveryMaterial(candidateSecret.secret);
    const vault = new FakeVault({
      vaultId: VAULT_ID,
      verifier: verifierOf(candidate),
      writers: [writerOf(material), writerOf(candidate)],
      generation: 3
    });
    // Publish the candidate-generation snapshot (post-rotation generation 4).
    const journal = { load: () => ({ lastCommitted: { revision: 0, generation: 3, digest: "sha256:none" }, highestSeen: { revision: 0, generation: 3 }, lastSuccessAt: null, lastError: null }), save() {} };
    void journal;
    const syncCandidate = new SnapshotSynchronizer({
      vault: new RecoveryVaultClient({ transport: vault }),
      journal: { load: () => ({ lastCommitted: null, highestSeen: { revision: 0, generation: 4 }, lastSuccessAt: null, lastError: null }), save() {} }
    });
    const committed = await syncCandidate.publish({ vaultId: VAULT_ID, bundle: bundleFixture(candidate), material: candidate, generation: 4 });
    expect(committed.outcome).toBe("committed");
    expect(vault.generation).toBe(4);
    // An old-generation incumbent write is refused — generation never regresses.
    const stale = new SnapshotSynchronizer({
      vault: new RecoveryVaultClient({ transport: vault }),
      journal: { load: () => ({ lastCommitted: { revision: 0, generation: 3, digest: "sha256:x" }, highestSeen: { revision: 0, generation: 3 }, lastSuccessAt: null, lastError: null }), save() {} }
    });
    const outcome = await stale.publish({ vaultId: VAULT_ID, bundle: bundleFixture(material), material, generation: 3 });
    expect(["refused", "superseded"]).toContain(outcome.outcome);
    expect(vault.generation).toBe(4);
  });

  it("rejects a second in-flight rotation for the same key", () => {
    const { material, manager } = fixture();
    manager.begin({
      incumbent: material, incumbentGeneration: 3, principalRef: PRINCIPAL,
      vaultId: VAULT_ID, endpointRouteIds: [ROUTE]
    });
    expect(() => manager.begin({
      incumbent: material, incumbentGeneration: 3, principalRef: PRINCIPAL,
      vaultId: VAULT_ID, endpointRouteIds: [ROUTE]
    })).toThrowError(expect.objectContaining({ code: "rotation_state_invalid" }));
  });
});
