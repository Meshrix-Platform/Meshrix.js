import { Buffer } from "node:buffer";

import {
  CiphertextMessageType,
  ErrorCode,
  Fingerprint,
  KEMPublicKey,
  LibSignalErrorBase,
  PreKeyBundle,
  PreKeySignalMessage,
  ProtocolAddress,
  PublicKey,
  signalDecrypt,
  signalDecryptPreKey,
  signalEncrypt,
  SignalMessage,
  processPreKeyBundle
} from "@signalapp/libsignal-client";

import { parsePeerPrekeyBundle, type PeerPrekeyBundle } from "./bundle.ts";
import {
  parsePeerEnvelope,
  type ParsedPeerEnvelope,
  type PeerCiphertext,
  type PeerCiphertextType,
  type PeerSessionHeader
} from "./envelope.ts";
import { isPeerCryptoError, peerCryptoError, type PeerCryptoError } from "./errors.ts";
import type { PeerIdentity } from "./identity.ts";
import { createSignalStoreBridges, type SignalStoreBridgeSet } from "./signal-bridge.ts";
import {
  parsePeerSessionAddressKey,
  peerSessionAddressKey,
  type PeerCryptoStore,
  type PeerIdentityBinding
} from "./store.ts";
import {
  assertPeerId,
  base64urlDecode,
  base64urlEncode,
  PEER_DEVICE_ID,
  PEER_MAX_CIPHERTEXT_BYTES,
  PEER_MAX_PLAINTEXT_BYTES,
  PEER_SAFETY_NUMBER_ITERATIONS,
  PEER_SAFETY_NUMBER_VERSION,
  toExactBytes
} from "./types.ts";

/**
 * Sesame-style session surface: one active Double Ratchet session per
 * (peerId, PEER_DEVICE_ID) pair, resolved by the sender's opaque peerId.
 * The store keeps the pinned identity binding authoritative — a remote key
 * that differs from the pin aborts with `peer_identity_changed` before any
 * cryptographic state is touched, and recovery is the explicit re-pair path
 * (`repinPeerIdentity`), never silent re-trust.
 */

/** "resumed" marks a session restored from durable state whose original role is unknown to this layer. */
export type PeerSessionDirection = "initiator" | "responder" | "resumed";

function mapSignalError(error: unknown, sessionBrokenFallback: string): PeerCryptoError {
  if (error instanceof LibSignalErrorBase) {
    if (error.is(ErrorCode.UntrustedIdentity)) {
      return peerCryptoError("peer_identity_changed", "The remote identity key differs from the pinned record; explicit re-pair is required.", { cause: error });
    }
    if (error.is(ErrorCode.DuplicatedMessage)) {
      return peerCryptoError("peer_duplicate_message", "The ciphertext was already processed by this session; delivery evidence only.", { cause: error });
    }
    if (error.is(ErrorCode.InvalidSession)) {
      return peerCryptoError("peer_session_broken", sessionBrokenFallback, { cause: error });
    }
  }
  if (isPeerCryptoError(error)) {
    return error;
  }
  return peerCryptoError("peer_message_unauthentic", "The ciphertext could not be authenticated or decrypted.", { cause: error });
}

export class PeerCryptoSession {
  readonly peerId: string;
  readonly peerDeviceId: number;
  readonly direction: PeerSessionDirection;
  readonly establishedAt: string | null;
  readonly #identity: PeerIdentity;
  readonly #store: PeerCryptoStore;
  readonly #bridges: SignalStoreBridgeSet;
  readonly #peerAddress: ProtocolAddress;
  readonly #localAddress: ProtocolAddress;

  constructor(input: {
    readonly identity: PeerIdentity;
    readonly localStore: PeerCryptoStore;
    readonly peerId: string;
    readonly peerDeviceId?: number;
    readonly direction: PeerSessionDirection;
    readonly establishedAt?: string | null;
  }) {
    this.#identity = input.identity;
    this.#store = input.localStore;
    this.peerId = assertPeerId(input.peerId);
    this.peerDeviceId = input.peerDeviceId ?? PEER_DEVICE_ID;
    this.direction = input.direction;
    this.establishedAt = input.establishedAt === undefined ? new Date().toISOString() : input.establishedAt;
    this.#bridges = createSignalStoreBridges(this.#store, this.#identity);
    this.#peerAddress = ProtocolAddress.new(this.peerId, this.peerDeviceId);
    this.#localAddress = ProtocolAddress.new(this.#identity.peerId, this.#identity.deviceId);
  }

  /** Envelope routing header this session stamps on outbound ciphertext. */
  envelopeHeader(): PeerSessionHeader {
    return Object.freeze({
      senderPeerId: this.#identity.peerId,
      senderDeviceId: this.#identity.deviceId
    });
  }

  /** The remote identity key currently pinned for this session's peer (public bytes). */
  async remoteIdentityKey(): Promise<Uint8Array | null> {
    const binding = await this.#store.loadPeerBinding(this.peerId);
    if (!binding || binding.state !== "active") return null;
    return base64urlDecode(binding.identityKey, 512);
  }

  /** The local store backing this session (for the wire layer's diagnostics). */
  get localStore(): PeerCryptoStore {
    return this.#store;
  }

  #addressKey(): string {
    return peerSessionAddressKey(this.peerId, this.peerDeviceId);
  }

  /** True when a persisted session record exists for this peer pair. */
  async hasEstablishedSession(): Promise<boolean> {
    return (await this.#store.loadSession(this.#addressKey())) !== null;
  }

  /**
   * Double Ratchet encrypt. The first message on an initiator session is a
   * PreKey ciphertext automatically; later messages are Whisper. The session
   * record is rewritten through the durable store on every call.
   */
  async encrypt(plaintext: Uint8Array): Promise<PeerCiphertext> {
    if (!(plaintext instanceof Uint8Array) || plaintext.length === 0 || plaintext.length > PEER_MAX_PLAINTEXT_BYTES) {
      throw peerCryptoError("peer_envelope_malformed", "The plaintext is empty or exceeds the peer message bound.");
    }
    if (!(await this.hasEstablishedSession())) {
      throw peerCryptoError("peer_session_broken", `No established session exists for peer ${this.peerId}; initiate or accept a session first.`);
    }
    let ciphertext;
    try {
      ciphertext = await signalEncrypt(
        toExactBytes(plaintext),
        this.#peerAddress,
        this.#localAddress,
        this.#bridges.sessions,
        this.#bridges.identities
      );
    } catch (error: unknown) {
      throw mapSignalError(error, `The session for peer ${this.peerId} cannot encrypt.`);
    }
    const type = ciphertext.type();
    const messageType: PeerCiphertextType = type === CiphertextMessageType.PreKey
      ? "prekey"
      : type === CiphertextMessageType.Whisper
        ? "signal"
        : (() => { throw peerCryptoError("peer_state_invalid", "The session produced a non-direct-message ciphertext type."); })();
    return Object.freeze({ messageType, body: ciphertext.serialize() });
  }

  /** Decrypt a typed ciphertext for this session's peer. */
  async decrypt(ciphertext: PeerCiphertext): Promise<Uint8Array> {
    return this.#decryptBody(ciphertext.messageType, ciphertext.body);
  }

  /**
   * Decrypt an inbound envelope: strict parse, sender binding to this session,
   * then dispatch on the declared message type.
   */
  async decryptEnvelope(value: unknown): Promise<Uint8Array> {
    const parsed = parsePeerEnvelope(value);
    if (!parsed) {
      throw peerCryptoError("peer_envelope_malformed", "The inbound value is not a valid peer envelope.");
    }
    if (parsed.senderPeerId !== this.peerId || parsed.senderDeviceId !== this.peerDeviceId) {
      throw peerCryptoError("peer_envelope_malformed", "The envelope sender does not match this session's peer.");
    }
    return this.#decryptBody(parsed.messageType, parsed.body);
  }

  async #decryptBody(messageType: PeerCiphertextType, body: Uint8Array): Promise<Uint8Array> {
    if (!(await this.hasEstablishedSession()) && messageType !== "prekey") {
      throw peerCryptoError("peer_session_broken", `No established session exists for peer ${this.peerId}.`);
    }
    try {
      if (messageType === "prekey") {
        let message: PreKeySignalMessage;
        try {
          message = PreKeySignalMessage.deserialize(toExactBytes(body));
        } catch (error: unknown) {
          throw peerCryptoError("peer_envelope_malformed", "The prekey ciphertext cannot be deserialized.", { cause: error });
        }
        return await signalDecryptPreKey(
          message,
          this.#peerAddress,
          this.#localAddress,
          this.#bridges.sessions,
          this.#bridges.identities,
          this.#bridges.preKeys,
          this.#bridges.signedPreKeys,
          this.#bridges.kyberPreKeys
        );
      }
      let message: SignalMessage;
      try {
        message = SignalMessage.deserialize(toExactBytes(body));
      } catch (error: unknown) {
        throw peerCryptoError("peer_envelope_malformed", "The signal ciphertext cannot be deserialized.", { cause: error });
      }
      return await signalDecrypt(
        message,
        this.#peerAddress,
        this.#localAddress,
        this.#bridges.sessions,
        this.#bridges.identities
      );
    } catch (error: unknown) {
      throw mapSignalError(error, `The session for peer ${this.peerId} cannot decrypt.`);
    }
  }
}

function bundleToNative(bundle: PeerPrekeyBundle): PreKeyBundle {
  const identityKeyBytes = base64urlDecode(bundle.identityKey, 512);
  const signedPubBytes = base64urlDecode(bundle.signedPreKey.publicKey, 512);
  const signedSigBytes = base64urlDecode(bundle.signedPreKey.signature, 1024);
  const kyberPubBytes = base64urlDecode(bundle.kyberPreKey.publicKey, 4096);
  const kyberSigBytes = base64urlDecode(bundle.kyberPreKey.signature, 1024);
  if (!identityKeyBytes || !signedPubBytes || !signedSigBytes || !kyberPubBytes || !kyberSigBytes) {
    throw peerCryptoError("peer_envelope_malformed", "The remote prekey bundle carries undecodable key material.");
  }
  let oneTimePub: PublicKey | null = null;
  let oneTimeId: number | null = null;
  if (bundle.oneTimePreKey !== null) {
    const bytes = base64urlDecode(bundle.oneTimePreKey.publicKey, 512);
    if (!bytes) {
      throw peerCryptoError("peer_envelope_malformed", "The remote one-time prekey cannot be decoded.");
    }
    oneTimePub = PublicKey.deserialize(toExactBytes(bytes));
    oneTimeId = bundle.oneTimePreKey.id;
  }
  try {
    return PreKeyBundle.new(
      bundle.registrationId,
      bundle.deviceId,
      oneTimeId,
      oneTimePub,
      bundle.signedPreKey.id,
      PublicKey.deserialize(toExactBytes(signedPubBytes)),
      toExactBytes(signedSigBytes),
      PublicKey.deserialize(toExactBytes(identityKeyBytes)),
      bundle.kyberPreKey.id,
      KEMPublicKey.deserialize(toExactBytes(kyberPubBytes)),
      toExactBytes(kyberSigBytes)
    );
  } catch (error: unknown) {
    throw peerCryptoError("peer_envelope_malformed", "The remote prekey bundle cannot be assembled.", { cause: error });
  }
}

export interface InitiatePeerSessionInput {
  readonly identity: PeerIdentity;
  readonly localStore: PeerCryptoStore;
  /** The remote peer's bundle — the serialized contract value or a parsed one. */
  readonly remoteBundle: unknown;
}

/**
 * X3DH/PQXDH initiator: validates the remote bundle, enforces the pinned
 * identity binding (first contact pins; a differing key aborts with
 * `peer_identity_changed` — never silent re-trust), then processes the bundle
 * into a live session. The first `encrypt` emits a `prekey` ciphertext.
 */
export async function initiatePeerSession(input: InitiatePeerSessionInput): Promise<PeerCryptoSession> {
  const bundle = parsePeerPrekeyBundle(input.remoteBundle);
  if (!bundle) {
    throw peerCryptoError("peer_envelope_malformed", "The remote prekey bundle does not satisfy the peer bundle contract.");
  }
  if (bundle.peerId === input.identity.peerId) {
    throw peerCryptoError("peer_state_invalid", "A device cannot initiate a peer session to its own identity.");
  }
  const existing = await input.localStore.loadPeerBinding(bundle.peerId);
  if (existing) {
    const matches = existing.state === "active"
      && existing.deviceId === bundle.deviceId
      && existing.identityKey === bundle.identityKey;
    if (!matches) {
      throw peerCryptoError("peer_identity_changed", `Remote identity for ${bundle.peerId} differs from the pinned record; explicit re-pair is required.`);
    }
  } else {
    await input.localStore.savePeerBinding(Object.freeze({
      peerId: bundle.peerId,
      deviceId: bundle.deviceId,
      identityKey: bundle.identityKey,
      trustGeneration: 1,
      pinnedAt: new Date().toISOString(),
      state: "active" as const
    }));
  }
  const session = new PeerCryptoSession({
    identity: input.identity,
    localStore: input.localStore,
    peerId: bundle.peerId,
    peerDeviceId: bundle.deviceId,
    direction: "initiator"
  });
  const bridges = createSignalStoreBridges(input.localStore, input.identity);
  try {
    await processPreKeyBundle(
      bundleToNative(bundle),
      ProtocolAddress.new(bundle.peerId, bundle.deviceId),
      ProtocolAddress.new(input.identity.peerId, input.identity.deviceId),
      bridges.sessions,
      bridges.identities
    );
  } catch (error: unknown) {
    throw mapSignalError(error, `The session for peer ${bundle.peerId} cannot be initiated.`);
  }
  return session;
}

export interface AcceptPeerSessionInput {
  readonly identity: PeerIdentity;
  readonly localStore: PeerCryptoStore;
  /** The inbound peer envelope carrying the initiator's first prekey ciphertext. */
  readonly envelope: unknown;
}

export interface AcceptedPeerSession {
  readonly session: PeerCryptoSession;
  readonly plaintext: Uint8Array;
}

/**
 * X3DH/PQXDH responder: accepts the initiator's first prekey envelope,
 * establishes the session (the embedded sender identity is pinned inside the
 * decrypt path — a mismatch with the pin aborts `peer_identity_changed`), and
 * returns the first plaintext alongside the live session.
 */
export async function acceptPeerSession(input: AcceptPeerSessionInput): Promise<AcceptedPeerSession> {
  const parsed: ParsedPeerEnvelope | null = parsePeerEnvelope(input.envelope);
  if (!parsed) {
    throw peerCryptoError("peer_envelope_malformed", "The inbound value is not a valid peer envelope.");
  }
  if (parsed.messageType !== "prekey") {
    throw peerCryptoError("peer_envelope_malformed", "acceptPeerSession expects an envelope of messageType \"prekey\".");
  }
  if (parsed.senderPeerId === input.identity.peerId) {
    throw peerCryptoError("peer_state_invalid", "A device cannot accept a peer session from its own identity.");
  }
  const session = new PeerCryptoSession({
    identity: input.identity,
    localStore: input.localStore,
    peerId: parsed.senderPeerId,
    peerDeviceId: parsed.senderDeviceId,
    direction: "responder"
  });
  const plaintext = await session.decrypt(parsed);
  return Object.freeze({ session, plaintext });
}

/**
 * Resume an existing session for a peer after restart — no new handshake.
 * A missing session record or a non-active pin fails honestly.
 */
export async function resumePeerSession(input: {
  readonly identity: PeerIdentity;
  readonly localStore: PeerCryptoStore;
  readonly peerId: string;
  readonly peerDeviceId?: number;
  /** Callers that recorded their original role may re-declare it; otherwise "resumed". */
  readonly direction?: "initiator" | "responder";
}): Promise<PeerCryptoSession> {
  const peerId = assertPeerId(input.peerId);
  const deviceId = input.peerDeviceId ?? PEER_DEVICE_ID;
  const binding = await input.localStore.loadPeerBinding(peerId);
  if (!binding || binding.state !== "active") {
    throw peerCryptoError("peer_identity_changed", `No active pinned identity exists for peer ${peerId}.`);
  }
  const record = await input.localStore.loadSession(peerSessionAddressKey(peerId, deviceId));
  if (!record) {
    throw peerCryptoError("peer_session_broken", `No established session exists for peer ${peerId}.`);
  }
  return new PeerCryptoSession({
    identity: input.identity,
    localStore: input.localStore,
    peerId,
    peerDeviceId: deviceId,
    direction: input.direction ?? "resumed",
    establishedAt: null
  });
}

/** True when a session record exists for the peer pair. */
export async function peerSessionExists(localStore: PeerCryptoStore, peerId: string, peerDeviceId: number = PEER_DEVICE_ID): Promise<boolean> {
  return (await localStore.loadSession(peerSessionAddressKey(assertPeerId(peerId), peerDeviceId))) !== null;
}

/**
 * Pairing-layer pin: records the remote identity key explicitly (e.g. from an
 * authenticated pairing exchange) so first contact cannot silently trust a
 * different key. An existing different pin refuses with
 * `peer_identity_changed` — use `repinPeerIdentity` for re-pair.
 */
export async function pinPeerIdentity(
  localStore: PeerCryptoStore,
  input: { readonly peerId: string; readonly identityKey: Uint8Array; readonly peerDeviceId?: number }
): Promise<PeerIdentityBinding> {
  const peerId = assertPeerId(input.peerId);
  const deviceId = input.peerDeviceId ?? PEER_DEVICE_ID;
  const encoded = base64urlEncode(input.identityKey);
  const existing = await localStore.loadPeerBinding(peerId);
  if (existing) {
    if (existing.state === "active" && existing.identityKey === encoded && existing.deviceId === deviceId) {
      return existing;
    }
    throw peerCryptoError("peer_identity_changed", `A pinned identity for ${peerId} already exists and differs; explicit re-pair is required.`);
  }
  const binding: PeerIdentityBinding = Object.freeze({
    peerId,
    deviceId,
    identityKey: encoded,
    trustGeneration: 1,
    pinnedAt: new Date().toISOString(),
    state: "active"
  });
  await localStore.savePeerBinding(binding);
  return binding;
}

/**
 * Explicit re-pair path: the ONLY sanctioned way to accept a changed remote
 * identity key. The caller supplies the peer's new key — learned through the
 * authorized pairing exchange, never inferred from wire traffic — and the pin
 * is replaced at trustGeneration + 1 while every stale ratchet record for the
 * peer is dropped, so no cryptographic state survives across a trust
 * generation boundary.
 */
export async function repinPeerIdentity(
  localStore: PeerCryptoStore,
  peerId: string,
  newIdentityKey: Uint8Array,
  options: { readonly peerDeviceId?: number } = {}
): Promise<PeerIdentityBinding> {
  const checked = assertPeerId(peerId);
  const deviceId = options.peerDeviceId ?? PEER_DEVICE_ID;
  if (!(newIdentityKey instanceof Uint8Array) || newIdentityKey.length === 0 || newIdentityKey.length > 512) {
    throw peerCryptoError("peer_envelope_malformed", "The re-pair identity key is not a valid public key encoding.");
  }
  // Validate the key is a real curve point before it becomes the trust root.
  PublicKey.deserialize(toExactBytes(newIdentityKey));
  const existing = await localStore.loadPeerBinding(checked);
  const binding: PeerIdentityBinding = Object.freeze({
    peerId: checked,
    deviceId,
    identityKey: base64urlEncode(newIdentityKey),
    trustGeneration: (existing?.trustGeneration ?? 0) + 1,
    pinnedAt: new Date().toISOString(),
    state: "active"
  });
  await localStore.savePeerBinding(binding);
  // Sweep every session recorded for this peer — across all device ids — so a
  // stale ratchet can never answer under the new trust generation. Keys are
  // parsed, not suffix-matched: peerIds may themselves contain "--".
  for (const key of await localStore.listSessionKeys()) {
    const parsed = parsePeerSessionAddressKey(key);
    if (parsed && parsed.name === checked) {
      await localStore.deleteSession(key);
    }
  }
  return binding;
}

/** Mark a pin as blocked: keeps the record as evidence; every later trust check refuses. */
export async function blockPeerIdentity(localStore: PeerCryptoStore, peerId: string): Promise<PeerIdentityBinding | null> {
  const checked = assertPeerId(peerId);
  const existing = await localStore.loadPeerBinding(checked);
  if (!existing) return null;
  const blocked: PeerIdentityBinding = Object.freeze({ ...existing, state: "blocked" as const });
  await localStore.savePeerBinding(blocked);
  return blocked;
}

export async function peerIdentityBinding(localStore: PeerCryptoStore, peerId: string): Promise<PeerIdentityBinding | null> {
  return localStore.loadPeerBinding(assertPeerId(peerId));
}

/**
 * Safety number for out-of-band verification, per the Signal fingerprint
 * construction over both identity keys and the opaque peer identifiers.
 */
export function peerSafetyNumber(identity: PeerIdentity, remote: { readonly peerId: string; readonly identityKey: Uint8Array }): string {
  const remoteBytes = remote.identityKey instanceof Uint8Array && remote.identityKey.length <= PEER_MAX_CIPHERTEXT_BYTES
    ? remote.identityKey
    : null;
  if (!remoteBytes) {
    throw peerCryptoError("peer_envelope_malformed", "The remote identity key is not decodable for the safety number.");
  }
  const fingerprint = Fingerprint.new(
    PEER_SAFETY_NUMBER_ITERATIONS,
    PEER_SAFETY_NUMBER_VERSION,
    toExactBytes(Buffer.from(identity.peerId, "utf8")),
    identity.publicKey,
    toExactBytes(Buffer.from(assertPeerId(remote.peerId), "utf8")),
    PublicKey.deserialize(toExactBytes(remoteBytes))
  );
  return fingerprint.displayableFingerprint().toString();
}
