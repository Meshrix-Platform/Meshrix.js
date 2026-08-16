---
name: meshrix-js-instance-usage
description: User-handbook chapter for operating a published or offline Meshrix.js instance and connecting external services or agents through its single public origin. Use from $meshrix-js-user-handbook. Do not change the release artifact contract from this chapter.
---

# Meshrix.js Instance Usage

This chapter belongs to `$meshrix-js-user-handbook`. It owns how operators
and external systems use a published or offline instance. The published
address shape belongs to `$meshrix-js-developer-handbook`. Runtime
configuration, plugin enablement, and instance repair belong to
`$meshrix-js-instance-configuration`.

Apply `$meshrix-js-repository` first when the worktree is the product
repository. Keep credentials, account data, private paths, and runtime
payloads out of commands, output, reports, screenshots, and skill files.

## One public origin

A published, offline, or `--with-ui` instance has one public origin
`<server-url>`. The default listen port is `7228`.

| Who | Where |
| --- | --- |
| Browser / operator Console | `<server-url>/` |
| Server API, health, auth, Operation Permission | `<server-url>/api/` |
| Agent, MCP connector, or other governed client | the same `<server-url>` |

There is no second public “backend port” to bridge. `/` is the Console. `/api`
is the Server. Both are the same process.

Source development may expose a separate Vite console port. Do not point
external services, agents, or production reverse proxies at that port.

## Connect an external service into Meshrix.js

Keep the external service on its own host, port, and credential custody.
Publish it through the authenticated upstream path so Meshrix.js projects a
governed catalog. Do not copy host credentials into the Meshrix.js container
merely to make a command reachable, and do not publish a second Meshrix.js
listen address for that service.

Use `$meshrix-js-upstream-service-publishing` for the publishing transaction
and `$meshrix-js-instance-configuration` plus its Agent connectivity reference for
host stdio or `gh` bridges.

## Connect an external agent or client to Meshrix.js

Point the connector at `<server-url>`, not at a Vite console port and not at a
guessed second API port. Authenticate with a Console-issued scoped API Key
through the signed connector. Client configuration stores connector metadata,
not the key.

Use `$meshrix-js-downstream-mcp-client-access` and the matching agent-target
skill. Treat Operation Permission grants as a separate transaction from
connector installation.

## Operate the instance

Reuse a healthy same-mode instance. Refuse an occupied default port or a
foreign container on the server name. Stop does not wipe volumes. Restart the
same mode only; a different running mode fails closed.

Probe `<server-url>/api/healthz` for the Server and `<server-url>/` for the
Console when the image is `runtime-ui`. An API-only source compose stack is
not the published usage shape.

Report only status, HTTP status classes, bounded reason codes, and
`<server-url>`. Never print credentials, fingerprints, or private paths.
