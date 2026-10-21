# Native MCP Registration and Optional Connector

Meshrix.js ships the Node installer through the root package's `meshrix-mcp` bin
and the portable archive. Optional first-party adapter modules are bundled in the
same release and resolved through Node's package resolution; there is no separate
adapter fetch or cache. Client applications remain external products.

## Native registration

The ordinary install path writes a native remote MCP endpoint and an explicitly
selected protected environment reference. It does not require a local Meshrix
client, stdio proxy, shared credential daemon, or installed extension at runtime.
`--server-name` selects the registration identity (default `lico`);
`--token-env` selects its credential reference. Different endpoints or references
must use distinct names rather than overwriting an existing authorization context.
The same explicitly selected authorization may be referenced by several clients.

An authorized administrator issues the scoped `mxak1` API key. The operator supplies
it securely to each selected client's launch environment. The configuration contains
only the reference, never the value. Protected requests use
`X-Meshrix.js-Api-Key`; Bearer authentication is not a substitute. Target identity
is not an authorization admission requirement.

Supported reference formats and client-specific limitations are maintained in the
[adapter kit contract](../../plugins/agents/client-adapter-kit/README.md).
Codex, Claude Code, OpenCode, Pi and OpenClaw have native header-reference paths.
Kimi Code's verified bearer-only reference cannot express this authentication.
Antigravity's protected static-key reference remains unqualified. Both fail before
mutation, with no plaintext, alternate-identity, OAuth or proxy fallback.

Native install does not provision persistent environment variables. `--token-stdin`
is rejected for installation with `credential_handoff_required`; a transient key
must not be silently converted into an unavailable future reference. A supplied
environment key is validated as `mxak1` and may be used for a separate installer
service probe; an explicit reference can be registered without resolving its value.
The installer never copies credentials from another client or the optional proxy's
credential store. Native auto-update subscription flags are unsupported.

## State and ownership

Results distinguish executable detection, native capability, matching configuration,
external credential readiness and native connectivity. `configured` means the
expected transport, endpoint and reference match, not that the client can connect.
Credential state is `external-reference-unverified`; native connectivity is
`not-run`. An installer service probe is reported separately and cannot prove the
client's future CLI/GUI environment.

Updates preserve unrelated registrations and existing policy fields. A conflicting
endpoint or reference fails without mutation. Only a positively identified old
Meshrix-generated proxy with the same binding is converted. Codex no longer creates
a marketplace registration alongside standalone MCP; only its positively identified
generated duplicate is disabled, while independent plugin assets are preserved.

Uninstall removes the selected matching registration without a live key or service
request. It preserves native authentication stores, externally managed variables,
optional proxy credential files and independent assets. A conflicting registration
is not deleted. Local discovery records retain other registration identities.
Claude Code updates avoid remove-before-add because its removal command can also
delete native OAuth data.

## Optional proxy

The separately invoked `proxy` command remains available. Its target-and-server
credential binding and protected-stdin behavior are independent of native install.
Native installation neither populates nor removes that store. Generic stdio protocol
negotiation, forwarding and cancellation remain owned by the proxy runtime; native
clients speak directly to the service. No new OAuth issuer or custody service is
part of this module.

## Verification

Run the adapter module's maintained `verify:local-client-adapters` command and the
owning installer/runner tests. Coverage includes exact native schemas, conflicts,
idempotence, policy preservation, safe uninstall, unsupported combinations and
secret-free requests. Synthetic fixtures and parser checks do not establish live
client authorization, GUI environment persistence, or server protocol compatibility.
Those require separately authorized integration and acceptance evidence.
