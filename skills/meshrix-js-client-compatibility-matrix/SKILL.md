---
name: meshrix-js-client-compatibility-matrix
description: Run the Meshrix.js downstream MCP protocol compatibility matrix for the upstream service publishing journey — verify each supported MCP protocol version through real or simulated consumers, install through the signed connector, invoke the debug operations, uninstall, and keep the matrix honest, including the simulated-fallback rule. Use when validating MCP protocol compatibility. The verification lanes are owned by $meshrix-js-release-journey-producer; the HTML report contract by $meshrix-js-html-report-contract.
---

# Meshrix.js Client Compatibility Matrix

This skill owns the **downstream MCP protocol compatibility matrix** of the
upstream service publishing journey: verifying each supported MCP protocol
version through real or simulated consumers, installing the connector,
invoking the debug operations, uninstalling, and keeping the matrix honest.
The verification lanes and candidate receipt belong to
`$meshrix-js-release-journey-producer`; the portable HTML report contract
belongs to `$meshrix-js-html-report-contract`.

## Establish authority

1. Run `git status --short` for every repository boundary before editing.
2. Read [references/publishing-contract.md](../../meshrix-js-upstream-service-publishing/references/publishing-contract.md) completely when changing the capability flow, state model, security boundary, event contract, protocol delivery, server gate, or client-matrix contract.
3. Keep the matrix separate from the verification lanes and the report contract: this skill owns protocol-version detection, installation, invocation, uninstall, and the fallback rule; `$meshrix-js-release-journey-producer` owns the lanes and receipt; `$meshrix-js-html-report-contract` owns the report projection.

## Organize the matrix by MCP protocol version

The compatibility dimension is the **MCP protocol version**, a stable
contract. Agent products are only consumers of a protocol version; they are
not the compatibility dimension and must not be hard-coded into the matrix.
Resolve the supported protocol versions from the canonical protocol
definition in `packages/protocols/` (the MCP protocol version the Meshrix.js
gateway speaks), not from a fixed product list. Each matrix row is one
protocol version.

For every supported protocol version, run the journey through the signed
connector over that version's wire contract: install, upload the fixture,
list the projected tools, invoke both debug operations, uninstall, and remove
the temporary configuration. Use any real consumer that speaks that protocol
version as the verification sample. When a real consumer for a version is
detected on the machine, it must pass; absence of a particular product is
recorded `not_detected`, never fabricated as a pass.

## Simulated fallback

Permit an MCP protocol simulation fallback only when the complete scan of
supported protocol versions has finished and every row has no real consumer.
Run one isolated simulated connector binding through the same upload,
tools/list, two-operation, approval, audit, screenshot, and cleanup path.
Mark the validation mode `simulated-fallback`, record the fixed reason
`no_supported_local_client_detected_after_complete_protocol_scan`, and state
that the result is protocol-path evidence rather than consumer compatibility
evidence. Never label the simulator as a specific product. This compatibility
matrix and fallback remain separate from the neutral-peer Core reducer and
cannot promote or modify its result.

## Report the connector configuration

The report must list the safe downstream connector configuration: transport
kind, every supported MCP protocol version, detected status per version,
adapter coordinate, requested toolsets, requested scopes, maximum risk, both
published capabilities, allowed service, installation, upload, tools/list,
both debug calls, and cleanup status. It must never include the issued token,
token path, process identity, private URL, private path, client command path,
or raw client configuration. The matrix first column contains one protocol
version per row; do not repeat a product id below the label.
