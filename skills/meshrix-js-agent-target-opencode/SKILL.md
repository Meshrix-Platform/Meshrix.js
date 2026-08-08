---
name: meshrix-js-agent-target-opencode
description: "Reference OpenCode 适配项 (adaptation items): install/data paths, config, session directories, databases, access methods, adapter operations, and consumer map for Meshrix.js."
---

# Agent target: opencode

This skill is a **reference** for this agent's **适配项** (adaptation
items): install/data paths, config, session directories, databases, access
methods, adapter operations, and consumer map. It records observed first-party
facts for Meshrix.js, Meshrix.js. It does not prescribe how a
product must adapt the agent. Readiness and send-enabled claims stay in Meshrix.js
compatibility inventories, not here.

## Identity

| Field | Value |
| --- | --- |
| Canonical id | `opencode` |
| Aliases | `open-code`, `open_code` |
| Native capability ids | `cli`, `local-server` |


### Forms

OpenCode has **CLI** and **Local Server** forms. Running modes are mutually
exclusive (ordinary CLI vs `serve` loopback HTTP + SSE).

| Form | What it is | Typical evidence | Notes in current first-party use |
| --- | --- | --- | --- |
| **CLI** | Ordinary `opencode` process | Binary `opencode` | Install / process presence |
| **Local Server** | Loopback HTTP + SSE (`opencode serve`) | Listener evidence; HTTP session APIs | Current Meshrix.js conversation lane (`opencode-serve-http-v1`) |

### Forms vs history layout

Live conversation sessions are owned by the HTTP service. On-disk history uses
shared config/data roots (including `opencode.db` session table in Meshrix.js).

## Install / binary discovery

- Binary names: `opencode`
- Process names: `opencode`, `opencode.exe`
- Discovery: shared Meshrix.js `$PATH` and platform user-bin roots

## Data and config roots

| Kind | Template |
| --- | --- |
| Config | `$HOME/.config/opencode`; Windows `%APPDATA%/opencode` |
| Config file | `$HOME/.config/opencode/opencode.jsonc` (Windows `%APPDATA%/opencode/opencode.jsonc`) |
| Data | `$HOME/.local/share/opencode`; `$XDG_DATA_HOME/opencode`; `%APPDATA%/opencode` |

## Session directories

On-disk session material under data/config roots. Live sessions are HTTP-owned.

### History discovery reference (Meshrix.js)

- `openagent_catalog` reads `session` table in `opencode.db` under data roots
  when present
- Filters include time cutoff; excludes archived and `parent_id` sub-agent rows
- Generic file walk of config/data roots also applies for file-backed history

## Databases / durable state

**Claim strength / 主张强度:** `named-inventory` for `opencode.db`; additional shapes under data roots are `acceptance`

- Primary session DB: `$HOME/.local/share/opencode/opencode.db` (and
  XDG/AppData equivalents under the data root)
- Other sqlite/jsonl under data roots follow history acceptance, not a second named primary

## Access methods

| Form | Access | Notes |
| --- | --- | --- |
| CLI | Process entry | Presence / tooling |
| Local Server | loopback HTTP + SSE | Current Meshrix.js conversation lane |

## Common adapter operations

Observed Meshrix.js adapter-facing behavior (reference):

- Detect: `opencode`; config/data roots; running Local Server also needs listener evidence
- Conversation continue: create/verify/reuse native HTTP session
- In-turn guidance: SSE progress, native session `abort`, resume exact HTTP session (`bridge_interrupt_resume`)
- History: `opencode.db` + config/data roots as above
- MCP (Meshrix.js): published client target `opencode`

## Consumer map

| Consumer | Use |
| --- | --- |
| Meshrix.js | serve-http conversation; history |
| Meshrix.js | MCP client target `opencode` |
| Other | Config/data roots and HTTP session notes as reusable reference |

## Fact sources

- `skills/meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md`
- https://opencode.ai/docs/config
- https://github.com/anomalyco/opencode
- `crates/meshrix-js-native/src/domain/targets/catalog.rs`
- `crates/meshrix-js-native/src/domain/conversation/source_catalog.rs`
- `crates/meshrix-js-native/src/domain/conversation/history/catalog.rs`
- `crates/meshrix-js-native/resources/agent-conversation-drivers.json`
- `docs/COMPATIBILITY.md` (access fields only)
- `packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.ts`

