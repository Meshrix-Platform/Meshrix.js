---
name: meshrix-js-security-boundary-audit
description: Audit Meshrix.js code, APIs, console flows, MCP and agent paths, plugins, uploads, storage, gateways, and runtime changes for exploitable trust-boundary failures, including runtime-data disclosure, authorization bypass or privilege escalation, injection or code execution, malicious files, SSRF, browser and protocol abuse, supply-chain compromise, prompt or tool poisoning, and resource exhaustion. Use when adding or reviewing an external interface, parser, upload, URL fetch, agent tool, protected operation, credential, side effect, or other security-sensitive change, and before accepting a suspected security fix.
---

# Meshrix.js Security Boundary Audit

## Establish the audit boundary

1. Run `git status --short` and apply the returned repository skill together with `$meshrix-js-security-authorization`.
2. Read the target repository's canonical security document completely. For Meshrix.js, read `docs/functionality/SECURITY-AUTHORIZATION.md`, especially `Mandatory Attack-Resistance Boundary`, plus the capability document that owns the changed surface.
3. Inspect `git status --short` before editing. Preserve unrelated and pre-existing worktree changes.
4. Inspect the catalog-backed plan with `npm run verify:security` and `npm test` before selecting verification.
5. Keep the audit read-only when the user asks only for review or diagnosis. Implement a fix only when the request authorizes a change.
6. Use synthetic, bounded fixtures. Never retrieve or expose production secrets, backend rows, prompts, files, logs, identities, paths, or other protected runtime data. Require explicit authorization before network probes, runtime-data access, destructive checks, or external effects.

## Model complete attack paths

Inventory every attacker-influenced source, including HTTP and browser fields, MCP or stdio messages, uploaded bytes and archives, imported configuration, upstream responses, plugin manifests and results, agent prompts, retrieved content, tool descriptions and results, memory, inter-agent messages, queues, retries, and recovered persisted state.

Inventory every protected sink, including authorization decisions, other tenants' objects, secrets, runtime databases and files, backups, configuration, plugin or code loading, process and sandbox launch, outbound network access, durable writes, externally visible effects, browser-rendered content, and logs, audit, metrics, traces, exports, and errors.

Trace each candidate path end to end:

```text
raw input -> admission budget -> parse -> canonicalize -> authenticate
-> authorize exact principal/action/resource/context -> queue/lock/wait/retry
-> revalidate -> protected sink -> response/evidence -> cleanup
```

Mark ownership and trust at every transition. Treat a missing, indirect, dynamically selected, or uninspectable edge as an unresolved finding, not as evidence of safety.

## Apply the complete attack taxonomy

Use the canonical Meshrix.js attack-resistance boundary as the minimum checklist. Classify every category as applicable, not applicable with a concrete reason, or unresolved. Do not use the checklist as an allowlist: combinations, alternate encodings, parser differences, races, and newly recognized attack forms remain in scope.

Enforce these invariants throughout the review:

- Never derive authority from transport, loopback, process co-location, route names, UI visibility, model output, prompt instructions, caller-supplied identity, role labels, cached allow decisions, approvals alone, or boolean bypass flags.
- Bind authority to the authenticated principal, exact operation and action, concrete tenant and resource, writable properties, audience, request digest, current policy and grant revisions, approval facts, risk, expiry, and side effect. Revalidate after waits and immediately before the protected effect.
- Parse bounded bytes into a closed schema. Reject duplicate, unknown, prototype-mutating, contradictory, non-canonical, or unsupported values before domain materialization.
- Keep untrusted content as data. Never let it select code, a class, command, template, environment name, filesystem path, SQL fragment, redirect, network target, tool authority, or security policy.
- Make the safe failure path explicit. Unknown, stale, partial, malformed, over-budget, cancelled, or dependency-failed state must not reach a protected sink.

When current taxonomy confirmation is material, compare coverage against primary, official OWASP ASVS, Web Top 10, API Security Top 10, Agentic Application guidance, and CWE Top 25 sources. Use them to find missing classes, never as proof that a Meshrix.js path is safe.

## Review sources and sinks, not keywords alone

Use bounded `rg` searches in the affected subsystem to locate candidate sinks and bypasses:

- dynamic execution, process creation, shell use, module loading, templates, and expression evaluators;
- database statements, object mappers, deserializers, XML/YAML parsers, regular expressions, and object merging;
- filesystem paths, temporary files, uploads, archives, links, permissions, and atomic publication;
- HTTP clients, redirects, DNS resolution, proxies, forwarded headers, URL parsing, and credential forwarding;
- HTML insertion, URL navigation, cookies, CORS, CSRF, caching, downloads, and security headers;
- authorization caches, generic dispatchers, fallback actors, default scopes, skip flags, stale approvals, and queue resumes;
- logs, audit, metrics, traces, health, diagnostics, exports, errors, and debug projections;
- unbounded bodies, decompression, recursion, pagination, batch size, fan-out, queues, retries, listeners, caches, cardinality, and retained state;
- prompts, retrieval, memory, tool metadata, tool results, multi-agent delegation, and model-selected operations.

A search hit is only a candidate. Trace attacker control to the concrete sink and inspect the actual enforcement point, failure behavior, cleanup, and response projection.

## Treat a bypass as a finding

Record a finding when an attacker can influence a protected sink or observation through any of these conditions:

- missing, forged, confused, stale, replayed, cross-tenant, cross-object, cross-property, or over-broad identity or authority;
- an ambiguity between parsers, representations, encodings, paths, hosts, redirects, credentials, operations, or policy revisions;
- injection into an interpreter, renderer, query, header, log, filename, package, prompt, tool, memory, or configuration surface;
- unsafe file acceptance, expansion, parsing, serving, installation, materialization, or execution;
- internal-network, local-file, metadata-service, alternate-scheme, redirect, DNS-rebinding, or credential-forwarding access;
- runtime-data disclosure through direct output, errors, diagnostics, logs, exports, caches, timing, size, status, or object-existence oracles;
- resource exhaustion, algorithmic complexity, amplification, retry or agent loops, cardinality growth, retained-state growth, or incomplete cancellation cleanup;
- a race, time-of-check/time-of-use gap, partial transaction, crash-recovery gap, duplicate effect, or stale decision after a wait;
- trust in an unsigned, mutable, unpinned, automatically installed, dynamically discovered, or insufficiently isolated artifact or dependency;
- reliance on a prompt, model, client, UI, proxy convention, scanner result, or monitoring alert as the primary security boundary.

Unknown exploitability is not a pass. Disable or remove the reachable surface, or add the missing enforceable boundary and evidence.

## Require adversarial negative evidence

Test allowed and denied cases through the same production contract. Assert that every denied case has zero handler, storage, process, network, credential, or external-effect invocation. Cover every applicable variant:

- absent, malformed, expired, revoked, replayed, wrong-audience, wrong-principal, wrong-tenant, wrong-resource, wrong-property, and wrong-operation authority;
- duplicate submissions, concurrent attempts, cancellation, retry, restart, queue resume, stale policy or approval, and target substitution after validation;
- duplicate keys and headers, conflicting framing, alternate encodings and Unicode forms, case and separator variants, oversized and deeply nested values, partial streams, and parser exceptions;
- path traversal, absolute paths, links and special files, filename collisions, MIME or magic mismatch, archive depth, member count, expansion ratio, total expanded bytes, nested or encrypted archives, and parser failure;
- redirect chains, DNS changes, alternative IP representations, IPv4/IPv6 private and local ranges, non-approved schemes and ports, proxy bypass, and credential stripping;
- SQL, command, template, HTML, header, log, formula, expression, deserialization, prototype, XML entity, and regular-expression injection using safe synthetic inputs;
- direct and indirect prompt injection, tool poisoning, forged observations, memory poisoning, goal hijacking, approval manipulation, cross-agent privilege amplification, and data-exfiltration attempts;
- slow and oversized input, decompression bombs, high-cardinality identifiers, unbounded pagination or batches, retry and tool loops, storage pressure, timeouts, and cleanup under cancellation;
- public errors, logs, audit, metrics, health, exports, downloads, and browser responses for secret, path, identity, stack, prompt, payload, runtime-row, and object-existence leakage.

Use property-based or fuzz testing for bounded parsers and canonicalizers when useful. Preserve every confirmed bypass as a focused regression test after fixing it; do not keep retired implementation names as permanent gates.

## Report minimum safe findings

For each finding, record only:

- stable finding ID, category, severity, and status;
- affected repository-relative surface and tight line references;
- attacker-controlled source, protected sink, and required preconditions;
- violated canonical rule and impact class;
- missing or bypassable enforcement point;
- safe negative-test description and expected zero-effect assertion;
- smallest complete remediation boundary and remaining uncertainty.

Do not include live exploit payloads, raw requests or responses, credentials, runtime values, machine details, private endpoints, or unredacted logs. A critical or high-severity finding, an unresolved attacker-to-sink edge, or missing negative evidence blocks a security-pass conclusion.

## Close and verify the change

1. Implement one independently acceptable security closure at a time, including every caller, parser, policy, persistence path, queue or recovery path, response projection, test, fixture, registry, and owning document it affects.
2. Remove the superseded bypass, fallback, compatibility route, unsafe default, fixture, and documentation in the same closure.
3. Run the narrowest focused tests after each closure.
4. Run `npm run verify:security` once after the complete candidate is assembled. Run the changed-path workflow only when its additional tasks are in scope.
5. Run the repository documentation verifier when formal documentation changed, then the owner-required `npm test` gate.
6. Run `npm run repo:local-info-hygiene` and `npm run repo:local-info-hygiene` before sharing evidence.
7. Report only commands, safe counts, statuses, rule IDs, repository-relative paths, and irreversible digests. A scanner or test pass never substitutes for the complete source-to-sink review.
