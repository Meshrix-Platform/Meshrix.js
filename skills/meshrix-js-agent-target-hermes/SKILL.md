---
name: meshrix-js-agent-target-hermes
description: "Reference Hermes Agent 适配项 (adaptation items): install/data paths, config, session directories, databases, access methods, adapter operations, and consumer map for Meshrix.js."
---

# Agent target: hermes

This skill is a **reference** for this agent's **适配项** (adaptation
items): install/data paths, config, session directories, databases, access
methods, adapter operations, and consumer map. It records observed first-party
facts for Meshrix.js, Meshrix.js. It does not prescribe how a
product must adapt the agent. Readiness and send-enabled claims stay in Meshrix.js
compatibility inventories, not here.

## Identity

| Field | Value |
| --- | --- |
| Canonical id | `hermes` |
| Aliases | `hermes-agent`, `hermes-serena` |
| Native capability ids | `cli`, `acp`, `tui-gateway` |


### Forms

Hermes has **CLI**, **ACP**, and **TUI Gateway** forms. Modes are mutually
exclusive by command tokens. TUI Gateway is a remote/manual-VM specialization.

| Form | What it is | Typical evidence | Notes in current first-party use |
| --- | --- | --- | --- |
| **CLI** | Ordinary `hermes` process | Binary `hermes` | Install / presence |
| **ACP** | Persistent ACP over stdio JSON-RPC | ACP transport | Current Meshrix.js local conversation lane (`hermes-acp-stdio-jsonrpc`) |
| **TUI Gateway** | Remote/manual-VM specialization | Connection-bound gateway evidence | Manual VM transport only; **verified-absent** as an unconditional local gateway (Meshrix.js / `COMPATIBILITY`) |

### Forms vs history layout

Attach is ACP (or VM ACP over SSH). History walks shared Hermes home/config
roots (generic file catalog), not a Cursor dual-store split.

## Install / binary discovery

- Binary names: `hermes`
- Process names: `hermes`, `hermes.exe`
- Discovery: shared Meshrix.js `$PATH` and platform user-bin roots (including Nix /
  user bins when present on `$PATH`)

## Data and config roots

| Kind | Template |
| --- | --- |
| Home | `$HERMES_HOME` (default `$HOME/.hermes`; Windows native installer often `%LOCALAPPDATA%/hermes`) |
| Primary config (vendor) | `$HERMES_HOME/config.yaml`; secrets `$HERMES_HOME/.env` |
| Config dirs (Meshrix.js history) | `$HOME/.config/hermes`; `$XDG_CONFIG_HOME/hermes` |
| Windows appdata (legacy scan) | `%APPDATA%/Hermes` |

**Claim strength:** `named-inventory` for `config.yaml` / `.env` under
`$HERMES_HOME` (vendor docs). Meshrix.js `default_config_path("hermes")` is currently
`None`; history still scans Hermes roots.

## Session directories

Session/state material under Hermes home/config roots. Manual VM conversations
use ACP session list/load over SSH stdio rather than guest filesystem browsing.

### History discovery reference (Meshrix.js)

- Generic file catalog over Hermes roots
- Broad accepted shapes including text and sqlite
- No composer/delegated folding specific to Hermes

## Databases / durable state

**Claim strength / 主张强度:** `acceptance` (+ `associated` for `state.db`)

- Meshrix.js history acceptance includes `sqlite` / `sqlite3` / `db` (and text
  shapes) under Hermes roots — acceptance for discovery, not a guarantee every
  install has those files
- Usage tracking code has referenced `state.db` under Hermes roots; that is an
  associated filename, not a full first-party schema inventory

## Access methods

| Form | Access | Notes |
| --- | --- | --- |
| CLI | Process entry | Presence / tooling |
| ACP | persistent stdio JSON-RPC | Current Meshrix.js local conversation lane |
| TUI Gateway | Manual/remote VM specialization | Conditional remote listener; connection-bound |

## Common adapter operations

Observed Meshrix.js adapter-facing behavior (reference):

- Detect: `hermes`; home/config roots as evidence
- Conversation continue: bind/load native ACP session on persistent transport
- In-turn guidance: `session/cancel` then continue same native session (`bridge_interrupt_resume`)
- History: Hermes roots as above
- Manual VM: system OpenSSH stdio + ACP (strict host verification; noninteractive auth; no password/key intake by Meshrix.js)
- MCP: not a Meshrix.js published target; optional ACP `session/mcp` may appear in Meshrix.js runtime

## Consumer map

| Consumer | Use |
| --- | --- |
| Meshrix.js | ACP conversation; history; optional VM transport |
| Meshrix.js | no published MCP target |
| Other | Hermes roots and ACP notes as reusable reference |

## Fact sources

- `skills/meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md`
- https://hermes-agent.nousresearch.com/docs/user-guide/configuration
- https://github.com/NousResearch/hermes-agent
- `crates/meshrix-js-native/src/domain/targets/catalog.rs`
- `crates/meshrix-js-native/src/domain/conversation/source_catalog.rs`
- `crates/meshrix-js-native/resources/agent-conversation-drivers.json`
- `docs/COMPATIBILITY.md` (access fields only)

