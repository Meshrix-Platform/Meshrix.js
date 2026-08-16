# Agent Self-Maintenance Local Configuration Contract

Version: `v0.0.1:meshrix-self-maintenance:local-config-1`.

The local Agent self-maintenance plugin is a separately started local client-peer
artifact. One fixed, closed-schema local configuration file
(`local-config.schema.json`) is its only non-credential behavior-control input.
The file is replaced atomically as a single unit; no partial or in-place mutation
is a valid control input.

The plugin owns its configuration-selected planning, strategies, schedules,
queue, cancellation, recovery, budgets, run journal, and evidence. It runs under
an independent non-privileged OS identity and shares no configuration, state,
credential store, PID, socket, listener, lifecycle handle, or control channel
with Meshrix.

## Boundaries

- The configuration file is the only control input. There is no inbound control
  surface: the closed schema declares no server, listener, socket, port, or
  lifecycle field.
- The plugin calls the Model Gateway Service directly over HTTP.
- The plugin calls Meshrix only as an ordinary governed external client through
  allowed operations in `operationAllowlist`.
- `credentialRefs` are references only; secret material never appears in the
  configuration file.
- Meshrix cannot call, schedule, cancel, observe, configure, start, stop, or
  restart Agent self-maintenance. There is no Meshrix-to-maintenance-plugin
  dependency edge.
