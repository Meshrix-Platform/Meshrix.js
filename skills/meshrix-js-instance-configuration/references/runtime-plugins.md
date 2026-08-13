# Runtime and Plugin Configuration

## Canonical sources

- Read startup and instance-reuse behavior in `docs/RUNBOOK.md`.
- Read plugin runtime semantics in
  `docs/functionality/SERVER-RUNTIME.md#plugin-runtime`.
- Read configuration parsing in
  `tools/server-scripts/lib/runtime-plugin-selection.ts`.
- Read packaging and installation in `tools/plugins/pack-plugins.mjs` and
  `packages/foundation/src/module-system/plugin-package-artifact-installer.ts`.

## Runtime fields

| Field | Contract |
| --- | --- |
| `runtime.enabledPlugins` | Explicit, unique, normalized plugin IDs. Missing means none. |
| `runtime.pluginConfigurations` | Settings only for selected plugins. Unknown or disabled IDs fail startup. |
| `runtime.pluginArtifactTrustedPublicKeys` | Public Ed25519 JWKs keyed by configured key ID. Missing means trust none. |
| `runtime.deploymentProfileId` | Optional lowercase immutable profile binding. Never synthesize it. |

Keep private signing material outside runtime JSON. A deployment that should
start Skill Hub every time must keep the explicit runtime-config path in its
supervisor or startup command; it must not change the plugin manifest's
`defaultEnabled: false` contract.

## Install a local plugin artifact

1. Build immutable plugin packages with
   `node tools/plugins/pack-plugins.mjs`.
2. Obtain the package bytes and digest from the generated package inventory.
3. Load or create an Ed25519 signing identity in private operator custody. Use
   only its public JWK in `runtime.pluginArtifactTrustedPublicKeys`.
4. Resolve the same effective data root as the target server.
5. Create the matching lifecycle state port with
   `createPluginLifecycleStatePort`, then create the canonical artifact
   authority with the active Core contract digest, trusted public keys, a
   narrow `ArtifactSignerPort`, and a secret reference rather than secret
   material.
6. Call `installPluginPackageArchive` with the verified archive digest, plugin
   ID, explicit generation, dependency closure, private staging root, artifact
   authority, lifecycle state port, and Core contract digest.
7. Require the lifecycle ledger to be `active` and bound to the installed
   artifact before selecting the plugin in runtime configuration.

Do not copy a repository plugin tree into the data directory, scan `plugins/`
at production startup, accept an unsigned snapshot, or repair a ledger by
editing its files. Installation and selection are two separate operations.

## Skill Hub configuration

Use the closed schema from `plugins/skill-hub/configuration.schema.json`:

```json
{
  "runtime": {
    "enabledPlugins": ["skill-hub"],
    "pluginConfigurations": {
      "skill-hub": {
        "enabled": true,
        "modules": {
          "registry": true,
          "opaqueCustody": true,
          "controlledSandbox": true,
          "operationPermission": true
        }
      }
    },
    "pluginArtifactTrustedPublicKeys": {
      "<key-id>": {
        "kty": "OKP",
        "crv": "Ed25519",
        "x": "<public-key-x>"
      }
    }
  }
}
```

Replace placeholders from operator-controlled public verification facts. Do
not add a private JWK, signer secret, API Key, endpoint credential, or account
value. Enabling the module does not configure the controlled execution sandbox;
that remains an explicit Host-owned configuration and conformance receipt.

## Start and verify

Use one of the canonical server commands:

```bash
npm run dev -- --runtime-config <private-runtime-config>
npm run server:start -- --runtime-config <private-runtime-config>
```

Start a separate development console only when needed:

```bash
npm run dev --workspace @meshrix/console
```

Verify `GET /api/healthz`, then probe one plugin route. For Skill Hub,
`GET /api/skill-hub/v1/skills` returning `401` or `403` without credentials
means the route exists and remains protected.

## Diagnose fixed failure classes

| Symptom | Meaning and next check |
| --- | --- |
| Installed artifact snapshot unavailable | Package was not installed into the target data root or selection points at the wrong instance. |
| Lifecycle ledger unavailable, invalid, or mismatched | Installation did not complete atomically, the generation differs, or artifact trust/profile facts drifted. Re-run the canonical install transaction; do not edit the ledger. |
| `Plugin console entry is invalid` | Check the signed artifact's executable console asset. The artifact asset is `.mjs`; a Host-generated virtual development URL may still end in `.ts`. This is a source defect, not a runtime-config workaround. |
| `plugin_process_rpc_failed` | Check isolated-process capability projection. Host facade methods may be non-enumerable and must remain callable across RPC. This is a source defect, not missing plugin configuration. |
| Plugin route returns `404` | The plugin is not mounted or the path is wrong. Check artifact, selection, configuration, and startup logs using redacted reason codes. |
| Plugin route returns `401` or `403` | The route is mounted and protected. Authenticate through the normal flow; do not weaken authorization for a health probe. |
| `/health` fails | Use the canonical `/api/healthz` endpoint. |
