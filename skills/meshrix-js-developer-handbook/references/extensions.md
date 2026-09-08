# Extension development owners

Select the component's own source, contract, and focused verifier before
editing it. Repository location does not merge its lifecycle with Core.

| Task | Source and first read | Focused verification owner |
| --- | --- | --- |
| Native runtime plugin | `plugins/<plugin>/README.md`, `plugin.json`, and `docs/protocols/PLUGIN-IMPLEMENTATION-CONTRACT.md` | Current `verify:local-runtime-plugins` and `verify:local-extension-package-closure` scripts, narrowed to the changed component where supported |
| Packaged Agent MCP adapter | `plugins/agents/<target>/adapter.mjs`, its README, and `plugins/agents/client-adapter-kit/` when the shared protocol changes | `verify:local-client-adapters` and the adapter's lifecycle tests |
| Model Gateway Service | `services/model-gateway/README.md` and its package scripts | Service-owned tests and build |
| Skill Hub Service | `services/skill-hub/README.md` and its package scripts | Service-owned tests |
| Format conversion Service | `services/file-parser/format-convert/README.md`, `go.mod`, and `scripts/acceptance.py` within that service | Service-owned Go tests and the separately authorized acceptance program |

Read command definitions in the current root or owning component's
`package.json`; these names select owners, not a command sequence to run for
every change. `$meshrix-js-regression-planner` selects verification scope.

Native Plugins use TypeScript/Node.js and the published Host contract. Services
may use another language and serve direct clients under their own governance.
Packaged Agent adapters configure external client products without absorbing
those products' implementations. Preserve all admission, configuration, trust,
credential custody, and operation authorization requirements.

Format conversion success returns document bytes through the multipart
contract, with integrity headers; error responses are bounded JSON. Its
acceptance evidence belongs to that service. Read the service-owned program
instead of reconstructing container, fixture, telemetry, or concurrency checks.
Container and network effects require the existing applicable authorization.

Core deployments do not start, wait for, or promote these optional components.
Use `tools/server-scripts/README.md` for that boundary and
`$meshrix-js-release-journey-producer` when the accepted task includes a specific
optional integration journey. A catalog-only sibling is not an alternate
source, build, or verification authority.
