# Plugin Package and Loading Contract

This contract defines the Core-owned boundary for loading optional plugin artifacts. Optional plugin implementations remain outside the Core ownership boundary; Core owns artifact admission, manifest validation, lifecycle ordering, contribution projection, and shutdown.

## Closed one-plugin bundle

External plugins enter Core as one closed, content-addressed archive per plugin identity. The archive is a gzip-compressed ustar with a closed manifest file `plugin.bundle.json` (`schemaVersion` `v0.0.1:meshrix:plugin-bundle-manifest-1`) and the declared payload files. The manifest is archive metadata and a closed object: unknown fields fail admission. Exactly one `pluginId` is allowed; the payload inventory lists every non-manifest archive member with per-file `sha256` and `size`. The `entrypoint` must be a contained `.ts` path present in that inventory.

`payloadDigest` binds the sorted payload file contents. The archive digest is recorded separately as `packageDigest` / `archiveDigest` after acquisition so the digest field never circularly hashes itself. Trust evidence is explicit (`configured-digest` or `ed25519` with an operator-configured public-key allow-list). Empty trust configuration admits nothing that requires a trusted key set.

Contracts live under `packages/contracts/src/plugins/`. Validation, custody, acquisition port, and lifecycle live under `packages/foundation/src/module-system/plugin-package-*.ts`. Contribution publication uses `packages/server-runtime/src/composition/plugin-contribution-transaction.ts`.

## Source-neutral acquisition

Acquisition adapters stop at one byte-stream boundary. The acquisition port accepts an explicit source identity (`bytes` for tests and composition seams; `github_release` for governed GitHub Release retrieval; `local_package` for offline import-root files). GitHub Release sources name one `owner/name` repository, release, and prebuilt asset; `credentialRef` remains absent unless configured and is resolved only through an injected secret reference. Local package sources name one configured `importRootId` and relative bundle file; the adapter revalidates an opened regular file under that root and never follows links or discovers candidates. Partial, oversized, cancelled, or digest-mismatched acquisition fails closed and never stages contributions. Distinct acquisition and activation idempotency keys apply per plugin identity.

## Artifact admission (installed snapshot)

Production loading of already-installed artifacts also consumes an immutable installed-artifact snapshot. The Host validates the artifact against explicitly configured trusted Ed25519 public keys and admits only plugin identifiers listed in `runtime.enabledPlugins`. An absent trust set or plugin selection remains empty. Repository discovery, package-root search, implicit installation, manifest defaults, and feature flags cannot enable a plugin.

Every executable installed-artifact manifest declares one normalized relative `.ts` runtime entry contained by its artifact. Admission rejects path traversal, symbolic-link entries, unknown fields, duplicate claims, dependency cycles, missing dependencies, mount conflicts, and route conflicts. A deployment profile, when configured, binds the exact manifest identities, artifact digests, configuration identifiers, and dependency order. Profile drift fails before the server listens.

## Lifecycle and contributions

The durable package lifecycle covers `declared → acquiring → acquired → verified → staged → active`, with `failed`, `disabled`, `rolled-back`, and `removed` outcomes under total guards. One fenced writer runs per plugin identity. Only a fully verified content-addressed package may stage one immutable contribution generation. Activation publishes that generation through a contribution transaction; any publication, configuration, hook, or health failure discards or rolls back the whole generation. Restart recovery restores durable `staged` or `active` generation records without inventing configuration defaults. Empty configuration remains empty.

Dependencies activate before dependents. The declared runtime module exports `activatePlugin`; activation returns the manifest identity, the exact declared mounts and executable contributions, and a `close` function. Operations, routes, MCP tools, console entries, state machines, and verifier hooks must match the signed or digest-bound package. Core snapshots and freezes accepted declarations before publishing read-only contribution maps.

Plugin modules are privileged in-process deployment code. Signature and entry validation prove provenance and declared loading; they are not an isolation boundary for hostile JavaScript. Agent-controlled or otherwise untrusted execution uses the separately governed execution-sandbox port and has no host-process fallback.

## Failure and shutdown

Activation failure closes resources and already activated plugins in reverse dependency order. Normal shutdown uses the same reverse-order lifecycle. Cleanup failure remains retryable and cannot convert a partially closed generation into an active one. Disabled artifacts are not imported and contribute no runtime surface. Public errors use bounded `PLUGIN_PACKAGE_*` codes and must not disclose local paths or credentials.

## Ownership

| Concern | Owner |
| --- | --- |
| Closed bundle / source / state / receipt contracts | `packages/contracts/src/plugins/` |
| Archive codec, validator, custody, acquisition port, lifecycle | `packages/foundation/src/module-system/` |
| Contribution generation publish/discard | `packages/server-runtime/src/composition/plugin-contribution-transaction.ts` |
| Installed-artifact registry and mount runtime | `packages/foundation/src/module-system/plugin-registry.ts`, `plugin-runtime.ts`, `mount-manager.ts` |

## Verification

```bash
node tools/server-scripts/verify-plugin-bundle-protocol.ts
npm run verify:plugin-runtime
npm run vitest -- tests/vitest/server/plugin-package-protocol.test.ts
npm run vitest -- tests/vitest/server/plugin-runtime.test.ts
```
