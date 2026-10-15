# `@meshrix/peer-client`

`@meshrix/peer-client` provides device-local durable messaging over the
private relay's online forwarding channel. It composes the Signal PQXDH and
Double Ratchet implementation in `@meshrix/peer-crypto` with an authenticated
route identity, a pairing-pinned peer directory, and a host-supplied session
transport.

The relay forwards encrypted messages only while the recipient is reachable.
It does not keep an offline mailbox or store business messages, delivery
receipts, task state, or results. The sender retains the exact ciphertext in
its local outbox until it verifies a signed receipt from the recipient. The
recipient commits decrypted data and its ratchet changes to local durable
storage before signing that receipt. Application dispatch is tracked
separately, so a deferred handler remains recoverable after transport delivery
has settled.

## Delivery behavior

- `sendMessage()` records the exact encrypted envelope locally before trying
  online forwarding. An uncertain or unreachable attempt leaves the entry
  pending. Retries reuse its tuple and ciphertext; only a verified signed
  `peer-delivery-ack` changes the outbox state to `delivered`.
- A recipient's durable inbox is keyed by tenant, route, sender device,
  recipient device, and message id. An exact duplicate replays its stored
  receipt without decrypting or dispatching again. Reuse of that tuple with
  different ciphertext is a conflict. A Signal-level duplicate under a new
  message id is retained as skipped evidence and receives no delivery receipt.
- The receipt signs a domain-separated transcript with the sender device's
  existing Signal identity key. The sender verifies it only against the
  identity persisted by authenticated pairing. Relay-provided identity data
  never establishes trust.
- Durable inbox receipt and application handoff are independent. A handler
  result of `deferred`, or a temporary exception, leaves the dispatch pending
  for `retryPendingDispatch()` or `resume()`. The host acknowledges application
  acceptance only after its own journal commit.
- Peer presence is route-scoped retry information, not authority. A reachable
  transition wakes pending ciphertext and receipt retries. The relay carries
  presence and control messages without retaining business payloads.
- A live-session `authority_stale`, `rate_limited`, or `backpressured` result
  retries the same durable tuple with exponential backoff from one to thirty
  seconds, with no retry deadline. An unreachable peer waits for its presence
  wakeup. Disposing the client clears only in-memory timers; the durable
  message remains available to the next client instance.

## Host integration

The host supplies a Signal identity, its `PeerCryptoStore`, a route-scoped
`PeerClientStore`, the currently admitted session transport, and a directory
that resolves a paired device to the identity established by pairing:

```ts
const client = new PeerClient({
  identity,
  cryptoStore,
  clientStore: createFilePeerClientStore(localStateDirectory),
  transport, // send(message), onMessage(handler)
  route: { tenantId, routeId, deviceId },
  directory: staticPeerDirectory({
    "dev.bob": peerIdentityPublicDescriptor(bobIdentity)
  })
});

client.onInboundMessage(async (message) => {
  // Return accepted_by_agent only after the host journal has committed.
  await applicationJournal.commit(message);
  return "accepted_by_agent";
});
client.on("peerPresence", (presence) => {
  // Presence can wake UI or retry work; pairing remains the authority.
});

await client.publishBundle();
await client.resume(); // recover local WAL, pending receipts, dispatch, and sends
const state = await client.sendMessage("dev.bob", encodedApplicationEvent);
await client.dispose(); // clear retry timers and drain queued durable writes before retiring storage
```

`presence(peerDeviceId)` returns the latest route-scoped peer reachability
observation. `outbox.pendingPage()` / `outbox.historyPage()` and the matching
inbox page methods expose bounded local projections using ascending local
sequence cursors. These cursors are device-local indexes; they are not relay
mailbox positions.

The client transports opaque ciphertext only. It does not execute application
content or infer Agent task state; the application protocol and host journal
own those semantics. Historical records from the retired mailbox model are
preserved locally during transition and are never sent as active authority or
used as proof of signed delivery.
