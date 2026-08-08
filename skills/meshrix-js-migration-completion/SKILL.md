---
name: meshrix-js-migration-completion
description: Complete a Meshrix.js refactor, rename, ownership move, route move, or schema migration in one pass. Use when old implementations and compatibility artifacts must be removed after the new authority is established.
---

# Meshrix.js Migration Completion

## Define the replacement

Name the old authority, the new canonical source, every consumer, generated artifact, test, document, install surface, and release task affected by the move.

Update the new source first, migrate all consumers, regenerate derived artifacts, and then delete the old implementation, names, routes, aliases, shims, fixtures, and documentation.

Persistent user state owned by a retired product name is a deliberate exception to ordinary state migration: reset it directly. The current product must initialize fresh current-name state and must not probe, import, rename, copy, translate, or prompt for a retired-name data root or preference namespace. Do not retain legacy-state fixtures or compatibility gates for this boundary.

## Close the migration

Use targeted searches during the migration to find residue. Do not keep permanent gates whose only purpose is proving an obsolete path remains absent.

Update catalog routes and workflow tasks so only the new boundary is selectable. Remove tests for deleted compatibility behavior; preserve behavioral tests only at the current contract.

Run the narrow package or verifier commands that own the changed paths, then
run `npm run typecheck` and the repository regression only after every
migration closure is complete.
