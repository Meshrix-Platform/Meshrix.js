# Meshrix Client Adapter Kit

This shared package supports the optional first-party adapters for Antigravity,
Claude Code, Codex, Kimi CLI, OpenClaw, OpenCode, and Pi.

When an adapter installs a connector, remote Meshrix endpoints must use HTTPS.
HTTP is accepted only for literal IPv4 or IPv6 loopback addresses used during
local development. Hostnames such as `localhost` and private-network addresses
must use HTTPS. URL credentials, query strings, and fragments are rejected so
they cannot become part of connector configuration.

The adapter stores only connector command metadata and the name of the
credential environment binding. It rejects raw credential fields in requests;
credential values remain in the connector's protected credential store.
