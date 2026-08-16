# Meshrix Plugin Package Contract

## Ownership

This repository owns optional plugin implementations and their package
archives. Meshrix Core owns the public Host contract, archive admission,
configured trust, installed-artifact custody, lifecycle ledger, Operation
Permission, and contribution publication.

Plugins consume public capabilities. They do not import Core runtime or
composition modules, inspect Core storage paths, discover sibling repositories,
or load unpackaged source directories.

## Closed one-plugin package archive

Every package archive contains exactly one plugin identity and one
`plugin.bundle.json` using schema
`meshrix.plugin-bundle.manifest.v1`. The manifest declares:

- plugin identity, version, label, and contained `.mjs` entrypoint;
- the complete payload inventory with byte size and SHA-256 for every file;
- the payload digest and compatible Core Host contract digest;
- dependencies, configuration schema, governed operations, and lifecycle hooks;
- the configured trust algorithm required by Core admission.

Archive entries must be normalized relative paths. Undeclared files, duplicate
paths, links, traversal, absolute paths, unsupported entry types, digest drift,
and identity mismatches fail verification. Generated archives are build output,
not source.

## Runtime manifest

`plugin.json` is the contained runtime declaration. A package-eligible runtime
plugin declares
its operations, HTTP routes, MCP tools, console entries, state machines,
verifier hooks, dependencies, runtime entrypoint, and contribution mode.

`defaultEnabled` is always `false`. Core deployment selection is explicit;
manifest metadata and feature names cannot enable a plugin. Configuration is a
closed object validated before activation. Empty configuration remains empty,
and activation failure publishes no partial contribution generation.

The runtime module exports `activatePlugin`. An active runtime returns its exact
declared contribution maps and a `close` function. Closing stops admission,
drains or cancels owned work according to the Host contract, persists required
state through `pluginData`, and releases resources. Dependencies close in
reverse activation order.

## Host capabilities

Core supplies only the Host ports declared by an admitted operation. Examples
include:

- `pluginData` for opaque, plugin-scoped state;
- controlled execution sandbox operations;
- opaque artifact custody;
- neutral workspace operations with bounded path preprocessing;
- operation-scoped external-service forwarding;
- narrow Operation Permission grant recording;
- artifact authority and signing capabilities declared by the package.

A plugin never receives a Core data root, unrestricted filesystem capability,
raw credential store, Host process launcher, or unrestricted network client.
Host errors and plugin responses use bounded public projections.

## Operation Permission

Operations are the authorization primitive. HTTP and MCP are projections of
the same operation catalog and dispatcher. Visibility and execution use the
same current grant and governance decision. A denied operation reaches no Host
side-effect boundary.

Each operation declares scopes, toolsets, resource context, risk, confirmation
requirements, and a closed input schema. Write operations use explicit
idempotency. Approval does not replace a fresh authorization check.

## External services

External-service artifacts are contracts, not live provider configuration.
They declare operation mappings, input allowlists, risk, transport requirements,
and required operator-supplied endpoint, service binding, and secret-reference
custody. They contain no default endpoint, service instance, credential
reference value, organization, repository, or account identity.

The plugin configuration selects an operator-published `serviceRef`. Core binds
that selection to the current operation and current grant, resolves endpoint
and credentials, enforces egress policy and timeout, performs the request, and
returns a filtered response. The plugin cannot supply a URL, method, path,
header, token, or secret reference at invocation time.

## Controlled execution

Plugin-triggered scanning, building, and executable workloads use the Core
controlled execution sandbox. Missing backend configuration, policy, resource
limits, current grant, or workload binding fails closed. There is no Host
process fallback.

## Console assets

Console contributions reference precompiled browser `.mjs` assets included in
the package inventory. Core binds each asset URL to plugin identity, artifact
digest, and active generation. Console contributions currently admit only
precompiled `.mjs` assets. Raw framework source, dynamic evaluation, and
source-repository scanning remain denied until a governed acquisition path
exists. Disabling, replacing, or removing
a generation invalidates its old asset route.

## Verification

Run the complete repository closure:

```bash
npm run verify
```

For faster bounded development, run `npm run verify:local-runtime-plugins`,
`npm run verify:local-client-adapters`, or
`npm run verify:local-extension-package-closure` for the affected scope, then
run `npm run verify` once before a candidate is committed. Passing these checks
does not publish the candidate.
