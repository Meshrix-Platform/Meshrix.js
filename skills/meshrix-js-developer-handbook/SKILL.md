---
name: meshrix-js-developer-handbook
description: Meshrix.js developer handbook. Use when changing the product, release definition, packaging, published address contract, acceptance, or repository source. Do not use this package to operate a running instance or to connect external services.
---

# Meshrix.js Developer Handbook

This package is the **developer handbook**. It owns how Meshrix.js is built,
packaged, and addressed. The **user handbook** is `$meshrix-js-user-handbook`.
Keep source ownership, operating procedures, and evidence claims separate.
One authorized user task may contain sequential development and instance
verification; load the owning handbook for each step and retain its required
operation approvals.

`$meshrix-js` is the product identity and specialist-module library. It is not
a second mixed handbook. Apply `$meshrix-js-repository` before editing the
product repository.

## When to use this package

- Change server, console, gateway, permission, storage, or acceptance source
- Change `tools/registry/release-definition.registry.json` or its schema
- Change the published image target, platforms, or listen-address contract
- Pack or verify a `runtime-ui` release or offline bundle
- Write developer-facing evidence, verifiers, or release workflow
- Develop repository-local native plugins, packaged client adapters, or
  independent services using the [extension ownership reference](references/extensions.md)

Do not use this package to start a published instance, log into the Console,
or bridge an external service. That work belongs to `$meshrix-js-user-handbook`.

## Published artifact and public address contract

The release definition is the sole source for version, tag, channel, package
manifests, container target, and platforms. The published artifact shape and
the one-public-origin address contract (console at `<server-url>/`, API at
`<server-url>/api/`, default port `7228`) are owned by
`$meshrix-js-release-artifact-contract`; read that skill for the exact
contract. This handbook only routes: changing the published image target,
platforms, or listen-address contract is a `release-artifact-contract` change;
packing or verifying a `runtime-ui` release or offline bundle is a
`$meshrix-js-release-engineering-workflow` change.

## Developer workflow

1. Preserve unrelated work. Identify one independently acceptable closure.
2. Update the canonical source first, then every owned consumer, derived
   fact, test, and document in the same change.
3. Keep the published address contract in `$meshrix-js-release-artifact-contract`.
4. Run the narrowest owning verifier, then the repository-owned release
   definition check when the artifact or address contract changed.
5. Commit only when covered by user authorization; treat push as a separate
   publication decision. Review the staged tree and outgoing changes at their
   respective boundaries. A source task may finish with verified, reviewable
   changes when no commit was requested; a requested publication remains
   incomplete until its authorized publication steps finish.

Specialist development modules stay under `$meshrix-js`. Load only the module
that owns the current change: repository, core-platform-operations,
release-artifact-contract, release-engineering-workflow,
platform-acceptance-workflow, security, protocol, or the matching domain
module.

## Remaining host qualification

A Linux VM may provide offline-delivery evidence. Prefer Ubuntu; accept Debian.
That evidence does not establish native Linux qualification, which remains
owned by the named Real-Machine Verification Workflow. Project-level
functional acceptance remains `npm run verify:acceptance`.
