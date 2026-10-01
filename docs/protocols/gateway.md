# Gateway protocol boundary

The modern MCP boundary uses protocol version `2026-07-28`. It accepts one
JSON-RPC request per POST, rejects batches, checks matching method metadata,
and does not gate access on a client product name. `clientInfo` is descriptive
only. These protocols define the peer contract, tagged result semantics, and
the standard request/response boundary.

Modern upstream requests are request-level and do not send `initialize`.
Legacy versions `2025-03-26`, `2025-06-18`, and `2025-11-25` are isolated in
their own adapter, where initialization and session headers are explicit.

External JSON Schemas are validated as JSON Schema 2020-12 without remote
reference fetching. Schema budgets and validation budgets are separate from
semantic errors. Business payloads are preserved by ownership tables; only
documented protocol URI/name slots are namespaced.

## Public failure projection

Public failures are closed. `GATEWAY_PUBLIC_FAILURES` in the Gateway contract
owns the stable code/message/status vocabulary that projects a thrown or
foreign error; anything else becomes the origin's stable fallback. Internal
exception messages, arbitrary codes, causes and stack data never cross the
boundary, and failure `details` carry only declared facts (`receiptId`, a
bounded numeric peer `errorCode`, and the schema `phase`).

An upstream JSON-RPC error keeps its bounded numeric code as the declared
protocol fact; peer `message` and arbitrary peer `data` are replaced with a
stable public message. Authentication failures use a closed message by status
class and may carry only the platform's bounded reason code. Tool `result.isError`
remains a successful tool result with its governed business payload.
