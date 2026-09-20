# Gateway convergence migration

This migration documents the compatibility boundary and the configuration
migrations required for gateway convergence.

The gateway convergence migration changes only the service configuration shape
owned by the gateway. It preserves grants, workspaces, assets, audit records,
and stable service identities.

Use the preview command first:

```bash
npm run gateway:migrate -- preview --input CONFIG.json
```

Apply requires the source revision from that preview. The command creates one
operator-selected backup and performs an atomic replacement. It does not start
the gateway, contact an upstream, or claim to reverse an external side effect:

```bash
npm run gateway:migrate -- apply --input CONFIG.json \
  --expected-revision REVISION \
  --backup CONFIG.json.backup
```

Old stateful MCP handles are not restored across the migration. They must be
marked lost or expired and clients must establish a new business context.
