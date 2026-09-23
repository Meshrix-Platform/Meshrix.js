# PLAN-001 Auto-generated layered architecture HTML and regen script

Phase: draft · Revision: unsealed

This document is a render-only projection of `Plan.json`. Edit `Plan.json`; never edit this file.

## Intent

**Goal**: Deliver a maintainable nested-rectangle layered architecture HTML projection plus a deterministic regenerate/check script for Meshrix.js packages, services, apps, and plugins.

**In scope**
- Architecture HTML generator under tools/generators
- Committed docs/architecture projection
- npm scripts for generate and stale-check
- Minimal pointers from architecture and development docs

**Out of scope**
- Replacing existing system or service architecture diagrams
- Runtime product behavior changes
- Falsely authorizing or closing this Plan without Designer compile

**Success**
- Generator regenerates identical HTML
- Committed projection matches generator output under check
- docs/plan remains draft until Designer and authorize-plan complete

**Risk boundary**
- No false authorization or invented Tasks
- Do not claim Designer or Reviewer sessions ran
- Coordinate with any parallel branch work without treating it as Plan authority

## Decisions

Dossier status: not_required

### Observed repository facts

- Open Meshrix.js PR #86 (branch docs/layered-architecture-diagram) already adds tools/generators/generate-layered-architecture-html.mjs, docs/architecture/MESHRIX-LAYERED-ARCHITECTURE.html, and npm docs:generate/check:layered-architecture scripts. Treat that work as observed parallel progress, not as Designer completion or authorize-plan for PLAN-001.
- PLAN-001 remains phase draft with empty spec.tasks, null lifecycle.designer_session, and null lifecycle.authorization. Design-needed; not authorized.

## Requirements

None recorded yet.

## Tasks

None recorded yet.

## Authorization

Not authorized. Designer session has not completed. Do not invent Tasks or start Workers.
