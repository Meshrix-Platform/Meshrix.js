---
name: meshrix-js-architecture-reassembly
description: Diagnose Meshrix.js architecture reassembly — source splits, package or ownership moves, protocol boundaries, composition-root changes, and capabilities whose consumers no longer agree with their authority — using the reassembly CLI inventory, the reassembly contract, and migration completion handoff. Delivery closure decisions are owned by $meshrix-js-delivery-closure.
---

# Meshrix.js Architecture Reassembly

This skill owns the **architecture reassembly diagnostic** for Meshrix.js:
source splits, package or ownership moves, protocol boundaries,
composition-root changes, and capabilities whose consumers no longer agree
with their authority. Delivery closure decisions belong to
`$meshrix-js-delivery-closure`; frontend visual direction belongs to
`$meshrix-js-frontend-visual-direction`.

## Establish authority

1. Run `git status --short` for every repository boundary before editing.
2. Use this skill only for the reassembly diagnostic. When the selected closure
   actually replaces a source, route, schema, name, or owner, hand off to
   `$meshrix-js-migration-completion` for the migration work.

## Diagnose reassembly

Use the reassembly diagnostic for a source split, package or ownership move,
protocol boundary, composition-root change, or capability whose consumers no
longer agree with its authority. Do not require it for every feature or UI edit.

1. Optionally run `node skills/meshrix-js-architecture-reassembly/scripts/reassembly-cli.mjs plan .` to inventory
   changed surfaces and receive a suggested depth. Add `--changed-from <ref>`
   only when those committed changes belong to the same candidate.
2. Read `references/reassembly-contract.md` when the inventory reveals material
   boundary or migration risk.
3. For a standard or deep closure, optionally copy
   `assets/reassembly-contract.template.json` into ignored process storage. Fill only the
   surfaces that sharpen a decision; missing or pending surfaces are prompts,
   not execution blockers.
4. Update the canonical contract and fact owner before projections when that
   ordering reduces split authority. Bind once, migrate consumers, regenerate
   derived facts, and remove superseded behavior when the selected work is a
   completed migration.
5. Optionally run `node skills/meshrix-js-architecture-reassembly/scripts/reassembly-cli.mjs check
   <contract-file> --target .`. Interpret `errors` as an unreadable or unsafe diagnostic
   artifact and `advisories` as review prompts. The command never authorizes,
   blocks, or completes a Better Plan lifecycle.

The `reassembly` check is an optional deep diagnostic. It does not replace the
repository-owned package scripts or acceptance reducer. See
`references/examples.md` for proportional examples.

## Boundaries

Do not make delivery closure decisions from this skill; use
`$meshrix-js-delivery-closure`. Do not choose frontend visual direction; use
`$meshrix-js-frontend-visual-direction`. Do not execute a migration; use
`$meshrix-js-migration-completion`.
