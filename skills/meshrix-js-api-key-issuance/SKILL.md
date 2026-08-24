---
name: meshrix-js-api-key-issuance
description: Issue a Meshrix.js organization-scoped API Key for a downstream MCP client (for example Command Code, Claude Code, or a custom connector) through the authenticated operation-permission API — including the organization-governance prerequisite check, minimal organization publication when unconfigured, policy construction, and key output. Use when a client needs an mxak1 key to call Meshrix.js MCP tools.
---

# Meshrix.js API Key Issuance

This skill owns **issuing an organization-scoped API Key** on a Meshrix.js
instance for a downstream MCP client. It covers the full prerequisite chain:
organization governance must be configured before a key can be scoped to a
node, and the key policy binds protocol, toolsets, scopes, risk, audience,
resources, process identity, limits, and the catalog fingerprint.

## Establish authority

1. Run `git status --short` for every repository boundary before editing.
2. The issuing actor needs `auth:admin` (the initial owner has it). Log in
   through `POST <server-url>/api/auth/login` and use the session cookie plus
   CSRF headers on every mutating request.
3. This skill issues keys only. Operation Permission, grants, and gateway
   behavior are owned by `$meshrix-js-operation-permission` and
   `$meshrix-js-protocol-gateway`.

## Prerequisite: organization governance

`GET <server-url>/api/authorization/organization-governance` reports
`snapshot.configured`. When `configured` is `false`, key issuance fails with
`api_key_scope_denied` (the `organizationNodeId` must be inside the issuer's
eligible nodes). Configure the organization first through
`$meshrix-js-organization-governance` — import a built-in template (for
example `enterprise-group`) and publish it. Do not hand-write a minimal
draft; the built-in templates are the default path.

After publishing, `GET /api/operation-permission/v1/api-keys/issuer-scopes`
returns `catalogFingerprint`, `serverAudience`, and `eligibleNodes`. Use the
first `eligibleNodes[].nodeId` as `organizationNodeId`.

## Issue the key

`POST /api/operation-permission/v1/api-keys` with:

```json
{
  "workloadDisplayName": "command-code",
  "organizationNodeId": "<eligible node id>",
  "expiresAt": "<ISO-8601 future timestamp>",
  "policy": {
    "protocol": "mcp",
    "serviceIds": [],
    "capabilityIds": ["<dynamic capability id>"],
    "toolsetIds": ["meshrix.gateway.read", "meshrix.gateway.write"],
    "allowedTools": [],
    "deniedTools": [],
    "scopeIds": ["gateway:read", "gateway:write"],
    "maximumRisk": "high",
    "audience": { "serverAudience": "<server-audience>", "targetIds": ["<target>"], "connectorPackageIds": [] },
    "resources": {
      "mode": "unrestricted", "workspaceIds": [], "dataClassifications": [], "egressClasses": [],
      "semanticFamilies": [], "capabilityDomains": [], "capabilityVerbs": [], "resourceKinds": [],
      "effectKinds": [], "secretBindingIds": [], "allowedOrigins": [], "allowedCidrs": []
    },
    "processIdentity": { "mode": "optional" },
    "limits": { "maxUses": 100, "requestsPerWindow": 100, "windowSeconds": 3600, "maxConcurrentEffects": 4 },
    "catalogFingerprint": "<from issuer-scopes>"
  }
}
```

Validation facts learned from the server (`api-key-distribution-worker-owner`):

- `policy.protocol` must be `"mcp"` and `policy.maximumRisk` must be one of
  `low | medium | high` (not the grant risk words); otherwise
  `api_key_input_invalid`.
- `policy.audience.targetIds` must be non-empty; use a Meshrix MCP client
  target such as `opencode` (the MCP client catalog lives in
  `packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.ts`).
- All of `audience`, `resources`, `processIdentity`, `limits`, and
  `catalogFingerprint` are required by the server even though the JSON schema
  lists them as optional; omitting any fails with
  `input.policy is missing a required property`.
- To see **upstream-projected** tools (for example the Requirement Cognition
  MCP tools behind the gateway), `policy.capabilityIds` must list each tool's
  dynamic capability id (`cap:upstream:<serviceId>:<operationKey>`, visible in
  the Operation Permission catalog as the tool's `dynamicCapability.capabilityId`).
  Without it the key authenticates but `tools/list` returns zero tools.

The response body carries `apiKey` (the `mxak1`-prefixed plaintext) exactly
once. Consume it in memory and never log, persist, or embed it in
configuration that is committed.

## Configure the downstream client

The client sends the key in the `X-Meshrix.js-Api-Key` header to
`<server-url>/mcp` (Meshrix's MCP ingress). For Command Code:

```bash
cmd mcp add-json meshrix '{"type":"http","url":"<server-url>/mcp","headers":{"X-Meshrix.js-Api-Key":"<mxak1...>"}}'
```

Anonymous `initialize` succeeds but `tools/list` returns zero tools; the key
is what projects the authorized tool catalog (for example
`meshrix.gateway` upstream services).

## Tooling

`scripts/issue-api-key.mjs` runs the whole flow: login, governance check
(with optional minimal publication), issuer-scope discovery, key issuance,
and plaintext output.

```bash
node skills/meshrix-js-api-key-issuance/scripts/issue-api-key.mjs \
  --origin http://127.0.0.1:7228 \
  --username owner --password '...' \
  --display-name command-code \
  [--publish-minimal-org]
```

## Boundaries

Never print the key except as the single script output. Never commit a key or
a populated policy into a repository. Key rotation and revocation belong to
the same API (`rotate` / `revoke`) and are owned by this skill's lifecycle;
see `$meshrix-js-operation-permission` for grant semantics.
