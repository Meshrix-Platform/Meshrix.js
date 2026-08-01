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
- Store paired local MCP process identity keys and grant tokens in the operating system credential store first: macOS Keychain on Darwin, Linux Secret Service or kernel keyring on Linux, with `0600` private-file fallback reserved for CI and controlled local verification.
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

- The Risk Control Model is the runtime governance model for each admitted operation. It binds subject identity, permission policy, data-state semantics, traffic/resource controls, and audit recovery evidence into a fail-closed decision path.
- Apply fail-closed handling for subject, grant, tag policy, capability binding, and risk decision resolution.
- Protected non-public writes revalidate the current grant, process identity or console authority, policy revision, and any approval binding after acquiring the operation lock and before invoking the handler. Missing revalidation support or authority revoked while waiting for the lock fails closed.
- Console password failures increment and lock the account through one conditional SQLite update after password verification. Concurrent failures cannot overwrite each other's counters, and a successful session transaction verifies that the credential, enabled state, and lock state did not change while password hashing was in progress.
- Console user updates compute password hashes before entering an immediate SQLite transaction, then re-read the latest user row and apply only the explicitly requested fields. Credential replacement and session invalidation commit together, so a concurrent disable or role reduction is not overwritten and a verified old credential cannot create a session across the change.
- Console login uses metadata-only operation audit and does not retain login input, an input-derived credential digest, or input logging material.
- A console session is resolved once per HTTP request and is never cached across requests. The request-scoped cache retains an immutable validated session projection, not the raw token, and rechecks absolute expiry on every cache hit. Persisted `last_seen_at` activity writes are coalesced to at most once per minute per active session through a conditional update bound to the prior session state. Invalid persisted times fail closed. Expiry, disabled-user, and inactivity checks run before a request snapshot is created; revocation or account changes are visible to the next request.
- Console Auth and authorization SQLite directories are owner-only (`0700`); current database, WAL, shared-memory, journal, and CSRF-secret files are owner-only (`0600`). Existing unsafe modes are tightened during construction before the stores are exposed.
- Local Secret Store value files contain only AES-256-GCM envelopes. Associated data binds the secret reference, provider, family, authentication type, revision, scope metadata, and value-key inventory. The 32-byte master key is loaded from `MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE`, must be outside governed data, and is never copied into backup snapshots, registries, audit, reports, or public status. Missing, wrong, malformed, or tampered custody fails closed; plaintext value records and the retired store protocol are rejected instead of migrated.
- Production operation-proof signing uses a separate 32-byte secret selected by `MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE`. The file must be absolute, regular, non-symlinked, bounded, outside governed data, and distinct from the Local Secret Store master key at deployment admission. Invalid or missing production signer custody fails before the proof runtime opens.
- The proof signer port can compose one active signer with historical verification generations. Signing always uses the active generation; verification selects the exact signer identity and algorithm and rejects unknown generations.
- Local Secret master-key rotation stages and verifies every active encrypted value under a distinct next provider while holding the mutation lock, then switches all registry references in one atomic registry write. Failure before that write preserves the prior generation.
- Redact raw tokens, cookies, private keys, upstream request secrets, local absolute paths, and private runtime state.
- Use grant tokens for Operation Permission and MCP execution boundaries.
- Direct `POST /api/mcp/local-grant` issuance is an administrative console operation. It requires a valid console session with `runtime:admin`, same-origin and CSRF validation, and explicit safety confirmation for write-capable grants. Loopback location and a caller-supplied process public key are not authorization facts.
- Native MCP installation uses a device-authorization sequence instead of direct grant issuance. The installer creates an expiring request bound to normalized targets, exact toolsets and scopes, maximum risk, and process-key fingerprints; the console displays the request id and the same short verification code printed by the installer. An authenticated administrator approves the immutable request, and the installer completes one logical issuance with an in-memory random claim. Only the claim SHA-256 is persisted as claim identity; the exact issued response is retained only as claim-bound encrypted retry material for two minutes. The same claim may recover that response after an interrupted delivery but cannot issue a second credential set. Approval, claim, or process identity alone cannot be reused as a grant.
- The local connector persists the issued grant token in the same secure credential record as its private process identity and reuses that pair after process restart. Client configuration and process arguments contain only the credential environment name, never the stored token. An explicitly supplied standard-input or environment token takes precedence.
- Published MCP client installation is connector-managed and local. Orb and remote-Linux direct HTTP modes are rejected before device authorization because bearer-only client configuration cannot satisfy signed process identity. Multi-target uninstall sends one signed, target-bound update per stored credential and removes only credentials whose server update succeeds.
- Device-authorization requests expire after ten minutes, are bounded globally, per source, and by aggregate persisted bytes, and move from `approved` to `issuing` through one compare-and-set. Request bodies are limited to 128 KiB and canonical persisted request payloads to 64 KiB. Ordinary request expiry does not rewrite an active issue lease. A stale issue lease is marked failed; a completed request can return only its exact claim-bound encrypted response during the two-minute retry window and cannot issue again. Expired retry material is removed, and any credential batch whose completion compare-and-set fails is revoked before the response returns.
- Direct administrative local-grant issuance requires a loopback socket peer. Device-authorization request/consume and authenticated uninstall accept a direct Docker bridge peer so a host connector can reach a loopback-published container, but they require a valid `Host`, require any browser `Origin` to match that host, and reject `Forwarded`, `X-Real-IP`, and every `X-Forwarded-*` header. These endpoints are not valid reverse-proxy targets. Uninstall additionally requires the existing bearer grant, signed process identity, and exact target binding.
- Local MCP requests carry signed process identity headers covering client id, package id, process key id, timestamp, nonce, body hash, fingerprint, signature, and capability key.
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
npm run verify:mcp-client-identity-proof
npm run verify:mcp-process-identity-credential-store
npm run verify:security-alert-lifecycle
npm run security:hygiene
npm run test:security
npm test -- --suite security.http-resource-admission
node tools/server-scripts/verify-authorization-governance.ts
node tools/server-scripts/verify-process-identity.ts
npx vitest run tests/vitest/server/process-identity-nonce-capacity.test.ts tests/vitest/server/local-secret-crash-consistency.test.ts tests/vitest/server/plugin-mcp-outlet-visibility.test.ts
npx vitest run tests/vitest/server/capability-binding-guard-persistence-and-recovery.test.ts tests/vitest/server/capability-binding-guard-corruption-and-lock-failures.test.ts tests/vitest/server/authorization-capability-binding-guard.test.ts
npx vitest run tests/vitest/server/runtime-logger.test.ts tests/vitest/server/console-auth.test.ts tests/vitest/server/client-registry-capacity-recovery.test.ts
npx vitest run tests/vitest/server/p2-security-boundaries.test.ts tests/vitest/server/mcp-installer-device-authorization.test.ts tests/vitest/server/http-server-middleware-rate-limit.test.ts
node tools/server-scripts/verify-security-local-stdio-lockdown.ts
```

`tools/server-scripts/lib/mcp-process-identity-credential-store-evidence.ts`
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
