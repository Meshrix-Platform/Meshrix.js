/**
 * `@meshrix/peer-crypto` — device-side Signal protocol layer for one-to-one
 * peer messaging (DEC-PEER-ENCRYPTED-MAILBOX).
 *
 * X3DH/PQXDH-family prekey exchange + Double Ratchet via the Node-native
 * `@signalapp/libsignal-client` bindings; Sesame-style resolution keeps one
 * active session per peer pair; pinned remote identities never silently
 * re-trust a changed key. The relay/mailbox stores ciphertext envelopes only.
 */

export {
  PEER_CRYPTO_ERROR_CODES,
  isPeerCryptoError,
  peerCryptoError,
  type PeerCryptoError,
  type PeerCryptoErrorCode
} from "./errors.ts";

export {
  PEER_CIPHERTEXT_TYPES,
  decodePeerEnvelope,
  encodePeerEnvelope,
  parsePeerEnvelope,
  serializePeerEnvelope,
  type ParsedPeerEnvelope,
  type PeerCiphertext,
  type PeerCiphertextType,
  type PeerEnvelope,
  type PeerSessionHeader
} from "./envelope.ts";

export {
  generatePrekeyBundle,
  parsePeerPrekeyBundle,
  type PeerPrekeyBundle
} from "./bundle.ts";

export {
  createPeerIdentity,
  loadPeerIdentity,
  replenishPeerPrekeys,
  rotateSignedPreKey,
  PeerIdentity,
  type CreatePeerIdentityOptions,
  type PeerPrekeyPoolSize
} from "./identity.ts";

export {
  createInMemoryPeerCryptoStore,
  InMemoryPeerCryptoStore,
  peerSessionAddressKey,
  parsePeerSessionAddressKey,
  type PeerCryptoCounters,
  type PeerCryptoStore,
  type PeerIdentityBinding,
  type PeerIdentitySecretRecord,
  type PeerPrekeyState,
  type StoredPreKeyEntry,
  type StoredPreKeyRecord
} from "./store.ts";

export {
  createFilePeerCryptoStore,
  FilePeerCryptoStore
} from "./file-store.ts";

export {
  acceptPeerSession,
  blockPeerIdentity,
  initiatePeerSession,
  peerIdentityBinding,
  peerSafetyNumber,
  peerSessionExists,
  pinPeerIdentity,
  repinPeerIdentity,
  resumePeerSession,
  PeerCryptoSession,
  type AcceptedPeerSession,
  type AcceptPeerSessionInput,
  type InitiatePeerSessionInput,
  type PeerSessionDirection
} from "./session.ts";

export {
  assertPeerId,
  base64urlDecode,
  base64urlEncode,
  PEER_DEFAULT_KYBER_PREKEY_COUNT,
  PEER_DEFAULT_ONE_TIME_PREKEY_COUNT,
  PEER_DEVICE_ID,
  PEER_ENVELOPE_FORMAT,
  PEER_ENVELOPE_VERSION,
  PEER_ID_PATTERN,
  PEER_MAX_CIPHERTEXT_BYTES,
  PEER_MAX_ENVELOPE_BYTES,
  PEER_MAX_PLAINTEXT_BYTES,
  PEER_PREKEY_BUNDLE_FORMAT,
  PEER_PREKEY_BUNDLE_VERSION
} from "./types.ts";
