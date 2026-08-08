---
name: meshrix-js-agent-target-codex
description: "Reference Codex 适配项 (adaptation items): install/data paths, config, session directories, databases, access methods, adapter operations, and consumer map for Meshrix.js."
---

# Agent target: codex

This skill is a **reference** for this agent's **适配项** (adaptation
items): install/data paths, config, session directories, databases, access
methods, adapter operations, and consumer map. It records observed first-party
facts for Meshrix.js, Meshrix.js. It does not prescribe how a
product must adapt the agent. Readiness and send-enabled claims stay in Meshrix.js
compatibility inventories, not here.

## Identity

| Field | Value |
| --- | --- |
| Canonical id | `codex` |
| Aliases | — |
| Native capability ids | `desktop`, `cli`, `app-server` |

### Forms

Codex is one agent id with **three native forms**. A live process exposes at
most one of CLI vs App Server (mutually exclusive command tokens). Desktop is a
separate product entry. Meshrix.js MCP target `codex` and Meshrix.js conversation
attach may involve different forms of the same id.

| Form | What it is | Typical evidence | Notes in current first-party use |
| --- | --- | --- | --- |
| **Desktop** | ChatGPT desktop product entry | macOS `ChatGPT.app` / process `ChatGPT`; Windows Store/winget ChatGPT (`9PLM9XGG6VKS`); **verified-absent** official Linux desktop package | Presence / labeling; shares `$CODEX_HOME` / `$HOME/.codex` (Windows `%USERPROFILE%\.codex`). Not itself the Meshrix.js conversation protocol. |
| **CLI** | Ordinary `codex` command process | Binary `codex`; process without `app-server` token | Install, skill, and some tooling surfaces. Distinct from a live App Server process. |
| **App Server** | Structured stdio JSON-RPC mode (`codex app-server`) | argv contains `app-server`; no network listener required | Current Meshrix.js conversation lane (`codex-app-server-stdio-jsonrpc`) with thread/turn/`turn/steer`. |

### Forms vs history layout (contrast with Cursor)

Forms matter for detect/attach. History is a **shared** `$HOME/.codex/` tree,
unlike Cursor’s dual CLI-transcript / IDE-`state.vscdb` stores.

| Concern | Codex (reference) | Cursor (contrast) |
| --- | --- | --- |
| Attach / detect | Desktop / CLI / App Server (CLI vs App Server by argv) | Desktop Composer store / Desktop Agent UI / Agent CLI |
| History layout | One shared `$HOME/.codex/` tree | Project `agent-transcripts` and IDE `state.vscdb` composers |
| Meshrix.js history discovery | Shared `.codex` roots; attach form separate from file provenance | Ordered CLI trees then IDE sqlite; no third Agent UI root |
| Provenance | A rollout/jsonl/`state_*.sqlite` hit is not inherently App Server-authored | CLI and IDE hits are different formats; IDE id ≠ CLI `--resume` |

## Install / binary discovery

- CLI / App Server binary name: `codex` (App Server is the same binary with
  `app-server` mode, not a second install name)
- Process names: `codex`, `codex.exe`; App Server runs as `codex … app-server …`
- Desktop: macOS `ChatGPT.app` → executable `ChatGPT` (Meshrix.js app-bundle search);
  Windows official ChatGPT desktop via Microsoft Store / `winget install --id
  9PLM9XGG6VKS -s msstore` (OpenAI docs); no official Linux desktop package
  (CLI / App Server on Linux use `$HOME/.codex`)
- Discovery: shared Meshrix.js `$PATH` and platform user-bin roots for `codex`;
  macOS desktop bundle search is separate

## Data and config roots

| Kind | Template |
| --- | --- |
| Config | `$HOME/.codex/config.toml` |
| Prompt history | `$HOME/.codex/history.jsonl` |
| Session index | `$HOME/.codex/session_index.jsonl` |
| Session store | `$HOME/.codex/sessions` |
| Archived sessions | `$HOME/.codex/archived_sessions` |
| Memory | `$HOME/.codex/memories/MEMORY.md` |
| Rollout summaries | `$HOME/.codex/memories/rollout_summaries` |

## Session directories

- Active sessions under `$HOME/.codex/sessions` (often date-partitioned)
- Archived sessions under `$HOME/.codex/archived_sessions`
- Rollout transcripts commonly appear as `rollout-*.jsonl`
- Session index and prompt history are separate JSONL files at the `.codex` root

### History discovery reference (Meshrix.js)

Meshrix.js treats Codex history as one shared home tree (not a Cursor-style dual
store). Observed coverage:

1. Shared roots under `$HOME/.codex/`:
   - `sessions/` (active, often date-partitioned `rollout-*.jsonl`)
   - `archived_sessions/`
   - `session_index.jsonl`, `history.jsonl`
   - `memories/` when browsing memory material (not a session-store substitute)
2. Newest `state_*.sqlite` beside that tree when present; unreadable DB is
   fail-closed in Meshrix.js history code
3. Rollout **lineage merge** where Meshrix.js history rules collapse related
   rollouts
4. Attach form (Desktop / CLI / App Server) is a separate classification from
   which form wrote a given file

Useful contrast: inventing a “CLI store then IDE db” split for Codex does not
match the current first-party layout.

## Databases / durable state

**Claim strength / 主张强度:** `named-inventory` for `state_*.sqlite`; sessions also `transcript-primary` (JSONL)

- Primary state DB pattern: `$HOME/.codex/state_*.sqlite`; Meshrix.js history code
  prefers the newest matching file when present
- Accepted history extensions include `jsonl`, `ndjson`, `json`, `md`

## Access methods

| Form | Access | Notes |
| --- | --- | --- |
| Desktop | Product UI / process presence | Detection and “ChatGPT desktop” labeling; not a stdio conversation protocol. |
| CLI | Process argv without `app-server` | Ordinary CLI; skill install and some tooling. Mutually exclusive with a live App Server process token. |
| App Server | stdio JSON-RPC (`codex-app-server-stdio-jsonrpc`) | Current Meshrix.js **conversation** lane; no listening TCP port. |

History under `$HOME/.codex` is shared across forms; file presence alone does not
identify the authoring form.

## Common adapter operations

Observed Meshrix.js adapter-facing behavior (reference, not a mandated
recipe):

- Detect: `codex` binary; optional Desktop bundle; `$HOME/.codex` as
  config/history evidence; live CLI vs App Server by argv tokens
- Conversation continue (App Server): start or resume exact `thread.id`, then
  next turn
- In-turn guidance (App Server): `turn/steer` against exact thread and expected
  turn; `native_steer` after acknowledgement
- History: shared `.codex` roots as in **History discovery reference**
- MCP (Meshrix.js): published client target id `codex` under Meshrix.js installer
  contracts

## Consumer map

| Consumer | Use |
| --- | --- |
| Meshrix.js | App Server conversation; history; usage rollups |
| Meshrix.js | MCP client target `codex` |
| Future | Reuse `.codex` layout and App Server attach recipe |

## Fact sources

- `skills/meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md`
- https://developers.openai.com/codex/config-reference
- https://developers.openai.com/codex/app/windows
- https://github.com/openai/codex
- `crates/meshrix-js-native/src/domain/targets/catalog.rs`
- `crates/meshrix-js-native/src/domain/conversation/source_catalog.rs`
- `crates/meshrix-js-native/src/domain/conversation/history/catalog.rs`
- `crates/meshrix-js-native/resources/agent-conversation-drivers.json`
- `docs/COMPATIBILITY.md` (access fields only)
- `packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.ts`
