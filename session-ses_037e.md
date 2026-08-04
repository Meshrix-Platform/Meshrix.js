# Meshrix Web Console UX Improvement Plan

**Session ID:** ses_037e7c042ffeErOZjZqTpJMAHd
**Created:** 2026/8/3 22:47:40
**Updated:** 2026/8/4 01:40:43

---

## User

Act as an expert Senior Frontend UX Designer specializing in enterprise-grade SaaS platforms. Your objective is to conduct a comprehensive UX audit and develop a strategic "User Experience Improvement Plan" for the Meshrix Web Console.

**Project Context:**
Meshrix is an enterprise-level AI Agent Service Gateway designed to create an efficient, controllable, and collaborative workspace for AI agents. The core design philosophy is "Seamless Interaction": maximizing workflow efficiency while minimizing user cognitive load, interruptions, and the sense of "friction" or "restriction." The ultimate goal is to provide a "frictionless" (invisible) experience for managing MCP (Model Context Protocol) services.

**Your Task:**
Please deliver a formal "User Experience Improvement Plan" structured into the following three dimensions:

1. **UX Audit & Functional Optimization:**
   - Identify existing design flaws in the current Web Console from the perspectives of functionality, usability, and information architecture.
   - Propose specific improvements for current features to reduce "friction" and "impedance" in user workflows.
   - Suggest new features or functional enhancements that align with the goal of providing a high-speed, intuitive MCP service management experience.

2. **Design System & Scalability:**
   - Propose a framework for a reusable, universal component library tailored to the Meshrix ecosystem.
   - Define how these components will ensure visual consistency and functional scalability across all modules of the control plane.

3. **Strategic Design Philosophy Application:**
   - Detail how your proposed changes specifically address the enterprise requirement of reducing "interference" in professional workflows.
   - Explain how the interface design will transition from a mere "tool" to an "integrated workspace" that feels intuitive and unobtrusive.

**Output Requirements:**
The final report should be professional, actionable, and deeply rooted in UX principles (e.g., Nielsen's Heuristics, Gestalt principles, or cognitive load theory), ensuring the design supports the long-term scalability of the Meshrix platform.

---

## Assistant

I'll start by loading the repository skill and exploring the actual console codebase before proposing anything.

**Tool: skill**

**Tool: bash**

---

## Assistant

I'll explore the console codebase in parallel across several dimensions.

**Tool: task**

**Tool: task**

---

## Assistant

Two more parallel explorations on interaction patterns and product/design context.

**Tool: task**

**Tool: task**

---

## Assistant

The interaction audit task errored. Resuming it.

**Tool: task**

---

## Assistant

I have a detailed evidence base. Before writing the plan, I need to resolve a real contradiction between your brief and the repository's own product mandate.

**The contradiction:** your brief frames the goal as *"frictionless (invisible)"* and *"minimizing... the sense of friction or restriction."* But `PRODUCT.md` and `CONTEXT.md` define Meshrix as a **private-deployable governance platform** whose entire reason to exist is that *"authority is never amplified"* and every protected effect passes one canonical governed path with **approval, grants, and minimum evidence**. `docs/functionality/SECURITY-AUTHORIZATION.md:283-293` mandates a one-time-reveal-only API key UX; `components/common.ts:157` mandates explicit confirmation for destructive actions.

Governance *is* deliberate friction at the authority boundary. A plan that removes it would break the product. Meanwhile the console is full of **incidental** friction that has nothing to do with governance — evidence:

- **0 retry buttons** across ~113 catch blocks (79 with generic `"…失败。"` fallbacks)
- **0 of 35** `ConsoleEmptyState` usages pass a CTA — the slot exists and is never used
- **1 URL-addressable entity link** in the whole console; no tab/filter/pagination is deep-linkable
- **0** `aria-invalid` / `required` / field-level errors in any form; the 656-line publish form collapses 8 validation rules into one string
- **4–6 pages across 3 nav sections** with exactly **1 cross-link** to publish a service and let an agent call it
- an 18-class skeleton system used in **1** place, while authenticated cold-boot renders a blank region

**Tool: question**

---

## Assistant

Confirmed direction. Let me verify the exact shape of the primitives I'll be changing.

**Tool: read**

**Tool: read**

**Tool: read**

**Tool: read**

---

## Assistant

**Tool: read**

---

## Assistant

---

## User

继续

---

## Assistant

**Tool: bash**

**Tool: bash**

---

## Assistant

All facts verified against the code. Writing the plan.

**Tool: write**

---

## Assistant

Plan written to `.kilo/plans/1785768460224-console-ux-improvement-plan.md`.

**What the audit found, and how it reframed the brief**

Your brief's "frictionless / invisible" goal contradicted `PRODUCT.md`, which makes governed execution — approval, grants, one-time reveal, confirmed destructive actions — the product's reason to exist. Governance friction *is* the product. So the plan adopts **"zero incidental friction, deliberate essential friction"**: strip navigation, orientation, data-entry, recovery, and verification friction; keep authority-boundary friction but make it fast and legible.

That reframing matters because the console's real problems are almost entirely incidental:

- **0** retry affordances across ~113 `catch` blocks (79 with generic `"…失败。"` fallbacks)
- **0 of 35** `ConsoleEmptyState` usages pass a CTA — the slot exists at line 25 and is never used
- **1** deep link console-wide; no tab, filter, or pagination is URL-addressable
- **0** `aria-invalid` / `required` / field-level errors in any form
- `busyKey` collapses a `Set` to its last member (`console-busy-controller.ts:24`), so concurrent operations mask each other; `clearAllBusy()` is used **36×** where `clearBusy(key)` belongs
- `ConsoleDrawer` is an untrapped modal with no `role`, no `aria-modal`, and no `inert`, permanently in the tab order for every logged-in user
- **≥6** unguarded destructive paths, including one-click session revoke and one-click disable of a live upstream service — violating the repo's own rule at `common.ts:157`
- The flagship 27-field publish form saves its draft **only** on explicit click, with no `beforeunload` guard

**Notable inversions of expectation**, worth calling out because they change where effort should go:

- Element Plus coupling is already excellent — **11** raw `el-*` tags total. The usual "wrap the framework" work is unnecessary.
- The design system is genuinely well-architected: 125 tokens, systematic 4px grid, 14 presets, a typed 28-entry component registry with per-component `usageRule`. The weakness is **enforcement** (318 hardcoded `px`, 65 non-token hex, 13 references to tokens that don't exist) and **coverage** (26 of 108 components registered).
- An 18-class skeleton system exists with **14 classes dead** and **1** render site, while authenticated cold-boot renders a blank region.

**Shape of the plan:** Phase 0 lands the gates before the cleanup; Phase 1 fixes shared primitives; Phase 2 makes governance friction legible using the approval flow as the reference pattern; Phase 3 fixes the MCP journey (currently 4–6 pages, 3 nav sections, 1 cross-link pointing backwards); Phase 4 consolidates the design system into three ownership tiers.

Two constraints I deliberately designed around rather than through: `ARCHITECTURE.md:244` forbids presenting current surfaces as a unified capability-assembly UI, so the journey is stitched with forward links and a derived readiness strip instead of a new wizard route; and the release gate embeds ten fixed-order Console screenshots, so Phases 2–3 require re-capture.

---

## User

请逐个实现你认为计划中最重要的部分，请开始。

---

## Assistant

I'll start with plan item **1.1** — the busy-controller concurrency bug. It's an actual correctness defect (not polish), it blocks Phase 1, and the plan designates it as land-alone-first. Let me establish exact scope.

**Tool: bash**

**Tool: bash**

---

## Assistant

**Important finding before I touch anything.** The working tree has ~300 uncommitted modified files, including many console files in my plan's scope, and `PublishServiceListPanel.vue` has been *deleted*. Let me understand the wiring before making changes.

**Tool: bash**

**Tool: bash**

---

## Assistant

Now I understand the full pattern. Let me set up tracking and inspect the controller-side `clearAllBusy` misuse.

**Tool: todowrite**

**Tool: bash**

---

## Assistant

**Tool: read**

---

## Assistant

Let me check for existing tests before I change the contract.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

Before writing code I need to flag a sequencing correction, and check two things: the i18n `actions` group and a candidate adoption site.

**Tool: bash**

**Tool: read**

---

## Assistant

This is an ideal adoption site: `catch {}` at line 50 discards the cause, sets a generic message, and line 96 renders it as dead text. Let me check how `ConsoleToastHost` localizes its close button so I follow the same convention.

**Tool: read**

**Tool: bash**

---

## Assistant

Note `ConsoleToastHost` uses raw Chinese literals (the DOM localizer translates them) — I'll stay consistent with that sibling convention rather than introducing a fifth i18n path. Let me verify the real `ConsoleInlineAlert` call sites so I preserve layout parity.

**Tool: bash**

---

## Assistant

**Tool: read**

---

## Assistant

`OrganizationGovernanceView:69-82` has already hand-rolled an alert-with-action wrapper — proof the missing slot forces per-page reimplementation, violating the repo's 通用组件优先 rule. Let me check the action-group contract before writing.

**Tool: read**

**Tool: bash**

---

## Assistant

Now I have everything. `--horizontal-action-control-height` is an overridable custom property, so I can honour the shared-height contract with a compact height. Let me check the phrase table for the dismiss label.

**Tool: bash**

---

## Assistant

Adding `重试` → `Retry` (absent) and a specific dismiss phrase. Starting with the component itself.

**Tool: write**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: edit**

---

## Assistant

Now migrating `OrganizationGovernanceView` off its hand-rolled wrapper onto the new slot — the full-migration step the repo requires.

**Tool: edit**

---

## Assistant

**Tool: edit**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: edit**

---

## Assistant

Now the `StrategyManagementView` adoption: preserve the discarded cause and add retry.

**Tool: edit**

---

## Assistant

**Tool: edit**

---

## Assistant

**Tool: edit**

---

## Assistant

Now update the component registry so the new capability is documented and hand-rolled alternatives are ruled out.

**Tool: bash**

---

## Assistant

**Tool: edit**

---

## Assistant

Let me check the existing common-components test so I extend it rather than duplicate.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

Now adding test coverage for the new slot contract.

**Tool: edit**

---

## Assistant

**Tool: edit**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

11 passed. Now the affected view suites and typecheck.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

Typecheck clean. Since I changed a shared component's DOM structure, let me run the full console suite to catch any test asserting the old markup.

**Tool: bash**

---

## Assistant

All 64 files / 277 tests pass. Let me confirm the removed CSS class has no lingering references and run the redundancy verifier.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

The one failure is pre-existing and in a file I never touched. Let me confirm.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

Item 1.2 is complete and verified. The one gate failure is pre-existing in-flight work, not mine — I'll report it rather than touch unrelated changes.

**Tool: todowrite**

---

## Assistant

Now item **1.4** — empty states that can actually start work. Let me look at the highest-value site, where the next step is currently written as prose.

**Tool: read**

---

## Assistant

Now adding a styled action region to `ConsoleEmptyState` (the bare default slot has no layout for controls).

**Tool: edit**

---

## Assistant

**Tool: edit**

---

## Assistant

Now the two highest-value adoption sites — the journey entry point that currently dead-ends.

**Tool: edit**

---

## Assistant

**Tool: edit**

---

## Assistant

Now the phrase pairs for the new copy — let me check which already exist.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: edit**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: edit**

---

## Assistant

Now tests for the new empty-state action region.

**Tool: edit**

---

## Assistant

**Tool: edit**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

Build and typecheck pass. Let me review my complete diff.

**Tool: bash**

---

## Assistant

`OrganizationGovernanceView.vue` is untracked so it's absent from diffstat, and the two phrase files already had in-flight changes — so git can't isolate my edits. Let me verify each one directly.

**Tool: bash**

---

## Assistant

All edits verified. Let me run the route-registry verifier and the repo hygiene scan.

**Tool: bash**

---

## Assistant

Two items down. Let me complete 1.4 by fixing the remaining "CTA-written-as-prose" sites.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

Converting this one eliminates three violations at once: hand-rolled empty markup, prose CTA, and direct `--el-*` reads with raw px/rem.

**Tool: bash**

---

## Assistant

**Tool: edit**

---

## Assistant

**Tool: edit**

---

## Assistant

**Tool: edit**

---

## Assistant

Now replacing the dead phrase entry with the new copy.

**Tool: edit**

---

## Assistant

Now the `WorkspacesView` prose CTA. Let me find the real create action.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: edit**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: edit**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: todowrite**

---

## Assistant

I implemented two complete plan items. First, a sequencing correction you should know about.

**I reordered against my own plan, deliberately.** The plan said land **1.1** (busy-controller) first and "land it alone." When I checked the tree, there were ~300 uncommitted modified files — including `useConsole.ts`, `useServerConsoleShell.ts`, and `PublishServiceForm.vue` — plus a deleted `PublishServiceListPanel.vue`. 1.1 touches ~70 files (40 template comparisons, 36 `clearAllBusy()` calls, 11 test files) and the repo forbids compat shims, so it must be one complete migration. Landing that inside an already-300-file diff would make it unreviewable and its precondition unsatisfiable. So I did the **additive** primitives instead, which interleave safely.

---

### Item 1.2 — Errors became recoverable

`ConsoleInlineAlert` was 43 lines with one text slot. Evidence it was insufficient: `OrganizationGovernanceView:69-82` had already **hand-rolled** an alert-with-button wrapper plus its own CSS, violating the repo's 通用组件优先 rule.

- Added `#action` slot, `title`, `dismissible`, `dismissLabel`. Kept `white-space: pre-line` on a dedicated body element so all 20 existing call sites render identically.
- Action region reuses the documented `.horizontal-action-group` contract (`CONTRIBUTING.md:30`), overriding `--horizontal-action-control-height` to 32px — the custom property exists for exactly this, so it's not a page-specific height exception.
- **Migrated** `OrganizationGovernanceView` onto the slot and **deleted** the hand-rolled selector and its 640px override.
- `StrategyManagementView:50` was `catch {}` — discarding the cause and showing a dead generic string. Now preserves the real message and offers a retry button.

### Item 1.4 — Empty states can now start work

The `#action` region was added with real layout (the pre-existing bare `<slot />` had none, which is why 0 of 35 sites used it).

Four dead ends converted:
- `UpstreamGatewayView` "暂无上游服务" → **"发布服务"** link. This was the journey's entry point with no way forward.
- `UpstreamGatewayView` "暂无操作" → **"添加工具路径"** deep link carrying `serviceId`.
- `ContextPresetListCard` — hand-rolled `.empty-profile-state` div → component with a real `emit('add')` button. This removed 3 direct `--el-*` reads and raw `3rem/1.5rem/8px/0.875rem`, so it also paid down plan 4.3.
- `WorkspacesView` — prose `点击"新建工作空间"` → real button wired to `panel = 'create'`.

Both new CTAs are scope-guarded with `canAccessAdminView('upstreamServicePublish')`, matching the existing guard at line 70 — an empty state must not advertise an action the user cannot perform.

I also added the missing i18n pairs (`重试`/`Retry` did not exist at all; neither did `暂无工作空间`, so English previously fell through to segment-substitution) and replaced one entry my change made dead. Registry `usageRule`s updated so the new slots are the documented path.

**Verification:** `typecheck:web` clean · `console:verify` build+typecheck clean · **64 files / 280 tests pass** (274 baseline + 6 new) · route registry verified (22 routes) · `repo:local-info-hygiene` clean · no dangling selectors.

---

**Two things need your decision:**

1. `npm run verify:console-redundancy` fails with one `dot_join` finding at `PublishServiceForm.vue:145` (`.join(" · ")`). I confirmed it is **not mine** — `git show HEAD:` proves it does not exist in the committed version, so it came from the in-flight work. I left it alone per the repo's "无关改动保持原样" rule.

2. **1.1 remains the most important open item** — `busyKey` at `console-busy-controller.ts:24` collapses a `Set` to its last member, and `clearAllBusy()` is called 36× where `clearBusy(key)` belongs, which can prematurely re-enable a button while its governed operation is still in flight. That is double-submit risk on approval and publish paths, not cosmetics. I'd like to do it against a clean tree — tell me when the current work is committed, or say the word and I'll do it now accepting the larger diff.

---

## User

1. 你可以修改任意该项目的代码或文档。
2. 你可以无视当前的任意改动，你应该书写正确的逻辑，而不是沿着错误的道路行走。

---

## Assistant

Understood — I'll do 1.1 properly and completely. Let me first map every usage precisely.

**Tool: bash**

---

## Assistant

Complete picture. Note there are three *legitimate* "is anything busy" consumers, so the new API must express that explicitly rather than via a magic string. Let me read the core wiring files.

**Tool: read**

**Tool: read**

---

## Assistant

**Tool: read**

**Tool: read**

---

## Assistant

**Tool: bash**

---

## Assistant

Now I have full clarity. Note `"manual-refresh"` exists **only in a test** — so `busyKey.value || "refresh"` is nondeterministic dead flexibility in production. Writing the new controller.

**Tool: write**

---

## Assistant

Now `useConsole.ts` — the wiring hub. Let me see its busy surface.

**Tool: bash**

---

## Assistant

Now the systematic migration. Let me get a precise view of every controller's `setBusy`/`clearAllBusy` pairing.

**Tool: bash**

---

## Assistant

The pattern is perfectly regular. Let me migrate the controllers with a precise script, handling the two special cases by hand.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: write**

---

## Assistant

**Tool: bash**

---

## Assistant

35 sites rewritten, none remaining. Let me spot-check the trickiest cases.

**Tool: bash**

---

## Assistant

Now the two special cases by hand. First the refresh-state controller, replacing the nondeterministic key with a real constant.

**Tool: edit**

---

## Assistant

**Tool: edit**

---

## Assistant

**Tool: edit**

---

## Assistant

Now `useConsole.ts` — the interface and wiring hub.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

The workspace sub-controllers take a **no-arg** `clearBusy()`. Let me find all of them.

**Tool: bash**

---

## Assistant

Same regular pattern in the workspace tree. Migrating those with the same approach.

**Tool: write**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

Now `useWorkspacesConsole` — replacing its single-slot busy shim with the real controller.

**Tool: bash**

---

## Assistant

Now rewriting the workspaces busy layer.

**Tool: edit**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: edit**

---

## Assistant

**Tool: edit**

---

## Assistant

Now the shell contexts, view controllers, and the page-refresh controller.

**Tool: bash**

---

## Assistant

**Tool: read**

---

## Assistant

**Tool: edit**

---

## Assistant

Now the page-refresh controller — this is one of the legitimate "is anything busy" consumers.

**Tool: bash**

---

## Assistant

Now `useServerConsoleShell.ts`, which wires the shell to workspaces.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

Let me typecheck now to surface the remaining work precisely.

**Tool: bash**

---

## Assistant

One error — my replacement injected `isAnyBusy` into the refresh-state options where I removed that dependency.

**Tool: read**

---

## Assistant

**Tool: edit**

---

## Assistant

**Tool: bash**

---

## Assistant

Typecheck passes — but that's **false confidence**: the contexts are typed `any`, so templates referencing a now-removed `busyKey` would silently be `undefined` at runtime. This is exactly Risk 6 from the plan. Let me find every template site.

**Tool: bash**

---

## Assistant

Now the templates. Let me check the prop-based components' consumers first.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

Now the bulk template migration.

**Tool: write**

---

## Assistant

**Tool: bash**

---

## Assistant

26 files clean. Let me fix the 4 remaining, which have non-literal comparisons or prop passing.

**Tool: bash**

---

## Assistant

**Tool: edit**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: edit**

---

## Assistant

Now the two prop-based children and their parents.

**Tool: bash**

---

## Assistant

These are props — a boolean per action is the honest contract for a leaf component, rather than threading a function.

**Tool: edit**

---

## Assistant

**Tool: bash**

---

## Assistant

Now the dead `busyKey` prop on `UploadFileListCard` (never passed by any consumer).

**Tool: bash**

---

## Assistant

Entire console is clean. Now typecheck and then the tests.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

My script left empty destructure slots where it removed a binding. Fixing all three.

**Tool: bash**

---

## Assistant

Let me sweep for any other script artifacts, then run the tests.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

17 failures, all in the busy mocks. Let me fix them — starting with the straight renames.

**Tool: bash**

---

## Assistant

**Tool: read**

---

## Assistant

**Tool: read**

---

## Assistant

Now correcting the refresh-state test to pin the new deterministic contract.

**Tool: bash**

---

## Assistant

Now the four remaining test files that mock `busyKey` as a ref.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

Using the real controller in tests so they exercise the actual primitive rather than a fake.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

Need to reset it between tests to avoid state leaking. Let me fix placement.

**Tool: bash**

---

## Assistant

**Tool: edit**

---

## Assistant

**Tool: edit**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: edit**

---

## Assistant

**Tool: bash**

---

## Assistant

All 280 pass. Now a dedicated test for the new primitive — this is the core fix and needs its guarantees pinned.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

Globbed automatically — no registry entry needed. Writing the primitive's test.

**Tool: write**

---

## Assistant

**Tool: bash**

---

## Assistant

Now the `aria-busy` part of 1.1. I'll only rewrite the safe, single-attribute-per-line pattern to avoid breaking varied template formatting.

**Tool: write**

---

## Assistant

**Tool: bash**

---

## Assistant

Now updating the registry for the `UploadFileListCard` prop change, then full verification.

**Tool: bash**

---

## Assistant

**Tool: edit**

---

## Assistant

**Tool: bash**

---

## Assistant

`grep -c` returned 1 — there **is** a typecheck error. Let me see it.

**Tool: bash**

---

## Assistant

**Tool: read**

---

## Assistant

My script duplicated a pre-existing `aria-busy` — I commented the guard but never implemented it. Fixing and checking for others.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

Let me verify the workspaces context actually exposes the new readers, since those components consume it via provide/inject.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

Plumbing is complete. Now the full repo gate and the console verifiers.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

This one **is** mine — the coverage verifier requires a `loading` token in `UpstreamGatewayView.vue`. Let me check.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

The in-flight work stripped the `loading` binding and refresh button from this view, breaking the gate — and leaving the view with **no loading feedback at all**. That's exactly the defect class my plan targets. Let me check what the controller offers.

**Tool: bash**

---

## Assistant

The controller still exposes `loading` and `refreshGateway` — the view just stopped consuming them. Reconnecting them fixes the gate *and* the missing loading feedback. Let me check the toolbar styling first.

**Tool: bash**

---

## Assistant

Flex toolbar — safe. Reconnecting loading and refresh, with retry on the error alert.

**Tool: edit**

---

## Assistant

**Tool: edit**

---

## Assistant

Now guard the empty states so they don't flash a false "no services" during load.

**Tool: bash**

---

## Assistant

`gateway: state:loading` is fixed. The remaining failure is the deleted server executor. Let me check whether its successor is unambiguous.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

5 test files still carry dead `busyKey` mocks. They pass, but leaving them is a misleading legacy remnant the repo forbids. Let me inspect and clean them.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

Fully clean. Final verification run.

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: todowrite**

---

## Assistant

Plan item **1.1** is now complete — the full migration, no compat shim, as the repo requires.

### The bug that was fixed

`busyKey` was `[...busyKeys].at(-1)` — a `Set` collapsed to its **last inserted member**. Combined with `clearAllBusy()` being called 35× where a scoped clear belonged, two concrete failures existed:

1. **Cross-operation masking** — two concurrent operations shared one identity, so only the most recent one showed progress.
2. **Premature re-enable** — one finishing request wiped every peer's busy state, re-enabling a button whose own request was still in flight. On `grant:*`, `auth:session:*`, and `maintenance-agent:approve:*` that is a **double-submit hazard on governed operations**, not cosmetics.

A second, worse implementation also existed: `useWorkspacesConsole` had its own `setBusy(k)` / `clearBusy()` writing a **single string slot**, so only one workspace operation could ever be tracked. That is why 13 workspace buttons used `:disabled="!!busyKey"` — they literally could not do better, and consequently any *unrelated* console operation disabled every workspace button.

### The new contract

`createConsoleBusyController` now exposes `isBusy(key)`, `isBusyPrefix(prefix)`, `isAnyBusy`, `setBusy`, `clearBusy(key)`, and `withBusy(key, fn)`. `busyKey` and `clearAllBusy` are **gone**, deliberately — I documented why in the source: both collapse independent operations into shared state. `mergeConsoleBusyReaders` lets workspaces reflect shell work without inheriting its identity.

Three consumers genuinely needed "is anything running" (page-refresh button, workspace session list, drawer). Those now say `isAnyBusy` or scoped `isBusyPrefix('ws:')` explicitly instead of inferring it from a magic string.

**Scope:** 1 primitive rewritten · 16 controllers (52 clear sites) · 30 view/component files · 9 test files · 3 prop-based components converted to explicit booleans · `aria-busy` added to 27 controls (there were 2).

### Two judgement calls worth flagging

**Typecheck was actively misleading.** It reported 0 errors while ~30 templates still referenced a deleted `busyKey`, because every context is typed `any`. Had I trusted it, I would have shipped silently-`undefined` bindings across the console. I migrated by exhaustive sweep instead and verified `rg` returns nothing.

**I found and fixed a regression in the in-flight work.** `UpstreamGatewayView` had lost its `loading` binding and refresh button entirely — the controller still exported both, the view just stopped consuming them. That broke the `verify:console-administration-coverage` gate (`gateway: state:loading`) *and* left the view with no loading feedback and no refresh. I reconnected both, added retry via the new `#action` slot, and guarded the empty states with `&& !loading` so they no longer flash a false "no upstream services" during first load. That gate check now passes.

### Verification

`typecheck:web` clean · **65 files / 288 tests pass** · `console:verify` build+typecheck clean · route registry (22 routes) · `local-info-hygiene` clean · `verify:console-administration-coverage` gateway check restored.

New `console-busy-controller.test.ts` (8 tests) pins the guarantees that matter: concurrent keys stay independent, `clearBusy` never clears a peer, `withBusy` releases on both resolve and reject.

### Still broken, and not mine

One coverage failure remains: `operation-permission-mcp: executor:operation-permission-authorization`. The in-flight work **deleted** `operation-permission-authorization-executor.ts` (it exists in `HEAD`) while the workflow requirement still demands it. The new `mcp-api-key-authentication.ts` and `api-key-issuer-authority.ts` suggest authorization moved to API-key-only, but whether the requirement should drop that executor or point at a successor is your architecture decision mid-refactor — I won't guess at it. Same for the `dot_join` finding at `PublishServiceForm.vue:145`, which also does not exist in `HEAD`.

---

