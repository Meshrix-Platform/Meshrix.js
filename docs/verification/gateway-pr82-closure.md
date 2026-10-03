# PR82 gateway closure: local Developer Preview inventory

This is a **working-candidate inventory, not an acceptance, publication or
deployment receipt**. The historical plan and its 16 requirements/100 reference
cases remain input evidence, not inherited passes. A separate coordinator-owned
local inventory maps all 100 original identifiers and 16 requirements as
**retained for verification**; none is individually re-executed or passed.
The exact candidate source is uncommitted, so GC-002 and the installed product
oracle cannot be reported as bound to a committed revision. The original
candidate-selection and whole-run execution-lease repair is awaiting maintainer
direction; this inventory does not implement or bypass it.

The following statuses concern only **owned, synthetic, focused checks**.
"Focused" means the named local assertion ran; it does not mean the whole
case's external oracle or the full acceptance profile passed. "Partial" means
some observable behavior is exercised but a stated element is missing.

| Frozen case | Status | Focused evidence or missing element |
| --- | --- | --- |
| GC-001 | Partial | Static local inventory maps all 100 originals and 16 requirements; each original case remains individually unverified. |
| GC-002 | Blocked | Current worktree has no committed exact candidate; historical baseline cannot supply one. |
| GC-003 | Focused | A consumed token cannot dispatch a second protected peer effect. |
| GC-004 | Focused | A noncanonical alternate spelling is rejected and canonical presentation still produces exactly one peer effect. |
| GC-005 | Focused | 20 concurrent presentations of the same token produce exactly one peer effect. |
| GC-006 | Focused | Ephemeral restart invalidates old tokens; private SQLite ACID claims persist across reopen and 12 independent processes admit one winner. |
| GC-007 | Focused | Wrong tenant does not claim token; rightful tenant subsequently invokes once. |
| GC-008 | Focused | Durable ledger capacity rejection is `not_started` before a second peer send; a previously dispatched unknown write remains non-replayable. |
| GC-009–GC-012 | Focused | Explicit route/method restrictions and fabricated approval flags rejected in `closure/authority.test.ts`. |
| GC-013 | Focused | Subject, target, route, input, grant generation, expiry, real current pending approval and revocation tested. |
| GC-014 | Focused | Queued grant revocation denies before secret resolution and peer send. |
| GC-015 | Focused | Target changed during credential resolution fails before send; unrelated catalog update succeeds. |
| GC-016 | Focused | Keyed response reaches peer and determines completion in `closure/mrtr.test.ts`. |
| GC-017–GC-018 | Focused | State-only challenges and absent, empty and nonempty upstream states each round-trip through two actual peer invocations. |
| GC-019 | Focused | Wrong route or business parameters cannot reuse original continuation. |
| GC-020 | Focused | Second-round cancellation reaches peer and write outcome remains unknown/non-replayable. |
| GC-021 | Focused | Tool, resource and prompt input cycles preserve their method-specific result fields and keyed answers. |
| GC-022 | Focused | Two interleaved subjects/context handles survive changed per-hop capabilities and one repeated missing-answer challenge without cross-talk. |
| GC-023–GC-024 | Focused | Complete envelope retained; unknown unnegotiated result rejected. |
| GC-025 | Focused | Valid `structuredContent` and content fields round-trip; invalid `structuredContent` fails explicitly. |
| GC-026 | Focused | Downstream list replies retain schema, annotations, title and prompt arguments; an unknown effect remains denied despite a read-only annotation. |
| GC-027–GC-029 | Focused | Resources/prompts method fields, safe RPC errors versus `isError`, and forged internal `kind` checked. |
| GC-030 | Focused | Modern required `_meta` and protocol headers observed on configured default peer. |
| GC-031 | Focused | A configured peer publishes recursive 2020-12 `$defs`/`$ref`, rejects wrong types before dispatch and preserves valid UTF-8 content; isolated hostile evaluation is separately bounded. |
| GC-032 | Focused | Default platform peer round-trips benign application metadata in arguments and result while required protocol `_meta` remains separate. |
| GC-033 | Focused | Default platform calls a real modern pinned-DNS peer without initialize or retired forwarder invocation. |
| GC-034 | Focused | Malformed external schema does not evict a healthy catalog neighbor. |
| GC-035–GC-038 | Focused | Three declared legacy versions each use a real HTTP peer to initialize once, send initialized notification, bind session/auth, and remain lost after fatal 404; configured default legacy path is separately exercised. |
| GC-039–GC-041 | Focused | Authorized pagination, related revision expiry, and stable collision aliases checked. |
| GC-042 | Focused | Resource and prompt lookups both reach the 101st published entry. |
| GC-043 | Focused | Resource template lists `uriTemplate`; a filled URI maps to upstream and only a URI field maps back. |
| GC-044 | Focused | Two subject-partitioned subscriptions; one revocation stops only that stream. |
| GC-045 | Focused | Authorized resource reading returns exact peer text without rewriting URI-like business text; an outsider cannot read it. Owner-bound full/range artifact downloads match exact peer bytes; another subject receives 404. |
| GC-046 | Focused | Separate raw `opaque_stream` owner tests retain byte-safe HTTP transit; the default platform projects configured multipart bytes, declared context header, artifact reference and owner-bound byte-range download without nesting its MCP result. |
| GC-047 | Focused | Context/permit/admission/schema/continuation budgets pass combined 24-client/8-upstream pressure; six injected-clock cycles return context/permit counts to zero and keep exactly two catalog routes. |
| GC-048–GC-049 | Focused | Six bounded drain/cancel cycles alternate blocked resource and prompt sinks; queue, controller, deadline-timer, stream and isolated-worker counts all return to zero. |
| GC-050 | Focused | A slow peer's queue does not serialize a separate fast peer; 8-upstream, 24-client waves complete independently. |
| GC-051 | Focused | The same private SQLite durable profile stores unknown receipts and continuation claims; a counted peer effect, lost response, reopen and scoped query return `outcome_unknown` without another send or permit replay. Foreign subject is denied. |
| GC-052 | Focused | Unsupported migration root rejected byte-for-byte. |
| GC-053 | Focused | Migrated stdio config launches, calls, and retires an actual owned child. |
| GC-054 | Focused | Byte-digest preview CAS and concurrent apply loser checked. |
| GC-055 | Focused | Original owner rejects invalid EEXIST backups, verifies first-backup provenance/content-addressed bytes, cleans partial write/rename temps and restores exact originals. |
| GC-056 | Focused | Empty-consumer package HTTP entry handles two calls and SIGTERM. |
| GC-057 | Focused | Empty-consumer installed HTTP, stdio, migration and remote TLS commands run with their working directory inside the installed package, not the source checkout. |
| GC-058 | Focused | Local defaults deny remote/inline secrets; explicit TLS/Bearer/allowlisted pinned-HTTPS remote profile filters service grants in a synthetic peer test. Public deployment is not claimed. |
| GC-059–GC-060 | Blocked | Concurrent original acceptance candidate/run isolation and exact committed package/command binding depend on unapproved original candidate/lease repair. |
| GC-061 | Partial | Required report missing/skipped/stale statuses fail original reducer; entire safe command DAG not run. |
| GC-062 | Blocked | Incomplete manifest versus immutable archive cannot be promoted without approved original gate changes. |
| GC-063 | Partial | The local Developer Preview support matrix below separates source/package/oracle/deployment claims; no promoted or published Preview candidate exists. |
| GC-064 | Failed diagnostic | The archived, unmodified PR82 baseline commit builds locally. Matching-concurrency, three-round synthetic common `tools/call` read measured the then-current dirty source at 2.015–5.080× baseline p95, exceeding the unchanged 10% threshold in every round; raw p50/p95/p99/throughput/RSS is in local plan evidence. Subsequent lifecycle-stat/receipt edits were not remeasured. Baseline state-only MRTR is semantically invalid, so that operation cannot be compared. Neither dirty snapshot is an accepted candidate. |
| GC-065 | Focused | Two independent synthetic services advance their own facts separately; calls before and after a gateway restart return each peer's surviving version, with no gateway-owned business counter. No real knowledge service is contacted. |

## Boundary and handoff

The lightweight gateway kernel remains independently packaged with contracts
and Ajv. The installed application composes governance, credentials, versioned
adapters and the original migration owner. The local serving profile binds
loopback and requires explicit operator risk for tool effects; standard MCP
clients do not require a product identity catalog. Declarative service custom
headers still reach the configured modern upstream peer. Published gateway
tools and the Console's direct MCP management operation now invoke the same
configured typed modern/legacy transport; the old tools-only MCP transport
core has been removed.

### Direct-forward contract (NODE011)

`callMcpToolByPublicName` is now a thin public-name/result-shape delegate to
the configured typed gateway route; its direct session isolation and indexed
lookup tests pass. Registered Console `gateway.forward` and
`upstream_operation.*` retain their operation IDs, existing response shape
and `finalProtectedSinkPermit`. The owned MCP branch revalidates/consumes that
permit against its current configured target **after argument validation and
before credentials or network access**, then enters the same typed
transport as the published gateway; missing, revoked, replayed and stale
attempts cannot dispatch. The former MCP transport forwarder module is gone;
its necessary response policy and audit projection lives in a Console adapter,
not a second protocol executor. Configured HTTP/JSON-RPC and binary transport
branches retain their independent existing owners. This source/focused-test
claim is separate from any acceptance candidate or release claim.

No complete regression, true same-candidate oracle, production deployment,
publication, tag, commit or push has been performed by this worker. Runtime
privacy-sensitive details and synthetic peer payloads are intentionally not
reproduced in this document.

## Local Developer Preview support boundaries

| Surface | Current source support | Not claimed |
| --- | --- | --- |
| Package | Declares Node 22/24; focused checks used Node 24. `@meshrix/gateway` plus `@meshrix/contracts` are lightweight, while governance and credential ports are supplied by the host. | A published, signed or promoted npm release; Node 22 runtime evidence. |
| Installed command | `meshrix-gateway check`, `serve --config FILE`, `serve --transport stdio --config FILE`, and `migrate preview|apply|restore` from the original migration owner. | Account lifecycle or Core deployment. |
| Transport | Local loopback HTTP MCP; newline-framed stdio MCP; configured loopback HTTP or owned stdio upstream. An explicit remote profile requires TLS listener identity, Bearer secret binding, exact service grants and pinned-HTTPS host allowlists. Modern `2026-07-28` uses `server/discover`, not initialize; declared legacy versions use an initialized session. | An unauthenticated public listener or network changes to a real external target. |
| Authority | Explicit subject/route/method grants, current target and credential generation rereads, permit consumption, verified platform pending approval, one-time continuation and optional dedicated private SQLite replay ledger. | Upstream annotations, client product names, inline credentials or a boolean `approved` flag as authority. |
| Resource limits | Bounded catalogs, admissions, contexts, continuation ledger, payload bytes and cancellable isolated schema workers. | A proved hardware-specific p95 threshold or an unlimited-content promise. |
| Files | Existing binary/multipart/artifact transit owners remain separately verified; focused default-platform multipart, declared header and owner-bound range checks pass. URI-template projection rewrites URI fields only. | Public remote-provider or deployed-file acceptance. |

**Performance hold:** the original 10% p95 budget is unchanged. A bounded
synthetic read operation failed that budget against the archived PR82 baseline
in all three warmed rounds at both tested concurrencies. Do not promote a
Preview result from this diagnostic. The canonical `gateway:benchmark` owner
currently labels a no-op workload as evaluated and is awaiting maintainer
direction for repair; this worker did not replace it with a second gate.

For a synthetic local-only profile, configure each service with a loopback
`baseUrl` or an owned `transport: "stdio"` plus `command`/`args`; give each
executable tool an operator-selected `toolRisk`. Optional authorization and
stdio environment bindings use `env:VARIABLE_NAME`, not inline secrets. The
HTTP `serve` command emits a single JSON line with `interopEndpoint` once
ready; terminate it with SIGTERM and wait for cleanup. Stdio `serve` reserves
stdout for JSON-RPC, stops on EOF/SIGTERM and never prints readiness there.
Migration `preview` yields the exact input byte digest; `apply` requires it,
preserves the earliest private backup alias, its content-addressed object and
source/target provenance receipt, and fences competing writers. `restore`
checks both digests and provenance before changing source bytes. Synthetic
partial-write/rename failures and invalid pre-existing backups are covered.
This is not a disaster-recovery release promise without a bound candidate and
final acceptance profile.
