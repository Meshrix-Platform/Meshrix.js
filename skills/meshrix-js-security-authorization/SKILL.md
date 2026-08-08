---
name: meshrix-js-security-authorization
description: Maintain Meshrix.js end-to-end authorization invariants, workload and process identity, resource binding, capability provenance, execution-side revalidation, secret references, risk policy, audit redaction, and security release gates. Use for any security-sensitive Core or gateway change, especially internal operation dispatch, delegated execution, asynchronous resume, authorization caching, or resource-policy semantics.
---

# Meshrix.js Security Authorization

## Enforce one authorization invariant

Normalize every non-public decision to principal, action, resource, and context. Bind the decision to
the authenticated identity, accepted principal kind, operation contract, required scopes or
capabilities, concrete target, audience, request digest, current policy and grant revisions, expiry,
risk, and approval facts. Deny when any required fact is absent, malformed, stale, conflicting, or
ambiguous, or when no explicit permit matches.

Treat transport, process co-location, loopback, an internal route name, and a generic `system` actor
as routing or execution facts only. They never confer authority. Give agents, maintenance workers,
plugins, queues, and runtime services first-class, narrowly scoped workload principals.

Require every registered non-public operation to own one canonical authorization contract. Derive
discovery, preflight, execution, audit, and UI projections from that contract. Do not maintain
parallel authored flags, transport-local policy, role-name shortcuts, or fallback decisions.

## Preserve capability provenance

Represent preauthorization with a short-lived immutable envelope or opaque in-process capability
minted by one private authority. Bind it to the principal, operation, action, target digest,
audience, request digest, current revisions, approval, and expiry. Reject copied fields as proof,
boolean skip flags, reusable bearer authority, target substitution, audience mismatch, replay, and
stale envelopes.

Inject narrow operation ports into internal consumers when their operation set is known. Do not
expose a generic dispatcher as production authority or let a caller choose a stronger actor,
audience, capability set, or resource-binding kind.

## Revalidate before effects

Use discovery and preflight to reject early, never as permanent authorization. Resolve current
principal, grant, policy, resource, approval, and workload-generation facts again after locks,
queueing, approval waits, retries, recovery, or resume and immediately before the first external or
durable side effect. A changed or unknown fact denies without invoking the handler effect.

Persist only the minimum redacted authorization intent and stable references for asynchronous work.
Never persist a reusable allow decision, raw envelope, private capability, token, secret, or runtime
payload as execution authority.

## Keep resource policy explicit

Model resource access as either `restricted` or `unrestricted`. In restricted mode, every required
resource must match an explicit relationship or identifier and an empty set authorizes nothing.
Make unrestricted access a distinct privileged fact governed by current high-risk confirmation and
approval. Never infer it from an empty or omitted field, wildcard, role label, or legacy record.

Keep absent user configuration empty. During migration, establish the built-in owner's explicit
recovery authority first, convert every other unresolved policy to restricted-empty, fail closed on
partial state, and remove the old interpretation and compatibility path in the same lifecycle.

## Bound decision work

Use immutable indexed registries and normalized sets so request evaluation does not scan the full
operation catalog or repeatedly normalize the same facts. Do not share cached allow decisions for
write or external-effect operations. If read-only discovery uses a cache, bound its capacity and
TTL, key it by all determining revisions, and bypass it for side-effect revalidation. Bound pending
envelopes, cleanup work, concurrency, and metric cardinality, and release request state on
cancellation or completion.

## Change the complete authority path

1. Run `git status --short` and identify the canonical fact owner.
2. Inventory every producer and consumer of the principal, operation contract, target binding,
   decision, reason code, queue intent, and side-effect enforcement point.
3. Deliver one independently acceptable migration unit at a time, including callers, persistence,
   registry projections, UI or protocol surfaces, fixtures, and focused tests.
4. Complete the migration once: remove superseded bypasses, flags, fallbacks, schemas, fixtures, and
   documentation before accepting the new behavior.
5. Run the smallest focused verifier after each unit. Run the catalog-backed `security` workflow
   once after the complete candidate is assembled.

Do not replace an authorization defect with an availability gate or conceal an executable failure
behind readiness state. Return the stable denial code from the first failed authorization stage.

## Protect minimum evidence

Prepare one compact governance receipt before any protected access or side
effect. Bind its irreversible correlation to the same principal, operation,
resource, revisions, approval, audience, and request facts as the authorization
envelope. Settle that record to a terminal or `in_doubt` outcome; do not emit
separate verbose request, decision, start, and finish logs.

Mandatory receipt-store failure denies before the protected boundary. Optional
logs, traces, routine denials, and success telemetry are aggregated, sampled,
bounded, and shed-capable. Evidence failure never turns an authorization deny
into allow or a completed external effect into a confirmed failure safe to
blindly retry.

## Protect secrets and evidence

Store secret references instead of secret material. Keep credentials out of arguments, logs, reports, fixtures, generated artifacts, and agent messages.

Keep release credentials and publisher-account metadata out of repositories and reports. Publish verification public material only when required by the consumer-verification allowlist.

## Verify the boundary

Test allowed and denied paths through the same contract. Cover missing or forged workload
capabilities, cross-identity and cross-tenant access, scope mismatch, restricted-empty resources,
target substitution, replay, expiry, revocation, policy change while waiting, queue resume,
concurrency, cancellation, provider failure, and redaction when applicable. Assert that denied paths
cannot reach the handler side effect. Keep audit retention and evidence minimization separate from
authorization decisions.

Use `npm run repo:local-info-hygiene` before sharing evidence. Use `npm run verify:security` for the catalog-backed verification closure. Side-effectful probes require explicit authorization through the CLI flag.
