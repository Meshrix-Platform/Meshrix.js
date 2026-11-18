# Core ingress admission

Core admission limits resource use before protected execution. Admission is not
authentication authority: policy, lifecycle, process identity, resource selection
and final protected-effect permits remain live downstream checks.

## Password login

The Console authentication owner maintains one source window for both registered
HTTP `auth.login` and JSON-RPC `auth.login`. Its configured default is 40 failed
or outstanding guesses per 60 seconds. A successful session commit refunds its
reservation. Failed attempts do not write an account lock or a durable source
lock. Legacy account-lock columns and source history remain preserved but cannot
deny a correct login.

At most four password checks per source and sixteen globally may execute at once.
A busy source or full check capacity returns `429` with a one-second retry;
a full guess window returns the remaining window duration. A full window rejects
before scrypt. The bounded source map retains at most 10,000 active windows and
prunes expired inactive entries. Admitted password checks are not cancelled by an
internal deadline. Correct authentication also rechecks the enabled account and
unchanged verifier when creating the session.

HTTP and RPC preserve the same retry carrier. Successful RPC login and session
rotation preserve the same session cookies as their HTTP counterparts. JSON-RPC
retains its existing HTTP 200 error envelope, including the operation status code.
A saturated source must wait for the advertised window; a username never creates
an account-wide denial, and changing a network is not a recovery requirement.

## Authenticated resource budgets

Before retaining an HTTP body, a Console cookie session or scoped API Key may
identify the admission subject. API Key possession uses the real primary-key
lookup, constant-time verifier comparison, current lifecycle, exact audience and
organization lineage checks. It returns only a workload subject and organization
identifier. It does not validate or consume process-identity nonces, grant uses,
protected-effect reservations or authorization receipts.

API Key body and request budgets use the workload principal and exact owning
organization. Cookie budgets use the validated Console user and tenant. Neither
uses a caller-supplied identity header. Unauthenticated and invalid credentials
remain in source budgets. Concurrent Key identification is bounded to sixteen
per source and sixty-four globally; no credential authority is cached between
requests. Full authentication and authorization still run before execution and
deduplicate only the already charged principal budget.

A valid subject on a shared NAT does not inherit another anonymous caller's
request/body budget. Global connection, memory and execution capacities remain
shared physical limits. Organization administrators and platform operators must
still configure suitable per-tenant limits for their deployment.

The Console producer's default Key audience is its server authority (`host` with
an optional port); development Console port 5173 maps to API port 7228. Connector
snippets add the transport scheme separately. Authentication compares the actual
Host audience exactly; an arbitrary URL is not an alternative audience spelling.

## HTTP telemetry

Unknown paths project to `unmatched`, registered paths to their fixed route
templates and unsupported methods to `OTHER`. Query strings and concrete path
parameters are not retained. Schema migration reprojects historical route and
method fields while preserving row identities, counts, timestamps and byte facts.

Denied and closed requests aggregate for up to one second before a transactional
batch. The buffer keeps up to 512 ordinary keys and a finite overflow lattice of
status, completion and transport keys. It never evicts an active key or resets a
count on key rotation. Overflow uses the `overflow` route and `OTHER` method while
retaining exact status, completion, transport, count, bytes and summed duration.
Reads and orderly close flush pending facts; failed writes retain pending facts
and read/close report the failure. Abrupt process loss can lose the current
in-memory telemetry interval; this is not an operation settlement ledger.

Summary, health, bucket and export request totals weight `event_count`. Physical
metric row counts remain separately observable. Aggregate latency percentiles use
bounded power-of-two millisecond histograms and explicitly report upper-bound
approximation; average latency, byte totals and total request counts remain exact.

## Skill Hub transport

The Core-bound Skill Hub principal is the source of its private service admission
header. A closure-owned opaque carrier survives internal option composition and
is recognized only by the actual HTTP sink. Public forward input, configured
headers and copied request bodies cannot mint that carrier. The sink removes
untrusted subject headers before inserting the bound pairwise subject reference.
The service independently verifies its service credential and requires the body
principal to match the header before publication work.

## Deployment boundary

Organization governance and workload Key resource policies do not turn every
platform-global administrative operation into a tenant-local SaaS API. Console
owner and platform administrative roles retain their documented platform scope.
A deployment offering independent untrusted tenants must separately review role
assignment and each platform-global administrative surface. Admission tenant keys
provide quota isolation, not an expansion or restriction of operation authority.
