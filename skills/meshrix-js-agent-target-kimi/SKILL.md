---
name: meshrix-js-agent-target-kimi
description: "Reference Kimi desktop 适配项 (adaptation items): install/data paths, config, session directories, databases, access methods, adapter operations, and consumer map for Meshrix.js."
---

# Agent target: kimi

This skill is a **reference** for this agent's **适配项** (adaptation
items): install/data paths, config, session directories, databases, access
methods, adapter operations, and consumer map. It records observed first-party
facts for Meshrix.js, Meshrix.js. It does not prescribe how a
product must adapt the agent. Readiness and send-enabled claims stay in Meshrix.js
compatibility inventories, not here.

## Identity

| Field | Value |
| --- | --- |
| Canonical id | `kimi` |
| Aliases | `moonshot` (history adapter alias) |
| Native capability ids | not in conversation native-capability inventory (desktop history / Meshrix.js MCP id) |


### Forms

`kimi` is the **desktop** product / Meshrix.js MCP allowlist id. It is separate
from `kimi-code` (CLI ACP conversation). There is no Meshrix.js conversation-driver
row for desktop `kimi`.

| Form | What it is | Typical evidence | Notes in current first-party use |
| --- | --- | --- | --- |
| **Desktop app** | Kimi desktop application | Process names; macOS `Kimi.app` bundle | Detection and app-state history |
| **Meshrix.js MCP id `kimi`** | Published MCP client target | Meshrix.js allowlist | Installer contracts; not proof of the same local protocol as `kimi-code` ACP |

### Forms vs history layout

No conversation attach form in Meshrix.js. History walks desktop app-state roots
(generic file catalog), isolated from `$HOME/.kimi-code` / `wire.jsonl`.

## Install / binary discovery

- `binary_names` in `target_defs`: empty (desktop product)
- Process names: `Kimi`, `kimi`, `Kimi.exe`, `kimi.exe`, `com.moonshot.kimi`
- macOS bundle fallback: `/Applications/Kimi.app/Contents/MacOS/Kimi` and
  `$HOME/Applications/Kimi.app/Contents/MacOS/Kimi`

## Data and config roots

| Kind | Template |
| --- | --- |
| App state (macOS) | `$HOME/Library/Application Support/Kimi`; `$HOME/Library/Application Support/com.moonshot.kimi` |
| Logs (macOS) | `$HOME/Library/Logs/Kimi` |
| Windows | `%APPDATA%/Kimi`; `%APPDATA%/com.moonshot.kimi`; `%LOCALAPPDATA%/Kimi` |
| XDG | `$XDG_CONFIG_HOME/Kimi`; `$XDG_DATA_HOME/Kimi` |
| Config file | macOS `…/Kimi/config.json`; Windows `%APPDATA%/Kimi/config.json`; Linux `$HOME/.config/Kimi/config.json` |

## Session directories

Meshrix.js scans the app-state roots above with the accepted extensions listed under
Databases (including sqlite when such files exist). No Meshrix.js conversation-driver
session protocol for this id.

### History discovery reference (Meshrix.js)

- Generic file catalog on desktop app-state roots
- Does not use kimi-code `wire.jsonl` acceptance rules
- History adapter alias includes `moonshot`

## Databases / durable state

**Claim strength / 主张强度:** `acceptance`

Meshrix.js history acceptance for desktop `kimi` includes
`jsonl` / `ndjson` / `json` / `md` / `txt` / `log` / `sqlite` / `sqlite3` /
`db` under the app-state roots (`accepts_file`). That means scanners may treat
matching files as history candidates when present; it does **not** name a
primary database path or table schema. Whether a given install actually
contains sqlite files is installation-specific and is not inferred from
“desktop app is installed.” No first-party conversation-driver DB inventory for
desktop `kimi`.

## Access methods

| Form | Access | Notes |
| --- | --- | --- |
| Desktop app | App-state / process presence | History and detection |
| Meshrix.js conversation lane | none | Not in conversation-driver table |
| Meshrix.js MCP | target id `kimi` | Separate from `kimi-code` |

## Common adapter operations

Observed first-party behavior (reference):

- Detect: process names and macOS app-bundle paths; app-state roots as evidence
- Conversation create/resume/steer: **verified-absent** for Meshrix.js desktop
  `kimi` (no conversation-driver / send lane; use `kimi-code` for CLI ACP)
- History: app-state roots as above
- MCP (Meshrix.js): published target `kimi` under Meshrix.js installer contracts
- For CLI ACP conversation, see `meshrix-js-agent-target-kimi-code`

## Consumer map

| Consumer | Use |
| --- | --- |
| Meshrix.js | History / desktop detection; no conversation driver row |
| Meshrix.js | MCP client target `kimi` |
| Other | Keep desktop (`kimi`) and CLI (`kimi-code`) as separate references |

## Fact sources

- `skills/meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md`
- https://www.kimi.com/help/kimi-work/overview
- `crates/meshrix-js-native/src/domain/targets/catalog.rs`
- `crates/meshrix-js-native/src/domain/targets/binaries.rs`
- `crates/meshrix-js-native/src/domain/conversation/source_catalog.rs`
- `packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.ts`

