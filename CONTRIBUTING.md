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

Local verification is the engineering acceptance environment. Hosted CI verifies
the submitted candidate and operates authorized release integrations. Ordinary
build, test, dependency, and package failures must be found and repaired locally
before submission.

- Maintain one executable definition for each engineering check. Local commands
  and GitHub jobs must call the same entry points with the same test selection,
  build prerequisites, dependency policy, and declared Node.js versions. Workflow
  YAML is executed locally by `act`; do not copy its commands into a second local
  checklist or bypass a failing workflow step. Artifact upload is a hosted-only
  transfer; the local runner retains the corresponding diagnostics locally.
- Qualify installation, packaging, build, and CI changes in a clean Linux checkout
  with freshly installed locked dependencies and an empty npm cache. Exercise the
  supported Node.js lines selected by CI. Existing build output, workspace links,
  user npm configuration, credentials, and a warm cache must not satisfy a clean
  installation check. Incremental checks remain useful during development but do
  not establish this clean-environment result.
- Complete one failure-discovery pass over the applicable scope. Retain every
  failure, group repairs by cause, run focused checks while repairing, and execute
  the complete selected scope after the fixes are integrated. Do not push each
  individual fix merely to find the next failure in hosted CI.
- Keep full sanitized command logs and structured regression results for both
  local and hosted execution, including failed stages. Preserve the actual exit
  status. Record candidate, environment, command, result, and any unexecuted scope;
  do not substitute a log tail or an earlier candidate's result.
- Reuse valid evidence when the exercised implementation, configuration, and
  artifact are unchanged. A changed workflow needs its affected checks refreshed;
  it does not invalidate unrelated runtime evidence. Keep test selection explicit
  so ordinary engineering CI cannot start the separately authorized performance
  workflow before functional acceptance.
- Verify real hosted identity, package publication, provenance, and external
  deployment permissions in their release stage. Local engineering checks must
  precede those operations; local simulations cannot prove those external facts.

When local and hosted behavior differs, identify the missing environment input or
check, fix the shared workflow, reproduce the failure locally, and verify the
repair there before the next submission. Maintain this process with the product;
do not leave a one-off troubleshooting script as its implementation.

Install Docker and [act](https://nektosact.com/installation/index.html), commit the
candidate locally, then run:

```bash
npm run ci:local -- --list
npm run ci:local
```

The runner checks the committed candidate in a disposable source checkout. It
executes the actual GitHub jobs for branch policy, regression, Node 22, Gateway,
distribution, package portability, and controlled sandbox in fresh Ubuntu 24.04
containers with the hosted runner's amd64 architecture (emulated on other host
architectures). Each job installs its
own dependencies without the user's npm configuration or a restored npm cache.
No publishing workflow or repository credential is supplied. To diagnose a
specific check, select its name, for example `npm run ci:local -- gateway`.
The branch check uses the actual source branch and origin repository. Its default
target is `nightly`; use `--base stable` or `--base release` for a promotion PR.
The complete failure inventory and sanitized logs are in `build/local-ci/`.
An untracked file is not part of the candidate; stage and commit intended source
before verification. Private untracked evidence remains outside the snapshot.

Stable audit, functional, security, and deployment engineering checks retain
their existing local commands and execution order. Run them locally before
promoting the candidate that hosted release jobs will consume. `act` does not
prove hosted identity, registry writes, or production deployment permissions.

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
