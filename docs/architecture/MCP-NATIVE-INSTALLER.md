# MCP Native Installer Architecture

The MCP user-device install surface consists of platform-native launchers and a
single bundled connector runtime.

## Decision

Meshrix ships POSIX and PowerShell launchers as the canonical user entrypoints.
They validate security-sensitive arguments, select the connector included in a
verified portable release, and delegate without evaluating shell text. The
connector is the only implementation of signed local-hub discovery, handshake
verification, device authorization, client detection, configuration, and uninstall.
Maintaining those protocols independently in shell and PowerShell is forbidden.

| Platform | Install | Uninstall |
| --- | --- | --- |
| macOS/Linux | `packages/protocols/mcp/adapter/native-installer/meshrix-mcp-install.sh` | `packages/protocols/mcp/adapter/native-installer/meshrix-mcp-uninstall.sh` |
| Windows | `packages/protocols/mcp/adapter/native-installer/meshrix-mcp-install.ps1` | `packages/protocols/mcp/adapter/native-installer/meshrix-mcp-uninstall.ps1` |

Windows supports PowerShell only. `.cmd` installer entrypoints are not part of
the release surface.

## Security Boundary

The launchers:

- reject raw token arguments and accept custom tokens only from standard input
  or a validated environment-variable name;
- never use `eval`, dynamic PowerShell expressions, or marker-only HTTP
  discovery;
- invoke connector commands through argument arrays;
- fail closed when no bundled, repository, explicitly selected, or installed
  connector is available.

The connector requires the Ed25519 discovery identity and nonce-bound handshake
before a URL can be used. JSON failure output is generic and reports neither
local paths nor raw credentials.

For an installation without a pre-issued grant, the connector generates the
client process key and a random one-time claim in memory. It submits only the
claim SHA-256 with the requested targets and process public-key material. The
server creates a ten-minute pending request; the connector prints its complete
request id and a short verification code. The authenticated Web Console shows
the same values together with the targets, risk, toolsets, and process-key
fingerprints. A `runtime:admin` console subject approves the request through the
normal same-origin, CSRF, and safety-confirmed operation boundary. The connector
then completes one logical issuance with the claim header and stores the
returned process identity and grant token together through the operating-system
credential backend. If the response is interrupted, the same claim can retrieve
the exact claim-bound encrypted response for two minutes; it cannot issue a
second credential set, and the retry material expires. Later proxy launches
reuse the paired credential and do not create a replacement device-authorization
request. A token provided through standard input or the configured environment
variable takes precedence without placing it in client configuration or process
arguments.
The request and consume endpoints accept a direct container bridge peer for the
supported host-to-loopback-published-container path; they reject forwarded
metadata and do not treat the bridge address as authorization. Direct
administrative grant issuance remains loopback-only.

The verification code identifies the pending request but is not an
authorization credential. The claim is not written to disk, placed in a URL,
or passed on a command line. Direct local-grant issuance remains available only
to an authenticated administrative console flow. A pre-issued grant may be
provided through standard input or the configured token environment variable.
Multi-target uninstall authenticates and notifies the server separately for each
target while its paired credential still exists. It deletes a target credential
only after that target's server update succeeds. A missing or rejected
credential is reported and retained for recovery; uninstall never creates a new
grant as a fallback.

The published connector supports local connector-managed client processes. Orb
and remote-Linux direct HTTP client modes cannot attach the required process
identity signature, so this release rejects those locations before device
authorization begins. Their absence is recorded through the release support
matrix instead of issuing an unusable grant.

All formal client targets use client-specific packages published from
Meshrix-Plugins. The installer verifies and reuses its local package cache,
invokes the adapter through bounded JSON-stdio, writes only non-secret connector
metadata, and keeps process credentials in the Core-managed operating-system
credential store. Core contains no client-specific adapter implementation.

## Portable Release Contract

Portable archives include the launchers, connector, an exact Node.js runtime,
Node legal files, and `licenses/node/NODE_RUNTIME.lock.json`. Node archives are
accepted only when their SHA-256 matches both the repository lock and the
OpenPGP-signed official Node.js checksum manifest from the pinned signer key.
Signature verification uses the lockfile-pinned JavaScript OpenPGP verifier and
does not depend on a host GPG installation. Unsupported or unsigned platform
builds fail closed.

The runtime lock also records the exact byte size of the checksum manifest,
detached signature, signer key, and every target archive. Downloads reject
redirects, non-HTTPS URL variants, mismatched `Content-Length`, and streams that
exceed or do not reach the locked byte count. Concurrent cache misses for the
same digest share one in-process transfer and publish the cache file without
overwriting a competing valid result.

Portable tar and zip creation uses lexical entry order, normalized timestamps,
numeric ownership, stable modes, and deterministic compression metadata. A
second assembly from the same source tree and locked runtime must produce the
same archive digest.

Every Meshrix release includes `RELEASE_SHA256SUMS` and its Sigstore bundle.
Users verify the checksum bundle against the exact release workflow identity
and GitHub Actions issuer before using the basename-keyed checksum to verify a
versioned archive. Only then do they extract the archive and run the local
launcher. The MCP assembly-local `SHA256SUMS` is covered by the signed outer
checksum and has no independent release-authority status. Documentation and
discovery metadata must not recommend piping a network response into a shell.

## Verification

```bash
sh -n packages/protocols/mcp/adapter/native-installer/meshrix-mcp-install.sh
npm test -- --suite downstream-mcp.installer-convergence
npm run verify:mcp-release-portable-assembly
npm run verify:node-runtime-supply-chain
npx vitest run tests/vitest/server/mcp-installer-device-authorization.test.mjs tests/vitest/server/p2-security-boundaries.test.mjs
```
