# Entity Config Layout

Entity config lives under `packages/foundation/config/entity-config/`.

| Directory | Purpose |
| --- | --- |
| `tools/` | Operation Permission scopes, operation groups, and profiles. |
| `runbooks/` | Built-in operational procedures shipped with modules. |
| `standards/` | Human governance standards and policy packages. |
| `specs/` | Protocol, import, source, and runtime configuration specs. |

Large payloads do not belong in entity config. Use source locators, checksums, and expected loaders instead.
