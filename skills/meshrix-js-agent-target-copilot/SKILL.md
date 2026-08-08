---
name: meshrix-js-agent-target-copilot
description: "Reference GitHub Copilot 适配项 (adaptation items): install/data paths, config, session directories, databases, access methods, adapter operations, and consumer map for Meshrix.js."
---

# Agent target: copilot

This skill is a **reference** for this agent's **适配项** (adaptation
items): install/data paths, config, session directories, databases, access
methods, adapter operations, and consumer map. It records observed first-party
facts for Meshrix.js, Meshrix.js. It does not prescribe how a
product must adapt the agent. Readiness and send-enabled claims stay in Meshrix.js
compatibility inventories, not here.

## Identity

| Field | Value |
| --- | --- |
| Canonical id | `copilot` |
| Aliases | `github-copilot` |
| Native capability ids | `cli`, `acp` |


### Forms

Copilot has **CLI** and **ACP** forms. History also appears under VS Code
plugin storage (adjacency for browse, not a third native running mode).

| Form | What it is | Typical evidence | Notes in current first-party use |
| --- | --- | --- | --- |
| **CLI** | `copilot` process / CLI session-state | Binary; `$COPILOT_HOME` | CLI session store / index |
| **ACP** | ACP over stdio NDJSON | ACP transport | Current Meshrix.js conversation lane (`copilot-acp-v1-stdio-ndjson`) |
| **VS Code storage (history adjacency)** | Plugin data under Code User storage | `workspaceStorage` / `globalStorage` | History browse keys related to Copilot chats |

### Forms vs history layout

Attach is ACP. History covers `$COPILOT_HOME` CLI stores plus VS Code Code
storage trees — two browse surfaces, not Cursor’s projects/vscdb Cursor layout.

## Install / binary discovery

- Binary names: `copilot`
- Process names: `copilot`, `copilot.exe`
- Discovery: shared Meshrix.js `$PATH` and platform user-bin roots

## Data and config roots

| Kind | Template |
| --- | --- |
| Copilot home | `$COPILOT_HOME` (default `$HOME/.copilot`; param `copilotHome`) |
| Primary config (vendor) | `$COPILOT_HOME/settings.json` (JSONC) |
| CLI sessions | `$COPILOT_HOME/session-state` |
| VS Code workspace | `$HOME/Library/Application Support/Code/User/workspaceStorage`; `%APPDATA%/Code/User/workspaceStorage`; `$XDG_CONFIG_HOME/Code/User/workspaceStorage` |
| VS Code global | same with `globalStorage` |

**Claim strength:** `named-inventory` for `$COPILOT_HOME/settings.json` (GitHub
docs). Meshrix.js `default_config_path("copilot")` is currently `None`; session and
history paths above remain first-party.

## Session directories

- CLI: transcripts under `$COPILOT_HOME/session-state` (event shapes such as
  `session.start`, `user.message`, `assistant.message` observed by Meshrix.js)
- VS Code: chat-related keys under `state.vscdb` / `store.db`

### History discovery reference (Meshrix.js)

- `copilot_catalog`: CLI `session-store.db` `sessions` table + session-state dirs;
  VS Code roots via generic file catalog with Copilot-related sqlite key filters
- Accepted shapes: `jsonl`, `ndjson`, `json`, sqlite/vscdb

## Databases / durable state

**Claim strength / 主张强度:** `named-inventory`

- CLI: `$COPILOT_HOME/session-store.db` (`sessions` table) when present
- VS Code: `state.vscdb` / `store.db` in workspace and global storage

## Access methods

| Form | Access | Notes |
| --- | --- | --- |
| CLI | Process / session-state | History and tooling |
| ACP | stdio NDJSON | Current Meshrix.js conversation lane |

## Common adapter operations

Observed Meshrix.js adapter-facing behavior (reference):

- Detect: `copilot`; `$COPILOT_HOME` or VS Code storage evidence
- Conversation continue: create/load/retain native ACP session ID
- In-turn guidance: `session/cancel` then reload exact session (`bridge_interrupt_resume`)
- History: CLI session-state/index + VS Code Copilot-marked storage
- MCP: not a Meshrix.js published target; optional ACP `session/mcp` may appear in Meshrix.js runtime

## Consumer map

| Consumer | Use |
| --- | --- |
| Meshrix.js | ACP conversation; history |
| Meshrix.js | no published MCP target |
| Other | `$COPILOT_HOME` and ACP notes as reusable reference |

## Fact sources

- `skills/meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md`
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
- https://github.com/github/copilot-cli
- `crates/meshrix-js-native/src/domain/targets/catalog.rs`
- `crates/meshrix-js-native/src/domain/conversation/source_catalog.rs`
- `crates/meshrix-js-native/resources/agent-conversation-drivers.json`
- `docs/COMPATIBILITY.md` (access fields only)

