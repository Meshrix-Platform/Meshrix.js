---
name: meshrix-js-better-plan
description: Complete-delivery Better Plan workflow for Meshrix.js large refactors, migrations, architecture generators, CI adaptations, multi-module dependency work, and multi-PR deliveries. Use before implementation when the change is multi-task or high-risk. Skip for tiny one-shot closures such as a doc typo.
audience: development
---

# Meshrix.js Better Plan

Development-only planning skill. It must **not** ship in usage skill packs.

Authority for the protocol lives upstream:
[Unka-Malloc/better-plan](https://github.com/Unka-Malloc/better-plan) (`nightly`).
This repository hosts a `docs/plan` workspace and a slim
`scripts/manifest_tool.py` (`validate`, `init-plan` only). Full
Designer / Worker / Reviewer commands come from checking out that upstream
repository.

## When to activate

Activate before implementation when the work is any of:

- Architecture generators or architecture-wide documentation projections
- CI / workflow adaptations spanning multiple packages or release surfaces
- Multi-module dependency or ownership moves
- Schema, protocol, data, or migration deliveries
- Multi-Task parallel work or multi-PR coherent deliveries
- High-risk security, privacy, release, or irreversible side-effect work

## When to skip

Skip for a tiny one-shot closure that can be understood, implemented, and
verified directly (for example a single documentation typo or a one-line
comment fix with no dependent consumers).

## Required workflow

1. Keep the Better Plan workspace at repository-root `docs/plan/` with
   `Manifest.json` schema `better-plan.manifest/v3`.
2. Before implementation of in-scope work, run upstream `next-action` (or the
   host equivalent) and obtain `authorize-plan` for the concrete sealed
   specification. Host Plan Mode approval must bind that exact Plan.
3. Semantic source is `Plan.json`. `Checkpoints.json` is execution state.
   `Plan.md` is render-only and never parsed back.
4. While Better Plan is active for a delivery, **do not invent Tasks** outside
   the Designer → compile → authorize path. Do not pretend Designer or
   Reviewer sessions ran unless they did.
5. Validate the workspace after structural edits:

   ```bash
   python3 scripts/manifest_tool.py validate docs/plan
   ```

6. Initialize a new draft Plan only when starting a delivery shell:

   ```bash
   python3 scripts/manifest_tool.py init-plan docs/plan \
     --code PLAN-00N \
     --title "..." \
     --directory short-slug \
     --goal "..." \
     --scope-in "..." \
     --scope-out "..." \
     --success "..." \
     --risk-boundary "..."
   ```

Load this skill from `$meshrix-js-developer-handbook` when the change is
multi-task, high-risk, or architecture-wide, **before** editing product
source for that delivery.
