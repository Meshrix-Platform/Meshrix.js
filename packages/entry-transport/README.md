# `@meshrix/entry-transport`

Entry-side transport and local MCP adaptation for the private-relay delivery
profile. The package carries the portable local MCP interface: authenticated
plaintext exists only inside the trusted entry, and every byte crossing the
relay travels inside the qualified `meshrix-private-relay/0` contract as an
opaque TLS record payload.

## Composition

```text
local MCP client
  -> stdio / loopback HTTP adapter (newline-framed JSON-RPC; no operational
     text on stdout; loopback listener enforces an explicit Origin allowlist)
  -> EntryMcpBridge (method forwarding + faithful GatewayOutcome projection)
  -> inner request channel (bounded, newline-delimited, per-request dispatch
     evidence)
  -> inner pinned mutual TLS 1.3 (entry presents its paired device
     certificate and pins the endpoint SPKI)
  -> relay frame duplex (bounded, honest backpressure)
  -> PrivateRelaySession (admission, cursors, reconnect generation)
  -> RelayTransportPort over real WebSocket/WSS (`undici` WebSocket)
```

Outer relay admission is never inner endpoint authentication: the endpoint's
semantic authorization context derives from the pinned inner channel and its
own trust store, not from anything the relay observed.

## Honest outcomes

- New work submitted while the route is `unreachable` — or while no inner
  channel is established — fails with `endpoint_unreachable`
  (`effectOutcome: "not_started"`). It is never silently queued.
- A request that was dispatched and then lost (channel, TLS or transport
  failure) reports `operation_status_unknown` (`effectOutcome: "unknown"`);
  an operation-query can resolve its endpoint-side ledger state.
- A request that provably never left the entry reports `not_started` with
  local evidence, the only retry-safe outcome.
- Relay frame acknowledgements are never treated as endpoint consumption or
  execution proof.
