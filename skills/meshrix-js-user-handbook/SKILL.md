---
name: meshrix-js-user-handbook
description: Meshrix.js user handbook. Use when operating a published or offline instance, opening the Console, or connecting an external service or agent through the single public origin. Do not use this package to change the product, release definition, or published address contract.
---

# Meshrix.js User Handbook

This package is the **user handbook**. It owns how operators and external
systems use a published or offline Meshrix.js instance. The **developer
handbook** is `$meshrix-js-developer-handbook`. Do not mix those purposes in
one closure.

`$meshrix-js` is the product identity and specialist-module library. It is not
a second mixed handbook.

## When to use this package

- Start, stop, restart, or reuse a published, offline, or `--with-ui` instance
- Open the Web Console and confirm the Server is on the same origin
- Connect an external service into Meshrix.js
- Connect an Agent, MCP client, or other governed client to Meshrix.js
- Configure plugins or repair one running instance without changing source

Do not use this package to change release definition, image target, packaging,
or the public address contract. That work belongs to
`$meshrix-js-developer-handbook`.

## How the instance is addressed

A published, offline, or `--with-ui` instance has **one public origin**
`<server-url>`. The default listen port is `7228`.

| Who | Where |
| --- | --- |
| Browser / operator Console | `<server-url>/` |
| Server API, health, auth, Operation Permission | `<server-url>/api/` |
| Agent, MCP connector, or other governed client | the same `<server-url>` |

There is no second public “backend port.” `/` is the Console. `/api` is the
Server. Both are the same process. Source development may expose a Vite
console port; do not point external systems or reverse proxies at that port.

Operator commands live in `docs/RUNBOOK.md`. Do not copy command maps into
this handbook.

## Connect an external service

Keep the external service on its own host, port, and credential custody.
Publish it through the authenticated upstream path so Meshrix.js projects a
governed catalog. Do not copy host credentials into the Meshrix.js container
merely to make a command reachable, and do not ask Meshrix.js to open a
second listen address for that service.

Use `$meshrix-js-instance-usage` first, then
`$meshrix-js-upstream-service-publishing` for the publishing transaction.

## Connect an external agent or client

Point the connector at `<server-url>`. Authenticate with a Console-issued
scoped API Key through the signed connector. Client configuration stores
connector metadata, not the key. Operation Permission grants are a separate
transaction from connector installation.

Use `$meshrix-js-instance-usage`, `$meshrix-js-downstream-mcp-client-access`,
and the matching agent-target skill.

## Operate the instance

Reuse a healthy same-mode instance. Refuse an occupied default port or a
foreign container on the server name. Stop does not wipe volumes. Restart the
same mode only.

Probe `<server-url>/api/healthz` for the Server and `<server-url>/` for the
Console. An API-only source compose stack is not the published usage shape.

Report only status, HTTP status classes, bounded reason codes, and
`<server-url>`. Never print credentials, fingerprints, or private paths.

Instance configuration and plugin repair belong to
`$meshrix-js-instance-configuration`. Everyday use and external connection
stay in this handbook and `$meshrix-js-instance-usage`.
