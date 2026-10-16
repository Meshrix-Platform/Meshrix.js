# Release status

- Repository: `Meshrix.js`
- Profile: `semver`
- Published version: `0.1.0`
- Prepared source version: `0.2.0` (not published)

## Release history

The first public release is available as:

- [`meshrix.js@0.1.0`](https://registry.npmjs.org/meshrix.js/0.1.0)
- [`@meshrix/gateway@0.1.0`](https://registry.npmjs.org/@meshrix%2fgateway/0.1.0)
- [GitHub release `v0.1.0`](https://github.com/Meshrix-Platform/Meshrix.js/releases/tag/v0.1.0), published on 2026-10-04 UTC.

These publication facts establish the listed release artifacts. They do not
establish deployment of later source, Workers support, application-layer
operator blindness or unqualified environment compatibility. See
[product status](../STATUS.md) for the current implementation and evidence
boundaries.

## Subsequent releases

The `0.2.0` source candidate consolidates the Rust client, adopts A4AA and
AwP for Agent adaptation and behavior profiles, and updates the Peer,
recording and security implementation. See the [changelog](../../CHANGELOG.md).
The native client is qualified independently from the two npm products.
Its current dependency API changes require matching distributable A4AA and
AwP releases; development-source checks alone do not establish that build path.

The standard tag-driven workflow performs build, test, packaging and
clean-consumer checks before npm and GitHub publication. Local source
preparation does not publish another release; new artifacts must follow that
workflow and preserve the documented support boundary of published interfaces.
