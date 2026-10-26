# Release status

- Repository: `Meshrix.js`
- Profile: `semver`
- Published version: `0.3.0`
- Prepared source version: `0.4.0` (not published)

## Release history

The latest public release is available as:

- [`meshrix.js@0.3.0`](https://registry.npmjs.org/meshrix.js/0.3.0)
- [`@meshrix/gateway@0.3.0`](https://registry.npmjs.org/@meshrix%2fgateway/0.3.0)
- [GitHub release `v0.3.0`](https://github.com/Meshrix-Platform/Meshrix.js/releases/tag/v0.3.0).

These publication facts establish the listed release artifacts. They do not
establish deployment of later source, Workers support, application-layer
operator blindness or unqualified environment compatibility. See
[product status](../STATUS.md) for the current implementation and evidence
boundaries.

## Subsequent releases

The `0.4.0` source candidate releases the Rust native client binaries
together with the npm products. The tag-driven workflow builds and qualifies
the Linux and macOS client matrices — musl CLI/TUI and X11/Wayland GUI
archives for Linux x86_64 and aarch64, thin Mach-O CLI/TUI and GUI archives
for macOS aarch64 and x86_64 — and attaches all eight archives to the GitHub
Release. The A4AA, AwP and A4AA dialect dependencies resolve exclusively from
published crates.io coordinates pinned in `apps/entry-native/Cargo.lock`. See
the [changelog](../../CHANGELOG.md).

The standard tag-driven workflow performs build, test, packaging and
clean-consumer checks before npm and GitHub publication. Local source
preparation does not publish another release; new artifacts must follow that
workflow and preserve the documented support boundary of published interfaces.
