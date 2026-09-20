# Gateway kernel architecture

`@meshrix/gateway` is a protocol-neutral, embeddable kernel. Its public flow is

`authenticate → route snapshot → policy/approval → bounded admission → final authority revalidation → credential/egress → settle`.

The kernel owns no Console, Agent, plugin, SkillHub, or model lifecycle. Those
systems provide ports from composition code. Construction is side-effect free;
`start()` and `close()` own only resources explicitly assigned to the gateway.
This document records gateway ownership boundaries and their runtime effects.

Catalog pages and continuation tokens are authorization-partitioned. A cursor
does not grant access, and a continuation is re-authenticated against the
current subject, grant revision, route revision, and endpoint before an
upstream request is admitted. Unknown external effects remain unknown and are
never retried automatically.

## Downstream subscription and notification surface

The modern `/mcp` downstream adapter advertises exactly the capabilities it
serves: `tools.listChanged`, `resources.listChanged`, `prompts.listChanged`,
and the `subscriptions/listen` POST-stream transport. It does not advertise
`resources/subscribe`, and that method is rejected explicitly rather than
silently ignored. A subscription is opened once against the opening grant, and
every delivery is re-authorized against the current authority before it is
written, so a revoked grant ends the stream instead of leaking further events.
Each notification is bounded by a per-notification byte budget; a notification
that exceeds it closes the stream explicitly instead of being truncated or
dropped.

The retained notification port (`packages/protocols/mcp/notifications.ts`) is
wired into this execution chain: the adapter registers each gateway
subscription through `registerMcpGatewaySubscription`, and the platform
publishes through `broadcastConfiguredMcpNotification` →
`publishConfiguredGatewaySubscription`. Capability flags that no producer can
serve are retired from the `/mcp` subscription contract: the former
`notifications/meshrix/skill_hub/catalog_changed` and
`notifications/meshrix/update_available` subscription flags are no longer
accepted, so a client requesting them fails explicitly instead of receiving an
acknowledgement that can never deliver. Business-specific event names belong to
the optional service adapter, not to the protocol module.
