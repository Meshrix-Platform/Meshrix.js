# Model Gateway Service Contract

Contract version: `v0.0.1:model-gateway:service-1`

The Model Gateway Service is an independently deployable, language-neutral HTTP and
JSON service. It never imports Meshrix runtime code, never discovers or contacts a
Meshrix process, and owns its own health, readiness, model calls, model and provider
management, routing, pricing revisions, client authentication, admission, settlement,
cancellation, stable errors, and idempotency.

## Native wire compatibility

The direct-call surface is natively wire-compatible with the standard APIs and
requires no Meshrix-only translation endpoint:

- OpenAI standard: `POST /v1/chat/completions`, `GET /v1/models`
- Anthropic standard: `POST /v1/messages`

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

Every admitted call has one Service-owned idempotent ledger bound to model
identity, an immutable pricing revision, currency, reservation, and a terminal
`released`, `settled`, or `in_doubt` state with fixed-point amounts and bounded
per-attempt usage. `settled` is terminal; `in_doubt` may settle later. Amounts
are fixed-point integers at scale `10^6`.

## Stable errors

`unauthorized`, `rate_limited`, `quota_exceeded`, `budget_exceeded`,
`invalid_request`, `model_not_found`, `provider_unavailable`, `cancelled`,
`settlement_uncertain`, `internal_error`.

The complete wire schema is frozen in `openapi.json`; `service-contract.v1.json`
is the closed ownership and admission metadata projection of that API.
