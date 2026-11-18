# Meshrix.js Deployment Entry Index

Start with `packages/foundation/config/deployment/index.json`. It is the machine-readable entry point for Docker presets and the verification commands that prove those entries still match the public implementation.

Useful commands:

```bash
npm run server:deployment-index
npm run server:deployment-index -- section dockerPresets
npm run release:package-server-source
node tools/server-scripts/verify-deployment-index.ts
```

Deployment proof must run in fresh containers. Use the commands under `validation.freshContainer` in `index.json` when the touched area affects bootstrap or container startup.

The package command writes a reproducible server source archive and SHA-256
checksum under `build/packages`. It intentionally excludes installed dependencies
and container images, so building it on a target host requires network access to
the configured package and operating-system repositories.
