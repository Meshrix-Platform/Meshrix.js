# LicoMesh v<VERSION>

This release was assembled by the canonical tag workflow after platform
acceptance, the required Node.js 22 clean install/start probe, final macOS arm64
MCP asset execution, and actionable high-severity scans of both container
platforms completed successfully.

## Changes

<!-- GENERATED_RELEASE_NOTES -->

## Quick Install

### Docker (Server + Web Console)

```bash
docker pull ghcr.io/licoland/licomesh:<VERSION>
docker volume create licomesh-server-data
docker run -d \
  --name licomesh-server \
  --restart unless-stopped \
  --stop-timeout 90 \
  --publish 127.0.0.1:7228:7228 \
  --mount source=licomesh-server-data,target=/opt/lico/data \
  ghcr.io/licoland/licomesh:<VERSION>
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
npm install --save-exact licomesh@<VERSION>
```

### MCP Connector (Agent Integration)

Download the versioned portable archive for your platform,
`RELEASE_SHA256SUMS`, and `RELEASE_SHA256SUMS.sigstore.json`. Never execute a
remote script directly. Verify the Sigstore bundle against the exact workflow
identity and issuer before treating the checksum file as authoritative. Then
verify the selected asset before extraction. This release train publishes the
`macos-arm64` connector:

```bash
asset="lico-mcp-connector-<VERSION>-macos-arm64.tar.gz"
base="https://github.com/LicoLand/LicoMesh/releases/download/v<VERSION>"
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
./lico-mcp-install.sh install
```

## Release Assets

| Asset | Description |
| --- | --- |
| `lico-mcp-connector-<VERSION>-macos-arm64.tar.gz` | MCP Connector for macOS Apple Silicon |
| `lico-mcp-connector-<VERSION>-macos-arm64.zip` | MCP Connector for macOS Apple Silicon (zip) |
| `lico-mcp-install.sh` | Bootstrap installer script |
| `lico-mcp-uninstall.sh` | Uninstaller script |
| `lico-mcp-release.json` | Release manifest |
| `latest.json` | Latest version metadata |
| `RELEASE_SHA256SUMS` | Authoritative checksums keyed by the final GitHub asset names |
| `RELEASE_SHA256SUMS.sigstore.json` | Sigstore bundle for the authoritative checksum file |
| `SHA256SUMS` | MCP assembly-local index covered by `RELEASE_SHA256SUMS`; not a release trust root |

## Support Matrix

| Surface | Target | Release status |
| --- | --- | --- |
| npm packages | Seven public `@lico/*` workspaces, `lico-mcp-connector`, and `licomesh` | Published or integrity-reverified through npm trusted publishing. |
| Server and Web Console container | Linux amd64 and arm64 | Published as the signed multi-platform container after pinned Trivy scans and per-platform provenance/SBOM validation. |
| MCP Connector | macOS arm64 | Published after required execution of the exact final archive on a macOS arm64 tag-workflow runner. |
| MCP Connector | macOS x64, Linux x64/arm64, Windows x64/arm64 | Build support remains in source; no artifact or runtime support claim is made by this release. |
| LicoArc relay client | Separately versioned client platforms | Optional and removable; not shipped by or required for this core release. |
| Pactium substrate | `pactium@0.5.0`, `pactium.v0.2`, `pactium.v0.2.schema.latest` | Exact runtime dependency for this release. |

## Uninstall

```bash
cd "lico-mcp-connector-<VERSION>-<PLATFORM>"
./lico-mcp-uninstall.sh
```

## Supported Agents

The external LicoMesh-Plugins catalog currently supplies adapters for OpenClaw,
Codex, Claude Code, Antigravity, OpenCode, and Pi. Their compatibility evidence
and release status are independent of this Core release.

---

[Full Changelog](https://github.com/LicoLand/LicoMesh/blob/release/CHANGELOG.md)
