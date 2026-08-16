---
name: meshrix-js-instance-configuration
description: Configure and repair a Meshrix.js local or container instance through canonical runtime configuration, signed plugin installation and enablement, service reuse or restart, and health checks. This chapter belongs to $meshrix-js-user-handbook. Everyday use and external connection belong to $meshrix-js-instance-usage.
---

# Meshrix.js Instance Configuration

This chapter belongs to `$meshrix-js-user-handbook`. Everyday use and
external connection through the one public origin belong to
`$meshrix-js-instance-usage`. The published address contract belongs to
`$meshrix-js-developer-handbook`.

Apply `$meshrix-js-repository` first. Preserve the current worktree, existing
runtime data, and unrelated processes. Keep credentials, account data, private
paths, runtime payloads, process environments, and backend records out of
commands, output, reports, screenshots, and skill files.

## Route the request

| Requested outcome | Use |
| --- | --- |
| Use the instance or connect an external service or agent | `$meshrix-js-instance-usage` |
| Start, reuse, restart, or diagnose one instance | `$meshrix-js-instance-usage`, this skill, and `docs/RUNBOOK.md#local-startup` |
| Select, install, trust, or configure a runtime plugin | Read [runtime-plugins.md](references/runtime-plugins.md) completely |
| Enable Skill Hub for one deployment | Read [runtime-plugins.md](references/runtime-plugins.md), then apply `$meshrix-js-skill-hub-lifecycle` only for its business lifecycle |
| Publish a host stdio command or bridge host `gh` | Read [agent-connectivity.md](references/agent-connectivity.md), then apply `$meshrix-js-upstream-service-publishing` |
| Install Meshrix MCP access into a supported Agent target | Read [agent-connectivity.md](references/agent-connectivity.md), `$meshrix-js-downstream-mcp-client-access`, and the matching target skill |
| Share governed skills between agents or a team | Apply `$meshrix-js-workspace-governed-sharing` and `$meshrix-js-skill-hub-lifecycle`; do not model sharing as runtime plugin configuration |

Keep runtime selection, upstream service publication, downstream connector
installation, Operation Permission, and Skill Hub content lifecycle as
separate transactions. Do not let success in one imply success in another.

## Inspect the active instance

1. Run `git status --short` before changing repository files.
2. Resolve the effective data directory from the same startup contract used by
   the running server. Do not print it or replace it with a temporary root.
3. Probe the public origin. A published, offline, or `--with-ui` instance
   serves Console at `<server-url>/` and API at `<server-url>/api/` on one
   port. Identify the owner without dumping process environments or complete
   argument lists. A separate Vite console port is source-development only.
4. Reuse a healthy server and console belonging to the same instance. If a
   default port belongs to an unrelated or unidentified process, stop and
   report the conflict instead of choosing another port.
5. Treat `build/` and readiness files as private generated state, not as
   configuration authority or shareable evidence.

## Prepare the change

1. Read the existing runtime configuration through the canonical parser in
   `tools/server-scripts/lib/runtime-plugin-selection.ts`. Keep omitted user
   configuration omitted; never manufacture providers, models, agents,
   plugins, permissions, or deployment profiles.
2. Make the smallest explicit configuration change that produces the requested
   outcome. Store private configuration with restrictive permissions.
3. Install and verify a selected plugin artifact before adding it to
   `runtime.enabledPlugins`. Never load production plugins directly from
   `plugins/` or make `defaultEnabled` activate a plugin.
4. Transfer credentials only through the owning secret channel. Never place a
   raw API Key, GitHub token, provider key, private signing key, or password in
   runtime JSON, client configuration, CLI arguments, source, or reports.

## Apply the change

1. Validate the staged configuration and artifact lifecycle before stopping a
   healthy process.
2. Stop only the exact server or console process that owns the target port and
   wait for graceful termination.
3. Restart one server against the same data directory and explicit runtime
   configuration. Start a separate console process only for source
   development when the server does not already serve the Web Console.
4. Require a controlled restart after changing plugin selection,
   configuration, artifact trust, or deployment profile. Do not claim a hot
   reload.

## Verify the outcome

1. Require HTTP `200` from `GET <server-url>/api/healthz`.
2. Require `<server-url>/` to load the Web Console when the instance is
   `runtime-ui` or `--with-ui`. A separate Vite console is source-development
   only.
3. Probe one selected plugin route without credentials. An authentication or
   authorization response such as `401` or `403` proves the route is mounted;
   `404` does not. Do not treat protected content as health evidence.
4. Confirm the requested target, route, or connector metadata without reading
   or returning secrets or backend payloads.
5. If repository source changed, run the narrowest owning verifier and
   `git diff --check`. Run the full repository test only once after all source
   changes are complete. A configuration-only restart does not justify a full
   regression run.

Report only the instance status, configured capability names, HTTP status
classes, bounded reason codes, and validation commands. Never include runtime
configuration contents, credential fingerprints, account metadata, private
paths, process fingerprints, or raw server output.
