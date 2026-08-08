# Proportional Reassembly Examples

## Contents

1. Private extraction inside one feature root
2. Workspace package extraction
3. Core and client protocol separation
4. Optional plugin contribution
5. Compatibility removal
6. Example contract fragments

## 1. Private extraction inside one feature root

Scenario: one runtime file owns parsing, policy, persistence, and lifecycle
cleanup. Parsing can change and be tested independently, but all responsibilities
remain under one package and one public API.

- Keep the canonical public facade unchanged.
- Extract a private sibling module with a responsibility name.
- Pass immutable input and explicit ports; do not expose shared writable state.
- Update the feature-root file inventory and its existing test suite only when
  the package manifest owns that inventory.
- Mark `configuration`, `documentation`, and `external-adapters` not applicable
  when their facts did not change.
- Run the changed-file closure. The full reassembly profile is optional unless
  a registered boundary or product surface changed.

## 2. Workspace package extraction

Scenario: a cohesive capability moves from a broad runtime package into an
independently owned workspace package.

- Establish the new package manifest, public facade, dependency declarations,
  source ownership, and executable suite before migrating callers.
- Move state ownership and lifecycle together. Do not leave the old package as
  a write-through proxy.
- Update public API and dependency-rule registries from the new authority.
- Bind the package once in the server composition root.
- Migrate operations, protocol adapters, UI clients, tests, fixtures, generated
  projections, and factual documentation.
- Delete the old exports, path aliases, fallback imports, fixtures, and tests.
- Start with the changed-file closure. Add the Core-owned `reassembly` profile
  when the move changes Core composition, registries, or product-surface
  convergence and the extra evidence is worth its cost.

Expected contract surface decisions:

| Surface | Example status |
| --- | --- |
| `canonical-contract` | `verified`: new package facade and typed operation contract. |
| `composition` | `verified`: one composition-root binding and reverse-order close. |
| `consumers` | `verified`: runtime and protocol callers use the facade. |
| `configuration` | `verified`: package exports and dependencies select the package. |
| `registries-generated` | `verified`: module, public API, dependency, and test registries. |
| `tests` | `verified`: package contract, composition, and end-to-end operation suites. |
| `documentation` | `verified`: current architecture owner and verification command. |
| `external-adapters` | `not-applicable` when no cross-repository protocol changed. |

## 3. Core and client protocol separation

Scenario: server and client implementations previously shared assumptions and
must be decoupled behind a published wire contract.

- Core owns the protocol schema, negotiation, server state machine, and neutral
  peer corpus required to prove server behavior.
- The client owns adoption, local cache replacement, UI observation, platform
  lifecycle, and packaging.
- Neither repository imports, discovers, executes, waits for, or reduces the
  other repository's source, tests, reports, or receipts.
- Give each repository its own contract and workflow closure.
- Record compatibility only after both sides independently pass the published
  protocol corpus. Do not let client adoption promote or block Core readiness.

The Core diagnostic may mark `external-adapters` not applicable to its own
assessment because client adoption is independently owned. The client selects
its own repository checks; it never inherits the Core `reassembly` profile.

## 4. Optional plugin contribution

Scenario: an optional provider implementation moves out of Core.

- Keep only the typed Host capability, contribution schema, admission policy,
  and composition mount in Core.
- Move provider implementation, credentials, provider-specific configuration,
  and provider tests to the plugin repository.
- Select the plugin only through an explicit verified artifact and deployment
  configuration. No manifest default may activate it.
- Verify Core with a synthetic contribution and the plugin with its own
  manifest, contract, and execution tests.
- Do not copy plugin operations into the static Core registry or add a fallback
  provider in Core.

This is two repository closures joined by a public plugin contract, not one
cross-repository source migration.

## 5. Compatibility removal

Scenario: a route, module name, or configuration key has been replaced.

- Put the current name and path in `authority.canonicalSources`.
- Put literal retired paths in `authority.supersededSources`.
- Record old symbols, route tokens, configuration keys, and generated names in
  `migration.residueSelectors` while migrating.
- Update every producer and consumer before deleting the old path.
- Remove redirects, aliases, fallback parsing, compatibility tests, fixtures,
  and documentation.
- Leave `migration.compatibilityRetained` empty at closure.
- Delete one-off residue scripts after the final search succeeds.

## 6. Example contract fragments

Planning-stage surface:

```json
{
  "id": "composition",
  "owner": "meshrix",
  "status": "pending",
  "paths": ["packages/server-runtime/src/composition/feature-provider.mjs"],
  "reason": "Confirm one activation and reverse-order shutdown binding."
}
```

Verified surface:

```json
{
  "id": "tests",
  "owner": "meshrix",
  "status": "verified",
  "paths": ["tests/contract/feature-contract.test.mjs"],
  "reason": "The current public contract and composition binding are covered."
}
```

Not-applicable surface:

```json
{
  "id": "external-adapters",
  "owner": "meshrix",
  "status": "not-applicable",
  "paths": [],
  "reason": "The change does not alter a published cross-repository protocol."
}
```

Possible Core deep-assessment verification declaration:

```json
{
  "profiles": ["changed", "reassembly"],
  "taskIds": ["meshrix.tests", "meshrix.build", "meshrix.reassembly-surface", "meshrix.reassembly-plan"],
  "blockers": []
}
```

Possible client or plugin declaration:

```json
{
  "profiles": ["changed"],
  "taskIds": [],
  "blockers": []
}
```

Either declaration is a recommendation record, not a completion gate. Omit
surfaces and tasks that do not help the current decision.
