# ADR-0001: Upstream services may declare optional custom fields

Status: Implemented

Date: 2026-08-24

## Context

Meshrix.js publishes external services (HTTP, JSON-RPC, MCP) through the
authenticated upstream publication path. The publishing contract historically
rejected any field that looked executable — `command`, `args`, `env`,
`headers`, and similar keys were globally banned by `rejectExecutableContent`
and absent from the MCP descriptor allowlist.

That blanket ban blocked legitimate, declarative service configuration. A
remote MCP service may require request context headers (for example
`x-valorius-project` on the ***REMOVED*** service), which are plain
data, not executable configuration. The runtime already consumed
`mcp.headers` (`normalizeMcpConfig`), but the publish validation rejected it,
so a valid runtime capability was unpublishable.

## Decision

Meshrix.js upstream service publishing **must support optional custom fields**
where the field is declarative configuration rather than executable content.
This is a standing capability target: all Agent work on upstream publishing
must preserve and extend it.

Concretely, `descriptor.mcp.headers` is allowed through publication:

- `MCP_DESCRIPTOR_FIELDS` includes `headers`.
- `rejectExecutableContent` exempts only the exact `descriptor.mcp.headers`
  path from the `headers` executable-key rejection.
- Descriptor values are literal data. A bare `$NAME` is forwarded unchanged;
  published HTTP MCP headers never read or interpolate the gateway process
  environment. Local stdio environment setup remains a separate operator-owned
  path.
- The shared context-header validator preserves ordinary project/workspace
  fields while rejecting sensitive credential names, known inline credential
  values, invalid or duplicate names, controls, transport-owned routing or
  framing headers, and excessive header counts or bytes. Credentials use typed
  Local Secret references bound to their exact HTTP(S) origin, including port.
- `normalizeUpstreamMcpContextHeaders` is used by the authenticated publisher
  and manifest loader. `normalizeUpstreamMcpHttpRequestHeaders` validates the
  final request after typed credentials are resolved. These target-neutral
  contracts are also available to the Workers runtime. The shared credential
  material resolver validates every selected origin, operation, and scope
  before calling an injected secret authority, then applies one payload-to-header
  normalization rule. The Node adapter alone resolves local files; Workers
  resolve tenant-bound payloads through their authority port. Only configured
  local stdio may consume the returned environment projection; remote MCP uses
  request headers only.
- Resolved credential headers are included only for the matching target origin.
  Cross-origin redirects are revalidated and remove credential and internal
  identity headers before another request is issued.

Executable fields remain rejected everywhere else. This ADR narrows the ban
for one declarative MCP field; it does not open a general execution channel.

## Consequences

- Remote MCP services that need request context headers can be published and
  discovered (health check `upstream_mcp_discovery_failed` no longer occurs
  solely because a required context header is absent).
- The security boundary is preserved by keeping the exemption path-specific,
  applying the same target-neutral header contract at publication and loading,
  and keeping secrets out of ordinary descriptor values.
- Future custom-field requests should follow the same pattern: add the field
  to the relevant allowlist, keep it declarative-only, preserve the literal
  semantics, and prove publication, loading and forwarding through focused
  tests before the ADR can claim `Implemented` for that field.

## Verification

- `tests/vitest/server/upstream-publishing-raw-boundary.test.ts` covers
  ordinary context fields, literal `$NAME`, credential-header rejection,
  transport-header rejection, and full-origin credential binding.
- `tests/vitest/server/upstream-mcp-session-manager.test.ts` verifies HTTP MCP
  headers remain literal when an environment source contains the matching
  synthetic name.
- `tests/vitest/server/upstream-service-publishing-evidence.test.ts` passes.
- Native OrbStack deployment of the change verifies with healthz 200 and
  console 200.
