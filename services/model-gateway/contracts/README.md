# Model Gateway Service Contract

Contract version: `v0.0.1:model-gateway:service-1`

The Model Gateway Service is an independently deployable, language-neutral HTTP and
JSON service. It never imports Meshrix runtime code, never discovers or contacts a
Meshrix process, and owns its own health, readiness, model calls, model and provider
management, routing, pricing revisions, client authentication, admission, settlement,
cancellation, stable errors, and idempotency.

## Supported request surface

The service uses the standard API endpoint paths and requires no Meshrix-only
translation endpoint, while enforcing a deliberately priced subset of each
request format:

- OpenAI standard: `POST /v1/chat/completions`, `GET /v1/models`
- Anthropic standard: `POST /v1/messages`

Calls accept string prompts and text-only client-tool history. OpenAI assistant
function-call messages may use `content: null`, followed by string tool results;
Anthropic messages may carry client `tool_use` and string/text-only
`tool_result` blocks, plus supported thinking blocks needed to continue those
conversations. Multimodal content, provider-managed or remote tools, prompt-cache controls, unpriced
pricing/destination selectors, and unknown request fields are rejected before
provider egress. OpenAI organization/project headers and Anthropic beta headers
are rejected because they can change billing authority or enable features
outside the configured token rates. OpenAI `x-client-request-id` remains a
correlation header; the configured provider credential controls the upstream
account and endpoint.

## Meshrix-owned contract paths

- `GET /health` — liveness without side effects.
- `GET /ready` — readiness including admission and persistence state.
- `GET /v1/model-gateway/pricing` — immutable pricing revisions.
- `GET /v1/model-gateway/ledger/{call_id}` — bounded call-ledger facts.

## Admission and settlement

Before provider egress the Service enforces bounded request rate, input-token
budget, requested output-token budget, total-token quota, concurrent calls, and
cost quota against authenticated tenant, subject, workload, model, provider, and
policy-revision partitions. A denial resolves no provider credential and causes
no egress.
The pricing revision and each token-rate amount use the configured admission
currency. Rates preserve exact nanounit precision. Missing or inconsistent
pricing fails before egress. Since the Service cannot query provider pricing,
operators must set the input and output rates to at least the highest
applicable per-token category for the selected model, provider account, and
endpoint. The input ceiling must include every applicable input category,
including automatic prompt-cache writes, long-context thresholds, and regional
rates. The output ceiling must include every applicable output category,
including long-context thresholds and regional rates. The provider schedule
determines which categories apply. This matters even though callers cannot
select cache-retention or service-tier options. These operator-supplied
rates are ceilings for quota admission and ledger estimates, not verified
provider prices or a guarantee of invoice totals. Before enabling or changing
a model, provider account, endpoint, or region, operators must review current
provider price categories. Pricing revisions are immutable and are not updated
from provider price tables; if an existing revision is below any applicable
category, create a new revision and bind the model to it before sending
traffic. The Service does not rewrite stored pricing revisions automatically.

Preflight input usage counts the UTF-8 byte length of the complete accepted
JSON body, plus an 804-token Anthropic client-tool prompt allowance. This
includes CJK, emoji, tool schemas, system prompts, tool history, and accepted
text controls. Anthropic publishes model- and tool-choice-specific system
prompt overheads for tool use; as of 2026-10-08, 804 is the largest value in
its [published table](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview#pricing)
(Opus 4.7 with `any`/`tool`). Before enabling client tools for any other or
newly published Anthropic model alias, operators must confirm its documented
tool overhead remains at or below 804; the Service has no per-model overhead
setting. The estimate may overestimate provider usage. A custom `http` provider
may transform the request. Admission reserves cost with operator-supplied ceilings
and estimated/requested token counts; settlement uses provider-reported usage
against the same rates. Neither the local estimate nor settlement proves
provider invoice totals.

Every provider-bound call has one Service-owned idempotent ledger bound to its
authenticated subject, model identity, immutable pricing revision, and currency.
The Service persists `in_doubt` before its single provider POST. A valid response
with provider usage settles the entry; ambiguous or unaccounted outcomes remain
`in_doubt`. The Service does not automatically retry provider POSTs. Amounts are
fixed-point integers at scale `10^6`; exact token-rate nanounits are multiplied
and aggregated first, then the total charge is rounded up once to that ledger
unit. Missing or invalid provider usage does not settle as zero; actual provider
billing remains governed by the provider's accounting contract. If operator
ceilings are too low for an applicable price category, the local ledger still
uses those configured rates and can understate the provider invoice.

An optional `Idempotency-Key` is scoped to the authenticated subject and request
body. A settled match is replayed without provider egress; a different request
using the same key is rejected; pending and uncertain matches return
`settlement_uncertain`. The key is not sent to the provider.
Cancellation remains the original caller's outcome even if the provider returns
a late success. Valid late usage and its response are still settled durably, so
a subsequent matching idempotency request recovers the completed result without
another provider POST.

Provider egress forwards only the OpenAI client-request-ID correlation header
and Anthropic protocol-version header. OpenAI organization/project and
Anthropic beta headers are rejected at the service boundary. Client
authentication, cookies, idempotency keys, response request IDs, and other
caller headers are not forwarded; the configured provider credential is the
only upstream authentication value.

## Stable errors

`unauthorized`, `rate_limited`, `quota_exceeded`, `budget_exceeded`,
`invalid_request`, `model_not_found`, `provider_unavailable`, `cancelled`,
`settlement_uncertain`, `completed_response_unavailable`, `internal_error`.

The complete wire schema is frozen in `openapi.json`; `service-contract.v1.json`
is the closed ownership and admission metadata projection of that API.


## Request, accounting, and egress boundaries

All authenticated native and managed routes acquire process-wide and authenticated
subject concurrency before body consumption. Body-reading routes also reserve
bounded bytes; a missing length reserves the request ceiling. Read-only discovery
and ledger routes consume concurrency without inventing a body reservation.
NAT addresses do not combine different subjects. Accepted work retains its slot
until completion or caller cancellation; aggregate admission adds no task deadline.

`MODEL_GATEWAY_MAX_GLOBAL_CONCURRENT_CALLS` (256),
`MODEL_GATEWAY_MAX_SUBJECT_CONCURRENT_CALLS` (64),
`MODEL_GATEWAY_MAX_GLOBAL_REQUEST_BYTES` (64 MiB), and
`MODEL_GATEWAY_MAX_SUBJECT_REQUEST_BYTES` (16 MiB) configure HTTP capacity.
`MODEL_GATEWAY_MAX_SUBJECT_TOTAL_TOKEN_QUOTA` and
`MODEL_GATEWAY_MAX_SUBJECT_COST_QUOTA_MICROS` default to the existing token/cost
quota. Global equivalents default to four times those quotas. Subject/global
`MAX_*_RATE_PER_SECOND` settings similarly default to one/four times the partition
rate, using durable refill buckets for actual provider effects. The separate
`MODEL_GATEWAY_MAX_SUBJECT_REQUEST_RATE_PER_SECOND` (100) and
`MODEL_GATEWAY_MAX_GLOBAL_REQUEST_RATE_PER_SECOND` (400) bound all authenticated
HTTP work before body reads, including malformed inputs and management routes.
These quotas aggregate
models and providers, are committed before external effects, and survive restart.
The reservation remains conservative when actual usage is smaller and increases
when reported usage is larger. Configuration changes do not erase prior paid facts.

Accounting, complete request-key bindings, and uncertain effects are kept in
`ledger.sqlite`, with bounded SQLite memory and indexed incremental writes. Startup
transactionally transfers an existing JSON ledger, then removes its superseded
field only after success. A repeated transfer after a crash does not revert a
record already committed to the new store. No request rewrites historical records.
`MODEL_GATEWAY_MAX_LEDGER_PENDING_ENTRIES` (1024) denies new provider effects when
uncertain capacity is exhausted. Existing uncertain and historical facts remain
readable; operator resolution or a deliberate capacity change is needed before
further effects. Raising capacity never retries an uncertain operation automatically.

Complete paid results remain in the durable SQLite ledger. Only serialized RAM
replay copies are bounded by `MODEL_GATEWAY_MAX_LEDGER_SETTLED_ENTRIES` (512) and
`MODEL_GATEWAY_MAX_LEDGER_RESPONSE_BYTES` (16 MiB). An LRU cache miss reads the
same complete result from SQLite; it never removes data or repeats a provider POST.
SQLite's page cache is separately bounded to 4 MiB. Restart and capacity pressure
preserve complete results, request-key bindings and accounting. Changed content
under a known key remains a conflict. Records already missing a response due to
an earlier defect return non-retryable `409 completed_response_unavailable` with
the original `service_call_id`; that protective error never reexecutes paid work.
`GET /v1/model-gateway/ledger/{call_id}` exposes minimum accounting with independent
`ledger:read` authority, separately from full result replay.

Management catalogs require `model:read` or `model:manage`. Native model discovery
retains its authenticated-client contract; `model:call` cannot inspect managed
provider or pricing records solely because it can invoke a model.

Provider destinations are operator-owned configuration, never request URLs. Public
providers require HTTPS, valid TLS, and public addresses at the actual connection.
The connector checks every DNS result and connects using that checked result;
redirects are rejected and credentials remain bound to the configured origin.
Literal loopback URLs retain the documented local-provider capability. A literal
RFC1918 or IPv6 ULA HTTPS URL grants that exact operator-configured LAN destination.
Internal DNS providers require a bounded exact `egressPolicy.allowedAddresses` list
in their `provider-egress.json` entry. Metadata, link-local and other special ranges
require an explicit exact address grant even for literal URLs.
This is an explicit destination grant, not general private-network authority;
new DNS results outside it fail closed. No arbitrary provider timeout or automatic
retry is introduced. A provider that ignores cancellation may still complete;
its returned usage is durably settled before cancellation is reported.


Implementation references: [Node 24 SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html),
[Node DNS lookup](https://nodejs.org/docs/latest-v24.x/api/dns.html#dnslookuphostname-options-callback),
and [Undici connection options](https://github.com/nodejs/undici/blob/main/docs/docs/api/Client.md).
The service already requires Node 24 and uses `node:sqlite` for data-root ownership;
this storage change introduces no runtime dependency or engine increase.
