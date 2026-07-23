# LicoMesh Entity Configs

This directory stores human-maintainable configuration entities as folders and lightweight bundles.

- `tools/`: operation-permission scopes, toolsets, and agent profiles.
- `auth/`: console roles as scope bundles for authorization and UI policy projection.
- `runbooks/`: built-in operational procedures shipped with modules.
- `standards/`: human governance standards and policy packages.
- `specs/`: protocol, import, source, and runtime configuration specs.

Large payloads should not be copied into these bundles. Use a manifest entry with a source locator, checksum, and expected loader instead.
