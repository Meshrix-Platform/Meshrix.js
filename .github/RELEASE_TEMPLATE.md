# Meshrix.js v<VERSION>

This release was assembled by the canonical tag workflow after the Functional
Release Gate, the required Node.js 22 clean install/start probe, and actionable
high-severity scans of both container artifacts completed successfully.
Runtime support is limited to exact artifact and environment pairs with a
matching verification receipt. This release makes no support claim for an
unqualified environment.

## Changes

<!-- GENERATED_RELEASE_NOTES -->

## Quick Install

### Docker (Server + Web Console)

```bash
docker pull <registry>/<namespace>/meshrix-js:<VERSION>
docker volume create meshrix-server-data
docker run -d \
  --name meshrix-server \
  --restart unless-stopped \
  --stop-timeout 90 \
  --publish 127.0.0.1:7228:7228 \
  --mount source=meshrix-server-data,target=<container-data-dir> \
  <registry>/<namespace>/meshrix-js:<VERSION>
```

### npm (Framework Integration)

The release workflow publishes the package set named by the release
definition to the public npm registry and records the resulting verification
evidence. Install the framework package at this exact release version:

```bash
npm install --save-exact meshrix.js@<VERSION>
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
base="<release-base-url>/v<VERSION>"
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
| npm packages | Packages named by the release definition | Published to the public npm registry for this version. |
| Server and Web Console container | Linux amd64 and arm64 | Published as the signed multi-platform container after pinned Trivy scans and per-platform provenance/SBOM validation. Native runtime support is claimed only by a matching optional real-machine receipt. |
| MCP Connector | macOS arm64 | Published as a functionally accepted artifact. Native runtime support is claimed only after the exact final archive passes the macOS arm64 Real-Machine Verification Workflow. |
| MCP Connector | macOS x64, Linux x64/arm64, Windows x64/arm64 | Build support may remain in source; each runtime support claim requires its own optional real-machine receipt. |
| Pactium substrate | `pactium@0.8.1` | Runtime dependency pinned by the release package manifests and lockfile. |

## Uninstall

```bash
cd "meshrix-mcp-connector-<VERSION>-<PLATFORM>"
./meshrix-mcp-uninstall.sh
```

## Supported Agents

Client adapters are explicit operator-supplied artifacts. They are not
discovered from another source repository and are not part of this release.

---

[Full Changelog](../CHANGELOG.md)
