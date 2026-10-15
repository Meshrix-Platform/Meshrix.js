# `@meshrix/peer-crypto`

Device-side Signal protocol layer for one-to-one peer messaging over the
online private relay. The package owns everything that must never
reach the relay: PQXDH-family prekey exchange, Double Ratchet sessions,
Sesame-style single-session resolution per peer pair, and the durable secret
store. The relay forwards only the opaque peer envelope; plaintext and key
material remain device-local.

## Composition

```text
pairing layer (opaque peerId authority)
  -> createPeerIdentity / loadPeerIdentity (X25519 identity keypair + registration id)
  -> generatePrekeyBundle (published X3DH/PQXDH bundle; consumes prekey pool entries)
  -> initiatePeerSession (initiator: pins remote identity key, processes bundle)
  -> acceptPeerSession  (responder: pins on first contact, first plaintext back)
  -> PeerCryptoSession.encrypt/decrypt (Double Ratchet, out-of-order tolerant)
  -> serializePeerEnvelope / parsePeerEnvelope (wire seam for NODE-PEER-WIRE)
```

`@signalapp/libsignal-client` 0.104.0 supplies all cryptographic primitives —
this package implements no crypto of its own. Prebuilt N-API bindings ship
for darwin-arm64, darwin-x64, linux-x64/arm64 and win32-x64/arm64.

## Trust and honesty

- Remote identity keys pin on first contact (`PeerIdentityBinding`); a
  presented key differing from the pin fails `peer_identity_changed` —
  recovery is the explicit `repinPeerIdentity` re-pair path, never silent
  re-trust. `pinPeerIdentity` lets the pairing layer pre-pin a key learned
  through an authenticated exchange.
- `peer_prekey_exhausted`, `peer_session_broken`, `peer_envelope_malformed`,
  `peer_duplicate_message` and `peer_message_unauthentic` are typed errors;
  no failure fabricates a decryption result.
- `FilePeerCryptoStore` writes one JSON record per key under owner-only
  permissions via atomic temp-file rename; `PeerIdentity.toJSON()` and every
  wire projection carry public material only — private key bytes never reach
  serialized or logged output.
