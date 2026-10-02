# Pi Agent Adapter

Plugin ID: `agent-pi`

Internal component: `@meshrix/agent-pi-adapter`

This private first-party component is bundled with `meshrix.js` and included
in the portable connector runtime. Both consumers resolve it through standard
Node package resolution and run it only for an explicit Pi action. Installation
and authorization remain owned by the Meshrix Core native installer; this
repository owns the Pi-specific extension runtime.

The same component exposes the standard client-adapter JSON-stdio entrypoint.
Pi loads its extension from the installed component directory; the adapter
does not fetch a second package or accept a separate package source.

The extension reads connector metadata from the Core-owned Pi configuration
file. That file contains no token, private key, provider credential, or backend
runtime data. The connector retrieves the target-and-server-scoped API Key from
its private credential store, unless the operator supplies a temporary override.
