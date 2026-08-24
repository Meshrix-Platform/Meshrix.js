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
`x-valorius-project` on the Requirement Cognition service), which are plain
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
- The exemption stays bounded: header values still pass the same string scan
  as all other fields (no `${`, `{{`, `<%`, `file://`, control characters, or
  unsafe Unicode), and the runtime continues to apply its own header handling
  through `normalizeMcpConfig` / `sanitizeHeaders`.

Executable fields remain rejected everywhere else. This ADR narrows the ban
for one declarative MCP field; it does not open a general execution channel.

## Consequences

- Remote MCP services that need request context headers can be published and
  discovered (health check `upstream_mcp_discovery_failed` no longer occurs
  solely because a required context header is absent).
- The security boundary is preserved by keeping the exemption path-specific
  and keeping the string-level injection scan on all values.
- Future custom-field requests should follow the same pattern: add the field
  to the relevant allowlist, keep the value validation declarative-only, and
  prove it with a focused publishing-boundary test before the ADR can claim
  `Implemented` for that field.

## Verification

- `tests/vitest/server/upstream-publishing-raw-boundary.test.ts` passes
  (hostile corpus still rejected; the bounded exemption does not widen the
  attack surface).
- `tests/vitest/server/upstream-service-publishing-candidate.test.ts` passes.
- Native OrbStack deployment of the change verifies with healthz 200 and
  console 200.
