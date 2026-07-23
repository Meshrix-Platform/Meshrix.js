## Change

Describe the user-visible or contract-visible outcome and the owning capability.

## Validation

List the exact checks run and their results.

## Release impact

State any configuration, protocol, migration, compatibility, security, storage, or rollback impact. Use `None` only when verified.

## Checklist

- [ ] The change has one current implementation; removed behavior has no compatibility shim or stale gate.
- [ ] Authorization, approval, audit, redaction, and privacy boundaries run before side effects where applicable.
- [ ] Tests and authoritative documentation cover changed public behavior.
- [ ] Generated registries and artifacts were refreshed or checked when their sources changed.
- [ ] Logs, fixtures, screenshots, reports, and examples contain no secrets, personal data, private hosts, production payloads, or local absolute paths.
- [ ] Relevant narrow checks and the appropriate repository verification profile pass.
- [ ] Remaining objective blockers and external evidence requirements are stated explicitly.
