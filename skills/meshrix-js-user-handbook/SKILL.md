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
`<server-url>` (Console at `/`, Server API at `/api/`). The full address
contract is owned by `$meshrix-js-release-artifact-contract`; instance
addressing, connection, and operation details are owned by
`$meshrix-js-instance-usage` and `$meshrix-js-instance-configuration`. This
handbook only routes: browser and operator access, external-service
publishing, and agent or client connection all start from
`$meshrix-js-instance-usage`. Operator commands live in `docs/RUNBOOK.md`; do
not copy command maps into this handbook.

## Connect an external service or client

Connecting an external service into Meshrix.js, connecting an external agent
or client, and operating a healthy instance are owned by
`$meshrix-js-instance-usage`; instance configuration and plugin repair by
`$meshrix-js-instance-configuration`. Publishing an external service uses
`$meshrix-js-upstream-service-publishing`; installing downstream MCP access
uses `$meshrix-js-downstream-mcp-client-access` and the matching agent-target
skill. This handbook does not repeat those procedures.
