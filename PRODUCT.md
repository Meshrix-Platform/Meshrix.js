# Meshrix.js Product

This document owns Meshrix.js's durable product goal and boundary. It does not
record current implementation, verification, release, support, or hosted
operation. Those facts belong to [Status](docs/STATUS.md),
[Compatibility](docs/COMPATIBILITY.md), and the owning technical documents.

## Purpose

Meshrix.js is the full private-deployable governance platform for organizations
that need to connect agent clients, upstream services, plugins, workspaces, and
operator actions without distributing unchecked credentials or bypassing a
single execution authority.

The product lets an operator keep configuration, credentials, data custody,
runtime policy, and operational decisions inside the operator's deployment
while exposing useful capabilities through governed protocol and console
surfaces.

A current gap is remaining required work. Meshrix.js records what is true
today and keeps closing that gap; it does not freeze “we do not do this” or
“we cannot do this” as a durable product refusal. Fail-closed security
invariants stay required until a stronger replacement lands.

## Durable outcome

A Meshrix.js deployment should let an authorized user or agent discover an
allowed operation, request it through a published boundary, satisfy any
required policy or approval, produce no more authority or effect than was
admitted, and receive a bounded outcome with privacy-preserving evidence.

The platform is designed around four simultaneous requirements:

- identity is independently verifiable;
- authority is never amplified by transport, cache, plugin, or internal call;
- admitted content remains bound to the protected effect; and
- the decision, effect, and terminal outcome remain traceable through minimum
  evidence.

The normative technical meaning of those requirements belongs to
[Governed Execution And Minimum Evidence](docs/architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md).

## Plugin and Service extension boundary

Plugins and Services both extend Meshrix.js, but they have different product
boundaries:

| Dimension | Plugin | Service |
| --- | --- | --- |
| Relationship to Meshrix.js | A Meshrix.js-specific extension coupled to native Host contracts, lifecycle, capability registration, and interoperability. Process isolation does not make it an independent Service. | A general remote service that Meshrix.js may consume through a published, language-neutral protocol. |
| Implementation | Must use the native Meshrix.js language and runtime: TypeScript on Node.js. | May use any programming language or runtime that implements its published service contract. |
| Deployment and use | Is admitted and operated through the Meshrix.js plugin boundary rather than defined as a standalone general-service API. | Is independently deployable and can serve external clients directly without passing through Meshrix.js. |
| Governance | Interoperation participates in Meshrix.js Host and governance boundaries. | Calls routed through Meshrix.js receive Meshrix.js governance; direct calls do not and remain the Service operator's responsibility. |

A native Plugin may adapt an independently deployed Service into Meshrix.js.
The adapter remains a Plugin and the remote capability remains a Service;
wrapping one does not collapse the two product boundaries.

## Fallible automation and recoverable change

Meshrix.js assumes that no agent, user, plugin, controller, queue worker,
upstream service, or runtime component is infallible. Agent-produced plans,
tool calls, generated outputs, and requested mutations are proposals rather
than execution authority or current platform state. A proposal becomes
authoritative only through the canonical governance path that checks current
identity and permission, binds the exact resource and content revision,
admits the protected effect, and records its terminal outcome.

Recovery must follow the effect boundary:

- A reversible platform mutation binds its preview or exact intended change
  to current state, retains a bounded checkpoint or preimage before commit,
  and either commits atomically or enters explicit compensation or rollback.
- An external or otherwise irreversible effect cannot be reversed by a local
  snapshot or archive. It requires durable intent, protected-sink admission,
  replay fencing, and an explicit uncertain outcome when completion cannot be
  proved.
- Immutable snapshots provide consistent inputs, checkpoints and preimages
  support bounded state recovery, archived receipts and audit records provide
  minimum trace evidence, and backups protect deployment state. These
  mechanisms are distinct and do not authorize retention of raw prompts,
  governed bodies, credentials, or unrestricted runtime data.

This governance controls the transition from a proposal to an authoritative
effect. Semantic correctness of model output is outside this governance
boundary. Compensation never reverses an already external unowned effect.

## Product boundary

Meshrix.js owns the complete server-side governance platform for a private
deployment:

- server configuration and runtime composition;
- authenticated protocol and console entry points;
- Operation Permission, grants, policy evaluation, approvals, and admission;
- exact execution dispatch and protected-sink authorization;
- upstream HTTP and MCP service publication;
- downstream governed protocol access;
- plugin package and Host boundaries;
- workspace assets, jobs, storage, checkpoints, backup, and restore;
- audit, metrics, diagnostics, and bounded evidence;
- release-candidate definition and repository-owned functional acceptance.

External databases, object stores, identity providers, model providers,
telemetry services, notification services, and upstream business systems are
optional operator-selected integrations. Their absence must not silently
become a configured default or a false capability claim.

## Product direction

Meshrix.js is intended to provide:

- a dependable single-node private deployment before broader deployment
  shapes;
- one canonical governed-execution path for every protected resource or
  effect;
- self-contained local operation and recovery, with optional integrations
  isolated behind versioned boundaries;
- protocol-neutral verification with synthetic peers instead of dependencies
  on client repositories;
- complete migrations without permanent legacy paths; and
- precise separation of functional acceptance, publication channels,
  environment support, and hosted operation.

## Product identity and remaining required work

Meshrix.js is currently a private-deployable governance platform. Gaps below
remain remaining required work after the current candidate; they are not
permanent refusals.

- The default product is operator-owned private deployment. Hosted operation,
  multi-node availability, forwarding, and federation remain FutureGoals after
  this candidate.
- The current gateway admits operator-configured model providers. Native model
  hosting remains remaining work if a deployment requires it.
- The current product governs operations rather than a human messaging or
  federation network. Those surfaces remain remaining work if they are admitted
  later.
- Client keys, end-to-end encryption, plaintext, and endpoint trust currently
  remain with the client or operator. Cryptographic inability of the server to
  recover plaintext remains remaining work for deployments that require it.
- Client transport and messaging protocol authority currently remain with the
  owning client product. Meshrix.js still has to complete and qualify its
  connector boundary.

These terms stay required and are not remaining work to weaken:

- Plugins, agents, controllers, queues, or internal services must not mint
  execution authority.
- An optional third-party integration remains remaining qualification work
  until its named receipt exists; absence is not silent support.
- A Meshrix.js functional pass does not substitute for a product-specific
  client, plugin, service, or hosted-operation receipt; those receipts remain
  remaining required evidence.

## Documentation authorities

- [Domain language](CONTEXT.md) defines Meshrix.js vocabulary.
- [Status](docs/STATUS.md) records the five current status dimensions.
- [Compatibility](docs/COMPATIBILITY.md) records exact runtime, protocol,
  adapter, and remaining environment-qualification evidence.
- [Documentation index](docs/README.md) routes implemented technical facts.
- [What's Next](docs/WHATS-NEXT.md) ranks remaining required work.
