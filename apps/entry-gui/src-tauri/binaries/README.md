# Vendored Node runtime for the sidecar

The installed product is self-contained: the Tauri shell spawns a **bundled
Node.js runtime** (`bundle.externalBin` → `binaries/node`) which executes the
compiled service bundle `resources/service/entry-service.mjs` (shipped via
`bundle.resources`). No system Node.js is required.

## Populating this directory

Tauri's externalBin convention resolves the file as
`binaries/node-<target-triple>[.exe]`; at install time it is renamed to
`node`/`node.exe` next to the app executable. Place one upstream Node binary
per target triple here:

| Target triple            | File                       |
| ------------------------ | -------------------------- |
| `aarch64-apple-darwin`   | `node-aarch64-apple-darwin` |
| `x86_64-apple-darwin`    | `node-x86_64-apple-darwin`  |
| `x86_64-pc-windows-msvc` | `node-x86_64-pc-windows-msvc.exe` |

Use the single-file distribution of a supported Node release (the repo's
`engines` floor: Node >= 22.18 / >= 24.3 — upstream `node` binaries are
single executables on all desktop targets). Download them from
`https://nodejs.org/dist/` and verify the published SHA-256 checksums.
The binaries are gitignored (`src-tauri/binaries/node*`): they are build
inputs fetched at packaging time, not repository content.

## Alternatives evaluated

- **Node SEA (single executable application)**: would fold the service into
  one binary, but it requires per-platform postject injection, produces a
  ~100 MB artifact, and still needs a runtime download per target. Rejected:
  the externalBin node + service `.mjs` split is lighter and keeps the
  service inspectable/patchable inside the bundle.
- **System Node**: rejected — an installed product must not depend on a
  runtime the user may not have.

In development (`npm run dev` / `tauri dev` without binaries vendored) the
shell falls back to `node` on `PATH` plus `../dist/service/entry-service.mjs`;
`MESHRIX_ENTRY_SERVICE_NODE` / `MESHRIX_ENTRY_SERVICE_ENTRY` override both
sides explicitly.
