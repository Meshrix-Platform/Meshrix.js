# Protocol Packages

`@meshrix/protocols` owns transport boundaries, protocol negotiation, normalization,
notifications, and protocol-local ports.

## Protocol Families

- `http/` — HTTP and console transport controllers and response normalization.
- `mcp/` — Downstream MCP adapter, discovery, installer, and upstream MCP client helpers.
- `pubsub/` — Runtime notification topics.
- `agent-sync/` and `downstream-client-aspect/` — Client/agent sync and shared aspect helpers.

Product-specific protocol implementations are delivered by verified plugin packages and are not
compiled or exported by `@meshrix/protocols`.

## Boundaries

Domain capabilities live in `packages/agents` and `packages/capabilities`. Protocol adapters
reach them only through registered operations or explicit facades bound by
`packages/server-runtime` composition.

Approved protocol ports include MCP notification-bus configuration, SSE registration, and the
injected Operation Permission provider methods `authorizeRequest` and `listVisibleTools`.
Adapters must not import server-runtime state, agents internals, or capabilities internals.

Unauthorized MCP operations stay hidden or denied through Operation Permission and tag-policy
evaluation on those ports.

## Verification

```bash
npm run server:verify:protocol-boundary
npm run vitest -- tests/vitest/server/plugin-mcp-outlet-visibility.test.mjs
```
