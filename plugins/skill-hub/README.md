# Skill Hub

Skill Hub is a default-disabled Meshrix product plugin for governed skill submission, opaque custody, controlled scanning and build execution, independent review, immutable publication, adoption, permission grants, usage statistics, revocation, and rollback evidence.

Activation is explicit and closed:

```json
{
  "enabled": true,
  "modules": {
    "registry": true,
    "opaqueCustody": true,
    "controlledSandbox": true,
    "operationPermission": true
  }
}
```

An empty configuration returns zero contributions. Unknown fields and partial module selections are rejected before contributions become visible.

Plugin state is stored only through the scoped `pluginData` capability. Submitted package bytes arrive only as an opaque custody receipt; the plugin never accepts a Core data-directory path, expands a package, starts a process, or falls back to Host execution. Scan, build, execute, status, and cancellation use the operation-scoped `sandboxExecution` Host port. Grant publication uses `operationPermissionGrant.recordPluginGrant` only after current Operation Permission governance has been projected into the call. Asset-integrity alerts use `securityAlertStore`.

The browser console is precompiled JavaScript. It performs no request during import or mount and issues same-origin read requests only after an authorized user action.
