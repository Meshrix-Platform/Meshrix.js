# Meshrix Entry — native client

Rust-native replacement for the Tauri 2 + Node.js sidecar + Vue entry client.
One workspace, three crates, zero runtime dependencies — each binary is a
single static native executable.

| Crate | Binary | Purpose |
|---|---|---|
| `meshrix-entry-core` | (lib) | Identity, custody, recovery, pairing, relay sessions, account client, MCP bridge |
| `meshrix-entry-cli` | `meshrix-entry` | clap CLI + ratatui TUI dashboard |
| `meshrix-entry-gui` | `meshrix-entry-gui` | egui desktop shell (account, pairing, connections, recovery, events) |

## Build

```sh
cargo build --release --bins
# → target/release/meshrix-entry       (CLI + TUI)
# → target/release/meshrix-entry-gui   (desktop window)
```

Cross-compiles: keep all deps pure-Rust (rustls, ring). Use `cargo-zigbuild`
or `cargo-xwin` for Linux/Windows targets from this host; macOS signing and
notarization still require a macOS host.

## Environment

| Variable | CLI flag | Meaning |
|---|---|---|
| `MESHRIX_ENTRY_DATA_DIR` | `--data-dir` | Config + file-custody directory (default: platform config dir) |
| `MESHRIX_ACCOUNT_ORIGIN` | `--account-origin` | Bare HTTPS origin of the account service |
| `MESHRIX_CUSTODY` | `--custody` | `auto` (default), `os`, or `file` |
| `MESHRIX_CUSTODY_SECRET` | `--custody-secret` | 64-hex wrap secret, required for `file` custody |
| `MESHRIX_INSECURE_LOOPBACK` | `--allow-insecure-loopback` | Literal `ws://` loopback relays (fixtures only) |

Custody: `auto` selects macOS Keychain on macOS, DPAPI on Windows, and
requires `file` (with a wrap secret) elsewhere. Secrets never leave the
selected adapter.

## CLI

```sh
meshrix-entry status                      # redacted service state (JSON)
meshrix-entry login                       # browser sign-in, polls to completion
meshrix-entry pair '<invite text>'        # challenge → browser step-up → enrolled
meshrix-entry connections                 # list enrolled endpoints
meshrix-entry connect <connection-id>     # open session, stream events
meshrix-entry request <id> '<json-rpc>'   # one-shot request
meshrix-entry query-op <id> <op-id>       # endpoint operation ledger
meshrix-entry disconnect <id>
meshrix-entry recover <id> '<recovery text>'
meshrix-entry mcp-stdio <id>              # newline-framed JSON-RPC over stdio
meshrix-entry tui                         # live ratatui dashboard
```

`login`/`pair` print a browser URL and poll the account transaction to
completion (≈5 min budget). `pair --no-wait` prints the step-up URL and the
PKCE verifier for a later manual finish.

## GUI

`meshrix-entry-gui` opens a single window:

- **Account** card — sign-in state, browser link for the login transaction.
- **Pair a new endpoint** — invite paste → challenge → step-up approval link → enrolled.
- **Recovery** — select a connection, paste the one-time recovery text, run.
- **Connections** — live session/route state per enrolled endpoint;
  connect / disconnect / recover actions.
- **Events** — rolling session event feed.

The render loop is fully message-driven; all `EntryService` calls run on a
background tokio worker.

## Protocol parity

`entry-core` mirrors the TS wire contracts byte-for-byte:

- pairing invite + restricted bootstrap → challenge → step-up permit
  (`pair_device`, bound to `bootstrapId` + challenge `target`) → signed
  completion, checkpointed in custody for completion-replay;
- device identity = Ed25519 keypair in custody + DER device certificate;
- forward sessions = WSS transport → pinned inner TLS → JSON-RPC channel,
  relay admission honesty (rejected/retryable, route generation tracking);
- recovery = recovery text (RFC-4648 lowercase base32 groups) → vault bundle
  → recover_device channel → fresh key + admission rollover;
- MCP face = the same newline-delimited stdio bridge the TS entry exposes.

Wire-level behavior is keyed on the same JSON field names and validation
rules as `packages/contracts` + `packages/entry-transport`.
