# Meshrix Entry GUI — installed macOS/Windows entry product

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
  publish to the endpoint vault automatically.
- Fresh-install recovery needs only the recovery text plus the endpoint
  service address.
- Staged recovery-key rotation reports per-endpoint pending state; it never
  claims global completion while an endpoint is pending.
- MCP setup produces a standard stdio `mcpServers` snippet — the app binary
  forwards `--mcp-stdio` to the sidecar, which serves the newline-framed MCP
  face on stdin/stdout with no listener at all.
- Revocation deletes only entry-owned custody refs and config; remote
  enforcement is reported as pending until the endpoint confirms.

## Build & packaging

- `npm run typecheck -w @meshrix/entry-gui` — node + vue typecheck.
- `npm run build:renderer -w @meshrix/entry-gui` — vite renderer bundle to
  `dist/renderer/` (the Tauri `frontendDist`).
- `npm run build:service -w @meshrix/entry-gui` — esbuild single-file bundle
  of the backend service (workspace sources resolved via the `source`
  export condition) to `dist/service/entry-service.mjs`.
- `npm run dist -w @meshrix/entry-gui` — `tauri build`: macOS `.app`/`.dmg`
  and Windows `nsis`/`msi` under `src-tauri/target/release/bundle/`.
  Publishing/updater are never configured — `bundle.active` only.
- `npm run icons -w @meshrix/entry-gui` — regenerate `src-tauri/icons/`
  (deterministic generated artwork).

### Sidecar contents

`src-tauri/binaries/` holds the per-target Node runtime (see
`binaries/README.md`): `node-<triple>` downloads, gitignored, fetched at
packaging time. `src-tauri/resources/service/entry-service.mjs` is staged
automatically from `dist/service/` by `stage:service` (owned by Tauri's
`beforeBuildCommand`, which `pack:dir`/`dist` trigger via `tauri build`).
Node SEA was evaluated
and rejected — per-triple runtime + `.mjs` is lighter and keeps the service
inspectable.

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
