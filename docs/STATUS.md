# Meshrix.js Status

Status distinguishes source implementation, deterministic engineering checks
and published artifacts. Each result applies to the source and configuration
it exercised.

## Current product state

| Dimension | Current status |
| --- | --- |
| **Published products** | `meshrix.js@0.3.0` and `@meshrix/gateway@0.3.0` are the published npm products. GitHub release `v0.3.0` is available. See [release history](releases/README.md). |
| **Prepared source** | `0.4.0` is the next source candidate, not a published release. It ships the Rust native client alongside the npm products: A4AA, AwP and the dialect cards resolve from published crates.io coordinates, the Linux and macOS build lanes qualify eight client archives, and the release workflow attaches them to the GitHub Release. |
| **Native client** | Rust egui and ratatui are the maintained client surfaces. A4AA owns Agent adaptation and process/protocol behavior; AwP owns behavior-profile schema, resolution and execution defaults. Meshrix owns authorization, secret custody, Peer delivery and durable task state. Available Agents are distinct from user-enrolled Agents and saved profiles. |
| **Antigravity** | The native integration follows the public A4AA Antigravity ACP-primary descriptor and explicit AwP profiles. Local subprocess fixtures exercise configuration, permissions, reservation and enrollment-to-execution behavior; they do not establish acceptance against the real Agent. Unsupported selectors remain rejected according to the selected lane and maintained card. |
| **Native build availability** | Builds resolve A4AA and AwP from the published crates.io coordinates pinned in `Cargo.lock`; no local sibling checkouts or Cargo patches are required. The Linux build entry runs on any local aarch64 or x86_64 Docker daemon and cross-compiles the full target set; `build-linux.mjs --host` additionally builds host-linked GNU binaries under `dist/linux-host` without Docker, which is separate from portable archive qualification. The macOS entry runs on a local aarch64 or x86_64 host and builds both architectures through the installed Rust targets. The tag-driven release workflow builds and qualifies both matrices and attaches the archives to the GitHub Release. |
| **Linux clients** | Separate x86_64 and aarch64 builds provide musl CLI/TUI executables and X11/Wayland GUI portable archives. The GUI targets glibc 2.28 and carries ordinary client libraries; the host supplies its display server and graphics drivers. Build, packaging and artifact verification commands live in the [native client guide](../apps/entry-native/README.md). |
| **macOS clients** | Separate aarch64 and x86_64 builds provide CLI/TUI executables and desktop GUI portable archives linked only against system dylibs. The unsigned binaries need a one-time Gatekeeper quarantine clear after browser download. |
| **Self-hosted runtime** | The Node.js server and optional container paths provide the framework runtime. Published packages do not supply a hosted endpoint. Public account and Peer protocol contracts describe integration boundaries; they do not establish deployment of a corresponding service. |
| **Privacy and recording** | Peer delivery keeps payload custody on paired devices. Self-hosted recording explicitly trusts the organization's administrator and local storage permissions; recording content does not have an independent encryption-key boundary. Policy redaction, retention and failure behavior are covered by deterministic tests. |
| **Engineering evidence** | Scoped Rust compilation, Agent/profile/Peer tests and Node typechecks cover the current migration. The client Cargo workspace is verified separately from server/npm checks. Release packaging and clean-consumer checks apply to their exact artifacts; earlier acceptance does not establish later-source readiness. |

## Publication and support boundary

The published `0.3.0` products cover the single-node Core platform with Web
Console, standard MCP access, governed upstream services and the independently
embeddable gateway within their documented artifact and environment support.
Project-owned source is Apache-2.0; independent dependency and asset licenses
remain applicable.

The tag-driven release workflow builds, checks, packs and smoke-installs the
npm products, and builds and qualifies the Linux and macOS native client
archives, before publication and GitHub Release creation. Preparing version
metadata or installing a local client does not publish another release.

## Verification scope

The current Peer implementation uses durable device-local inbox/outbox state,
paired-device authorization, encrypted forwarding, signed receipts and local
application journals. Receiving a message does not authorize execution; the
host must admit the operation and reserve it durably before sending a prompt.
Rust and TypeScript use one request digest projection for new operations.

Real Agent conversations, provider behavior, visual acceptance, native Windows
and power-loss behavior, comparative performance and deployment require their
own evidence. They are not established by source review, synthetic fixtures or
a local build. The product-level functional gate remains
`npm run verify:acceptance`; client-owned verification is documented in the
[native client guide](../apps/entry-native/README.md).
