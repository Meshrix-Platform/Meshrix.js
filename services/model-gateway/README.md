# Model Gateway Service

Contract version: `v0.0.1:model-gateway:service-1`.

The Model Gateway Service is an independently deployable, language-neutral HTTP and
JSON service. It never imports Meshrix runtime code, never discovers or contacts a
Meshrix process, and owns its own health, readiness, model calls, model and provider
management, routing, pricing revisions, client authentication, admission, settlement,
cancellation, stable errors, and idempotency. It has no dependency on the External
Gateway Runtime Plugin and is not included in the Meshrix runtime-ui image or offline
bundle.

## Supported request surface

The service uses the standard API endpoint paths and needs no Meshrix-only
translation endpoint, while enforcing a deliberately priced subset of each
request format:

- OpenAI standard: `POST /v1/chat/completions`, `GET /v1/models`
- Anthropic standard: `POST /v1/messages`

Calls accept string prompts and text-only client-tool history. OpenAI assistant
function-call messages may use `content: null`, followed by string tool results;
Anthropic messages may carry client `tool_use` and string/text-only
`tool_result` blocks, plus supported thinking blocks needed to continue those
conversations. Requests with image, audio, video, document, or other non-text
content; provider-managed or
remote tools; prompt-cache controls; unpriced pricing/destination selectors;
or unknown fields are rejected before provider credentials are read or egress
starts. OpenAI organization/project headers and the Anthropic beta header are
also rejected because they can change billing authority or enable features
outside the configured token rates. OpenAI `x-client-request-id` remains a
correlation header; the configured provider credential determines the upstream
account and endpoint.

## Meshrix-owned contract paths

- `GET /health` — liveness without side effects.
- `GET /ready` — readiness including admission and persistence state.
- `GET /v1/model-gateway/pricing` — immutable pricing revisions.
- `GET /v1/model-gateway/pricing-revisions` — same revisions (management list).
- `POST /v1/model-gateway/pricing-revisions` — create one immutable pricing revision.
- `GET/POST /v1/model-gateway/models` — service-owned model management.
- `GET/POST /v1/model-gateway/providers` — service-owned provider management.
- `POST /v1/model-gateway/calls/{call_id}/cancel` — request cancellation.
- `GET /v1/model-gateway/ledger/{call_id}` — bounded call-ledger facts.

## Admission and settlement

Before provider egress the Service enforces bounded request rate, input-token
budget, requested output-token budget, total-token quota, concurrent calls, and
cost quota against authenticated tenant, subject, workload, model, provider, and
policy-revision partitions. A denial resolves no provider credential and causes
no egress. Each pricing revision and both token-rate amounts must use the
configured admission-policy currency. Missing or inconsistent pricing fails
before egress. Because the Service cannot query a provider's live price table,
operators must set the input and output rates to at least the highest
applicable per-token price category for the selected model, provider account,
and endpoint. The input ceiling must include every applicable input category,
including automatic prompt-cache writes, long-context thresholds, and regional
rates. The output ceiling must include every applicable output category,
including long-context thresholds and regional rates. The provider schedule
determines which categories apply. This matters even though callers cannot
select cache-retention or service-tier options. The
configured rates are operator-supplied ceilings for quota admission and ledger
estimates; they are not verified provider prices or a guarantee of invoice
totals. Before enabling or changing a model, provider account, endpoint, or
region, operators must review its current provider price categories. Pricing
revisions are immutable and are not updated from provider price tables; if an
existing revision is below any applicable category, create a new revision and
bind the model to it before sending traffic. The Service does not rewrite
stored pricing revisions automatically.

Preflight input usage counts the UTF-8 byte length of the full accepted JSON
body, plus an 804-token Anthropic client-tool prompt allowance. This includes
CJK, emoji, tool schemas, system prompts, tool history, and accepted text
controls. Anthropic publishes model- and tool-choice-specific system-prompt
overheads for tool use; as of 2026-10-08, 804 is the largest value in its
[published table](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview#pricing)
(Opus 4.7 with `any`/`tool`). Before enabling client tools for any other or
newly published Anthropic model alias, operators must confirm its documented
tool overhead remains at or below 804; this service has no per-model overhead
setting. Byte and overhead estimates may overestimate provider usage. A custom
`http` provider may transform the request. After provider-reported usage settles the
call, admission and ledger accounting still use the operator-supplied ceilings;
neither that accounting nor the request estimate proves provider invoice
totals.

Every provider-bound call has one Service-owned ledger bound to the authenticated client subject,
model identity, an immutable pricing revision, and currency. A single provider
POST is recorded as `in_doubt` durably before egress; a confirmed response with
valid provider usage changes it to `settled`. Any uncertain provider outcome
stays `in_doubt`, and the Service never automatically repeats a model POST.
Cancellation reports whether an active request was interrupted; if it has
already ended with an uncertain provider outcome, cancellation reports
`in_doubt` and does not claim that provider-side work or charges were undone.
If a provider completes after cancellation, valid usage and the response are
still settled durably, while the original caller receives `cancelled`. A later
authenticated request with the same idempotency key can recover that receipt
without another provider request.
Per-token prices preserve exact nanounits. Admission reserves cost using the
operator-supplied input/output ceilings and estimated/requested token counts.
Settlement multiplies provider-reported usage by those same rates, aggregates
the exact amounts, then conservatively rounds the total up once to the nearest
microcurrency unit (`10^6` ledger scale); a token is never rounded individually.
Provider invoice amounts may differ, including when the configured ceiling is
too low for an applicable provider price category.
This follows [RFC 9110 §9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2): a client cannot assume a failed non-idempotent request had no effect.

An optional `Idempotency-Key` header, scoped to the authenticated subject and
request body, replays a settled response without a second provider egress. Reuse
with a different request is rejected; a pending or uncertain call returns
`settlement_uncertain` with automatic retry disabled. Keys are not forwarded to
provider APIs. Missing provider usage leaves the call `in_doubt` instead of
recording zero-cost settlement. Provider-side billing remains subject to the
provider's own contract and accounting.

OpenAI requests reserve `max_completion_tokens` (or the legacy `max_tokens`)
multiplied by `n`. If no output cap is supplied, the Service forwards
`max_completion_tokens: 1024` and reserves one such completion. Conflicting
`max_tokens` and `max_completion_tokens` fields are rejected before egress.
The cap follows the [OpenAI Chat Completions request reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), which defines `max_completion_tokens` as the generated-token limit and `n` as the number of choices.

## Stable errors

`unauthorized`, `rate_limited`, `quota_exceeded`, `budget_exceeded`,
`invalid_request`, `model_not_found`, `provider_unavailable`, `cancelled`,
`settlement_uncertain`, `completed_response_unavailable`, `internal_error`.

## Configuration

The Service has no runtime dependency on Meshrix. Environment variables:

- `PORT` — listen port (default `8080`; `0` selects an ephemeral port).
- `HOST` — listen host (default `127.0.0.1`; the service image binds `0.0.0.0`
  for container networking).
- `MODEL_GATEWAY_ALLOW_PUBLIC_BIND` — required to set `HOST` to a non-loopback
  address (`1`, `true` or `yes`); keeps exposure an explicit operator decision.
- `MODEL_GATEWAY_DATA_ROOT` — independent data root (default `/var/lib/model-gateway`).
- `MAX_REQUEST_BYTES` — bounded JSON request body size (default 2 MiB, max 4 MiB).
- `MODEL_GATEWAY_CLIENTS` — JSON object of `clientId` to `{subject, secret, scopes}`
  entries; each secret must contain between 32 and 512 bytes.
- `MODEL_GATEWAY_MAX_RATE_PER_SECOND`, `MODEL_GATEWAY_MAX_INPUT_TOKEN_BUDGET`,
  `MODEL_GATEWAY_MAX_REQUESTED_OUTPUT_TOKEN_BUDGET`, `MODEL_GATEWAY_MAX_TOTAL_TOKEN_QUOTA`,
  `MODEL_GATEWAY_MAX_CONCURRENT_CALLS`, `MODEL_GATEWAY_MAX_COST_QUOTA_UNITS`,
  `MODEL_GATEWAY_CURRENCY` — admission bounds for one policy revision.

The data root keeps `state.json` (client identifiers and scopes, admission policy, providers, models,
immutable pricing revisions) written atomically, `ledger.sqlite` (incremental durable accounting and idempotency records),
`provider-egress.json` (operator-owned provider base URLs) and `secrets.json`
(provider credentials, mode `0600`), plus `.model-gateway-owner.sqlite` for the
live process lock. Client secrets are read only from the
current `MODEL_GATEWAY_CLIENTS` configuration and are not persisted. Provider
egress and credentials are resolved only after admission, never on denial, and
never enter logs or responses. One service process owns this data root at a
time. Startup acquires a SQLite-held operating-system lock before reading or
reconciling state; a competing process fails startup. Orderly shutdown closes
admission, drains active calls and durable writes, then releases the lock.
Process termination releases the OS lock. Keep the root on a filesystem that
supports SQLite locking and do not remove its owner database while the service
is active. Provider URLs use HTTPS; HTTP is limited to
numeric loopback addresses for local development. Redirects are rejected, and
provider responses are capped at 8 MiB. Cancellation is propagated to the
provider request; the provider POST has no implicit connection, response-header,
body-idle, or attempt timeout. Callers retain cancellation ownership, and the
service closes only its own Undici dispatcher after active provider calls and
durable writes finish.
The service listener itself speaks plain HTTP. Keep it on a private trusted
network or terminate TLS at an authenticated ingress before sending bearer
credentials across an untrusted network.

Provider egress forwards only the OpenAI client-request-ID correlation header
and the Anthropic protocol-version header. OpenAI organization/project and
Anthropic beta headers are rejected at the service boundary. Client
authentication, cookies, idempotency keys, response request IDs, and other
caller headers are not forwarded; the configured provider credential is the
only upstream authentication value.

## Build, test, and run

```sh
npm ci
npm test
npm run build
npm start
```

Build the OCI artifact:

```sh
docker build -t meshrix/model-gateway:0.0.1 .
```


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
