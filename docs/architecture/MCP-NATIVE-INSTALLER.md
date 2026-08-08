# MCP Native Installer

Meshrix.js ships a signed portable connector and native launchers for the supported downstream MCP
target matrix. The installer verifies signed discovery and release metadata, detects supported
targets, invokes the target adapter, and writes only connector-managed configuration.

## API Key-only access

An authenticated administrator first creates a scoped API Key in Console Key Distribution. The
Console displays plaintext once. The operator transfers it through an approved secret channel and
supplies it to the connector through the documented environment variable or protected standard
input. Plaintext must not appear in command arguments, configuration files, logs, reports,
screenshots, or support bundles.

The connector validates the strict `mxak1` envelope before discovery, target scanning, adapter
loading, configuration access, process launch, or network I/O. Missing, empty, malformed, legacy,
duplicate, or ambiguous input fails locally. Multi-target installation reuses the supplied key and
never generates per-target credentials.

Client configuration stores the environment-variable name, never plaintext. Protected requests
carry exactly `X-Meshrix.js-Api-Key`; the connector does not add bearer, tool-token, client authority,
or process-signature credentials. The server authenticates the recorded workload, projects only
policy-visible tools, and routes calls through canonical Operation Permission. A higher-risk tool
may enter the ordinary pending-operation approval flow after authentication.

## Lifecycle and uninstall

Rotation, revocation, expiry, exhaustion, audience mismatch, target mismatch, connector mismatch,
organization-lineage change, or stale policy fails closed on the next protected request. There is
no fallback or automatic enrollment side effect.

Uninstall removes only connector-managed target configuration and local adapter material. It does
not require a key, read a credential store, or notify the server. Adapter cleanup failure remains
visible and does not mutate server state.

Generic process identity and delegated-child binding are independent security capabilities. They
do not issue or replace the API Key required by an ordinary downstream MCP client.

## Verification

Use the current API-Key-only installer, MCP authentication, portable-release, protocol-consistency,
and release-journey commands from the canonical test registry. Verifier plaintext remains only in
direct process memory and is registered with the redaction tracker before any output.
