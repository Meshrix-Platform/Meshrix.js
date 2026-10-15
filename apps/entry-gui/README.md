# Meshrix Entry GUI — installed macOS, Windows and Linux entry product

> **Retiring.** This Tauri entry product is scheduled for removal. The current
> lightweight desktop client is the Rust egui application in
> [`apps/entry-native`](../entry-native/). Do not extend this UI or add new
> design assets here; keep only fixes required until removal. Design resources
> are indexed in [`docs/design/README.md`](../../docs/design/README.md).

`@meshrix/entry-gui` is the installable entry product: a **Tauri 2 thin
shell + Node.js sidecar backend + Vue.js renderer** over the
`@meshrix/entry` model layer and `@meshrix/entry-transport` production
bindings. Electron is not used anywhere in this package.

## Process model

- **Tauri shell** (`src-tauri/`) — a minimal Rust binary owning only the
  window and the sidecar lifecycle. It mints a per-launch bearer token,
  spawns the Node backend as a Tauri `externalBin` sidecar
  (`binaries/node-<triple>` + `resources/service/entry-service.mjs`), learns
  the service's ephemeral port from one machine-readable stdout line, and
  kills the sidecar when the app exits. `--mcp-stdio` argv is forwarded
  straight onto the service so the emitted MCP snippet stays real. No
  product logic lives in Rust.
- **Backend service** (`src/main/`) — plain Node, compiled standalone.
  `service-entry.ts` starts `EntryProductService` (custody, pairing,
  recovery, sessions, MCP — everything sensitive) and serves the closed op
  set over `loopback-server.ts`: `http://127.0.0.1:<ephemeral>` HTTP with
  bearer auth (`POST /meshrix-entry` invoke, `POST /meshrix-entry:state`
  long-poll). The token travels only in the `Authorization` header — never
  in a URL, log or the window title.
  Shared Foundation private-file and capacity primitives are consumed only by
  this Node backend; renderer and shared UI sources cannot import Foundation.
- **Renderer** (`src/renderer/`) — the Vue app rendering the redacted
  `GuiState` snapshot (`src/shared/gui-state.ts`). `bridge.ts` resolves the
  loopback coordinates via the `meshrix_bridge_config` Tauri command
  (`window.__TAURI__`, enabled by `app.withGlobalTauri`) and talks through
  `shared/loopback-client.ts`. Every emitted snapshot still passes the
  secret-free scan; `recovery.revealKey` returns the recovery text exactly
  once.

## Flows

- Explicit pairing invite → device fingerprint confirmation → enrolled
  connection with the endpoint's decrypting-party principal + SPKI pin shown.
- One user-held recovery key: generated once, shown once, then only the
  derived signing/writer material stays in custody. Encrypted snapshots
  publish to the endpoint vault automatically. The private configuration journal
  persists an encrypted pending operation before sending it. Vault capacity
  refusals retain the prior successful backup and writer authority; the next
  explicit publication retries the same ciphertext with a fresh signed proof,
  including after restart. A lost response cannot create another revision.
  Configuration changes during a pending operation are published after that
  operation completes. No timed or unlimited background resend loop is used.
- Fresh-install recovery needs only the recovery text plus the endpoint
  service address.
- Staged recovery-key rotation reports per-endpoint pending state; it never
  claims global completion while an endpoint is pending.
- MCP setup produces a standard stdio `mcpServers` snippet — the app binary
  forwards `--mcp-stdio` to the sidecar, which serves the newline-framed MCP
  face on stdin/stdout with no listener at all.
- Revocation deletes only entry-owned custody refs and config; remote
  enforcement is reported as pending until the endpoint confirms.
- Opt-in peer messaging (`"peer": { "enabled": true }` in
  `entry-gui.config.json`) attaches a Signal-encrypted client to each
  admitted private-relay session, using the same session connection as
  other frames. Messages are forwarded only while both devices are online;
  cryptographic outbox/inbox custody and the application journal persist on
  the devices for exact retry and crash recovery. User-visible operation
  state, permissions, and complete results remain end-to-end encrypted;
  transient ACP progress stays local. New work is refused before local
  acceptance when the exact paired device is known offline, while already
  accepted work remains visibly pending and resumes with its original
  message identity. The local API exposes bounded `peer.status`,
  `peer.send`, `peer.inbox` history pages, and `peer.pairSafety` operations.

## Build & packaging

- `npm run typecheck -w @meshrix/entry-gui` — node + vue typecheck.
- `npm run build:renderer -w @meshrix/entry-gui` — vite renderer bundle to
  `dist/renderer/` (the Tauri `frontendDist`).
- `npm run build:service -w @meshrix/entry-gui` — esbuild single-file bundle
  of the backend service (workspace sources resolved via the `source`
  export condition) to `dist/service/entry-service.mjs`.
- `npm run dist -w @meshrix/entry-gui` — `tauri build`: macOS `.app`/`.dmg`,
  Windows NSIS/MSI installers, or the requested Linux bundle formats for the
  native build host. Publishing and auto-update are not configured.
- `npm run dist:linux:container -w @meshrix/entry-gui` — builds one Debian
  package, RPM and AppImage inside an Ubuntu 22.04 Docker builder for the
  selected architecture. It keeps the host's `node_modules` untouched. The
  default is the engine's native architecture; an x86_64 build on ARM is only
  attempted after Docker successfully runs a native x86_64 probe and is
  recorded as emulated.
- When no native Windows build host is available, Tauri's NSIS cross-build can
  be run with
  `npm run dist --workspace @meshrix/entry-gui -- --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis`.
  The build host needs `cargo-xwin`, NSIS and LLVM. MSI creation remains
  Windows-only.
- Packaged service configuration is supplied at build time through
  `MESHRIX_ACCOUNT_ORIGIN` (a bare HTTPS origin) and `MESHRIX_RELAY_SERVICE`
  (`wss://<same-host>/relay`). The release build rejects mismatched hosts and
  does not provide a development or placeholder endpoint.
- `npm run icons -w @meshrix/entry-gui` — regenerate `src-tauri/icons/`
  (deterministic generated artwork).

### Sidecar contents

`src-tauri/binaries/` holds the per-target Node runtime (see
`binaries/README.md`). Packaging fetches the pinned Node.js 24.21.0 binary from
the official Node distribution and verifies both the archive and executable
SHA-256 values. The downloaded runtime is gitignored and included in the
installer, so the installed app does not require system Node.js, npm or Cargo.
`src-tauri/resources/service/entry-service.mjs`, its native Signal prebuild and
the service configuration are staged together by Tauri's `beforeBuildCommand`.
Node SEA was evaluated and rejected; the per-target runtime plus `.mjs` keeps
the service inspectable.

Linux artifacts cover the Debian/Ubuntu family through `.deb`, Fedora-compatible
RPM distributions through `.rpm`, and AppImage where the host provides the
required desktop libraries. The `.deb` and `.rpm` declare `xdg-utils` for
opening the configured account page, plus their WebKitGTK 4.1 and GTK runtime
dependencies. AppImage still relies on the distribution's WebKitGTK 4.1 and
GTK runtime and may require FUSE. Linux packages are built on Ubuntu 22.04 to
keep the glibc baseline compatible with that release and newer systems. The
installed Linux app uses the existing encrypted file-custody tier and reports
that tier in the UI; it does not claim a Secret Service keyring integration.

Direct macOS downloads require Developer ID signing and notarization to avoid
Gatekeeper approval prompts. Ad-hoc signing supports local trials but still
requires the user to allow the app in Privacy & Security. Windows code signing
reduces SmartScreen warnings; Windows 10 and 11 provide the WebView2 runtime.

## Development

- `npm run dev -w @meshrix/entry-gui` — `tauri dev` (vite dev server +
  shell). Without vendored binaries the shell falls back to `node` on
  `PATH` plus the built `dist/service/entry-service.mjs`; set
  `MESHRIX_ENTRY_SERVICE_NODE` / `MESHRIX_ENTRY_SERVICE_ENTRY` to override.
- `npm run dev:service -w @meshrix/entry-gui` — run the backend alone
  (`MESHRIX_ENTRY_SERVICE_TOKEN`, `MESHRIX_ENTRY_DATA_DIR`, … envs); the
  renderer can point at it via `window.__MESHRIX_ENTRY_BRIDGE__` or
  `VITE_ENTRY_SERVICE_URL`/`VITE_ENTRY_SERVICE_TOKEN`.

## Lifecycle boundary

The app owns exactly: its data directory (`entry-gui.config.json`, the
managed MCP snippet, the file-custody store when the file tier is active)
plus `entry-gui.*` / `dev.entry.*` custody entries it minted. Uninstall
removes those and nothing else.
