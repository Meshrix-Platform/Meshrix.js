# Usage

This document lists common commands for local startup, verification, server operation, and agent access.

## Local Startup

```bash
npm install
npm run dev
```

## Verification

```bash
npm run typecheck
npm test -- --suite domains.manifest
npm test
```

Use broader checks before release readiness:

```bash
npm test
npm run build
```

## Server

```bash
npm run server:start
npm run server:doctor
npm run server:reconcile
```

The packaged server reads optional plugin selection from the JSON file named by
`LICO_RUNTIME_CONFIG`. Plugin fields are nested below `runtime`. No plugin,
trust key, capability, signing purpose, or deployment profile is inferred when
the corresponding field is absent or empty.

```json
{
  "runtime": {
    "enabledPlugins": ["example-plugin"],
    "pluginArtifactTrustedPublicKeys": {
      "ed25519:<key-id>": {
        "kty": "OKP",
        "crv": "Ed25519",
        "x": "<base64url-ed25519-public-x>"
      }
    },
    "pluginConfigurations": {
      "example-plugin": {
        "hostCapabilities": [],
        "artifactSigningPurposes": []
      }
    }
  }
}
```

Only public Ed25519 JWK fields are accepted in
`runtime.pluginArtifactTrustedPublicKeys`; private key fields are rejected.
Production startup loads verified installed artifact generations only. Adding a
source plugin directory does not install or trust it. A selected plugin also
requires a matching active lifecycle ledger. Selection, trust, configuration,
or deployment-profile changes require a controlled restart.

## MCP Native Installer

Use a versioned portable release archive and download both
`RELEASE_SHA256SUMS` and `RELEASE_SHA256SUMS.sigstore.json` from the same
release. First verify the Sigstore bundle with Cosign against the exact
`release.yml` workflow identity for the version tag and the
`https://token.actions.githubusercontent.com` issuer. Only then use the signed
checksum file to compare the archive's SHA-256 before extraction. Checksum
entries use the final GitHub asset basename. The MCP-local `SHA256SUMS` file is
an assembly index covered by the signed release checksum and is not an
independent release authority. Do not pipe a network response into a shell.
From an extracted and verified bundle:

```bash
./lico-mcp-install.sh install --target openclaw,codex,claude-code,antigravity,opencode,pi --json
./lico-mcp-uninstall.sh --target openclaw,codex,claude-code,antigravity,opencode,pi
```

The launchers delegate discovery, signed handshake verification, grant issuance,
and client configuration to the bundled connector. Raw tokens are accepted only
through standard input or a validated environment-variable name; `--token` is
rejected because process arguments are observable. The documented downstream
adapter target scope is OpenClaw, Codex, Claude Code, Antigravity, OpenCode, and Pi. Every client-specific adapter is independently packaged by LicoMesh-Plugins. Core reuses a verified local cache when present, fetches only a missing pinned package, and keeps credentials in the Core-managed operating-system credential store.

## Upstream Services

Authenticated maintainers publish upstream services through the console or `/api/gateway/v1/services` control-plane routes. The closed command accepts explicit payload representations, typed certificate and credential references, permissions, traffic limits, and governed audiences; compiles a canonical manifest without interpolating user input; hot-reloads an immutable gateway snapshot; atomically refreshes Operation Permission; and exposes scoped invalidation, authenticated pull, acknowledgement, disconnect, timeout, and reconnect-fence semantics through the published protocol. Forwarding must pass Operation Permission, tag policy, approval when required, audit, and metrics.

The console accepts one portable import document using schema
`v0.0.1:upstream-service:portable-import-2`. For example, import
[file-parser-format-convert.upstream.json](examples/file-parser-format-convert.upstream.json)
after deploying the converter at its declared URL. This registers the service
and complete multipart/artifact mapping; deployment and plugin installation
remain separate steps. Native HTTP file transit uses
`POST /api/gateway/v1/transit/:serviceId/:operationKey`. JSON-only MCP calls
stage a file through `/api/upload-sessions`, pass its owner-bound `upload:`
reference, and receive an MCP `resource_link` for the converted artifact. No
gateway file path requires Base64 encoding.

`server_published` is terminal server success after the gateway, catalog, audience, and protocol-delivery revisions agree. Compatible consumer cache adoption is independently owned and is not a server implementation or readiness dependency. See [Gateway](functionality/GATEWAY.md) for the complete contract and verification command.

Local gateway credentials use an explicit, non-secret target file. The target has no provider defaults or inferred binding fields:

```json
{
  "provider": "example-provider",
  "family": "upstream-gateway",
  "authType": "bearer",
  "secretRef": "secret://example/service-material",
  "scope": {
    "serviceId": "example-service",
    "scopes": ["gateway:read", "gateway:write"],
    "allowedHosts": ["api.example.test"],
    "allowedProtocols": ["https"]
  }
}
```

Initialize material through standard input. Rotation requires the complete unchanged target binding and the current revision. Revocation requires the reference and current revision:

```bash
lico secret init --target-file <target-file> --json-stdin
lico secret rotate --target-file <target-file> --expected-revision <revision> --json-stdin
lico secret revoke --secret-ref secret://example/service-material --expected-revision <revision>
lico secret list
lico secret status
```

`--token-stdin`, `--api-key-stdin`, and `--http-password-stdin` are single-field alternatives to `--json-stdin`. `--from-env <name>` is accepted only with an explicit `--payload-key <field>`. Secret material is not accepted through `--body` or other process arguments. List and mutation responses contain lifecycle metadata and value field names, but not values, storage paths, or scope identifiers.

## Verified Plugin Packages

Core acquires a single-plugin bundle from an explicitly configured local package or GitHub Release source, validates its closed file inventory and trust evidence, and stores it in content-addressed custody. Activation publishes one immutable contribution generation only after configuration, dependency, lifecycle, and health checks pass. Operations, routes, MCP tools, precompiled console assets, and state machines remain unavailable until that generation is active.

See [Plugin Package and Loading](protocols/PLUGIN-PACKAGE-AND-LOADING.md) for the bundle, installation, activation, rollback, and console asset contracts.
