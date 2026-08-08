---
name: meshrix-js-downstream-mcp-client-access
description: Guide Console-issued API Key-only downstream MCP access through signed connector installation, protected proxy use, catalog refresh, governed operation approval, and local uninstall.
---

# Meshrix.js Downstream MCP Client Access

Read the current Meshrix.js native-installer architecture and MCP gateway contract. This flow covers
connector-managed downstream clients; official external client product behavior remains client-owned.

Use only the signed connector target matrix and documented local or container-bridge endpoints.
Do not generalize this workflow to arbitrary remote clients.

For client install/data/config/session path templates and adapter-facing layout of
a named MCP target, use the repository-local connector and installer contracts
as the only layout authority. Meshrix.js installer contracts
remain authoritative for signed discovery, credential handling, and
connector-owned config mutation.

## Canonical transaction

1. An authenticated administrator creates a short-lived, least-privilege API Key in Console Key
   Distribution. The key is scoped to the workload, organization branch, server audience, connector
   target, tools, capabilities, resources, risk, usage, concurrency, and expiry.
2. The administrator transfers the plaintext exactly once through an approved secret channel. The
   Console permanently hides it after dismissal; logs, reports, screenshots, command arguments,
   configuration files, and support bundles must never contain plaintext or a fingerprint.
3. Verify signed portable release metadata and signed discovery, then launch the packaged native
   connector. Supply the strict `mxak1` value through the documented environment variable or
   protected standard input. Missing, malformed, duplicate, or ambiguous input fails locally before
   discovery, target scanning, adapter loading, configuration access, process launch, or network I/O.
4. The connector discovers supported targets, writes only the environment-variable reference into
   client configuration, and sends the credential only as `X-Meshrix.js-Api-Key`. It never generates,
   requests, persists, exchanges, or falls back to another MCP credential.
5. Meshrix.js authenticates the recorded workload and projects only the current policy-authorized MCP
   catalog. Each call passes through canonical Operation Permission. A higher-risk operation may
   enter the ordinary pending-operation approval flow after authentication; this is operation
   governance, not client enrollment.
6. Catalog change notifications invalidate client caches. The client refreshes from the protected
   server projection and never synthesizes authority from stale local state.
7. Rotation, revocation, expiry, exhaustion, organization-lineage changes, audience mismatch, or
   policy changes fail closed on the next request with no fallback or enrollment side effect.
8. Uninstall removes only the connector-managed client configuration and local adapter material.
   It requires no credential, credential lookup, or server request; cleanup failures remain visible.

## Required invariants

- Only a Console-issued scoped API Key authenticates an ordinary downstream MCP client.
- Plaintext exists only in the one-time Console response, approved transfer channel, and direct
  process memory. Register verifier values with the redaction tracker before any output.
- Signed release/discovery verification and the supported-target matrix remain mandatory.
- Client configuration contains the environment-variable name, never plaintext.
- Tool visibility is the current server policy projection; client-declared scope is not authority.
- Operation approval remains a separate, post-authentication Operation Permission control.
- Generic process identity and delegated-child bindings remain independent where their canonical
  contracts require them; they do not issue an ordinary client credential.

## Verification

Use the current API-Key-only installer, MCP authentication, protocol-consistency, release-journey,
and downstream gateway acceptance commands from the Meshrix.js test registry. Reports may contain only
bounded status and record identifiers. Keep obsolete-reference searching as a one-time migration
audit; do not add it to CI, package scripts, or registries.
