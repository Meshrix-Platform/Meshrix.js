# Meshrix Product

This document owns Meshrix's durable product goal and boundary. It does not
record current implementation, verification, release, support, or hosted
operation. Those facts belong to [Status](docs/STATUS.md),
[Compatibility](docs/COMPATIBILITY.md), and the owning technical documents.

## Purpose

Meshrix is the full private-deployable governance platform for organizations
that need to connect agent clients, upstream services, plugins, workspaces, and
operator actions without distributing unchecked credentials or bypassing a
single execution authority.

The product lets an operator keep configuration, credentials, data custody,
runtime policy, and operational decisions inside the operator's deployment
while exposing useful capabilities through governed protocol and console
surfaces.

## Durable outcome

A Meshrix deployment should let an authorized user or agent discover an
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

## Product boundary

Meshrix owns the complete server-side governance platform for a private
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

Meshrix is intended to provide:

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

## Non-goals

Meshrix is not:

- a hosted SaaS product by default;
- a model provider or model-hosting product;
- a human messaging or federation protocol;
- the owner of client keys, end-to-end encryption, plaintext, or endpoint
  trust decisions;
- a station implementation or Lico Arc Protocol authority;
- a bypass that lets plugins, agents, controllers, queues, or internal
  services create execution authority;
- a guarantee that an optional third-party integration is configured,
  available, or supported;
- a substitute for a product-specific client, plugin, service, or hosted
  operation receipt.

MeshCore is an independent same-origin product. It is not Meshrix's internal
Core, library, backend, compatibility layer, or reduced distribution. Neither
product uses the other's source, runtime, contract, verification, release, or
support evidence.

## Documentation authorities

- [Domain language](CONTEXT.md) defines Meshrix vocabulary.
- [Status](docs/STATUS.md) records the five current status dimensions.
- [Compatibility](docs/COMPATIBILITY.md) records exact runtime, protocol,
  adapter, and environment claim boundaries.
- [Documentation index](docs/README.md) routes implemented technical facts.
- [What's Next](docs/WHATS-NEXT.md) ranks objective gaps without claiming
  completion.
