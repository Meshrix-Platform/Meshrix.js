# Meshrix Entry — native client

The maintained Meshrix Entry client is Rust-native: one workspace and three
crates provide the core library, CLI/TUI and egui desktop app. The native
client uses A4AA for Agent adaptation and AwP for behavior profiles.

| Crate | Binary | Purpose |
|---|---|---|
| `meshrix-entry-core` | (lib) | Identity, custody, recovery, pairing, relay sessions, account client, MCP bridge, A4AA/AwP Agent runtime |
| `meshrix-entry-cli` | `meshrix-entry` | clap CLI + ratatui TUI dashboard |
| `meshrix-entry-gui` | `meshrix-entry-gui` | egui desktop shell (account, pairing, connections, recovery, events) |

## Build

```sh
cargo build --release --bins
# → target/release/meshrix-entry       (CLI + TUI)
# → target/release/meshrix-entry-gui   (desktop window)
```

Cross-target builds need the Rust target toolchain and any C/assembler tools
used by native dependencies such as `ring`. These are build-machine
requirements; they do not imply that recipients need a compiler or Cargo.
The target triple alone does not establish static linkage or runtime support.

## Portable Linux artifacts

The maintained Linux build entry produces four client binaries from the
integrated native workspace. Packaging is a separate step that consumes the
build manifest rather than guessing Cargo output paths:

```sh
node apps/entry-native/tools/build-linux.mjs
node apps/entry-native/tools/package-linux.mjs \
  --input-dir apps/entry-native/dist/linux \
  --output-dir apps/entry-native/dist/linux/packages
```

The CLI/TUI artifacts target musl for x86_64 and aarch64. GUI artifacts target
GNU for both architectures and include the eframe X11 and Wayland backends.
The packaging step writes four versioned `tar.gz` archives plus
`package-manifest.json`. Each archive can be extracted and launched directly;
there is no installer or AppImage/FUSE prerequisite. The GUI still needs a
host display server or compositor and a compatible graphics driver. The exact
glibc floor, ELF dependencies and any bundled user-space libraries are
artifact-specific facts established by the Linux artifact verification; a
target name is not evidence of universal Linux compatibility.

The build manifest records sanitized dependency-source provenance. Current
local development dependency patches are not copied into the archives, and
these artifacts do not establish clean-clone reproducibility or publication
qualification. The CLI and GUI archives include the native workspace license
and third-party license notices; the GUI archive also includes the Inter font
license for its embedded fonts.

On the packaging host, install `readelf` or `llvm-readelf` and keep Docker
available with the local builder image. The packager uses the image's target
sysroots to stage only measured, licensed GUI runtime libraries; these are
build-time requirements and are not required on recipient machines.

## Verify

From the repository root, run the native workspace checks independently:

```sh
cargo test --manifest-path apps/entry-native/Cargo.toml --workspace --all-targets --locked --no-fail-fast
```

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
meshrix-entry login                       # browser sign-in; polls transaction status
meshrix-entry pair '<invite text>'        # challenge → browser step-up → enrolled
meshrix-entry connections                 # list enrolled endpoints
meshrix-entry connect <connection-id>     # open session, stream events
meshrix-entry request <id> '<json-rpc>'   # one-shot request
meshrix-entry query-op <id> <op-id>       # endpoint operation ledger
meshrix-entry disconnect <id>
meshrix-entry recover <id> '<recovery text>'
meshrix-entry mcp-stdio <id>              # newline-framed JSON-RPC over stdio
meshrix-entry agent-cards                 # read-only A4AA card availability
meshrix-entry agent-specs                 # saved A4AA AgentSpec ids
meshrix-entry profile-enroll <card-id>    # explicitly save one card as an AwP profile
meshrix-entry profiles                    # list saved behavior profiles
meshrix-entry profile-upsert <id> '<json>' # patch AwP profile fields
meshrix-entry profile-remove <id>
meshrix-entry profile-set-enabled <id> false
meshrix-entry agent-upsert '<spec-json>'  # save an A4AA AgentSpec
meshrix-entry agent-remove <agent-id>     # also removes dependent profiles
meshrix-entry chat <connection> <profile-id> '<prompt>' --model <id> --effort <level>
meshrix-entry tui                         # live ratatui dashboard
```

`agent-cards` reports supported/detected adapters without writing local
configuration. `profile-enroll` is the explicit action that saves an A4AA
AgentSpec and an AwP profile; `profiles` lists only saved profiles. The
`profile-upsert` argument is an AwP `ProfilePatch` JSON object, so AwP owns
profile validation and patch behavior. Optional per-turn `--model` and
`--effort` values override the selected profile through AwP. The TUI shows
saved profiles with `p` and the read-only A4AA card list with `a`.
CLI profile and AgentSpec listings return summaries and omit instructions,
paths and environment contents.

The card catalog reports model, effort, execution-mode and permission-mode
support, plus card allowlists and model-enumeration routes. Profile and per-turn
selector requests are checked against the selected A4AA lane. Supported mode
and permission selectors are forwarded through session configuration.
This client rejects AwP `mechanisms` because it does not install the
resulting agent artifacts; unsupported requests fail with an explanation.
Permission-mode presets are separate from runtime tool approval decisions.
The execution path applies profile instructions and instruction mode, model,
effort, working directory and environment; profile MCP servers apply on ACP
lanes. AwP `contextWindow`, capability preferences, skill references, state
keys and extensions remain stored metadata in this client, not active Agent
behavior.
An empty registry stays empty until an explicit card enrollment or AgentSpec
registration.

Existing local Agent IDs and secret references are retained when the former
`agents.json` document is converted to the AwP-backed registry. Account,
device and endpoint profiles remain separate.

`login`/`pair` print a browser URL and poll the account transaction.
`pair --no-wait` prints the step-up URL and PKCE verifier for a later manual
finish.

## GUI

`meshrix-entry-gui` opens a single window:

- **Account** card — sign-in state, browser link for the login transaction.
- **Pair a new endpoint** — invite paste → challenge → step-up approval link → enrolled.
- **Recovery** — select a connection, paste the one-time recovery text, run.
- **Connections** — live session/route state per enrolled endpoint;
  connect / disconnect / recover actions.
- **Agents** — separate A4AA card availability from saved AwP profiles; enroll
  cards explicitly, edit common profile fields or apply an AwP patch, toggle
  Peer availability, and remove profiles.
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
- MCP face = a newline-delimited stdio bridge served by the native client.

Wire-level behavior is keyed on the same JSON field names and validation
rules as `packages/contracts` + `packages/entry-transport`.
