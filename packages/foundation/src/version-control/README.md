# Version Governance Module

`packages/foundation/src/version-control` is the infrastructure boundary for LicoMesh version governance. It owns the shared vocabulary, registry facts, scan rules, and gates for platform, protocol, schema, runtime capability, and migration-path versions.

## Layer

- Layer: Common / Infrastructure
- Protocol family: `v0.0.1:version-governance:protocol-1`
- Product boundary: version governance, not release approval or source control

## Source-Controlled Configuration

- Singleton registry: `packages/foundation/src/version-control/version-registry.json`
- Registry schema: `packages/foundation/src/version-control/version-registry.schema.json`
- Scan contract: `packages/foundation/src/version-control/version-scan.mjs`
- Naming verifier: `node tools/server-scripts/verify-version-naming.mjs`
- Verifier: `npm run verify:version-registry`
- Runtime artifact store root: `.licomesh-server-data/artifacts`
- Platform version baseline: `v0.0.1`
- Governed version format: `v<platform-version>:<domain>:<subsection>-<version>`

The registry stores version-governance facts: versioned artifact identities, `artifactId@v<platform-version>:<domain>:<subsection>-<version>` references, artifact lifecycle state, transition paths, compatibility table rows, runtime artifact references, and evidence references. The registry verifier scans current functional roots: apps, packages, plugins, crates, content, fixtures, tools, tests, and docs, while excluding the registry document itself from functional-source discovery. Every complete governed version string it finds must resolve to a registry artifact version, and every active registry version must be backed by a scanned non-registry source that is named by its evidence references. The core public test profile runs this verifier. The registry does not store materialized payload bodies, generated reports, recovery packages, or runtime state.

A governed version has exactly three segments after tokenization: the platform version, one semantic domain, and one independently incrementing subsection. Single-colon tokens and extra version axes are invalid. The domain and subsection must not encode migration boundaries such as `legacy`, `compat`, or `v2`. A dynamic template is accepted only when its full template shape can be reduced to the canonical format and its interpolated identifier is validated by the owning generator before use.

## Responsibilities

1. Maintain a source-controlled singleton Version Registry for every current platform-governed version identity found in the repository.
2. Define migration path configuration as explicit `fromVersion -> toVersion` transitions.
3. Preserve adjacent-version migration rules, compatibility windows, retirement state, and evidence references.
4. Maintain a Version Compatibility Table for `consumerRef -> providerRef` compatibility facts.
5. Export compatibility projections for UI, diagnostics, and release-readiness consumers without making those consumers the source of truth.
6. Reference materialized version artifacts in `.licomesh-server-data/artifacts` without treating that artifact store as the configuration authority.

## Identity

- Version artifact IDs use stable dotted names such as `lico.platform`, `lico.protocol.mcp`, `lico.store.operation-permission`, and `lico.policy.authorization`.
- Version artifact references use `artifactId@v<platform-version>:<domain>:<subsection>-<version>`.
- The platform version segment is shared across the platform baseline; the domain segment groups versions such as `workspace`, `risk-control`, `state-machine`, `storage`, or `mcp`; the subsection segment identifies the independently incrementing governed object.
- Examples: `lico.platform@v0.0.1:platform:assembly-1`, `lico.protocol.mcp@v0.0.1:mcp:interface-1`, and `lico.state-machine.version-artifact-lifecycle@v0.0.1:state-machine:version-artifact-1`.

## Lifecycle

Versioned artifacts use the shared `version.artifact.lifecycle` state machine:

```text
draft -> candidate -> active -> deprecated -> retired
```

`retired` is terminal. Activation, deprecation, and retirement are protected transitions because they change which version facts may be selected for new bindings.

Version transitions use the shared `version.transition.lifecycle` state machine:

```text
planned -> dry_run_passed -> checkpointed -> running -> verified -> completed
```

`failed` is a recoverable state that must resolve through guarded `retry`, `rollback`, or `abandon`. `completed`, `rolled_back`, and `abandoned` are terminal states. This lifecycle governs the migration action between two `artifactId@version` references; it does not replace the lifecycle of either versioned artifact.

## Non-goals

- It is not git or source-code version control.
- It is not a release page, release note generator, or production-readiness gate.
- It is not an artifact payload store.
- It must not let individual domains own hidden startup migrations, old-format version retention paths, or long-lived compatibility branches.
- It must not store secret values as migration or version evidence.
