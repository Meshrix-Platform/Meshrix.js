# Canonical shared design assets

`assets/` is the single store for shared art and retained design references
in this repository. Canonical masters are referenced directly (markup, embed,
or build-time read) or held as byte-identical projections written by
`node tools/generators/sync-design-assets.ts`. Editing a projected copy by
hand is drift and fails `npm run verify:design-assets`.

| Directory | Holds |
| --- | --- |
| `brand/` | Identity masters — `logo.svg`, `banner.svg` |
| `diagrams/` | Shared visual-documentation figures |

Known consumers are listed in
[docs/design/README.md](../docs/design/README.md); add new asset categories
as new subdirectories and index them in the same change. Rasterized or
composed derivatives used by the current product are produced by their owning
builds and are not committed here.
