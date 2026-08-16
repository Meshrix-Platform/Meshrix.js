# Build Week Demo

This guide walks through the repository-verified runtime plugins in
[Meshrix.js](../../README.md):

| Plugin | Role in the demo |
| --- | --- |
| `shared-space` | Governed local-directory mounts, snapshots, and controlled sandbox runs |
| `skill-hub` | Opaque skill submission, review, publication, and controlled execution |
| `coding-github` | Governed GitHub REST, read-only MCP, Codespace provider, and skill installer operations |

## What this demo proves

- Each plugin passes repository verification: typecheck, synthetic tests, build,
  catalog validation, deterministic packaging, and import-time smoke tests.
- Closed configuration examples activate only the declared plugin surfaces.
- No live provider credentials, private endpoints, or machine-local paths are
  required for the repository demo.

## Remaining work this demo still has

- Meshrix Core and its repository-local extensions remain **pre-release**.
  Source availability, repository verification, and a tagged production release
  remain remaining required work on separate evidence tracks.
- Passing `npm run verify` here is repository verification. Formal release
  acceptance and production qualification remain remaining required work.
- `coding-github` does not contact GitHub during repository tests. Live REST or
  MCP access requires operator-published upstream services and grants in Core.
- Catalog-only placeholder plugins elsewhere in this repository are not yet
  implemented runtime packages. Completing those packages remains remaining
  work before they can be presented as release-ready.

## Quick start (reproducible)

Requirements: Node.js 22 or 24.

```bash
cd Meshrix.js
npm run verify:local-runtime-plugins
```

This focused gate validates, builds, packages, and smoke-tests all three runtime
plugins. Run the full `npm run verify` gate once before committing a candidate.

## Manual walkthrough

### 1. Build closed plugin archives

```bash
npm run verify
```

Inspect `build/packages/packages.json` for archive names, byte sizes, and SHA-256
digests. Generated output under `build/` is disposable and must not be committed.

### 2. Review each plugin in isolation

| Plugin | Primary test entrypoint | What to look for |
| --- | --- | --- |
| `shared-space` | `tests/plugins/shared-space.test.mjs` | Snapshot, sandbox run, quarantine, and checkpoint lifecycle |
| `skill-hub` | `tests/plugins/skill-hub.test.mjs` | Opaque custody, scan/build/execute sandbox path, publication lifecycle |
| `coding-github` | `tests/plugins/coding-github.test.mjs` | External-service Host forwarding, idempotency, and closed configuration |

Run one plugin at a time when narrating:

```bash
node --test tests/plugins/shared-space.test.mjs
```

### 3. Use the demo deployment profile

The seed profile lives at
[`plugins-build-week-profile.json`](./plugins-build-week-profile.json).
It declares:

- `runtime.deploymentProfileId`: `build-week-demo`
- `runtime.enabledPlugins`: the selected runtime plugin ids
- `runtime.pluginConfigurations`: closed, synthetic activation settings

Copy the `runtime` object into Core deployment configuration **only after**
admitting the matching verified plugin packages through the Core plugin-package
workflow described in the
[plugin package and loading contract](../protocols/PLUGIN-PACKAGE-AND-LOADING.md).

Replace `demo-github-rest-binding` and `demo-github-mcp-binding` with the
logical service references your operator publishes in Core. Do not add tokens or
endpoint URLs to the profile.

## Core integration checklist

When wiring the profile into a Core deployment:

1. Build and verify plugin archives in this repository.
2. Admit each archive through Core's governed plugin-package workflow.
3. Configure `runtime.enabledPlugins` and `runtime.pluginConfigurations` from
   the demo profile (or a deployment-specific derivative).
4. Publish upstream services for `coding-github` before expecting live GitHub
   responses.
5. Run Core verification commands separately; plugin repository success does
   not substitute for Core release gates.

## Related public surfaces

- Product overview: [meshrix.io](https://meshrix.io)
- Core documentation: [Meshrix documentation](https://github.com/Meshrix-Platform/Meshrix/tree/nightly/docs)
- Plugin source: the repository-local [`plugins/`](../../plugins/) tree
- Plugin contract: [PLUGIN-IMPLEMENTATION-CONTRACT.md](../protocols/PLUGIN-IMPLEMENTATION-CONTRACT.md)
- Installation: local adapter/package scripts in [`tools/plugins/`](../../tools/plugins/)
