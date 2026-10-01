# ADR-0002: Maintainable module boundaries — runtime edge kinds, Contracts independence, and public package facades

Status: Implemented

Date: 2026-10-01

## Context

The architecture graph verifier resolved every import as a single edge kind. It
could not tell a static runtime import or re-export from an `import type`, a
named type specifier, an `export type ... from`, or an `import()` type query.
The Console already contains a type-only relation (`approvalFlowViewContext` to
the approval view controller) and lazy route `import()` relations, so any
strongly connected component computation over the raw graph would report false
runtime cycles.

Two further boundaries were declared but not machine-checked:

- The module map fixes Contracts as dependency-free, with Foundation depending
  on Contracts and never the reverse, while the registry still listed
  `foundation` in `contracts.allowedDependsOn`.
- Production cross-package imports could traverse another package's source
  path relative to the importer instead of a declared public facade. The
  shipped startup closure contains `tools/server-scripts/start-server.ts` and
  its helper `runtime-plugin-selection.ts`, which imported Foundation internals
  by source-relative path.

Runtime entry roots also needed an explicit declaration source; a filename
prefix or a broad `tools/**` exemption would hide exactly the closure that
ships.

## Decision

1. **Edge kinds.** Every resolvable import gets one classification: static
   `runtime`, `type-only`, or `dynamic`. One `es-module-lexer` parse supplies
   specifier positions and dynamic flags; one TypeScript parse per file
   classifies `import type`, named type specifiers, `export type` declarations,
   mixed type/value re-exports, and type-position `import()` queries.
   Type-only edges are removed only from the runtime cycle computation; all
   classified edges remain subject to layer, constraint, and public-facade
   rules. Dynamic edges are classified separately and never become static
   runtime edges.
2. **Runtime cycles.** An iterative Tarjan SCC pass over static runtime edges
   only, O(V+E), reports a `static-runtime-import-cycle` violation with the
   concrete member paths for every component larger than one node (or a self
   loop).
3. **Contracts independence.** `contracts.allowedDependsOn` is empty and
   `foundation` is forbidden for Contracts. Foundation continues to allow
   Contracts.
4. **Public package facades.** Production consumers under `apps/**`,
   `packages/**`, `plugins/**`, and declared shipped runtime entry closures
   must reach `packages/**` through a declared `package.json` `exports` subpath
   or a `#meshrix` alias resolving to a declared public target. Same-component
   private imports remain legal. Test, verifier, generator, and fixture
   white-box reads remain owned inspection. Runtime entry roots come from the
   existing `package.json` `bin` metadata (dist path mapped back to its source),
   so the `start-server.ts` closure is enforced exactly.
5. **Minimal fixes.** The two relative Foundation imports in
   `tools/server-scripts/lib/runtime-plugin-selection.ts` now use the declared
   `@meshrix/foundation/module-system/...` subpaths; behavior is unchanged.

## Rejected Over-Splits

- The Console approval-flow context, controller, and views were not split. The
  only back edge is a type-only import; removing it from the runtime graph
  proves there is no runtime cycle, and the files share one state owner,
  lifecycle, and change reason.
- No tools-wide or filename-prefix exemption was added. Declaring the exact
  `bin` entry roots keeps the shipped closure in scope and keeps unrelated
  tooling out.
- No facade wildcard or source-path allowlist was added. Public targets are the
  packages' own declared exports plus the registered alias registry.
- No new export or alias was published for `apps/server` so the shipped entry
  could import its composition root through a package name. Application
  packages deliberately publish no package exports, `start-server.ts` remains
  the documented thin entry into the same composition, and adding a public app
  API would widen the surface without a real consumer.
- No second CI job was added. The existing `architecture.import-graph` suite
  drives the same analyzer through the `core-public` profile.

## Consequences

- `npm run server:verify:architecture-graph` now reports static runtime,
  type-only, and dynamic edge counts together with runtime cycles, facade
  violations, declared entry roots, and the entry closure. The current
  repository reports 1485 nodes, 3595 resolved edges (3308 static runtime, 261
  type-only, 26 dynamic), 0 runtime cycles, and 0 facade violations.
- A new cross-package source-relative import, an alias resolving outside the
  declared public surface, or a static runtime cycle fails the existing
  `architecture.import-graph` suite and the verifier command.
- The Console type-only and lazy route relations are classified correctly and
  are not reported as runtime cycles.

## Verification

- `npm test -- --suite architecture.import-graph --continue-on-failure` passes;
  it drives the classification, cycle, closure, and facade fixtures together
  with the live repository scan.
- `npm run server:verify:architecture-graph` exits with 0 violations and
  reports the classification and SCC statistics above.
- `npm test -- --suite domains.manifest --continue-on-failure`,
  `npm run typecheck:node`, and `npm run verify:docs` pass for this change.
