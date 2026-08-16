# MCP Native Installer

Meshrix.js ships a signed portable connector and native launchers for the supported downstream MCP
target matrix. The installer verifies signed discovery and release metadata, detects supported
targets, invokes the target adapter, and writes only connector-managed configuration.
Client-specific behavior is owned by operator-supplied external client-adapter packages; Core owns only their bounded contract and loading boundary.

## API Key access and local custody

An authenticated administrator first creates a scoped API Key in Console Key Distribution. The
Console displays plaintext once. The operator transfers it through an approved secret channel and
supplies it to the connector through the documented environment variable or protected standard
input. After the target is installed and verified, the connector persists the key in its private,
target-and-server-scoped credential file. Plaintext must not appear in command arguments, client
configuration, logs, reports, screenshots, or support bundles.

The connector validates the strict `mxak1` envelope before discovery, target scanning, adapter
loading, configuration access, process launch, or network I/O. Missing, empty, malformed, legacy,
duplicate, or ambiguous input fails locally. Multi-target installation reuses the supplied key and
never generates per-target credentials.

Client configuration stores connector metadata and an optional environment-variable override name,
never plaintext. The connector prefers an explicitly supplied temporary key and otherwise reads the
persisted target-and-server binding. Protected requests carry exactly `X-Meshrix.js-Api-Key`; the
connector does not add bearer, tool-token, client authority, or process-signature credentials. The
server authenticates the recorded workload, projects only policy-visible tools, and routes calls
through canonical Operation Permission. A higher-risk tool may enter the ordinary pending-operation
approval flow after authentication.

The installer's automatic-update choice is persisted as an exact boolean in
the same private target-and-server binding. Only `true` starts the connector's
authenticated `subscriptions/listen` stream. Update notifications refresh
catalog state and surface availability; they never authorize or execute an
installer command. Executable updates still require explicit user approval.

## Lifecycle and uninstall

Rotation, revocation, expiry, exhaustion, audience mismatch, target mismatch, connector mismatch,
organization-lineage change, or stale policy fails closed on the next protected request. There is
no fallback or automatic enrollment side effect.

Uninstall removes only connector-managed target configuration, the matching local credential
binding, and local adapter material. It does not require a supplied key or notify the server.
Adapter cleanup failure remains visible and retains the credential for repair.

Generic process identity and delegated-child binding are independent security capabilities. They
do not issue or replace the API Key required by an ordinary downstream MCP client.

## Verification

Use the current API Key installer, MCP authentication, portable-release, protocol-consistency, and
release-journey commands from the canonical test registry. Verifier plaintext remains only in direct
process memory or an isolated private credential fixture and is registered with the redaction tracker
before any output.
