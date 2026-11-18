# MCP Protocol

Owns the downstream MCP adapter, discovery surface, notification bus ports, installer packaging,
and upstream MCP client helpers.

Tool visibility and execution authorization arrive through the injected
`toolSkillManagementProvider` port (`authorizeRequest`, `listVisibleTools`, `executeTool`).
Unauthorized or tag-policy-denied grants never list or execute governed tools. SSE and
notification runtime state are configured by server-runtime composition, not by the HTTP
application adapter.
