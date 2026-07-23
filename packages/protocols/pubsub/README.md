# Pubsub Protocol

Pubsub topics carry runtime notifications for console and operator workflows.

## Topic Families

- `runtime.status`
- `jobs.changes`
- `gateway.changes`
- `operation_permission.audit`
- `approval.changes`
- `workspace.changes`

## Boundary

Topics are transport notifications only. Authorization, capability facts, and persistence remain
in the owning runtime or capability provider. This package does not import domain or
server-runtime internals.
