# Meshrix.js Framework Scope

This document defines Meshrix.js's technical purpose and architecture
boundaries. Current implementation, verification, release, and support facts
belong to [Status](docs/STATUS.md), [Compatibility](docs/COMPATIBILITY.md),
and the owning technical documents.

## Purpose

Meshrix.js is an open-source TypeScript and Node.js framework for composing
governed HTTP and MCP services, optional plugins, workspace capabilities, and
operator workflows behind a single execution authority.

The runtime keeps configuration, credentials, persistent state, and policy
under the instance operator's control while exposing capabilities through
versioned protocol and Console surfaces.

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

## Runtime boundary

The Meshrix.js server runtime owns:

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

## Architecture goals

The maintained architecture targets:

- a dependable single-node topology before adding broader deployment shapes;
- one canonical governed-execution path for every protected resource or
  effect;
- self-contained local operation and recovery, with optional integrations
  isolated behind versioned boundaries;
- protocol-neutral verification with synthetic peers instead of dependencies
  on client repositories;
- complete migrations without permanent legacy paths; and
- precise, candidate-bound verification of package and environment support.

## Scope boundaries

The server provides a governed runtime, protocol boundaries, and a Console.
It does not infer external support from source presence, a configured endpoint,
or a passing unit test. The exact candidate and environment determine each
published support claim; see [Status](docs/STATUS.md) and
[Compatibility](docs/COMPATIBILITY.md).

Plugins, agents, queues, protocol adapters, and internal services do not mint
execution authority. Optional integrations remain outside the default runtime
unless explicitly selected and admitted through their owning contract. A
standard MCP client is authorized by protocol capabilities and grants, not by a
hard-coded client catalogue.

## Documentation authorities

- [Domain language](CONTEXT.md) defines Meshrix.js vocabulary.
- [Status](docs/STATUS.md) records the five current status dimensions.
- [Compatibility](docs/COMPATIBILITY.md) records exact runtime, protocol,
  adapter, and remaining environment-qualification evidence.
- [Documentation index](docs/README.md) routes implemented technical facts.
- [Status](docs/STATUS.md) records current product and evidence state; concrete
  future work belongs to its owning task or technical authority rather than a
  perpetual roadmap.

## Programmable gateway product boundary

The gateway kernel is a small public package with injected policy, credential,
catalog, upstream, resource, prompt, and lifecycle ports. It is not a built-in
general-purpose orchestrator. Downstream MCP client access and upstream service
adaptation are separate protocol boundaries. Each declared profile must use the
same governed invocation boundary; an upstream adapter does not establish
support for a downstream client profile. Optional business events and
collaboration remain separate adapters.
