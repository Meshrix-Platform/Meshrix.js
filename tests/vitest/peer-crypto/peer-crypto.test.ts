import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PEER_CRYPTO_ERROR_CODES,
  PEER_ENVELOPE_FORMAT,
  PEER_PREKEY_BUNDLE_FORMAT,
  acceptPeerSession,
  base64urlDecode,
  blockPeerIdentity,
  createFilePeerCryptoStore,
  createInMemoryPeerCryptoStore,
  createPeerIdentity,
  decodePeerEnvelope,
  encodePeerEnvelope,
  generatePrekeyBundle,
  initiatePeerSession,
  isPeerCryptoError,
  loadPeerIdentity,
  parsePeerEnvelope,
  parsePeerPrekeyBundle,
  peerIdentityBinding,
  peerSafetyNumber,
  peerSessionAddressKey,
  peerSessionExists,
  pinPeerIdentity,
  repinPeerIdentity,
  replenishPeerPrekeys,
  resumePeerSession,
  serializePeerEnvelope,
  type PeerCryptoStore,
  type PeerEnvelope,
  type PeerIdentity
} from "@meshrix/peer-crypto";

/**
 * Real PQXDH + Double Ratchet coverage between two device identities.
 * No transport double: envelopes are handed over directly, so every failure
 * observed is produced by the actual crypto layer — the same failures the
 * mailbox will project into receipts.
 */

const ALICE = "peer.alice.1";
const BOB = "peer.bob.1";

interface Device {
  readonly store: PeerCryptoStore;
  readonly identity: PeerIdentity;
}

async function makeDevice(peerId: string, store?: PeerCryptoStore): Promise<Device> {
  const localStore = store ?? createInMemoryPeerCryptoStore();
  const identity = await createPeerIdentity({ localStore, peerId });
  return { store: localStore, identity };
}

async function pairSessions(alice: Device, bob: Device) {
  const bobBundle = await generatePrekeyBundle(bob.identity);
  const aliceSession = await initiatePeerSession({
    identity: alice.identity,
    localStore: alice.store,
    remoteBundle: bobBundle
  });
  const first = await aliceSession.encrypt(new TextEncoder().encode("pairing hello"));
  const envelope = serializePeerEnvelope(aliceSession.envelopeHeader(), first);
  const accepted = await acceptPeerSession({
    identity: bob.identity,
    localStore: bob.store,
    envelope
  });
  return { aliceSession, bobSession: accepted.session, firstPlaintext: accepted.plaintext };
}

function envelopeOf(session: { envelopeHeader(): { senderPeerId: string; senderDeviceId: number } }, ciphertext: { messageType: "prekey" | "signal"; body: Uint8Array }): PeerEnvelope {
  return serializePeerEnvelope(session.envelopeHeader(), ciphertext);
}

async function expectPeerError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(isPeerCryptoError(error, code as never), `expected ${code}, got ${String((error as { code?: string })?.code ?? error)}`).toBe(true);
    return;
  }
  throw new Error(`Expected a peer crypto error ${code}, but the call resolved.`);
}

describe("peer-crypto X3DH/PQXDH + Double Ratchet", () => {
  it("round-trips the first prekey message and steady-state replies", async () => {
    const alice = await makeDevice(ALICE);
    const bob = await makeDevice(BOB);
    const { aliceSession, bobSession, firstPlaintext } = await pairSessions(alice, bob);
    expect(new TextDecoder().decode(firstPlaintext)).toBe("pairing hello");
    expect(aliceSession.direction).toBe("initiator");
    expect(bobSession.direction).toBe("responder");

    for (let index = 0; index < 6; index += 1) {
      const outbound = await aliceSession.encrypt(new TextEncoder().encode(`a2b ${index}`));
      // Until the responder's first reply arrives the initiator session is
      // unconfirmed: libsignal keeps emitting PreKey ciphertext so a lost first
      // message can still establish the session. The reply confirms it and the
      // ratchet switches to steady-state Whisper ciphertext.
      expect(outbound.messageType).toBe(index === 0 ? "prekey" : "signal");
      const plaintext = await bobSession.decryptEnvelope(envelopeOf(aliceSession, outbound));
      expect(new TextDecoder().decode(plaintext)).toBe(`a2b ${index}`);
      const reply = await bobSession.encrypt(new TextEncoder().encode(`b2a ${index}`));
      const replyPlaintext = await aliceSession.decryptEnvelope(envelopeOf(bobSession, reply));
      expect(new TextDecoder().decode(replyPlaintext)).toBe(`b2a ${index}`);
    }
  });

  it("decrypts out-of-order deliveries through the ratchet's skipped keys", async () => {
    const alice = await makeDevice(ALICE);
    const bob = await makeDevice(BOB);
    const { aliceSession, bobSession } = await pairSessions(alice, bob);
    const envelopes = [] as PeerEnvelope[];
    for (const text of ["m0", "m1", "m2", "m3", "m4"]) {
      envelopes.push(envelopeOf(aliceSession, await aliceSession.encrypt(new TextEncoder().encode(text))));
    }
    // Delivered 3, 0, 4, 1, 2 — the ratchet must recover every skipped key.
    for (const index of [3, 0, 4, 1, 2]) {
      const plaintext = await bobSession.decryptEnvelope(envelopes[index]);
      expect(new TextDecoder().decode(plaintext)).toBe(`m${index}`);
    }
  });

  it("rejects a replayed ciphertext as peer_duplicate_message (idempotent evidence)", async () => {
    const alice = await makeDevice(ALICE);
    const bob = await makeDevice(BOB);
    const { aliceSession, bobSession } = await pairSessions(alice, bob);
    const ciphertext = await aliceSession.encrypt(new TextEncoder().encode("once"));
    const envelope = envelopeOf(aliceSession, ciphertext);
    const plaintext = await bobSession.decryptEnvelope(envelope);
    expect(new TextDecoder().decode(plaintext)).toBe("once");
    await expectPeerError(bobSession.decryptEnvelope(envelope), "peer_duplicate_message");
    // A following fresh message still decrypts — duplicates don't poison the session.
    const next = await aliceSession.encrypt(new TextEncoder().encode("twice"));
    expect(new TextDecoder().decode(await bobSession.decryptEnvelope(envelopeOf(aliceSession, next)))).toBe("twice");
  });

  it("fails tampered ciphertext with peer_message_unauthentic and recovers", async () => {
    const alice = await makeDevice(ALICE);
    const bob = await makeDevice(BOB);
    const { aliceSession, bobSession } = await pairSessions(alice, bob);
    // Confirm alice's session first so this ciphertext is a steady-state
    // Whisper message whose flipped byte lands inside the authenticated region.
    const first = await bobSession.encrypt(new TextEncoder().encode("confirm"));
    await aliceSession.decryptEnvelope(envelopeOf(bobSession, first));
    const ciphertext = await aliceSession.encrypt(new TextEncoder().encode("integrity check"));
    expect(ciphertext.messageType).toBe("signal");
    const tampered = new Uint8Array(ciphertext.body);
    tampered[tampered.length - 5] = tampered[tampered.length - 5] ^ 0x01;
    const envelope = serializePeerEnvelope(aliceSession.envelopeHeader(), {
      messageType: ciphertext.messageType,
      body: tampered
    });
    await expectPeerError(bobSession.decryptEnvelope(envelope), "peer_message_unauthentic");
    const next = await aliceSession.encrypt(new TextEncoder().encode("still good"));
    expect(new TextDecoder().decode(await bobSession.decryptEnvelope(envelopeOf(aliceSession, next)))).toBe("still good");
  });

  it("surfaces peer_session_broken when decrypting with no established session", async () => {
    const alice = await makeDevice(ALICE);
    const bob = await makeDevice(BOB);
    const { aliceSession, bobSession } = await pairSessions(alice, bob);
    const carol = await makeDevice("peer.carol.1");
    // Confirm alice's session so this ciphertext is steady-state Whisper —
    // decrypting it without a session must be the honest session-broken state.
    const confirmation = await bobSession.encrypt(new TextEncoder().encode("confirm"));
    await aliceSession.decryptEnvelope(envelopeOf(bobSession, confirmation));
    const ciphertext = await aliceSession.encrypt(new TextEncoder().encode("to bob"));
    expect(ciphertext.messageType).toBe("signal");
    const envelope = envelopeOf(aliceSession, ciphertext);
    // Carol has a valid envelope parser view but no session with alice.
    const { PeerCryptoSession } = await import("@meshrix/peer-crypto");
    const stray = new PeerCryptoSession({
      identity: carol.identity,
      localStore: carol.store,
      peerId: ALICE,
      direction: "responder"
    });
    await expectPeerError(stray.decryptEnvelope(envelope), "peer_session_broken");
    await expectPeerError(stray.encrypt(new TextEncoder().encode("no session")), "peer_session_broken");
    // A prekey envelope routed to a device that never published the referenced
    // prekey cannot be decrypted — unauthentic, never a fabricated session.
    const bobBundle = await generatePrekeyBundle(bob.identity);
    const initiator = await initiatePeerSession({
      identity: alice.identity,
      localStore: alice.store,
      remoteBundle: bobBundle
    });
    const prekeyEnvelope = envelopeOf(initiator, await initiator.encrypt(new TextEncoder().encode("not for carol")));
    await expectPeerError(stray.decryptEnvelope(prekeyEnvelope), "peer_message_unauthentic");
    await expectPeerError(
      resumePeerSession({ identity: carol.identity, localStore: carol.store, peerId: ALICE }),
      "peer_identity_changed"
    );
  });

  it("pins the remote identity on first contact and never silently re-trusts a changed key", async () => {
    const alice = await makeDevice(ALICE);
    const bob = await makeDevice(BOB);
    await pairSessions(alice, bob);

    // A different device identity presenting the same peerId must be refused.
    const impostorStore = createInMemoryPeerCryptoStore();
    const impostor = await createPeerIdentity({ localStore: impostorStore, peerId: BOB });
    const impostorBundle = await generatePrekeyBundle(impostor);
    expect(impostorBundle.identityKey).not.toBe((await peerIdentityBinding(alice.store, BOB))?.identityKey);
    await expectPeerError(
      initiatePeerSession({ identity: alice.identity, localStore: alice.store, remoteBundle: impostorBundle }),
      "peer_identity_changed"
    );
    // The original pin survives the failed attempt.
    const binding = await peerIdentityBinding(alice.store, BOB);
    expect(binding?.state).toBe("active");
    await expectPeerError(
      pinPeerIdentity(alice.store, { peerId: BOB, identityKey: base64urlDecode(impostorBundle.identityKey, 512)! }),
      "peer_identity_changed"
    );
  });

  it("responder-side trust check refuses a forged prekey message under a pinned peerId", async () => {
    const alice = await makeDevice(ALICE);
    const bob = await makeDevice(BOB);
    await pairSessions(alice, bob);

    // An attacker with a different identity forges an envelope as ALICE.
    const mallory = await makeDevice("peer.mallory.1");
    const bobBundle = await generatePrekeyBundle(bob.identity);
    const mallorySession = await initiatePeerSession({
      identity: mallory.identity,
      localStore: mallory.store,
      remoteBundle: bobBundle
    });
    const forged = await mallorySession.encrypt(new TextEncoder().encode("i am alice"));
    const forgedEnvelope = serializePeerEnvelope(
      { senderPeerId: ALICE, senderDeviceId: 1 },
      forged
    );
    const { PeerCryptoSession } = await import("@meshrix/peer-crypto");
    const pinnedSession = new PeerCryptoSession({
      identity: bob.identity,
      localStore: bob.store,
      peerId: ALICE,
      direction: "responder"
    });
    await expectPeerError(pinnedSession.decryptEnvelope(forgedEnvelope), "peer_identity_changed");
    // Bob's pinned record for alice is untouched.
    expect((await peerIdentityBinding(bob.store, ALICE))?.state).toBe("active");
  });

  it("blocks a pin explicitly and completes the honest re-pair path", async () => {
    const alice = await makeDevice(ALICE);
    const bob = await makeDevice(BOB);
    const { aliceSession, bobSession } = await pairSessions(alice, bob);

    // A blocked pin refuses every later trust decision for that peer.
    await blockPeerIdentity(alice.store, BOB);
    const ciphertext = await bobSession.encrypt(new TextEncoder().encode("after block"));
    await expectPeerError(aliceSession.decryptEnvelope(envelopeOf(bobSession, ciphertext)), "peer_identity_changed");
    await expectPeerError(
      resumePeerSession({ identity: alice.identity, localStore: alice.store, peerId: BOB }),
      "peer_identity_changed"
    );

    // Explicit re-pair: the caller supplies the peer's NEW key; the pin is
    // replaced at generation + 1 and the stale ratchet is destroyed.
    const bobReplacement = await makeDevice(BOB);
    const newKey = bobReplacement.identity.publicKey.serialize();
    const repinned = await repinPeerIdentity(alice.store, BOB, newKey);
    expect(repinned.state).toBe("active");
    expect(repinned.trustGeneration).toBe(2);
    expect(await peerSessionExists(alice.store, BOB)).toBe(false);

    // The stale ratchet is gone; decrypting old-session traffic must fail honestly.
    await expectPeerError(aliceSession.decryptEnvelope(envelopeOf(bobSession, ciphertext)), "peer_session_broken");

    const freshBundle = await generatePrekeyBundle(bobReplacement.identity);
    const reInitiated = await initiatePeerSession({
      identity: alice.identity,
      localStore: alice.store,
      remoteBundle: freshBundle
    });
    const first = await reInitiated.encrypt(new TextEncoder().encode("after re-pair"));
    expect(first.messageType).toBe("prekey");
    const accepted = await acceptPeerSession({
      identity: bobReplacement.identity,
      localStore: bobReplacement.store,
      envelope: envelopeOf(reInitiated, first)
    });
    expect(new TextDecoder().decode(accepted.plaintext)).toBe("after re-pair");
  });

  it("fails prekey bundle minting with peer_prekey_exhausted and recovers via replenish", async () => {
    const store = createInMemoryPeerCryptoStore();
    const identity = await createPeerIdentity({
      localStore: store,
      peerId: "peer.pool.1",
      prekeyPool: { oneTimeCount: 1, kyberCount: 1 }
    });
    await generatePrekeyBundle(identity);
    await expectPeerError(generatePrekeyBundle(identity), "peer_prekey_exhausted");
    await replenishPeerPrekeys(identity, { oneTimeCount: 1, kyberCount: 1 });
    const bundle = await generatePrekeyBundle(identity);
    expect(bundle.format).toBe(PEER_PREKEY_BUNDLE_FORMAT);
    expect(bundle.oneTimePreKey?.id).toBe(2);
    expect(bundle.kyberPreKey.id).toBe(2);
  });

  it("rejects malformed envelopes and bundles without fabricating decrypt state", async () => {
    const alice = await makeDevice(ALICE);
    const bob = await makeDevice(BOB);
    const { aliceSession, bobSession } = await pairSessions(alice, bob);
    const valid = envelopeOf(aliceSession, await aliceSession.encrypt(new TextEncoder().encode("x")));

    expect(parsePeerEnvelope({ ...valid, extra: true })).toBeNull();
    expect(parsePeerEnvelope({ ...valid, body: "!!!" })).toBeNull();
    expect(parsePeerEnvelope({ ...valid, messageType: "senderkey" })).toBeNull();
    expect(parsePeerEnvelope({ ...valid, format: "other" })).toBeNull();
    expect(parsePeerEnvelope("not an envelope")).toBeNull();
    expect(decodePeerEnvelope(new TextEncoder().encode("{"))).toBeNull();
    await expectPeerError(bobSession.decryptEnvelope({ ...valid, body: "!!!" }), "peer_envelope_malformed");
    await expectPeerError(
      bobSession.decryptEnvelope({ ...valid, senderPeerId: "peer.impostor.9" }),
      "peer_envelope_malformed"
    );
    await expectPeerError(
      initiatePeerSession({ identity: alice.identity, localStore: alice.store, remoteBundle: { bogus: 1 } }),
      "peer_envelope_malformed"
    );
    expect(parsePeerPrekeyBundle({ ...(await generatePrekeyBundle(bob.identity)), signedPreKey: null })).toBeNull();

    // Encoded form round-trips through bytes.
    const encoded = encodePeerEnvelope(valid);
    const decoded = decodePeerEnvelope(encoded);
    expect(decoded?.senderPeerId).toBe(ALICE);
    expect(new TextDecoder().decode(await bobSession.decryptEnvelope(JSON.parse(new TextDecoder().decode(encoded))))).toBe("x");
    expect(decoded?.body.length).toBeGreaterThan(0);
  });

  it("persists identity, bindings, prekeys and ratchet state across store reload", async () => {
    const root = await mkdtemp(join(tmpdir(), "peer-crypto-test-"));
    try {
      const alice = await makeDevice(ALICE);
      const bobStore = createFilePeerCryptoStore(root);
      const bob = await createPeerIdentity({ localStore: bobStore, peerId: BOB });
      const { aliceSession } = await pairSessions(alice, { store: bobStore, identity: bob });
      const ciphertext = await aliceSession.encrypt(new TextEncoder().encode("persist me"));
      const envelope = envelopeOf(aliceSession, ciphertext);

      // Everything is durable: identity file, pins, session and remaining prekeys.
      const files = await readdir(root);
      expect(files.sort()).toEqual(expect.arrayContaining(["identity.json", "meta.json", "peers", "sessions", "prekeys", "signed-prekeys", "kyber-prekeys"]));
      const peerFiles = await readdir(join(root, "peers"));
      expect(peerFiles.length).toBe(1);
      const sessionFiles = await readdir(join(root, "sessions"));
      expect(sessionFiles.length).toBe(1);
      // Owner-only permissions on secret material.
      const mode = (await stat(join(root, "identity.json"))).mode & 0o777;
      expect(mode).toBe(0o600);

      // Reload from disk: the identity, the pin and the ratchet all resume.
      const reloadedStore = createFilePeerCryptoStore(root);
      const reloaded = await loadPeerIdentity(reloadedStore);
      expect(reloaded?.peerId).toBe(BOB);
      expect(reloaded?.registrationId).toBe(bob.registrationId);
      const resumed = await resumePeerSession({
        identity: reloaded!,
        localStore: reloadedStore,
        peerId: ALICE,
        direction: "responder"
      });
      expect(new TextDecoder().decode(await resumed.decryptEnvelope(envelope))).toBe("persist me");
      const reply = await resumed.encrypt(new TextEncoder().encode("from reloaded"));
      expect(new TextDecoder().decode(await aliceSession.decryptEnvelope(envelopeOf(resumed, reply)))).toBe("from reloaded");
      // A second device identity in the same store is refused, not overwritten.
      await expectPeerError(createPeerIdentity({ localStore: reloadedStore, peerId: "peer.other.1" }), "peer_state_invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes only public material: no private key bytes reach wire or log surfaces", async () => {
    const alice = await makeDevice(ALICE);
    const bob = await makeDevice(BOB);
    const { aliceSession } = await pairSessions(alice, bob);
    const bundle = await generatePrekeyBundle(alice.identity);
    const ciphertext = await aliceSession.encrypt(new TextEncoder().encode("covert"));
    const envelope = envelopeOf(aliceSession, ciphertext);

    const surfaces = [
      JSON.stringify(alice.identity),
      JSON.stringify(bundle),
      JSON.stringify(envelope),
      JSON.stringify(await peerIdentityBinding(alice.store, BOB))
    ].join("\n");
    // The identity's own serialized private material must never appear.
    const record = await alice.store.loadIdentity();
    expect(record).not.toBeNull();
    expect(surfaces).not.toContain(record!.identityKeyPair);
    const privateKeyBytes = base64urlDecode(record!.identityKeyPair, 4096)!;
    expect(surfaces).not.toContain(Buffer.from(privateKeyBytes).toString("base64url"));
    expect(surfaces).not.toMatch(/privateKey|secretKey/i);
    // Public identity keys DO appear — they are the publishable material.
    expect(JSON.stringify(alice.identity)).toContain(bundle.identityKey);
    expect(envelope.format).toBe(PEER_ENVELOPE_FORMAT);
    for (const code of PEER_CRYPTO_ERROR_CODES) {
      expect(typeof code).toBe("string");
    }
  });

  it("computes a stable pairwise safety number over both identity keys", async () => {
    const alice = await makeDevice(ALICE);
    const bob = await makeDevice(BOB);
    const { bobSession } = await pairSessions(alice, bob);
    const bobBinding = await peerIdentityBinding(alice.store, BOB);
    const aliceBinding = await peerIdentityBinding(bob.store, ALICE);
    const aliceSide = peerSafetyNumber(alice.identity, {
      peerId: BOB,
      identityKey: base64urlDecode(bobBinding!.identityKey, 512)!
    });
    const bobSide = peerSafetyNumber(bob.identity, {
      peerId: ALICE,
      identityKey: base64urlDecode(aliceBinding!.identityKey, 512)!
    });
    expect(aliceSide).toBe(bobSide);
    expect(aliceSide.length).toBeGreaterThan(20);
    expect(bobSession.direction).toBe("responder");
    expect(peerSessionAddressKey(BOB, 1)).toBe("1--peer.bob.1");
  });
});
