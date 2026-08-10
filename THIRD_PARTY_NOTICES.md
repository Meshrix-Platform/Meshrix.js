# Third-party notices

Meshrix.js remains MIT-licensed for its pre-existing code. The repository-local
service and plugin implementation trees below are migrated Apache-2.0 code and
retain the complete notice in their subtree:

- `services/file-parser/format-convert/` — Apache-2.0 (`LICENSE`)
- `plugins/` runtime plugins and client adapters, plus their migrated
  `tools/plugins/` and `tests/plugins/` support trees — Apache-2.0
  (`plugins/LICENSE-APACHE-2.0`, plus each package manifest's `license` field)

No migrated implementation is silently relicensed by co-location. Dependency
licenses remain governed by their own package metadata and lockfile.
