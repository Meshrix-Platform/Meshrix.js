---
name: meshrix-js
description: Meshrix.js technical scope and specialist skill routing. Use the developer handbook for repository changes and the user handbook for operating an instance.
---

# Meshrix.js

## Product and authority

Meshrix.js is an open-source TypeScript and Node.js framework for governed
HTTP and MCP services. This repository defines its implementation and
technical boundaries. Source availability does not establish registry
publication or support for a particular artifact and environment; cite exact
release evidence for those claims. Never disclose credentials, personal or
machine identity, private deployment details, or runtime payloads.

Authoritative Meshrix.js skills live in this repository's `skills/` directory.
Distribution and installed packages are generated from these sources. They
are projections, not independent places to edit policy. Use the current
repository's AGENTS.md, source, and command definitions when a distribution is
stale; report the distribution defect and continue authorized work.

Keep architecture and dependency ownership aligned with the registries and
layer boundaries in `docs/architecture/ARCHITECTURE.md`. External libraries
may provide implementation primitives; protocol, authorization, state,
storage, audit, and runtime decisions remain with their registered Meshrix.js
owners.

## Route the task

- `$meshrix-js-developer-handbook` owns source, packaging, and release-artifact
  work; apply `$meshrix-js-repository` for repository changes.
- `$meshrix-js-user-handbook` owns operating an instance and connecting external
  systems. One authorized task may contain development followed by instance
  verification; retain each step's owner, authorization, and evidence claim.
- `$meshrix-js-regression-planner` selects focused checks and final integration.
  Load only the specialist skills needed for the accepted outcome.

| Common task | First specialist |
| --- | --- |
| Diagnose denied access or an empty tool catalog | `$meshrix-js-operation-permission`; use `$meshrix-js-api-key-issuance` only for an authorized new key |
| Connect a standard MCP client | `$meshrix-js-downstream-mcp-client-access`, then the relevant agent reference if needed |
| Develop a Plugin, client adapter, or Service | `$meshrix-js-developer-handbook` and its extension ownership reference |
| Build an offline archive | `$meshrix-js-offline-pack` with an explicit product repository |
| Change Console source | `$meshrix-js-repository` and `$meshrix-js-frontend-visual-direction` |
| Change documentation or skills | `$meshrix-js-regression-planner` for focused checks |

Follow repository `AGENTS.md` for execution authority and
`CONTRIBUTING.md` for the common engineering workflow. Complete ordinary
in-scope repairs and focused verification within the approved outcome. Keep
publishing, pushing, deployment, and real-environment acceptance within their
separately defined authority and evidence boundaries.

For skill maintenance, use the [bounded task scenarios](references/maintenance-scenarios.md)
to review routing and observable outcomes after changing an entry or helper.

## Plugin and Service boundaries

A Plugin is a target-specific native TypeScript/Node.js extension coupled to
Host contracts, lifecycle, capability registration, and interoperability.
Process isolation does not make it a Service. A Service exposes an independent,
language-neutral remote contract and can serve clients without Meshrix.js.
Direct Service access belongs to its own operator's governance. A native
Plugin may adapt a Service without merging the two boundaries.
