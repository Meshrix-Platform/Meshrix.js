# Security, Authorization, And Identity

> **Meshrix trusted-forwarding requirements:** verifiable identity,
> non-amplifying authority, content integrity, and end-to-end traceability.
> [Governed Execution And Minimum Evidence](../architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md)
> owns their normative meaning.

Security and authorization provide subject identity, session control, capability binding, secret handling, risk policy, approval, audit, and redaction for all governed operations.

## Responsibilities

- Authenticate console and operational subjects.
- Resolve users, agents, services, roles, teams, and local MCP grants.
- Evaluate Operation Permission, tag policy, risk, approval, and capability binding.
- Store secrets only through runtime secret references or secure local mechanisms.
- Redact secrets and private runtime data from logs, audit, metrics, and public responses.
- Bind local MCP grant use to a signed client process identity package in addition to the bearer token.
- Keep downstream MCP API Key plaintext only in the one-time Console response, approved transfer channel, and connector process memory. Client configuration stores only the environment-variable name; generic process identity remains independently governed.
- Record governed security alerts for identity mismatch, replay, path escape, unauthorized or malformed upstream publishing attempts, direct runtime/configuration mutation, and unsafe package storage.

## Security Rules

### Non-bypass execution acceptance

This rule specializes the project-wide [Governed Execution And Minimum
Evidence](../architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md) policy.

No protected resource or side-effect sink may rely on transport, loopback,
process co-location, a generic system actor, an internal route, cached allow,
approval, or a boolean authorization skip. The canonical decision authority
must mint a short-lived, audience-bound permit for the exact principal, action,
operation, concrete resource, determining revisions, approval, request digest,
deadline, and effect. The sink validates provenance and every binding after
locks, queues, waits, retries, recovery, or target materialization and before
the first protected action.

Authorization evidence is deliberately smaller than diagnostic logging. Keep
one bounded logical lifecycle proof using stable classes, revisions, counts,
and irreversible correlations. Do not copy identities, resources, requests,
responses, prompts, errors, paths, URLs, headers, tokens, or runtime content.
Mandatory proof failure denies before the protected boundary; optional logs,
metrics, and traces may be aggregated, sampled, or shed without changing the
authorization result. A surface lacking sink-bound permit validation fails the
Functional Release Gate even when its ingress check succeeds.

### Mandatory attack-resistance boundary

Every value that an external subject can supply, select, observe, persist, or
cause Meshrix to retrieve is attacker-controlled until the consuming boundary
has admitted it. This includes HTTP, browser, MCP and stdio fields; uploaded
bytes and archives; imported configuration; plugin metadata and results;
upstream responses; agent prompts, retrieved content, tool descriptions, tool
results, memory and inter-agent messages; and state resumed from queues,
retries, recovery or storage.

No such value may expose or provide an oracle over protected server runtime
data, cross a tenant or resource boundary, increase identity or authority,
select executable behavior, modify code or trusted configuration, escape
governed storage, reach an unapproved network target, or cause an ungoverned
durable or external effect. The following classes are a minimum taxonomy, not
an allowlist. Alternate encodings, parser disagreement, races, multi-step
composition and newly recognized attack forms remain denied by the same
source-to-sink invariant.

- **Authentication, credentials and sessions.** Prevent account and subject
  enumeration, credential stuffing, brute force, fixation, hijacking, replay,
  downgrade, token substitution and ambiguous multiple credentials. Use one
  canonical credential parser, secure random material, bounded attempts,
  explicit expiry and revocation, secure cookie and origin rules, and stable
  public failures. Never accept caller-declared identity, forwarded metadata,
  loopback location or possession of one unrelated credential as stronger
  authority.
- **Authorization, tenancy and property control.** Prevent object-, function-
  and property-level authorization failures, IDOR/BOLA, mass assignment,
  confused-deputy use, horizontal or vertical privilege escalation, target
  substitution and cross-tenant inference. Authorize the exact principal,
  action, operation, tenant, object, writable properties, audience and effect
  at the protected sink. Closed input models admit only server-declared
  writable fields; empty, unknown, conflicting or stale policy admits nothing.
- **Interpreter and data injection.** Prevent SQL and NoSQL injection, shell
  and command injection, expression and template injection, server- and
  client-side script or style injection, header and response splitting, log
  forging, spreadsheet-formula injection, regular-expression denial,
  prototype pollution, unsafe polymorphic deserialization, XML external
  entities and equivalent parser gadgets. Parse bounded bytes into closed
  data, reject duplicate, unknown and prototype-mutating keys, use
  parameterized APIs and context-specific output encoding, and never pass
  attacker data to an evaluator, shell, executable template or type resolver.
- **Protocol and parser ambiguity.** Prevent request smuggling and desync,
  conflicting length or transfer framing, duplicate security headers, invalid
  host or forwarded metadata, method override, content-encoding confusion,
  non-canonical paths, duplicate object keys, batch partial-authentication and
  inconsistent normalization between proxy, router, policy and handler. Reject
  ambiguity before body consumption or effects and use one canonical form for
  authentication, authorization, routing, hashing and execution.
- **Browser and console attacks.** Prevent reflected, stored and DOM XSS,
  CSRF, permissive CORS, clickjacking, open redirects, host-header and cache
  poisoning, MIME sniffing, unsafe inline rendering, session leakage and
  cross-window or cross-origin data exposure. Apply exact origin and redirect
  allowlists, CSRF binding for browser state changes, restrictive content and
  framing policy, secure cookies, explicit cache policy, correct media types,
  safe download disposition and contextual rendering. Client-side hiding is
  never authorization.
- **Runtime-data and secret disclosure.** Treat databases, object stores,
  settings, environment and secret material, prompts, model or provider data,
  job and upload state, queues, checkpoints, backups, paths, process and host
  details, identities, logs and historical records as protected runtime data.
  Public APIs, health and debug surfaces, errors, redirects, logs, audit,
  metrics, traces, alerts, exports, downloads and generated reports use closed
  response projections and stable reason classes. They must not reveal raw
  rows, values, payloads, stacks, paths or existence through status, timing,
  size, cache or pagination differences.
- **Filesystem and storage escape.** Prevent traversal, absolute-path and
  separator tricks, symbolic- or hard-link escape, special files, devices,
  sockets, FIFOs, unsafe permissions, temporary-file races, overwrite and
  name-collision attacks, partial publication and time-of-check/time-of-use
  substitution. Use server-generated opaque identities, anchored roots,
  no-follow and regular-file checks, owner-only custody, bounded streaming,
  identity revalidation immediately before commit, and atomic no-replace or
  revision-bound publication. Untrusted names are metadata, never paths.
- **Uploads, archives and active content.** Extension, filename and declared
  content type are not trust evidence. Admit only operation-required formats;
  verify bounded bytes, magic and closed structure; cap member count, nesting,
  expansion ratio and total expanded bytes; and reject unsupported nested,
  encrypted, linked or special-file content. Store untrusted bytes outside
  executable, source, configuration and public-serving roots under opaque
  non-executable custody. A parser runs only in a current isolated profile with
  no implicit network, host path, secret or process authority. Content that
  cannot be proven safe for an enabled parser remains opaque or is rejected;
  upload never implies parse, import, publish, install or execute.
- **Server-side request forgery and outbound confusion.** Treat every URL,
  host, port, scheme, proxy, redirect and upstream-selected location as a
  resource. Use operation-owned destinations and schemes, canonical parsing,
  exact credential scope, DNS and address validation at each connection and
  redirect, network-layer egress limits, and bounded response handling. Deny
  loopback, private, link-local, multicast, metadata-service, local-file and
  alternate-scheme targets unless the exact operation explicitly owns them;
  prevent DNS rebinding, alternative address notation, proxy bypass and
  credential forwarding across origins.
- **Code, plugin and supply-chain compromise.** Prevent dependency confusion,
  typosquatting, mutable or unsigned artifacts, compromised install scripts,
  manifest injection, unreviewed native code, runtime package installation,
  dynamic discovery and trust-on-first-use. Bind source, lock state, package,
  manifest, inventory, signature, digest, declared entry point, configuration
  and active lifecycle generation. Empty trust and selection enable nothing.
  Only explicitly reviewed and verified deployment code may enter the Host;
  attacker-controlled code remains behind the controlled-execution boundary.
- **Agent, model, tool and memory manipulation.** Prevent direct and indirect
  prompt injection, jailbreak-driven effects, tool poisoning, forged tool
  observations, memory or retrieval poisoning, goal hijacking, approval or
  policy manipulation, excessive agency, cross-agent privilege amplification,
  recursive action loops and data exfiltration through tool arguments or model
  output. Natural-language instructions, model output, confidence, tool
  metadata and memory are untrusted proposals, never identity, policy,
  approval or authority. Code-owned operation contracts apply least privilege,
  provenance, tenant binding, output schemas, independent confirmation and
  sink-side revalidation. Prompt-only defenses cannot protect an effect.
- **Resource exhaustion and amplification.** Prevent oversized or slow bodies,
  decompression and archive bombs, parser depth and regex complexity attacks,
  unbounded pagination, batches, fan-out, concurrency, queues, retries, agent
  turns, tool calls, storage, output, history, cache entries, identifiers,
  metrics and logs. Enforce streaming admission plus global, principal,
  operation and resource budgets; use bounded structures, backpressure,
  deadlines, cancellation and `finally` cleanup. Do not evict active security
  state or mandatory unexpired evidence to admit attacker-chosen cardinality.
- **State, concurrency and recovery attacks.** Prevent replay, double effects,
  lost updates, stale approvals, stale allow caches, race-to-revoke, queue or
  retry privilege retention, partial transactions and crash-recovery authority
  gaps. Bind idempotency and nonces to the complete request, use current
  revisions and atomic compare-and-set or transactions, and re-resolve identity,
  policy, approval, resource and target after locks or waits and immediately
  before effects. Recovery resumes intent, never a reusable allow decision.
- **Cryptographic and secret failures.** Use reviewed platform primitives,
  cryptographically secure randomness, explicit algorithms and formats,
  authenticated encryption or signatures where integrity is required, unique
  nonces, constant-time secret comparison where applicable, and separate keys
  for separate purposes. Keep keys and credentials behind references and
  approved custody, support expiry, rotation and revocation, and never expose
  them through arguments, environment dumps, source, fixtures, telemetry or
  evidence. Unknown algorithms, keys, generations or verification state fail
  closed; encoding and hashing alone do not provide secrecy.
- **Misconfiguration and exceptional conditions.** Production startup rejects
  debug routes, default credentials, broad proxy or origin trust, writable code,
  unsafe filesystem modes, incomplete secret custody, contradictory security
  settings and unavailable mandatory enforcement. Absent user configuration
  remains empty. Parser errors, dependency failures, timeouts, cancellations,
  evidence failure and cleanup failure return bounded public reasons without
  falling back to a more permissive path or acknowledging an uncertain effect
  as safely retryable.
- **Detection, evidence and security-control tampering.** Security events use
  bounded fixed schemas, protected ordering and retention, privacy-safe
  correlation and explicit loss accounting. Attacker input cannot choose event
  names, labels, metric dimensions, destinations or retention. A logging,
  alerting or scanner failure never grants authority, and a passing scanner
  never substitutes for prevention at the sink. Changes that weaken, skip or
  delete applicable negative tests or release gates are security changes and
  require the same review.

For every changed attack surface, maintainers must trace each attacker-controlled
source through parsing, normalization, authentication, authorization, waits and
revalidation to every protected sink and public observation. Verification must
exercise allowed and denied cases through the same production contract and
assert zero protected side effects on denial. It must include applicable
cross-identity, cross-tenant, encoding, ambiguity, replay, concurrency,
cancellation, recovery, resource-pressure and redaction cases. A static scan,
entry-point check, UI restriction or happy-path test alone is insufficient.
An unknown or untested source-to-sink edge fails security acceptance until the
surface is removed, disabled, or protected and covered by negative evidence.

- The Risk Control Model is the runtime governance model for each admitted operation. It binds subject identity, permission policy, data-state semantics, traffic/resource controls, and audit recovery evidence into a fail-closed decision path.
- Apply fail-closed handling for subject, grant, tag policy, capability binding, and risk decision resolution.
- Protected non-public writes revalidate the current grant, process identity or console authority, policy revision, and any approval binding after acquiring the operation lock and before invoking the handler. Missing revalidation support or authority revoked while waiting for the lock fails closed.
- Console password failures increment and lock the account through one conditional SQLite update after password verification. Concurrent failures cannot overwrite each other's counters, and a successful session transaction verifies that the credential, enabled state, and lock state did not change while password hashing was in progress.
- Console user updates compute password hashes before entering an immediate SQLite transaction, then re-read the latest user row and apply only the explicitly requested fields. Credential replacement and session invalidation commit together, so a concurrent disable or role reduction is not overwritten and a verified old credential cannot create a session across the change.
- Console login uses metadata-only operation audit and does not retain login input, an input-derived credential digest, or input logging material.
- A console session is resolved once per HTTP request and is never cached across requests. The request-scoped cache retains an immutable validated session projection, not the raw token, and rechecks absolute expiry on every cache hit. Persisted `last_seen_at` activity writes are coalesced to at most once per minute per active session through a conditional update bound to the prior session state. Invalid persisted times fail closed. Expiry, disabled-user, and inactivity checks run before a request snapshot is created; revocation or account changes are visible to the next request.
- Console Auth and authorization SQLite directories are owner-only (`0700`); current database, WAL, shared-memory, journal, and CSRF-secret files are owner-only (`0600`). Existing unsafe modes are tightened during construction before the stores are exposed.
- The built-in console role catalog contains exactly `owner`, `maintainer`, and `viewer`. Their localized product names are Super administrator, Maintainer, and Auditor. `owner` is the only all-scope recovery role; `maintainer` receives the configured operational scope bundle; `viewer` is read-only. Administrative authority is derived from explicit scopes such as `auth:admin`, never from a role-name shortcut. Existing persisted `admin` and `operator` assignments are migrated once to `maintainer`, including console users, OIDC role mappings, authorization user policies, and role-tag projections.
- Local Secret Store value files contain only AES-256-GCM envelopes. Associated data binds the secret reference, provider, family, authentication type, revision, scope metadata, and value-key inventory. The 32-byte master key is loaded from `MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE`, must be outside governed data, and is never copied into backup snapshots, registries, audit, reports, or public status. Missing, wrong, malformed, or tampered custody fails closed; plaintext value records and the retired store protocol are rejected instead of migrated.
- Production operation-proof signing uses a separate 32-byte secret selected by `MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE`. The file must be absolute, regular, non-symlinked, bounded, outside governed data, and distinct from the Local Secret Store master key at deployment admission. Invalid or missing production signer custody fails before the proof runtime opens.
- The proof signer port can compose one active signer with historical verification generations. Signing always uses the active generation; verification selects the exact signer identity and algorithm and rejects unknown generations.
- Local Secret master-key rotation stages and verifies every active encrypted value under a distinct next provider while holding the mutation lock, then switches all registry references in one atomic registry write. Failure before that write preserves the prior generation.
- Redact raw tokens, cookies, private keys, upstream request secrets, local absolute paths, and private runtime state.
- Use ordinary Grant tokens for their existing Operation Permission HTTP/RPC boundaries. Ordinary downstream MCP clients use only a scoped API Key.
- Native MCP installation uses a Console-issued scoped API Key. The administrator binds workload, organization, audience, targets, tools, resources, risk, limits, and expiry before transferring plaintext once. The connector validates the strict key before I/O and the server revalidates lifecycle and policy before protected effects.
- The local connector reads the operator-supplied API Key from the documented environment variable or protected standard input. Client configuration stores only the environment-variable name.
- Published MCP client installation is connector-managed and local. Multi-target installation reuses the operator-supplied API Key without generating target credentials. Local uninstall performs adapter and configuration cleanup without credential lookup or network access.
- Generic process identity signing remains available to independently governed boundaries but does not authenticate an ordinary downstream MCP client.
- Accepted process-identity nonces remain recorded for the complete replay window. If the bounded replay store is full, new signed requests fail closed until entries expire; an unexpired nonce is never evicted to admit traffic.
- One signed MCP HTTP batch consumes process identity once before protected messages are dispatched. Message-level operation policy is still evaluated independently, without replaying the HTTP nonce or allowing an authentication failure after an earlier protected message has executed.
- HTTP body admission enforces a 32 MiB request limit, a 128 MiB and 64-request process budget, and a 64 MiB and 16-request authenticated-subject budget. Declared lengths are rejected before body reads when possible; streamed chunks are charged incrementally, oversized streams are stopped, and every admission charge is released from the request `finally` path.
- `X-Forwarded-For` is untrusted by default, including for direct loopback connections. HTTP client-IP normalization parses a forwarded chain only when the direct socket peer is explicitly listed in `MESHRIX_TRUSTED_PROXIES`; it walks the validated IP chain from the trusted edge toward the first untrusted hop and otherwise uses the socket peer.
- `MESHRIX_PRODUCTION_INGRESS_MODE=trusted-proxy` additionally requires an HTTPS advertised origin, secure cookies, exact proxy IPs, one forwarded host and protocol, and a valid client chain before application routing. Only loopback health probes bypass proxy metadata.
- Fixed-window HTTP rate-limit state is bounded. Each limiter retains at most its configured bucket capacity, defaults to 10,000 buckets, reclaims expired buckets in creation order, and aggregates new high-cardinality identifiers into one overflow bucket while capacity is saturated. Active buckets are not evicted to admit rotating identifiers.
- Discovery capacity recovery evicts only expired offline client records. The operator's configured offline threshold is applied first; when that user setting is empty, a private 15-minute retention bound protects runtime capacity without representing a persisted user default.
- Capability-binding state accepts only the exact prior local-file record shape for one atomic migration into sealed sidecar-backed state. Any malformed current record, invalid key material, unexpected field, or failed migration remains fail-closed.
- Runtime logs retain fixed event names and metadata projections. Free-form strings, request query data, addresses, user agents, identities, commands, paths, and error details are represented only by keyed hashes, types, lengths, and counts. Console audit identity and path fields use the same persisted-key projection; prior rows are reprojected with secure deletion, WAL truncation, and vacuum before the migration is complete.
- Security alert operations are exposed through `security_alerts.list`, `security_alerts.ack`, `security_alerts.export`, and `security_alerts.prune`; exported alerts are redacted.
- High-risk and destructive operations require approval or explicit confirmation where configured.

## Organization Governance Snapshot

Meshrix stores one canonical organization-governance aggregate in the
tag-management SQLite store. An empty store returns `configured: false`, revision
zero, and empty nodes, tags, and roles. Built-in choices are versioned TOML files
under the Foundation package configuration directory; catalog summaries never
represent configured state.

The server imports either a catalog key or exactly one bounded local `.toml`
source through `smol-toml`, then applies closed normalization. Hierarchy depth is
derived from the explicit acyclic node graph. Tags and scoped administrator roles
are explicit records rather than inferred from names or depth. Person identities,
subject assignments, unrestricted policy, and business-resource actions are
rejected.

Template roles may contain only `organization.structure.read`,
`organization.membership.read`, and `organization.membership.manage`;
`businessResourceActions` and `assignedSubjectIds` remain empty. Names and labels
never confer authority. The five enterprise-template administrator roles bind
that same minimum management-action set to the group, primary organization,
secondary organization, department, or team node respectively. Publication
creates definitions and projections only; no person receives a template role
until a separate governed subject-assignment capability exists.

The authenticated `authorization.organization_governance.get`,
`authorization.organization_governance.import`,
`authorization.organization_governance.preview`, and
`authorization.organization_governance.publish` operations require
`auth:admin`. Preview normalizes and validates without storage mutation.
Publish requires the current expected revision, rechecks it inside one SQLite
immediate transaction, replaces metadata, nodes, template-managed tags, role
projections, and provenance atomically, and increments the revision once.
Unmanaged tag or role collisions, invalid graphs, stale revisions, or transaction
failure preserve the complete prior aggregate. Removed template-managed records
are archived or disabled so external references fail closed. Publish is a confirmed
governance write; its update event contains only bounded mutation and current
governance-policy revision facts, not hierarchy labels, memberships, or
runtime data. Publication audit and runtime logging are metadata-only and do
not retain submitted TOML, hierarchy labels, or local file data.

## API Key Issuer Authority And Custody

The Permission console exposes **Key Distribution** only after the authenticated
subject receives a non-empty, server-computed issuer-scope result. Group,
organization, department, and team administrators may issue only within their
explicitly assigned node and its descendants. Navigation availability is a user
interface projection; every create, list, rotate, and revoke request repeats the
same current server-side authority and lineage checks.

An API Key is the downstream workload credential, not an enrollment request or
approval ticket. Meshrix records the workload principal before distribution,
shows plaintext only in the create or rotate response, and provides no later
reveal operation. The console keeps that response only in ephemeral view state
and clears it on dismissal, refresh, route history, and reload. Lists, audit,
logs, metrics, errors, and screenshots contain redacted metadata only.

Bearer possession is identity within the stored bounds, so a copied key can be
used until expiry, rotation, or revocation. Administrators may additionally
require a pre-provisioned process-identity fingerprint. That binding is never
learned on first use and does not turn client-declared machine data into an
identity fact. Requests containing both a Grant credential and an API Key are
ambiguous and denied.

## Plugin Host Security Ports

`ArtifactSignerPort` is the Host custody boundary for plugin artifact signatures. A plugin receives only the intersection of purposes declared by its verified signed manifest and purposes explicitly granted by runtime configuration; an empty grant remains empty. The Host resolves the configured local secret reference, signs a stable envelope containing the purpose, payload digest, and public context digest, and returns only the Ed25519 public key, key id, signature, and minimum receipt. Private key material and the secret reference never enter plugin configuration, results, reports, or persistent plugin state.

The Host plugin artifact authority verifies a bounded deterministic inventory against `runtime.pluginArtifactTrustedPublicKeys`, publishes immutable generations through private staging, and requires the lifecycle ledger to match the verified plugin id and generation. Empty trust accepts no artifact. Production discovery reads installed artifact snapshots only and has no source-tree, package-resolution, or automatic-install fallback. Update, reinstall, and removal use monotonic generations, compare-and-set expectations, durable journals, and tombstones; code and bundle namespaces are removed while plugin-owned data is retained.

Owner-scoped Host ports bind every admission to the verified artifact generation and an active lifecycle ledger. Business methods on captured ports recheck that binding. Cleanup methods needed for cancellation, revocation, recovery deletion, and shutdown remain available after admission is fenced.

Process identity issuance and controlled execution additionally require a Host-issued invocation authorization derived from the admitted request's subject and current governance result. The signed in-memory authorization is bounded, short-lived, operation-, request-, source-request-, owner-, and generation-bound, and separately single-use for each Host capability audience. Host ports use only its principal and governance claims. The authorization is transient call data and is not persisted in plugin state, relay sessions, logs, audit, or recovery storage.

The generic process-identity Host capability reuses the sealed Meshrix process-identity state. A binding covers tenant, subject, target, device, process, workspace, correlation, and the request idempotency digest. Issue, inspect, and revoke serialize through the same persistent authority, so valid and revoked bindings survive restart. Revocation records a minimum Ed25519 receipt bound to the process identity reference, binding reference, target, context digest, revocation time, and Meshrix server signing identity. Public plugin projections contain controlled references, status, expiry, revocation time, and receipt digest only.

Process-identity persistence accepts only the exact current top-level state schema and current state version. A non-current version or unexpected field initializes fresh current state; no retired binding field is discovered, translated, or imported, and no compatibility migration remains.

The controlled-execution Host capability rechecks tenant, subject, target, and process-identity binding for target resolution, readiness, execution, cancellation, and terminal observation. The Host-configured adapter submits only its configured workload and the invocation authorization's current governance claims to the Controlled Execution Sandbox broker. It has no `spawn`, shell, direct host-process, inferred-target, or plugin-supplied policy fallback. Active executions and terminal receipts are bounded so an idempotent retry receives the same controlled terminal result instead of starting another workload. Cross-binding cancel or observation is denied, invalid deadlines return a fixed error, and cancel, observation, and close have bounded waits even when a backend ignores cancellation.

`ProtectedRecoveryPort` is separate from general secret storage and opaque payload custody. It stores only short-lived, purpose-scoped recovery records, encrypts each record with authenticated owner-generation binding metadata, and rejects purpose, digest, expiry, capacity, authentication, or inactive-generation mismatch. Deletion remains available to the bound retired generation for cleanup. Temporary opaque payload custody is an in-memory, TTL-bounded Host capability keyed by tenant, session, and turn. It never becomes plugin data, audit evidence, a process argument, or a durable recovery store.

## Upstream Publishing Security Boundary

Service developer publishing is authorized only through the authenticated control-plane contract (`POST /api/gateway/v1/services` and its service-specific replace, disable, remove, and republish routes); the console Publish action submits that same authenticated command. Direct gateway registration or manifest filesystem mutation remains prohibited. Authentication, service ownership, expected revision, idempotency, reference binding, risk, and approval checks occur before persistence, secret resolution, or network side effects.

Publishing input is parsed from bounded bytes with duplicate-key detection before domain materialization. Closed schemas reject unknown and prototype-mutating keys, controls, unsafe Unicode, unsupported methods or protocols, caller-defined executable names, path traversal, unsafe targets, unbounded schemas, and excessive bytes, depth, collections, operations, or strings. Caller data is never evaluated as a template, command, expression, environment-variable name, filesystem name, or configuration fragment.

Manifests contain typed certificate and credential references only. Reference materialization remains behind the current Operation Permission, tag, risk, approval, host, protocol, scope, and revision decision at invocation time. The manifest writer and gateway reader use separate logical identities and roots; links, non-regular files, root escape, and ownership or mode mismatches fail closed. Audit, metrics, notifications, errors, and release evidence contain fixed reason classes and redacted opaque identifiers, not raw requests, paths, subjects, catalogs, certificates, credentials, or runtime state.

## Verification

```bash
npm test
node tools/server-scripts/verify-process-identity.ts
npm run verify:security-alert-lifecycle
npm run security:hygiene
npm run test:security
npm test -- --suite security.http-resource-admission
node tools/server-scripts/verify-authorization-governance.ts
node tools/server-scripts/verify-process-identity.ts
npx vitest run tests/vitest/server/process-identity-nonce-capacity.test.ts tests/vitest/server/local-secret-crash-consistency.test.ts tests/vitest/server/plugin-mcp-outlet-visibility.test.ts
npx vitest run tests/vitest/server/capability-binding-guard-persistence-and-recovery.test.ts tests/vitest/server/capability-binding-guard-corruption-and-lock-failures.test.ts tests/vitest/server/authorization-capability-binding-guard.test.ts
npx vitest run tests/vitest/server/runtime-logger.test.ts tests/vitest/server/console-auth.test.ts tests/vitest/server/client-registry-capacity-recovery.test.ts
npx vitest run tests/vitest/server/p2-security-boundaries.test.ts tests/vitest/server/mcp-installer-api-key-only.test.ts tests/vitest/server/http-server-middleware-rate-limit.test.ts
node tools/server-scripts/verify-security-local-stdio-lockdown.ts
```

`tools/server-scripts/verify-process-identity.ts`
owns the Functional Release Gate evidence for MCP process-identity credential
storage. The functional evidence requires `reportLeakScan=true`, zero verifier
failures, explicit denial of private-file fallback reads in `system` or named
system-backend mode, the controlled `0600` file fallback, and a reproducible
Linux Secret Service simulation. The Linux simulation runs in
`MESHRIX_MCP_PROCESS_IDENTITY_LINUX_IMAGE` when provided, otherwise in the
local `meshrix-mcp-secret-service-proof:node24-bookworm` image built by the
verifier with Docker BuildKit apt caches. The Functional Release Gate checks
the concrete verifier evidence, not only summary flags.

A native operating-system credential backend is verified separately through
`npm run verify:real-machine -- ...`. Its receipt may establish an Environment
Support Claim for that exact system, but a missing or failed native receipt
cannot block or change functional acceptance.

The local stdio functional check is named `local-stdio-interface-lockdown` and
is verified by
`tools/server-scripts/verify-security-local-stdio-lockdown.ts`. Run
`npm run verify:acceptance` for the complete Functional Release Gate; this page
lists the security-specific verification entry points.
