# Plan Docs

**Purpose:** Better Plan v3 workspace for Meshrix.js complete-delivery planning.
Indexed by [Manifest.json](./Manifest.json). Development skill:
`$meshrix-js-better-plan`. Upstream authority:
[Unka-Malloc/better-plan](https://github.com/Unka-Malloc/better-plan).

## Workspace boundary

1. `Manifest.json` uses schema `better-plan.manifest/v3`.
2. Each registered directory holds semantic `Plan.json`, optional execution
   `Checkpoints.json` (required only after authorization), and render-only
   `Plan.md`.
3. `Design.md` / `Design.pristine.md` appear after Designer close; they are
   compiler inputs, not alternate semantic state.
4. Repository-local slim validator / initializer:

   ```bash
   python3 scripts/manifest_tool.py validate docs/plan
   python3 scripts/manifest_tool.py init-plan docs/plan --code PLAN-00N ...
   ```

5. Full Designer / Worker / Reviewer CLI comes from checking out
   `Unka-Malloc/better-plan` (`nightly`). Do not invent Tasks while Better Plan
   is active without that Designer → compile → authorize path.
6. `.better-plan.lock` and generated `Report.html` remain untracked.

## In-flight shells

Draft Plans below are **init-only**. They are not Designer-complete and are
**not authorized**. Observed facts may note parallel branch work; that is not
authorization to implement from this Plan.
