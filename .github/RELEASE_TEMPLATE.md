# Meshrix v<VERSION>

This release was assembled by the canonical tag workflow after the Functional
Release Gate, the required Node.js 22 clean install/start probe, and actionable
high-severity scans of both container artifacts completed successfully.
Real-machine results are separate candidate-bound Environment Support Claims;
their absence or failure does not block this release.

## Changes

<!-- GENERATED_RELEASE_NOTES -->

## Quick Install

### Docker (Server + Web Console)

```bash
docker pull ghcr.io/licoland/meshrix:<VERSION>
docker volume create meshrix-server-data
docker run -d \
  --name meshrix-server \
  --restart unless-stopped \
  --stop-timeout 90 \
  --publish 127.0.0.1:7228:7228 \
  --mount source=meshrix-server-data,target=<container-data-dir> \
  ghcr.io/licoland/meshrix:<VERSION>
```

### npm (Framework Integration)

The canonical tag workflow performs a credential-free preflight of the complete
npm release set before any remote container mutation, repeats that preflight
before the first npm mutation, then publishes or reverifies integrity, registry
signatures, provenance, and monotonic release tags. It installs the published
set without lifecycle scripts and completes `npm audit signatures` before the
GitHub Release is exposed. Install the framework package at the exact release
version:

```bash
npm install --save-exact meshrix@<VERSION>
```

### MCP Connector (Agent Integration)

Download the versioned portable archive for your platform,
`RELEASE_SHA256SUMS`, and `RELEASE_SHA256SUMS.sigstore.json`. Never execute a
remote script directly. Verify the Sigstore bundle against the exact workflow
identity and issuer before treating the checksum file as authoritative. Then
verify the selected asset before extraction. This release train publishes the
`macos-arm64` connector:

```bash
asset="meshrix-mcp-connector-<VERSION>-macos-arm64.tar.gz"
base="https://github.com/LicoLand/Meshrix/releases/download/v<VERSION>"
curl -fLO "$base/$asset"
curl -fLO "$base/RELEASE_SHA256SUMS"
curl -fLO "$base/RELEASE_SHA256SUMS.sigstore.json"
cosign verify-blob RELEASE_SHA256SUMS \
  --bundle RELEASE_SHA256SUMS.sigstore.json \
  --certificate-identity "https://github.com/<REPOSITORY>/.github/workflows/release.yml@refs/tags/v<VERSION>" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
expected=$(awk -v file="$asset" '$2 == file { print $1 }' RELEASE_SHA256SUMS)
actual=$(shasum -a 256 "$asset" | awk '{ print $1 }')
test -n "$expected" && test "$actual" = "$expected"
tar -xzf "$asset"
cd "${asset%.tar.gz}"
./meshrix-mcp-install.sh install
```

## Release Assets

| Asset | Description |
| --- | --- |
| `meshrix-mcp-connector-<VERSION>-macos-arm64.tar.gz` | MCP Connector for macOS Apple Silicon |
| `meshrix-mcp-connector-<VERSION>-macos-arm64.zip` | MCP Connector for macOS Apple Silicon (zip) |
| `meshrix-mcp-install.sh` | Bootstrap installer script |
| `meshrix-mcp-uninstall.sh` | Uninstaller script |
| `meshrix-mcp-release.json` | Release manifest |
| `latest.json` | Latest version metadata |
| `RELEASE_SHA256SUMS` | Authoritative checksums keyed by the final GitHub asset names |
| `RELEASE_SHA256SUMS.sigstore.json` | Sigstore bundle for the authoritative checksum file |
| `SHA256SUMS` | MCP assembly-local index covered by `RELEASE_SHA256SUMS`; not a release trust root |

## Support Matrix

| Surface | Target | Release status |
| --- | --- | --- |
| npm packages | Seven public `@meshrix/*` workspaces, `meshrix-mcp-connector`, and `meshrix` | Published or integrity-reverified through npm trusted publishing. |
| Server and Web Console container | Linux amd64 and arm64 | Published as the signed multi-platform container after pinned Trivy scans and per-platform provenance/SBOM validation. Native runtime support is claimed only by a matching optional real-machine receipt. |
| MCP Connector | macOS arm64 | Published as a functionally accepted artifact. Native runtime support is claimed only after the exact final archive passes the macOS arm64 Real-Machine Verification Workflow. |
| MCP Connector | macOS x64, Linux x64/arm64, Windows x64/arm64 | Build support may remain in source; each runtime support claim requires its own optional real-machine receipt. |
| MeshrixUp relay client | Separately versioned client platforms | Optional and removable; not shipped by or required for this core release. |
| Pactium substrate | `pactium@0.5.0`, `pactium.v0.2`, `pactium.v0.2.schema.latest` | Exact runtime dependency for this release. |

## Uninstall

```bash
cd "meshrix-mcp-connector-<VERSION>-<PLATFORM>"
./meshrix-mcp-uninstall.sh
```

## Supported Agents

The external Meshrix-Plugins catalog currently supplies adapters for OpenClaw,
Codex, Claude Code, Antigravity, OpenCode, and Pi. Their compatibility evidence
and release status are independent of this Core release.

---

[Full Changelog](https://github.com/LicoLand/Meshrix/blob/release/CHANGELOG.md)
