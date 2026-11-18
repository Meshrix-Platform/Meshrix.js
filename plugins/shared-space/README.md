# Shared Space

Shared Space is a default-disabled Meshrix product plugin for governed local-directory mounts, workspace synchronization, immutable snapshots, controlled sandbox runs, quarantined output proposals, and checkpoint-restore lifecycle contributions.

The plugin never opens a host path, starts a process, selects a sandbox backend, or stores workspace bytes directly. Local-directory and workspace transactions use the `agentWorkspace` Host port; sandbox admission and quarantine use `sandboxExecution`; unavailable opaque input uses `opaqueArtifactCustody`; plugin-owned lifecycle state uses only `pluginData`.

Activation is explicit and closed:

```json
{
  "enabled": true,
  "modules": {
    "localDirectory": true,
    "controlledSandbox": true
  }
}
```

An empty configuration keeps the installed plugin inactive with zero contributions. Unknown fields and partial activation configurations are rejected before any contribution is returned.

The console module is precompiled JavaScript. It performs no work during import and uses only same-origin plugin routes after an authorized user action.
