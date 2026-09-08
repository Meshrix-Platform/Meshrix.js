---
name: meshrix-js-api-key-issuance
description: Issue an organization-scoped Meshrix.js API Key with an explicitly selected policy and private credential delivery. Use when a downstream MCP client needs a new key; diagnose existing access before issuing another.
---

# Meshrix.js API Key Issuance

Use the authenticated Operation Permission API for an authorized key request.
The actor needs `auth:admin`. Existing authorization for the same instance,
organization node, policy, expiry, and delivery destination remains valid.
Creating a key does not authorize publishing organization governance or
changing a client's configuration.

## Prepare the request

Read the current Operation Permission catalog and
`GET /api/operation-permission/v1/api-keys/issuer-scopes`. Select the authorized
organization node from `eligibleNodes`; do not choose the first node by default.
If organization governance is unconfigured, route the prerequisite to
`$meshrix-js-organization-governance` with its own authorized organization shape.

Start from the [request example](references/issuance-request.example.json) and
replace every placeholder in a private working copy. It is an example, not an
approved policy. Set the requested capabilities or tools, scopes, resource
restrictions, process identity, limits, and expiry explicitly. Do not add
gateway write access, high risk, or unrestricted resources as defaults.

For upstream-projected operations, select the current dynamic capability IDs
from the catalog. A successful login or MCP discover does not prove that the
key exposes the intended tools. Diagnose `tools/list` against the existing
policy and catalog before issuing more credentials.

`audience.targetIds: []` allows a standard client without a product identity
header. Set a non-empty list only when that restriction is part of the request;
a client does not need to belong to the packaged adapter catalog. The server
owns policy validation and normalization in
`packages/capabilities/src/operation-permission-core/api-key-distribution-worker-owner.ts`.
The helper fills only `audience.serverAudience` and `catalogFingerprint` from
the live issuer scope. If supplied bindings differ, review the changed
authority before executing a revised request.

## Execute and deliver privately

Resolve [issue-api-key.mjs](scripts/issue-api-key.mjs) from this skill directory;
it also works from the installed package. Run it with the approved request:

```sh
node <skill-dir>/scripts/issue-api-key.mjs \
  --origin <server-origin> --username <issuing-actor> \
  --request <private-approved-request.json> \
  --key-file <new-private-credential-file> \
  --password-stdin < <private-password-file>
```

The password comes from a private input file or secret-provider pipe, never a
command argument. The helper creates the specified credential file exclusively
with mode `0600`, writes the key there once, and prints only delivery status.
Use a private destination outside tracked repository content. Do not print the
file, copy its contents into tool calls, or retain it in reports. Deliver it to
the already-authorized client or credential store and remove temporary secret
material when that handoff is complete.

The helper logs in, checks governance and the exact eligible node, then issues
once. It never publishes an organization, chooses a replacement node, broadens
the supplied policy, or configures another application. It rejects unknown or
missing arguments and invalid risk values before making requests; `--help`
does not authenticate. The request JSON uses the server's current policy shape.

A transport failure during issuance can leave the outcome uncertain. Inspect
the issuance record before retrying. If issuance succeeded but private delivery
failed, reconcile or revoke that undelivered key through the owning API;
do not silently create another. Login cookies, passwords, response bodies, and
key plaintext never belong in ordinary output.

## Verify the intended access

The client sends the credential to `<server-origin>/mcp` using
`X-Meshrix.js-Api-Key` or an accepted bearer header. Use
`$meshrix-js-downstream-mcp-client-access` for an authorized client configuration
change. Verify the selected catalog and allowed operation without claiming
access outside the approved policy. Rotation and revocation use the same
Operation Permission API; `$meshrix-js-operation-permission` owns their semantics.
