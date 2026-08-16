# Model Gateway Service

Contract version: `v0.0.1:model-gateway:service-1`.

The Model Gateway Service is an independently deployable, language-neutral HTTP and
JSON service. It never imports Meshrix runtime code, never discovers or contacts a
Meshrix process, and owns its own health, readiness, model calls, model and provider
management, routing, pricing revisions, client authentication, admission, settlement,
cancellation, stable errors, and idempotency. It has no dependency on the External
Gateway Runtime Plugin and is not included in the Meshrix runtime-ui image or offline
bundle.

## Native wire compatibility

The direct-call surface is natively wire-compatible with the standard APIs and
requires no Meshrix-only translation endpoint:

- OpenAI standard: `POST /v1/chat/completions`, `GET /v1/models`
- Anthropic standard: `POST /v1/messages`

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
no egress.

Every admitted call has one Service-owned idempotent ledger bound to model
identity, an immutable pricing revision, currency, reservation, and a terminal
`released`, `settled`, or `in_doubt` state with fixed-point amounts and bounded
per-attempt usage. `settled` is terminal; `in_doubt` may settle later. Amounts
are fixed-point integers at scale `10^6`.

An optional `Idempotency-Key` header replays a settled call without a second
provider egress and returns `settlement_uncertain` for a pending or uncertain
call.

## Stable errors

`unauthorized`, `rate_limited`, `quota_exceeded`, `budget_exceeded`,
`invalid_request`, `model_not_found`, `provider_unavailable`, `cancelled`,
`settlement_uncertain`, `internal_error`.

## Configuration

The Service has no runtime dependency on Meshrix. Environment variables:

- `PORT` — listen port (default `8080`; `0` selects an ephemeral port).
- `HOST` — listen host (default `0.0.0.0`).
- `MODEL_GATEWAY_DATA_ROOT` — independent data root (default `/var/lib/model-gateway`).
- `MAX_REQUEST_BYTES` — bounded JSON request body size (default 2 MiB, max 4 MiB).
- `MODEL_GATEWAY_CLIENTS` — JSON object of `clientId` to `{subject, secret, scopes}`
  entries; each secret must contain between 32 and 512 bytes.
- `MODEL_GATEWAY_MAX_RATE_PER_SECOND`, `MODEL_GATEWAY_MAX_INPUT_TOKEN_BUDGET`,
  `MODEL_GATEWAY_MAX_REQUESTED_OUTPUT_TOKEN_BUDGET`, `MODEL_GATEWAY_MAX_TOTAL_TOKEN_QUOTA`,
  `MODEL_GATEWAY_MAX_CONCURRENT_CALLS`, `MODEL_GATEWAY_MAX_COST_QUOTA_UNITS`,
  `MODEL_GATEWAY_CURRENCY` — admission bounds for one policy revision.
- `MODEL_GATEWAY_REQUEST_TIMEOUT_MS` — per-provider attempt timeout (default 30000).
- `MODEL_GATEWAY_MAX_ATTEMPTS` — bounded per-call provider attempts (default 3, max 16).

The data root keeps `state.json` (clients, admission policy, providers, models,
immutable pricing revisions, and the idempotent call ledger) written atomically,
`provider-egress.json` (operator-owned provider base URLs) and `secrets.json`
(provider credentials, mode `0600`). Provider egress and credentials are resolved
only after admission, never on denial, and never enter logs or responses.

## Build, test, and run

```sh
npm install
npm test
npm run build
npm start
```

Build the OCI artifact:

```sh
docker build -t meshrix/model-gateway:0.0.1 .
```
