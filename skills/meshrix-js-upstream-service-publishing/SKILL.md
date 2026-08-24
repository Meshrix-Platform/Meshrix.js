---
name: meshrix-js-upstream-service-publishing
description: Publish an external service (HTTP, JSON-RPC, MCP, or host stdio command) into a Meshrix.js instance through the authenticated upstream publication path — descriptor, operation mapping, revision handling, health verification — and keep the governed publishing transaction intact. Use for upstream onboarding, gateway lifecycle, service registration, or runtime publication. The release verification lanes are owned by $meshrix-js-release-journey-producer, the HTML report by $meshrix-js-html-report-contract, and the client compatibility matrix by $meshrix-js-client-compatibility-matrix.
---

# Meshrix.js Upstream Service Publishing

This skill owns **publishing a service into a Meshrix.js instance** through
the authenticated upstream publication path. The release verification lanes
belong to `$meshrix-js-release-journey-producer`, the portable HTML report to
`$meshrix-js-html-report-contract`, and the client compatibility matrix to
`$meshrix-js-client-compatibility-matrix`; do not run those lanes from this
skill.

## Establish authority

1. Run `git status --short` for every repository boundary before editing.
2. Read [references/publishing-contract.md](references/publishing-contract.md) completely when changing the capability flow, state model, security boundary, event contract, protocol delivery, or server gate.
3. Keep ownership split as follows:
   - Core owns the developer control plane, normalized service descriptor, manifest persistence contract, upstream gateway reload, Operation Permission projection, tag-scoped discovery, protocol notifications, and platform acceptance.
   - Client implementations independently own cache consumption, product lifecycle, packaging, and compatibility. Core never discovers, imports, executes, or waits for those implementations or their evidence.
   - repository-local maintenance owns this skill and the catalog-backed workflow task.
4. Use `$meshrix-js-security-authorization`, `$meshrix-js-protocol-gateway`, `$meshrix-js-operation-permission`, and `$meshrix-js-platform-acceptance-workflow` only for the Core boundaries actually changed.
5. Use `$meshrix-js-release-journey-producer` for the pre-release verification lanes and receipt, `$meshrix-js-html-report-contract` for the report template, renderer, and screenshots, and `$meshrix-js-client-compatibility-matrix` for the downstream client matrix.

## Preserve the publishing transaction

Treat one accepted service revision as one monotonic publishing transaction:

1. Authenticate the service developer and bind the request to a service owner.
2. Parse the request into a closed, versioned publishing command and authorize every declared service, operation, audience, credential reference, certificate reference, traffic policy, and risk policy.
3. Compile the command into a canonical manifest without interpolating untrusted input into paths, commands, templates, environment names, header names, or executable configuration.
4. Persist the manifest through the control-plane writer into a dedicated configuration root; keep the gateway runtime identity read-only and keep mutable runtime state elsewhere.
5. Detect the new manifest revision, validate it completely, and atomically swap an immutable gateway snapshot without exposing a partial revision.
6. Compile every operation into Operation Permission facts and publish one catalog revision only after the gateway snapshot and permission projection agree.
7. Recompute discovery visibility for each affected grant or audience from organization, team, role, and other governed tags; send scoped invalidation notifications without publishing unauthorized schemas.
8. Expose scoped revision-only invalidation, authenticated catalog pull, exact acknowledgement, grant disconnect, timeout, and reconnect-fence semantics through the published protocol; verify them with a neutral peer.

The Core terminal success is `server_published` after the gateway, Operation Permission, audience projection, and protocol-delivery facts agree. A control-plane request may return `accepted` or `publishing` while those server stages advance. Client adoption is neither a Core state nor an input to this gate. A failed server-side step must leave the previous accepted revision authoritative and emit only redacted audit facts.

## Enforce security and consistency

- Treat user input as untrusted data, not as configuration syntax. Normalize through a closed schema, reject unknown and duplicate keys, bound bytes, depth, collections, and strings, and reject prototype keys and control characters.
- Derive storage paths from server-owned identifiers. Do not accept a caller path, filename, command, environment-variable name, arbitrary header name, or template fragment.
- Store private keys, tokens, and certificate material only through typed secret references. Bind each reference to the service, target, protocol, scopes, and revision before materialization.
- Separate the control-plane writer identity from the gateway reader identity. Reject symlinks and non-regular files; validate ownership and mode before loading.
- Use durable staging, file synchronization, atomic replacement, directory synchronization, revision digests, and rollback. Do not mutate a live descriptor object in place.
- Use immutable snapshots and monotonic revisions so readers do not lock the hot path. Coalesce file-system events, but never coalesce distinct accepted revisions into an unverified state.
- Apply the same authorization and tag policy during discovery and execution. Discovery must not reveal operation names or schemas that execution would deny.
- Scope notifications by grant or audience and include only protocol-schema revision facts and a fixed reason. Notifications do not carry the catalog, grant identity, tags, or secrets.
- Bind delivery cohorts to opaque server-side grant digests, negotiated protocol sessions, audience partitions, and revision chains; do not model or inspect a consumer cache.
- Accept only exact acknowledgements for the pending revision and affected partition set. Disconnect on grant retirement, fence timed-out sessions, and reject same-session reconnect after a timeout until a fresh protocol session is established.

## Preferred flow: declarative configuration file

Registering an upstream service should be a **declarative configuration file
that the server hot-loads**, not a sequence of hand-built API calls. This is
the standing target for upstream onboarding; the API steps below are the
manual/advanced fallback.

```jsonc
{
  "services": [
    {
      "name": "requirement-cognition",
      "type": "mcp",                          // http | json-rpc | mcp
      "url": "http://<host>:8871/mcp",        // remote MCP endpoint
      "auth": { "type": "bearer", "token": "..." },   // upstream credential
      "headers": { "x-valorius-project": "dev" }      // non-sensitive request context
    }
  ]
}
```

The server reads the file and completes the internal steps itself: create or
replace the service publication, store the credential as a typed secret,
bind the credential reference, and make the MCP service immediately
available. Internal identifiers (`capabilityId`, `secretBindingId`,
`issuer-scopes`) are derived server-side and are **not** part of the file.

Scope boundaries:

- **Upstream service registration** (this skill): the configuration file
  above. It does not involve API Keys, organization governance, or client
  authorization.
- **Downstream client access**: issuing API Keys and configuring clients is a
  separate workflow owned by `$meshrix-js-api-key-issuance` and
  `$meshrix-js-organization-governance`; never mix client authorization into
  service registration.

While the configuration-file entry point is being implemented, use the
manual API flow below; it is the same publication contract, expressed step by
step.

## Publish to a running instance (manual API flow)

### Authenticate

`POST <server-url>/api/auth/login` with a maintainer credential returns a
session cookie and a CSRF token. Every mutating request needs the cookie, the
CSRF token (`X-CSRF-Token` and `X-Meshrix-CSRF`), and
`X-Meshrix-Safety-Confirm: true`.

### Publish an HTTP or JSON-RPC service

`POST /api/gateway/v1/services` with a closed command:

```jsonc
{
  "schemaVersion": "v0.0.1:upstream-service-publishing:command-2",
  "action": "create",                       // create | replace | disable | remove | republish
  "expectedServiceRevision": 0,             // create=0; mutations use the current revision
  "expectedSetRevision": 0,                 // current control-plane setRevision
  "idempotencyKey": "create-my-service",    // /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/
  "serviceKey": "my-service",               // create only; letter-start, [A-Za-z0-9_.-], optional / segments
  "descriptor": {
    "serviceProtocol": "http",              // http | json-rpc | mcp
    "label": "My Service",
    "baseUrl": "http://host:port",          // explicit port, no credentials
    "allowLocalNetwork": true,              // required for private/loopback targets
    "operations": [{
      "operationKey": "root",
      "method": "GET",
      "path": "/",
      "risk": "read_only",                  // read_only | safe_write | repair_write | destructive
      "payloadTransport": {
        "request": { "mode": "structured_json", "maxBytes": 1048576, "mediaTypes": ["application/json"] },
        "response": { "mode": "opaque_stream", "maxBytes": 10485760, "mediaTypes": ["text/html"] }
      }
    }]
  }
}
```

Representation modes: request `structured_json | opaque_stream |
artifact_body | artifact_multipart`; response `structured_json |
opaque_stream | artifact`. JSON-RPC requires `structured_json` both ways.

### Publish an MCP service

MCP services derive tools/call from the remote catalog and must not carry an
`operations` array:

```jsonc
{
  "serviceProtocol": "mcp",
  "label": "Requirement Cognition",
  "allowLocalNetwork": true,
  "mcp": {
    "transport": "http",                  // remote HTTP only; stdio is rejected
    "url": "http://<service-host>:<port>/mcp",  // must pass the remote-URL validation
    "headers": {                          // optional declarative request headers
      "x-valorius-project": "<project>"   // supported per ADR-0001; values are
    }                                     // plain strings, injection syntax rejected
  }
}
```

Declarative custom fields (for example MCP request context headers) are a
standing capability per ADR-0001
(`docs/adrs/0001-upstream-service-custom-fields.md`). If an upstream service
needs an optional field, extend it the same way: add the field to the relevant
allowlist, keep the value validation declarative-only, and prove it with a
focused publishing-boundary test.

### Connect an authenticated MCP service (generic steps)

These steps apply to any remote MCP service that requires authentication and
runs in a local container or VM. They are environment-agnostic; resolve the
actual addresses, tokens, and scopes for the instance at hand.

1. **Make the service reachable from the Meshrix runtime.** A container on the
   same host must publish its port (for example `0.0.0.0:<port>` so a sibling
   VM can reach it through the host address). Confirm the Meshrix VM can
   `curl` the MCP endpoint before publishing: a `401`/`403` response proves
   reachability (the service is asking for credentials), while a timeout or
   connection failure means the port is not exposed.
2. **Confirm the MCP protocol version.** The gateway accepts the supported set
   in `MCP_SUPPORTED_PROTOCOL_VERSIONS` (see
   `packages/protocols/mcp/upstream-mcp-transport-common.ts`). The server
   selects the version it returns during `initialize`; if the upstream service
   speaks an older version, either upgrade it or add the version to the
   supported set.
3. **Non-sensitive request context goes in `mcp.headers`** (for example
   `x-valorius-project`). Sensitive material (Authorization, API keys) must
   never go there: the publishing contract rejects it with
   `storage_manifest_sensitive_material`. Use a typed secret reference instead.
4. **Store credentials as a local secret.** Write a `secret://` entry into the
   instance's local secret store with `initializeLocalSecret` (payload
   `{ headers: { authorization: "Bearer <token>" } }`), scoped to the
   serviceId, host, protocol, and the scopes the operation requires. The
   instance must have `MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE` configured and
   the key file must live **outside** the governed data directory
   (`local_secret_key_custody_invalid` otherwise).
5. **Reference the secret in the descriptor.** Add
   `references: [{ type: "credential", reference: "secret://...", revision,
   use: "request-auth", host, protocol }]`. Leave `scopes` empty unless every
   operation that uses the binding shares one scope set; a binding whose scope
   is absent from an operation's `requiredScopes` is denied with
   `upstream_credential_binding_denied`.
6. **Verify.** `GET /api/gateway/v1/external-services/:id/health` must return
   `ok: true` with the discovered `toolCount`. Then invoke one tool through
   `/api/gateway/v1/forward` with `operationKey: "tools/call"` and
   `toolName: "<prefix>::<tool>"` (the public prefix is the service's
   `mcp.toolNamePrefix`). A business error from the upstream service (for
   example `-32003 forbidden`) means the link works and the upstream policy
   rejected the call; an `upstream_mcp_*` reason code means the gateway could
   not complete the protocol exchange.

### Lifecycle endpoints

| Action | Method | Path |
| --- | --- | --- |
| Create | POST | `/api/gateway/v1/services` |
| Replace | PUT | `/api/gateway/v1/services/:serviceId` |
| Disable | POST | `/api/gateway/v1/services/:serviceId/disable` |
| Remove | DELETE | `/api/gateway/v1/services/:serviceId` |
| Republish | POST | `/api/gateway/v1/services/:serviceId/republish` |
| List (control plane) | GET | `/api/gateway/v1/services` |
| List (runtime) | GET | `/api/gateway/v1/external-services` |
| Detail | GET | `/api/gateway/v1/services/:serviceId` |
| Health | GET | `/api/gateway/v1/external-services/:serviceId/health` |
| Forward (JSON) | POST | `/api/gateway/v1/forward` |
| Forward (opaque stream) | POST | `/api/gateway/v1/transit/:serviceId/:operationKey` |

### Verify the outcome

1. `GET /api/gateway/v1/services/:serviceId` until
   `publication.status === "server_published"`.
2. `GET /api/gateway/v1/external-services/:serviceId/health` returns `ok: true`
   — this also proves the gateway can reach the target through its egress
   policy.
3. For a JSON operation, call `/api/gateway/v1/forward`; for an opaque-stream
   operation (HTML, files), call `/api/gateway/v1/transit/:serviceId/:opKey`.

### Common failures

- `upstream_publishing_schema_invalid`: wrong `schemaVersion`; use
  `v0.0.1:upstream-service-publishing:command-2`.
- `storage_manifest_service_revision_stale`: stale
  `expectedServiceRevision`/`expectedSetRevision`; read the control-plane list
  first.
- `upstream_publishing_idempotency_invalid` / `service_key_invalid`:
  idempotency key or service key fails its pattern.
- `descriptor.baseUrl must be a remote URL`: the URL is missing or does not
  carry an explicit port; check the actual request body, not only the format.
- `descriptor.baseUrl must use an HTTP transport with an explicit port`:
  add the port, strip credentials.
- Health `ok: false` with `status: 0`: the gateway egress policy rejected or
  could not reach the target. Loopback/private targets need
  `allowLocalNetwork: true`; special hostnames such as `host.docker.internal`
  may resolve to addresses the policy classifies as restricted — prefer a
  reachable private IP.
- `opaque_response_requires_stream`: an opaque (non-JSON) response through
  `/forward`; use `/transit` with `opaque_stream` request/response modes.
- MCP health `upstream_mcp_discovery_failed`: the remote MCP catalog could not
  be discovered; confirm the remote `/mcp` endpoint and its authentication.

## Boundaries

Do not run the release verification lanes, prepublication verifier,
screenshot capture, or HTML report from this skill; those belong to
`$meshrix-js-release-journey-producer`, `$meshrix-js-html-report-contract`,
and `$meshrix-js-client-compatibility-matrix`. Do not copy a host credential
into a container merely to make a host-owned command reachable; publish only
the governed service and keep credential custody on the host.
