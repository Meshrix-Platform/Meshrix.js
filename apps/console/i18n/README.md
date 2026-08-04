# Console i18n

This directory holds the console's localization modules. Five mechanisms coexist here; for any
copy added by the console UX closure plan, exactly one of them is allowed: the keyed dictionary
[`console-messages.ts`](console-messages.ts). The binding rule lives in
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md) → Change Rules → Console UX Copy (i18n).

## The convention for plan-added copy

Every user-facing string the plan adds — retry labels, field errors, empty-state CTAs, remediation
copy, journey links, confirmation bodies — is a leaf entry in `consoleMessages`, added under BOTH
locale blocks, `zh-CN` and `en`. Extending the runtime DOM localizer
(`console-dom-localizer.ts`) for new copy is forbidden, as are new Chinese-literal `tt(zh, en)`
pairs, new per-module `t(zh, en)` maps, and new dynamic pattern matchers.

Real example — the existing `nav.dashboard` entry in
[`console-messages.ts`](console-messages.ts):

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

Consumption in a view (both symbols are re-exported from [`console.ts`](console.ts);
`currentConsoleLocale` is defined in [`console-locale-state.ts`](console-locale-state.ts), where
`ConsoleLocale = "en" | "zh-CN"`):

```ts
import { consoleMessages, currentConsoleLocale } from "../i18n/console";

const msg = computed(() => consoleMessages[currentConsoleLocale.value]);
// template: {{ msg.nav.dashboard }}
```

New plan entries follow the same shape inside the Node's assigned top-level group (table below).

## Namespace table (shared-dictionary merge rule)

`console-messages.ts` is one shared file edited by up to 13 copy-bearing plan Nodes in parallel.
Each Node owns exactly one new top-level group and inserts it in alphabetical order among
plan-added groups within each locale block, so parallel appends merge cleanly. This table is
identical to `docs/plans/console-ux-closure/Architecture.md` §5 H3:

| Node | Group | Node | Group |
| --- | --- | --- | --- |
| N5 | `toast` | N13 | `publishList` |
| N6 | `skeleton` | N14 | `publishForm` |
| N7 | `formField` | N15 | `publishDraft` |
| N9 | `overlay` | N16 | `publishOutcome` |
| N10 | `destructive` | N17 | `journey` |
| N11 | `governedConfirm` | N18 | `readiness` |
| N12 | `secretReveal` | | |

## Mechanisms in this directory (legacy for this plan's purposes)

Only mechanism 1 accepts new copy. Converting existing views off the other four is a separate
effort and out of scope for this plan — do not migrate existing strings.

1. `console-messages.ts` — the keyed dictionary, canonical for new copy. Re-exported from
   `console.ts` together with `currentConsoleLocale` and the `ConsoleMessageKey` type.
2. Chinese-literal `tt(zh, en)` helper pairs spread across views and controllers.
3. Inline per-module `t(zh, en)` maps (for example `api-key-distribution.ts`,
   `tag-management.ts`, `organization-governance.ts`).
4. `console-dom-localizer.ts` — the runtime DOM localizer installed by the shell preferences
   composable. Never extended for new copy.
5. `console-dynamic-patterns.ts`, `console-dynamic-count-patterns.ts`,
   `console-dynamic-status-patterns.ts`, `console-text-localizer.ts` — dynamic pattern matchers
   and the segment-substitution fallback, which can emit partially translated output; this is why
   error and recovery copy must be keyed.
