# Vendored Node runtime for the sidecar

The installed product is self-contained: the Tauri shell spawns a **bundled
Node.js runtime** (`bundle.externalBin` → `binaries/node`) which executes the
compiled service bundle `resources/service/entry-service.mjs` (shipped via
`bundle.resources`). No system Node.js is required.

## Packaging

Tauri's externalBin convention resolves the file as
`binaries/node-<target-triple>[.exe]`; at install time it is renamed to
`node`/`node.exe` next to the app executable. `tools/stage-service.mjs` fetches
the pinned runtime and stages it before Tauri bundling. `tools/node-runtime.mjs`
owns the upstream version and SHA-256 pins; do not substitute the build host's
Node executable.

| Target triple            | File                       |
| ------------------------ | -------------------------- |
| `aarch64-apple-darwin`   | `node-aarch64-apple-darwin` |
| `x86_64-apple-darwin`    | `node-x86_64-apple-darwin`  |
| `aarch64-pc-windows-msvc` | `node-aarch64-pc-windows-msvc.exe` |
| `x86_64-pc-windows-msvc` | `node-x86_64-pc-windows-msvc.exe` |
| `aarch64-unknown-linux-gnu` | `node-aarch64-unknown-linux-gnu` |
| `x86_64-unknown-linux-gnu` | `node-x86_64-unknown-linux-gnu` |

Node.js 24.21.0 is the pinned LTS runtime for the installed app. The staging
tool downloads the target asset from `https://nodejs.org/dist/`, verifies the
pinned archive checksum, extracts only the Node executable when needed, and
checks the executable hash before Tauri bundles it. The binaries are gitignored
build inputs; installed users do not need a system Node.js installation.

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
