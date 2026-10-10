# `@meshrix/peer-client`

Device-side durable peer messaging client for `DEC-PEER-ENCRYPTED-MAILBOX`.
The package composes the `@meshrix/peer-crypto` Signal session layer
(PQXDH prekey exchange + Double Ratchet) with the private-relay peer
mailbox wire contract into a reliable, honest delivery surface. It runs on
the admitted session channel a device already owns — all 13 peer wire
kinds are request/response on that channel, with `peer-messages` pages
pushed as wakeups and `peer-fetch` as the always-correct fallback.

## Composition

```text
PeerClient (lane-serialized operations + typed events)
  ├── PeerOutbox            durable sender-scoped sends + receipt states
  ├── PeerInbox             durable dedup'd inbound entries + cursor + tombstones
  ├── ReceiptReconciler     peer-receipt → peer-status pulls for lost replies
  ├── PeerClientStore       durable port: FilePeerClientStore | InMemory
  ├── PeerCryptoStore       crypto layer's own store (sessions, pins, prekeys)
  ├── PeerClientTransport   host port: send() + onMessage() on the session channel
  └── PeerDeviceDirectory   host port: wire device id → crypto peer id
```

## Delivery semantics

- **Outbox.** `sendMessage` persists `pending` first, then sends the exact
  stored wire envelope. `accepted`/`duplicate` both record the mailbox's
  accepted receipt and position — `duplicate` is the honest success for a
  retry. `conflict` (same sender scope, different bytes) is terminal,
  surfaced, never retried. A lost `peer-accepted` is recovered by
  `peer-receipt`/`peer-status` reconciliation; a send the mailbox provably
  never recorded past the attempt bound is surfaced `unrecorded`.
- **Inbox.** Every fetched/stored message dedups on `(messageId,
  position)` before decrypt or dispatch; the decrypt output commits to the
  store before the host sees it; each page closes with an idempotent
  `peer-ack` (`received[]` + queued application `reports[]`) and only then
  does the durable cursor advance. `gaps[]` tombstones persist and surface
  as `lostRange` events — a lost range is never silently skipped.
- **Receipts.** `accepted` is the mailbox's, `received` is the recipient's,
  and `accepted_by_agent`/`completed`/`rejected` are independent agent
  reports (`peer-ack` `reports[]`), never derived from acknowledgements.
- **Trust.** `peer_identity_changed` emits `requiresRePair` and blocks
  delivery; the only recovery is the explicit `repinPeer` re-pair call —
  never silent re-trust. `peer_prekey_exhausted` triggers one
  replenish-and-retry, then surfaces.

## Dispatch boundary — no agent authority

`PeerDispatchSurface.onInboundMessage` hands the host
`{messageId, position, senderPeerId, senderDeviceId, plaintext,
receivedAt}` and awaits `"accepted_by_agent" | "rejected"` (optionally
with a detail payload). The client reports that outcome back as the
application receipt. **The client never executes message content, never
calls runtime control, and never interprets plaintext semantics.** The
handler is the product's trust boundary: what it does with bytes is the
host's decision, on the host's authority.

## Wiring (what the product layer supplies)

```ts
const client = new PeerClient({
  identity,                          // loadPeerIdentity(store) result
  cryptoStore,                       // FilePeerCryptoStore
  clientStore: createFilePeerClientStore(dir),
  transport,                         // { send(msg), onMessage(handler) }
  route: { tenantId, routeId, deviceId },   // admitted session identity
  directory: staticPeerDirectory({ "dev.bob": "peer.bob.1" }), // optional
});
client.onInboundMessage(async (msg) => "accepted_by_agent");
client.on("requiresRePair", ({ peerId }) => /* out-of-band re-pair UX */);
await client.publishBundle();                 // advertise our prekeys
await client.sendMessage("dev.bob", bytes);   // first send: prekey type
await client.resume();                        // after restart/reconnect
await client.reportOutcome(messageId, "completed");
```

`handleInboundMessage(obj)` is the manual demux entry when a transport
cannot offer `onMessage`. `resume()` retries pending sends (same ids, same
envelopes), reconciles receipts, flushes queued reports and runs the fetch
loop — the session itself resumes lazily from the durable crypto store.

## Honesty rules this layer keeps

- Never fabricates a receipt, position, plaintext or acceptance.
- Never retries a `conflict`, never auto-repairs a changed identity.
- Never drops an ack entry silently — mailbox refusals surface with
  reasons (`ackRefused`), dispatch failures surface (`dispatchFailed`),
  undecryptable input is stored as evidence (`decryptFailure`).
- Never exposes plaintext to the mailbox or the log path; the wire
  envelope stays an opaque ciphertext carrier.
