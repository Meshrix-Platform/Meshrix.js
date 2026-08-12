# Examples

These examples demonstrate current public contracts with synthetic values. They
do not define protocol, configuration, or capability facts.

## Upstream Service Publishing Report Template

[upstream-service-publishing-report-template.html](upstream-service-publishing-report-template.html)
is the portable, bilingual, offline blank structural template for the mandatory
publishing report. It is visibly marked `Not executed / 未执行` and is not release
evidence. Generated reports are single-file artifacts: verified screenshots and
the downloadable publishing JSON are embedded as data URLs, so the HTML can be
moved and opened without neighboring resource files. Update the publishing skill
and contract first, then regenerate this template, then change the report
renderer and generated report. Live Console evidence uses a 1440 × 1000 CSS
viewport at 2× device scale, producing 2880 × 2000 PNG screenshots.
The fixed ten-section structure includes in-document navigation, accessible
section headings, table captions, and a mandatory interface catalog with
runtime health beside published operations. A generated local report remains
scoped but unbound until the external candidate receipt hashes its final bytes.
The blank template also exposes synthetic-only slots for candidate scope,
publication/runtime health, the ordered client lifecycle, the visual evidence
index, journey timings, and cleanup summary. Those slots contain no build
locations or executed evidence.

```bash
npm run generate:upstream-service-report-template
npm run verify:upstream-service-report-template
```

## Upstream Service Import

[file-parser-format-convert.upstream.json](file-parser-format-convert.upstream.json)
is a synthetic portable-import example for an HTTP file-conversion service.
Publishing mints a server-assigned opaque service id (`svc_…`, derived from the
owner subject and `serviceKey`); the descriptor `serviceKey` never appears in
compiled identifiers. Grants and tool calls bind to the service id returned by
the publish response: the compiled capability is `cap:upstream:svc_…:convert`
and the projected MCP tool is `upstream.svc_….convert`. Do not precompute
capabilities from the `serviceKey`.

[skill-hub.upstream.json](skill-hub.upstream.json) is the portable contract for
the independently deployed Skill Hub service. Publish it after the service is
reachable from Meshrix, then configure the `skill-hub` adapter with the opaque
server-assigned service id returned by publication. The adapter does not accept
a URL and stores no local Skill Hub registry.
The authoritative schema and runtime behavior are owned by:

- [Gateway functionality](../functionality/GATEWAY.md)
- [Public protocols](../protocols/PROTOCOLS.md)
- `packages/contracts/src/upstream-service/`

Validate the example and its owning contract with:

```bash
npm run verify:upstream-fixture-transit
```

Operational startup, deployment, maintenance, recovery, diagnostics, and
repository verification commands are maintained in the [runbook](../RUNBOOK.md).
Plugin package examples and installer commands remain with their independently
maintained module documentation.
