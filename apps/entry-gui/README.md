# Meshrix Entry GUI — installed macOS/Windows entry product

`@meshrix/entry-gui` is the Electron + Vue application that turns the
`@meshrix/entry` model layer and `@meshrix/entry-transport` production
bindings into the installable entry product.

## Process model

- **Main process** (`src/main/`) owns everything sensitive: the custody
  adapter, device private keys, relay bearer credentials, recovery material,
  TLS material, live relay sessions, the recovery channel and the owned
  config file. `product-service.ts` is the audited composition root; the
  renderer never receives a secret as state.
- **Preload** (`src/preload/index.cjs`) exposes one narrow bridge —
  `window.meshrixEntry.invoke(op, args)` / `onState(cb)` — over an
  allowlisted operation set (`src/shared/ipc-contract.ts`). No arbitrary
  Electron or Node surface reaches the sandboxed renderer.
- **Renderer** (`src/renderer/`) is a Vue app rendering the redacted
  `GuiState` snapshot (`src/shared/gui-state.ts`). Every emission passes the
  secret-free scan; recovery text is revealed exactly once through
  `recovery.revealKey` and never persists in state.

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
- MCP setup produces a standard stdio `mcpServers` snippet — no listener,
  port or token.
- Revocation deletes only entry-owned custody refs and config; remote
  enforcement is reported as pending until the endpoint confirms.

## Build & packaging

- `npm run typecheck -w @meshrix/entry-gui` — node + vue typecheck.
- `npm run build:renderer -w @meshrix/entry-gui` — vite renderer bundle to
  `dist/renderer/`. The main process compiles through the repository-wide
  `npm run build:node` into `dist/`; `build:node` cleans `dist/` first, so
  run the renderer build after it (the `pack:dir`/`dist` scripts already
  chain it).
- `npm run dist -w @meshrix/entry-gui` — electron-builder macOS (dmg, zip)
  and Windows (nsis, zip) artifacts under `release/`. Publishing is never
  configured (`--publish never`, no provider).

## Lifecycle boundary

The app owns exactly: its data directory (`entry-gui.config.json`, the
managed MCP snippet, the file-custody store when the file tier is active)
plus `entry-gui.*` / `dev.entry.*` custody entries it minted. Uninstall
removes those and nothing else.
