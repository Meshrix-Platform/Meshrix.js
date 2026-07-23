# Examples

These examples demonstrate current public contracts with synthetic values. They
do not define protocol, configuration, or capability facts.

## Upstream Service Import

[file-parser-format-convert.upstream.json](file-parser-format-convert.upstream.json)
is a synthetic portable-import example for an HTTP file-conversion service.
The authoritative schema and runtime behavior are owned by:

- [Gateway functionality](../functionality/GATEWAY.md)
- [Public protocols](../protocols/PROTOCOLS.md)
- `packages/contracts/src/upstream-service/`

Validate the example and its owning contract with:

```bash
npm run verify:upstream-fixture-transit
```

Operational startup, deployment, maintenance, recovery, diagnostics, and
repository verification commands are maintained in the [runbook](../RUNBOOK.md).
Plugin package examples and installer commands remain with their independently
maintained module documentation.
