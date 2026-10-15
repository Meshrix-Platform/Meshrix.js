# Canonical shared design assets

`assets/` is the single store for shared art in this repository. Every file
here is a master: consumers reference it directly (markup, embed, or
build-time read) or hold a byte-identical projection written by
`node tools/generators/sync-design-assets.ts`. Editing a projected copy by
hand is drift and fails `npm run verify:design-assets`.

| Directory | Holds |
| --- | --- |
| `brand/` | Identity masters — `logo.svg`, `banner.svg` |
| `diagrams/` | Shared visual-documentation figures |

Known consumers are listed in
[docs/design/README.md](../docs/design/README.md); add new asset categories
as new subdirectories and index them in the same change. Rasterized or
composed derivatives (for example the entry-native icon tile) are produced
by the owning build from these masters and are not committed here.
