---
name: meshrix-js
description: Meshrix.js product identity and specialist skill routing. Use the developer handbook for product changes and the user handbook for operating an instance.
---

# Meshrix.js

## Product and authority

Meshrix.js owns its private Node.js platform. Keep its implementation, paths,
commands, evidence, and history private; never project them into the public
Meshrix repository or describe public work as originating here. Public Go work
uses `$meshrix`. Work touching both products keeps separate contracts, source,
tests, evidence, and completion claims.

Authoritative Meshrix.js skills live in this repository's `skills/` directory.
Distribution and installed packages are generated from these sources. They
are projections, not independent places to edit policy. Use the current
repository's AGENTS.md, source, and command definitions when a distribution is
stale; report the distribution defect and continue authorized work.

Meshrix.js follows a self-owned implementation route for its core Node.js
platform and infrastructure. Do not apply the public Go dependency-admission
table here or replace owned protocol, gateway, permission, queue, state, plugin,
storage, audit, or runtime authorities with third-party frameworks merely
because the Go product admits them. Existing runtime, UI, database-driver,
cryptographic, and edge utility dependencies do not transfer those authorities.
Any exception requires an explicit maintainer decision for this private product.

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

Preserve unrelated work and finish every replacement claimed by the selected
outcome. Record other gaps with their owning workflow; they do not expand the
current task automatically. Existing explicit authorization remains valid for
the same target, operation, and effects. New authority or a material unresolved
decision needs user input; continue independent authorized work meanwhile.
Applicable script-repair, regression-failure, dependency, and publication
approvals remain required. Plans, routing, successful tests, and command flags
never grant execution authority.

For skill maintenance, use the [bounded task scenarios](references/maintenance-scenarios.md)
to review routing and observable outcomes after changing an entry or helper.

## Plugin and Service boundaries

A Plugin is a target-specific native TypeScript/Node.js extension coupled to
Host contracts, lifecycle, capability registration, and interoperability.
Process isolation does not make it a Service. A Service exposes an independent,
language-neutral remote contract and can serve clients without Meshrix.js.
Direct Service access belongs to its own operator's governance. A native
Plugin may adapt a Service without merging the two boundaries.
