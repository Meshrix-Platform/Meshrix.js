# Contributing To Meshrix.js

Meshrix.js is an open-source TypeScript and Node.js framework for governed HTTP/MCP services, pluggable capabilities, and auditable execution.

Changes should improve runtime behavior, architecture, documentation accuracy,
tests, or supported installation and operation. Do not add claims that are not
backed by the implementation or candidate evidence. Never include secrets,
personal data, machine identifiers, or runtime payloads in source or reports.

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Development Setup

Requirements are declared in `package.json`. Use the current Node.js range from `engines.node`.

```bash
npm ci
npm run dev
```

The default local server URL is `http://127.0.0.1:7228`.

## Change Workflow

CONTRIBUTING owns the common engineering workflow for features, architecture
drift, vulnerabilities, dependency updates, and data or schema repairs. Other
canonical sources link here instead of restating it. The same finite process
applies to every change:

1. Identify the module owner and one integration owner for the change, and
   record the affected boundaries.
2. Decide only consequential architecture, published-support, authority, or
   risk changes before editing. Ordinary scoped repairs proceed after the
   problem and repair are reported.
3. Update the canonical source first, then migrate every owned producer,
   consumer, test, registry, generated projection, and document in the same
   change; remove the superseded path instead of adding compatibility.
4. Run the narrowest owning checks and collect failures across the selected
   scope before repairing. Keep the final complete regression for the selected
   integration scope after all changes and repairs are complete.
5. Keep the root `allowScripts` install policy aligned with admitted dependencies;
   enable only required package lifecycle scripts, never a blanket bypass.
6. Complete the applicable local CI checks below before pushing or promoting the
   candidate. Integrate once through the integration owner, and maintain version,
   deprecation, and release facts in the canonical release source.

## Local And Hosted CI

For agent-led development and release work, the agent automatically invokes
`npm run ci:local` within the authorized task. The user is not responsible for
starting the toolchain, choosing environments or assembling commands.
This single entry coordinates environment discovery, selects and starts the
applicable workflows, cleans up owned resources and reports their results. Its
internal discovery tool observes the current device's operating system, CPU
architecture, Node.js runtime and available local tools. Operators do not run
discovery separately, manually select its results or assemble a sequence of
verification commands. Do not hard-code a maintainer's device inventory, replace
scripted discovery with manual probing, or connect to remote machines during
local discovery.

Implement this toolchain in cross-platform Node.js. Use Node APIs for file
operations, process ownership, orchestration and reporting instead of sh, Bash,
PowerShell or inline workflow shell logic whenever Node.js can provide the
behavior. Invoke necessary external tools with argument arrays. Keep genuinely
OS-specific integration in a narrow adapter, update all callers and tests, and
remove the replaced implementation. Hosted YAML calls the same maintained tools;
it must not contain a separate implementation of the workflow.

The entry automatically runs the native-host workflow and, when a local Docker
engine is available, the compatible Linux container workflow selected from its
observed operating system and architecture. It may schedule independent workflows
concurrently or sequentially. Without Docker, it runs the applicable native-host
checks; do not require a virtual
machine, install a hypervisor or run an incompatible architecture under emulation
to satisfy a fixed matrix. A missing prerequisite is recorded as `not_run` with
a finite reason. A check that starts and fails remains a failure requiring
investigation; lack of another platform does not turn it into a pass.

Meshrix.js is a cross-platform Node.js framework. An npm release may be qualified
on one or two available platforms. Complete the selected platforms' actual
installation, functional and security verification, and report which environments
were exercised. Do not require every operating system, CPU architecture, native
Ubuntu host, container image or deployment target before npm publication.
Unmeasured platforms remain explicitly unmeasured without blocking the qualified
npm candidate. Container images and deployments have separate validation for
those artifacts when they are included in the delivery.

- Local and hosted checks use the same maintained engineering entry points,
  applicable test selection, dependency policy and supported runtime versions.
  Shared checks must not acquire different pass criteria solely because they
  run locally or in GitHub. Keep hosted identity and publication operations in
  their authorized release stage.
- Verify changed installation and packaging behavior in an isolated consumer
  on a discovered, available platform with freshly installed locked inputs and
  an empty npm cache. Existing build output, workspace links, user npm
  configuration or credentials must not substitute for the actual package.
- Complete one diagnostic pass over the selected executable scope, collect
  all failures, repair their causes with focused checks, then rerun the same
  maintained local workflow. Continue that repair-and-rerun cycle until the
  applicable scope passes, reusing still-valid results. Include deterministic
  release-artifact review in this workflow; remove redundant or inapplicable
  artifact restrictions while preserving required functional and security
  verification. Do not use repeated pushes to discover ordinary build, test,
  dependency or package defects.
- Retain full sanitized command logs and structured results, including failures
  and interrupted execution. Record the candidate, observed environment,
  selection, actual exit status and unexecuted scope. Missing or skipped checks
  cannot be presented as successful executions.
- Reuse valid evidence while its exercised implementation, configuration and
  artifact remain unchanged. Do not repeat unrelated platform checks for each
  focused repair. Performance verification follows successful relevant
  functional verification as required by `AGENTS.md`.
- GitHub dependency review, hosted run identity, package publication,
  provenance and deployment permissions require their real external checks.
  Local environment discovery and engineering results do not establish those
  external facts.

Keep this orchestration and its tools in the canonical implementation and update
their existing consumers together. Any genuinely necessary manual step must
state what the operator must do, why automation cannot do it and what input lets
the workflow continue. Do not retain undocumented manual handoffs, a one-off
script or a second local command list as a substitute for the automated workflow.

## Public npm Products

The public npm products are `meshrix.js` and `@meshrix/gateway`. Workspace
boundaries describe source ownership and do not imply independent publication.
Keep internal runtime modules, adapters, and tools within their owning product
unless an external consumer has a distinct supported API, dependency set,
lifecycle, and maintenance need that justifies a separate package.

Before adding or changing a public package boundary, update
[ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) with its external
consumer and support surface, then migrate the package metadata, build and
release consumers, tests, and documentation together. Prepare an archive once
and verify that same unmodified archive in an isolated consumer. Do not create
a package solely to mirror a workspace or make an internal module independently
installable.

## Change Rules

- Keep each change scoped to one capability, protocol boundary, verifier, or documentation area.
- Follow [Source File Organization](docs/architecture/ARCHITECTURE.md#source-file-organization): choose the smallest cohesive boundary that reduces coupling, and never split or reject a source file solely because of its line count.
- Preserve existing user changes in the working tree.
- Prefer registered operations, generated registries, and existing domain helpers over parallel implementations.
- Do not keep old compatibility paths when a refactor is meant to replace the old implementation.
- Name extracted modules by stable responsibility and ownership; do not create numeric, stage-named, or pass-through shards.
- Update documentation when public behavior, configuration, commands, or verification changes.
- Add or update tests for behavior changes.
- Render sibling buttons or button-like controls placed in the same horizontal action group at one shared explicit height. Different button implementations, wrappers, variants, or labels must not produce uneven controls on the same visual row; use the shared horizontal action-group contract instead of page-specific height exceptions.

### Console UX Copy (i18n)

Every new user-facing console string — retry labels, field errors, empty-state CTAs, remediation copy, journey links, and confirmation bodies — MUST use the keyed dictionary `consoleMessages` in `apps/console/i18n/console-messages.ts`. Add each new leaf entry under BOTH the `zh-CN` and the `en` locale block, and consume it in views as `consoleMessages[currentConsoleLocale.value].<group>.<key>`, with `currentConsoleLocale` imported from `apps/console/i18n/console-locale-state.ts` (both symbols are re-exported from `apps/console/i18n/console.ts`; reuse the view's existing `msg`/`locale` composition when present). Converting existing views to the keyed dictionary is out of scope.

Forbidden for new copy — reviewers reject these on sight:

- Extending the runtime DOM localizer `apps/console/i18n/console-dom-localizer.ts`.
- New Chinese-literal `tt(zh, en)` pairs.
- New per-module `t(zh, en)` maps.
- New dynamic pattern matchers (`apps/console/i18n/console-dynamic-patterns.ts`, `apps/console/i18n/console-text-localizer.ts` fallbacks).

Example — the existing `nav.dashboard` entry shows the required shape in `apps/console/i18n/console-messages.ts`:

```ts
export const consoleMessages: any = {
  "zh-CN": {
    nav: {
      dashboard: "工作台",
    },
  },
  en: {
    nav: {
      dashboard: "Workbench",
    },
  },
};
```

```ts
import { consoleMessages, currentConsoleLocale } from "../i18n/console";

const msg = computed(() => consoleMessages[currentConsoleLocale.value]);
// template: {{ msg.nav.dashboard }}
```

The dictionary is one shared file: each copy-bearing feature owns one top-level group and inserts it alphabetically in both locale blocks, so independent changes merge cleanly. The durable namespace table is published in [apps/console/i18n/README.md](apps/console/i18n/README.md).

## Documentation Rules

The root READMEs are user entry points, not maintenance contracts. Keep their copy focused on useful capabilities, real console images, and a working quick start. Move language conventions, repository structure, architecture internals, release procedures, and verification details to their owning technical documents. See the [Developer Guide](docs/development/README.md#documentation-conventions) for placement and review rules.

- Write technical facts, not intent narratives.
- Keep documents tied to code paths, runtime behavior, configuration fields, protocol surfaces, or verification commands.
- Record durable technical decisions in the canonical public architecture, protocol, functionality, registry, or verifier source that owns the affected behavior.
- Use placeholders such as `<repo-root>`, `<server-url>`, `<server-data-dir>`, `<input-file>`, and `<output-file>`.
- Do not write secrets, tokens, local absolute paths, private hosts, production payloads, or private runtime state.

## Validation

Run the narrowest verifier that covers the change, then run broader checks when the change crosses public boundaries. These commands are alternatives selected by the changed behavior, not a mandatory sequence for every task; `npm test` runs the `core-public` integration profile.

```bash
npm run typecheck
npm test -- --suite domains.manifest
npm test
```

For documentation-only changes, follow the [documentation validation scope](docs/development/README.md#validation):

```bash
npm run verify:docs
git diff --check
```

Skill changes use `npm run verify:skills`; operator helper changes use `npm run verify:skill-tools`. Do not run the full regression merely to select checks for a documentation edit.

## Pull Requests

One pull request maps to one independently deliverable task with one integration owner; keep unrelated work out. A pull request should state the changed capability, the affected owner and boundaries, the behavior and evidence, the validation commands run, and any objective blocker. State support or data impact when the change affects them. A code-organization refactor should also state the new responsibility and owner, dependency and public API effects, and why the result can be changed and tested independently. Security issues must not be reported through public issues; use the security reporting path in `SECURITY.md`.
