# State Machine

This directory contains lifecycle state-machine primitives and machine-readable
definitions.

## Layout

- `engine/`: pure runtime transition engine, result types, errors, transition
  selection, and definition compilation helpers.
- `definitions/`: JSON lifecycle definitions. Definitions describe states,
  events, total transition matrices, guards, invariants, and proof obligations.
- `guards/`: guard registry, required context metadata, and runtime guard
  predicates referenced by definitions.
- `verification/`: schema checks and offline/CI verification for definition
  quality, including matrix totality, reachability, terminal-state rules, and
  high-risk transition protection.

Specialized product state machines are delivered by their owning verified plugin
packages and are intentionally kept outside this generic Core layout.
