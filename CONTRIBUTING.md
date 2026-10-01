# Contributing To Meshrix.js

Meshrix.js is an open, private-deployable gateway platform for agent access, upstream service forwarding, governed operations, and auditable collaboration.

Contributions must keep the repository serious, calm, pragmatic, and accurate. Changes should improve current runtime behavior, documentation accuracy, tests, or deployability. Do not add private product capabilities, secrets, local machine details, or speculative product claims. Document current gaps as remaining required work the project keeps closing, not as permanent non-goals.

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Development Setup

Requirements are declared in `package.json`. Use the current Node.js range from `engines.node`.

```bash
npm install
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
5. Integrate once through the integration owner, and maintain version,
   deprecation, and release facts in the canonical release source.

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

For documentation-only changes, validate the changed facts, referenced paths, and commands with the owning documentation checks instead of the Core test profile:

```bash
npm run verify:docs
git diff --check
```

Skill changes use `npm run verify:skills`; operator helper changes use `npm run verify:skill-tools`. Do not run the full regression merely to select checks for a documentation edit.

## Pull Requests

One pull request maps to one independently deliverable task with one integration owner; keep unrelated work out. A pull request should state the changed capability, the affected owner and boundaries, the behavior and evidence, the validation commands run, and any objective blocker. State support or data impact when the change affects them. A code-organization refactor should also state the new responsibility and owner, dependency and public API effects, and why the result can be changed and tested independently. Security issues must not be reported through public issues; use the security reporting path in `SECURITY.md`.
