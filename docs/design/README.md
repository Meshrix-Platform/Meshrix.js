# Meshrix.js Design And Art Asset Index

This is the unified index of every frontend design surface and art asset in
the repository. Any agent must be able to reach a listed resource within
three index hops: this page is linked from the
[documentation index](../README.md), the
[developer guide](../development/README.md), the
[frontend visual direction skill](../../skills/meshrix-js-frontend-visual-direction/SKILL.md),
and [AGENTS.md](../../AGENTS.md).

## Canonical rules

- **Shared art lives in `assets/` and nowhere else.** A consumer references a
  canonical file directly (build-time read, embed, or markup reference) or
  holds a byte-identical projection written by
  `node tools/generators/sync-design-assets.ts`. Hand-edited duplicates of a
  canonical asset are drift and fail `verify:design-assets`.
- **Derived raster art is generated at build time.** Do not commit a second
  source of an image a build step can produce (the entry-native icon tile is
  rasterized from `assets/brand/logo.svg` by `build.rs`).
- **Demo workspaces are local only.** Keep demo scenes, mockups, and scratch
  assets under `demo/`; that directory is git-ignored and must never be
  committed or shipped. Documentation walkthroughs under `docs/examples/` are
  documentation, not demo workspaces.
- **`apps/entry-gui` (Tauri) is retiring.** The lightweight Rust egui client
  in `apps/entry-native` is the current desktop entry product. Do not extend
  the Tauri UI or add new design assets under `apps/entry-gui`.
- **Cloudflare-hosted commercial operations live elsewhere.** The hosted
  account, private relay, and public gateway deployment has moved to a
  separate private operations repository; this repository carries only the
  public upstream product. Its design surfaces are indexed there, not here.

## Design authority documents

| Document | Owns |
| --- | --- |
| [Frontend visual direction skill](../../skills/meshrix-js-frontend-visual-direction/SKILL.md) | Visual-direction convergence and the approved product system |
| [HTML report contract skill](../../skills/meshrix-js-html-report-contract/SKILL.md) | Visual contract of generated HTML reports |
| [CONTRIBUTING.md — Change Rules](../../CONTRIBUTING.md#change-rules) | Shared-height and layout invariants for console controls |
| [Console i18n README](../../apps/console/i18n/README.md) | The keyed-dictionary rule for user-facing copy |

## Canonical shared assets (`assets/`)

| Asset | Consumers |
| --- | --- |
| `assets/brand/logo.svg` — master mark | `README.md`, `README.zh-CN.md`; projected to `apps/console/favicon.svg` by the sync generator; rasterized by `apps/entry-native/crates/entry-gui/build.rs` into the native icon tile |
| `assets/brand/banner.svg` — product banner | Documentation and product-page visuals |
| `assets/diagrams/architecture-overview.svg` | [Developer guide](../development/README.md) |

Runtime variants that render the mark in code are registered here rather than
copied: `apps/console/components/MeshrixJsMark.vue` (theme-aware inline SVG).

## Per-surface design resources

### Web Console — `apps/console/`

| Resource | Location |
| --- | --- |
| Design tokens (Meshrix Crystal) | `styles/tokens.css` |
| Full stylesheet tree | `styles/` (`index.css`, `reset.css`, `layout/`, `components/`, `features/`, `views/`, `themes/`, `element-plus-overrides.css`) |
| Appearance presets (14 themes) | `appearance-presets/*.json` + `lib/appearance-preset-config.ts` + the inline preset bootstrap in `index.html` |
| Favicon (synced projection) | `favicon.svg` — do not edit directly |
| Vendored Octicon glyphs | `public/icons/` |
| Shared console components | `../../packages/ui-console/src/` (`StatusPill`, `OptionBar`, `BinaryCheckbox`) and `components/` |
| Copy and localization rules | `i18n/README.md`, `i18n/console-messages.ts` |

### Lightweight desktop client — `apps/entry-native` (egui, current)

| Resource | Location |
| --- | --- |
| macOS-oriented token system | `crates/entry-gui/src/theme.rs` |
| Bundled Inter / Inter Display fonts (OFL) | `crates/entry-gui/assets/fonts/` |
| Icon tile source | `build.rs` rasterizes `assets/brand/logo.svg`; `crates/entry-gui/assets/logo.png` is only the standalone-build fallback |

### Installed entry GUI — `apps/entry-gui` (Tauri, retiring)

| Resource | Location |
| --- | --- |
| Application icon set | `src-tauri/icons/` |
| Renderer styles | `<style>` blocks inside `src/renderer/**/*.vue` |

Removal is pending; index retained so agents can find what remains.

### Generated HTML surfaces (owned by the HTML report contract skill)

| Resource | Location |
| --- | --- |
| Service publishing report renderer | `tools/server-scripts/lib/upstream-service-publishing-html.ts` |
| Regression report generator | `tests/lib/regression-html-report.ts` → `docs/verification/regression.html` |
| Deployment and closure report emitters | `tools/server-scripts/offline-delivery-vm-target.ts`, `plugin-console-isolation-closure.ts`, `npm-package-consumer.ts`, `lib/native-orb-deployment/support.ts` |
| Plugin console sandbox document | `packages/server-runtime/src/composition/plugin-console-sandbox-document.ts` |
| Generated architecture diagrams | `docs/architecture/MESHRIX-SYSTEM-ARCHITECTURE.html`, `docs/architecture/MESHRIX-SERVICE-CAPABILITY-ARCHITECTURE.html` (projections of `packages/contracts/src/modules/manifest.ts`) |

## Not design assets

These paths look like art assets but are owned elsewhere; do not index or
restyle them here:

| Path | What it actually is |
| --- | --- |
| `packages/agents/src/workspace-asset-registry/`, `docs/functionality/WORKSPACE-ASSETS.md` | A product feature: governed workspace files |
| `content/` | Packaged non-code content root for shipped artifacts |
| `output/`, `test-results/`, `.playwright-cli/` | Git-ignored verification evidence (screenshots, traces) |
| `*/.impeccable/` | Local design-review tool state; never committed |

## Adding or changing design assets

1. Place shared masters under `assets/` (new category = new subdirectory).
2. Reference the canonical file from the consumer; if the consumer needs a
   physical copy, add a projection pair to `DESIGN_ASSET_PROJECTIONS` in
   `tools/generators/sync-design-assets.ts`.
3. Update the matching table on this page in the same change.
4. Verify:

```bash
npm run verify:design-assets
npm run verify:docs
git diff --check
```
