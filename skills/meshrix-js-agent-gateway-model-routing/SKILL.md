---
name: meshrix-js-agent-gateway-model-routing
description: Guide the Meshrix.js model-agent configuration, authorization, routing, execution, health, and cost-accounting capability flow. Use for Agent Gateway calls, model libraries, module agent profiles, provider selection, circuit breaking, or model-routing evidence.
---

# Meshrix.js Agent Gateway Model Routing

Read `docs/functionality/AGENT-GATEWAY.md` and the security authorization contract before changing this capability line.

## Canonical transaction

1. Read only real entries from the agent configuration registry. Empty user configuration remains empty; templates are creation choices, never active models.
2. Permit model-library mutation only when Agent Management is explicitly enabled. Validate the closed schema, lock across processes, compare the expected revision, and atomically switch to an immutable generation.
3. Filter selectable agents by `moduleAccess`. Compose runtime input in this order: connection identity, `moduleAgentProfiles` parameters, then session or task context.
4. Submit `agent_gateway.call` through Operation Permission with `model:call`, the target agent, module visibility, risk, and resource limits bound.
5. Resolve credential references only after authorization, target validation, and allowlisted egress checks pass.
6. Select only candidates that satisfy explicit configuration, permission, health, rate, concurrency, and circuit-breaker policy.
7. Bound retries and fallback. Only retry failures explicitly classified as transient provider or transport failures. Authorization, egress, schema, credential, and policy failures terminate immediately. Update circuit state and stop when the allowed candidate set is exhausted.
8. Filter the provider response, update low-cardinality health and cost facts, and return a source-safe result.

## Boundaries and failure semantics

- Model calls are `safe_write` because user content leaves the process boundary.
- Core edition must not silently activate the standard Agent Gateway surface.
- Model records and credential references belong to the agent registry, not general settings.
- A cross-document registry/settings change uses the durable transaction journal.
- Missing profiles, credentials, routes, or allowed egress fail closed; never synthesize a default provider.
- Prompts, tokens, credentials, provider bodies, and raw provider errors do not enter evidence.

## Ownership and routing

The Agent Gateway owns configured candidate selection and routing state. Route governed execution to `$meshrix-js-operation-permission`, credential and egress enforcement to `$meshrix-js-security-authorization`, and transport-boundary changes to `$meshrix-js-protocol-gateway`.

## Verification

Run `npm test` for the current baseline. Empty configuration, disabled management, module denial, missing credentials, invalid egress, bounded concurrency, circuit recovery, candidate exhaustion, generation crash recovery, response redaction, and low-cardinality accounting remain acceptance requirements. Until a catalog-backed routing task proves them together, capability-line readiness remains remaining required work. Select available evidence with `$meshrix-js-regression-planner`.
