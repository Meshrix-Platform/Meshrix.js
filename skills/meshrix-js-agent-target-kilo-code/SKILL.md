---
name: meshrix-js-agent-target-kilo-code
description: "Reference Kilo Code 适配项 (adaptation items): install/data paths, config, session directories, databases, access methods, adapter operations, and consumer map for Meshrix.js."
---

# Agent target: kilo-code

This skill is a **reference** for this agent's **适配项** (adaptation
items): install/data paths, config, session directories, databases, access
methods, adapter operations, and consumer map. It records observed first-party
facts for Meshrix.js, Meshrix.js. It does not prescribe how a
product must adapt the agent. Readiness and send-enabled claims stay in Meshrix.js
compatibility inventories, not here.

## Identity

| Field | Value |
| --- | --- |
| Canonical id | `kilo-code` |
| Aliases | `kilo`, `kilo_code`, `kilocode` |
| Native capability ids | `cli`, `local-server` |


### Forms

Kilo Code has **CLI** and **Local Server** forms. It may also appear as an
editor extension bundling the same `kilo` binary.

| Form | What it is | Typical evidence | Notes in current first-party use |
| --- | --- | --- | --- |
| **CLI** | `kilo` / `kilocode` process | Binary on PATH or extension-bundled `bin/kilo` | Install / presence |
| **Local Server** | Loopback HTTP + SSE | Listener evidence | Current Meshrix.js conversation lane (`kilo-code-serve-http-v1`) |
| **Editor extension (install adjacency)** | `kilocode.kilo-code*` under editor extensions | Extension dir + `globalStorage/kilocode.kilo-code` | Discovery fallback for the binary |

### Forms vs history layout

Live sessions are HTTP-owned. On-disk history centers on `kilo.db` and kilo
data/config trees (shared home layout, not Cursor dual-store).

## Install / binary discovery

- Binary names: `kilo`, `kilocode`
- Process names: `kilo`, `kilo.exe`, `kilocode`, `kilocode.exe`, `kilo code`
- Extension-bundled fallback:
  `$HOME/.vscode/extensions/kilocode.kilo-code*/bin/kilo` (also
  `.vscode-insiders`, `.cursor`, `.vscodium`; highest semver wins)
- Discovery: shared Meshrix.js search roots + extension fallback

## Data and config roots

| Kind | Template |
| --- | --- |
| Config | `$HOME/.config/kilo`; Windows `%APPDATA%/kilo` |
| Config file | `$HOME/.config/kilo/kilo.json` (Windows `%APPDATA%/kilo/kilo.json`) |
| Data | `$HOME/.local/share/kilo`; `$XDG_DATA_HOME/kilo`; `%APPDATA%/kilo` |
| Log | `$HOME/.local/share/kilo/log` |
| Session diff | `$HOME/.local/share/kilo/storage/session_diff` |
| Session share | `$HOME/.local/share/kilo/storage/session_share` |

## Session directories

Session share/diff trees under data storage; live sessions are HTTP-owned.

### History discovery reference (Meshrix.js)

- `openagent_catalog` on `kilo.db` `session` table when present
- Skips sqlite tables whose names contain `account` or `control_account`
- Excludes `parent_id` sub-agent rows from browse
- Generic file walk on config/data/log trees

## Databases / durable state

**Claim strength / 主张强度:** `named-inventory` for `kilo.db`; editor storage path `associated` (detection)

- Primary: `$HOME/.local/share/kilo/kilo.db` (`kilo-session-database`)
- Editor `globalStorage/kilocode.kilo-code` as detection evidence

## Access methods

| Form | Access | Notes |
| --- | --- | --- |
| CLI | Process entry | Presence / tooling |
| Local Server | loopback HTTP + SSE | Current Meshrix.js conversation lane |

## Common adapter operations

Observed Meshrix.js adapter-facing behavior (reference):

- Detect: `kilo`/`kilocode` or extension-bundled binary; config/data/`kilo.db`; listener for Local Server
- Conversation continue: create/verify/reuse native HTTP session
- In-turn guidance: SSE progress, native session `abort`, resume exact HTTP session (`bridge_interrupt_resume`)
- History: `kilo.db` + data trees (skip account tables)
- MCP: not a Meshrix.js published target

## Consumer map

| Consumer | Use |
| --- | --- |
| Meshrix.js | serve-http conversation; history |
| Meshrix.js | no published MCP target |
| Other | kilo data layout and HTTP session notes as reusable reference |

## Fact sources

- `skills/meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md`
- https://kilo.ai/docs/getting-started/settings
- https://github.com/Kilo-Org/kilocode
- `crates/meshrix-js-native/src/domain/targets/catalog.rs`
- `crates/meshrix-js-native/src/domain/targets/binaries.rs`
- `crates/meshrix-js-native/src/domain/conversation/source_catalog.rs`
- `crates/meshrix-js-native/resources/agent-conversation-drivers.json`
- `docs/COMPATIBILITY.md` (access fields only)

