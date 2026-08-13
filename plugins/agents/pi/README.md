# Pi Agent Adapter

Plugin ID: `agent-pi`

Package: `@meshrix/agent-pi-adapter`

This Pi package exposes tools discovered through the official Meshrix MCP
connector. Installation and authorization remain owned by the Meshrix Core
native installer; this repository owns the Pi-specific extension runtime.

The same package exposes the standard client-adapter JSON-stdio entrypoint.
Its default install source is the currently executing, already verified local
package directory, so a normal install does not download the package again.
Only an explicit `client.packageSource` request selects another source.

The extension reads connector metadata from the Core-owned Pi configuration
file. That file contains no token, private key, provider credential, or backend
runtime data. The connector retrieves the target-and-server-scoped API Key from
its private credential store, unless the operator supplies a temporary override.
