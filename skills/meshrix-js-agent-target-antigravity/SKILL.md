---
name: meshrix-js-agent-target-antigravity
description: "Reference Antigravity 适配项 (adaptation items): install/data paths, config, session directories, databases, access methods, adapter operations, and consumer map for Meshrix.js."
---

# Agent target: antigravity

This skill is a **reference** for this agent's **适配项** (adaptation
items): install/data paths, config, session directories, databases, access
methods, adapter operations, and consumer map. It records observed first-party
facts for Meshrix.js, Meshrix.js. It does not prescribe how a
product must adapt the agent. Readiness and send-enabled claims stay in Meshrix.js
compatibility inventories, not here.

## Identity

| Field | Value |
| --- | --- |
| Canonical id | `antigravity` |
| Aliases | — |
| Native capability ids | `desktop`, `cli` |


### Forms

Antigravity has **Desktop** and **CLI** forms. Meshrix.js conversation attach uses
a Meshrix.js-owned Hook + per-turn CLI lane, not a Native ACP/App Server protocol.

| Form | What it is | Typical evidence | Notes in current first-party use |
| --- | --- | --- | --- |
| **Desktop** | Antigravity IDE | macOS `Antigravity.app`; IDE Application Support / XDG / AppData trees | Presence and IDE history roots |
| **CLI (Hook)** | `agy` / `antigravity` with argv hook | Binary and bounded hook receipt | Current Meshrix.js conversation lane (`antigravity-cli-argv-hook-v1`); adapter owner **Meshrix.js** |

### Forms vs history layout

Attach is Hook CLI. History walks IDE state trees plus `$HOME/.gemini/antigravity*`
bridge roots (generic/sqlite catalog), shared across desktop/CLI evidence.

## Install / binary discovery

- Binary names: `agy`, `antigravity`
- Process names: `agy`, `agy.exe`, `antigravity`, `antigravity.exe`
- Desktop (macOS): `Antigravity.app`
- Discovery: shared Meshrix.js search roots + desktop bundle search

## Data and config roots

| Kind | Template |
| --- | --- |
| IDE state (macOS) | `$HOME/Library/Application Support/Antigravity IDE` |
| IDE state (Windows) | `%APPDATA%/Antigravity IDE`; `%LOCALAPPDATA%/Antigravity IDE` |
| IDE state (XDG) | `$XDG_CONFIG_HOME/Antigravity IDE` |
| Bridge | `$HOME/.gemini/antigravity`; `$HOME/.gemini/antigravity-ide` |
| CLI bridge | `$HOME/.gemini/antigravity-cli` |
| MCP config | `$HOME/.gemini/config/mcp_config.json` (legacy bridge fallback: `$HOME/.gemini/antigravity/mcp_config.json`) |

## Session directories

IDE trees are scanned for accepted sqlite/vscdb (and text) chat material. CLI bridge material lives under
`$HOME/.gemini/antigravity-cli`. Hook conversation identity is recovered via the
namespaced Hook receipt rather than a single documented on-disk session dirname.

### History discovery reference (Meshrix.js)

- Generic file catalog across IDE + Gemini bridge roots
- Accepted shapes include sqlite/vscdb and text chat formats
- Sqlite interest includes `itemTable` and chat/session/history-related keys

## Databases / durable state

**Claim strength / 主张强度:** `acceptance` (IDE sqlite interest keys are `associated` where named)

Meshrix.js history acceptance for Antigravity includes `sqlite` / `sqlite3` / `db` /
`vscdb` (and text shapes) under IDE + Gemini bridge roots. Scanners look for
those shapes when present; there is no single named primary DB like `kilo.db`.
Exact table layouts are implementation-sensitive; Meshrix.js history scanners are
the first-party reader.

## Access methods

| Form | Access | Notes |
| --- | --- | --- |
| Desktop | IDE product | Detection / IDE history |
| CLI Hook | argv hook (`--print`, `--conversation` family) | Current Meshrix.js conversation lane; Meshrix.js-owned bridge |

## Common adapter operations

Observed Meshrix.js adapter-facing behavior (reference):

- Detect: `agy`/`antigravity` or IDE/bridge roots
- Conversation continue: recover/resume native conversation ID via Hook receipt
- In-turn guidance: interrupt supervised CLI turn; resume Hook-bound ID (`bridge_interrupt_resume`)
- History: IDE + Gemini bridge roots as above
- MCP (Meshrix.js): published client target `antigravity`; local MCP file `mcp_config.json`

## Consumer map

| Consumer | Use |
| --- | --- |
| Meshrix.js | Hook CLI conversation; history |
| Meshrix.js | MCP client target `antigravity` |
| Other | IDE/Gemini roots and Hook receipt model as reusable reference |

## Fact sources

- `skills/meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md`
- https://antigravity.google/docs/home
- https://antigravity.google/docs/mcp
- `crates/meshrix-js-native/src/domain/targets/catalog.rs`
- `crates/meshrix-js-native/src/domain/conversation/source_catalog.rs`
- `crates/meshrix-js-native/resources/agent-conversation-drivers.json`
- `docs/COMPATIBILITY.md` (access fields only)
- `packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.ts`
