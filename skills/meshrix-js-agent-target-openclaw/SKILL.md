---
name: meshrix-js-agent-target-openclaw
description: "Reference OpenClaw 适配项 (adaptation items): install/data paths, config, session directories, databases, access methods, adapter operations, and consumer map for Meshrix.js."
---

# Agent target: openclaw

This skill is a **reference** for this agent's **适配项** (adaptation
items): install/data paths, config, session directories, databases, access
methods, adapter operations, and consumer map. It records observed first-party
facts for Meshrix.js, Meshrix.js. It does not prescribe how a
product must adapt the agent. Readiness and send-enabled claims stay in Meshrix.js
compatibility inventories, not here.

## Identity

| Field | Value |
| --- | --- |
| Canonical id | `openclaw` |
| Aliases | `openclaw-kate` |
| Native capability ids | `cli`, `acp`, `gateway` |


### Forms

OpenClaw is one agent id with **CLI**, **ACP**, and **Gateway** forms. Running
modes are mutually exclusive by command tokens (`cli` vs `acp` vs `gateway`).
Meshrix.js conversation attach uses ACP through the Gateway; Meshrix.js MCP uses the
same agent id as a published client target.

| Form | What it is | Typical evidence | Notes in current first-party use |
| --- | --- | --- | --- |
| **CLI** | Ordinary `openclaw` process | Binary `openclaw` | Install / process presence |
| **ACP** | Agent Client Protocol over stdio | ACP session transport | Structured conversation protocol |
| **Gateway** | Intermediate attach layer | Gateway process; may own loopback TCP | Current Meshrix.js lane attaches ACP through Gateway (`openclaw-acp-stdio-jsonrpc`) |

### Forms vs history layout

Forms matter for detect/attach. History walks the shared OpenClaw home/config
roots (generic file catalog), not a Cursor-style dual store.

## Install / binary discovery

- Binary names: `openclaw`
- Process names: `openclaw`, `openclaw.exe`
- Discovery: shared Meshrix.js `$PATH` and platform user-bin roots

## Data and config roots

| Kind | Template |
| --- | --- |
| Home | `$HOME/.openclaw` |
| Primary config (vendor) | `$HOME/.openclaw/openclaw.json` (JSON5); override `OPENCLAW_CONFIG_PATH` |
| Config dirs (Meshrix.js history) | `$HOME/.config/openclaw`; `$XDG_CONFIG_HOME/openclaw` |
| Windows appdata | `%APPDATA%/OpenClaw` |

**Claim strength:** `named-inventory` for `openclaw.json` (vendor docs). Meshrix.js
`default_config_path("openclaw")` is currently `None`; adapters still scan the
home/config roots above.

## Session directories

Meshrix.js scans the home/config roots above with the accepted extensions listed
under Databases. Manual VM conversations use ACP session list/load over SSH
stdio rather than guest filesystem browsing.

### History discovery reference (Meshrix.js)

- Generic file catalog over listed roots
- Accepted shapes include `jsonl`, `ndjson`, `json`, `md`, `txt`, `log`, sqlite
- Skips `*.backup` and `codebase-external.sqlite`
- No dedicated composer/delegated folding for OpenClaw

## Databases / durable state

**Claim strength / 主张强度:** `acceptance`

Meshrix.js history acceptance for OpenClaw includes extensions
`jsonl` / `ndjson` / `json` / `md` / `txt` / `log` / `sqlite` / `sqlite3` /
`db` under the history roots (`accepts_file` in `source_catalog.rs`). That is an
**acceptance rule for discovery**, not a claim that every install contains a
sqlite file, and not a named primary DB (contrast `kilo.db` /
`opencode.db` / Codex `state_*.sqlite`). No first-party OpenClaw table schema
inventory.

## Access methods

| Form | Access | Notes |
| --- | --- | --- |
| CLI | Process entry | Presence / tooling |
| ACP | stdio ACP | Conversation protocol |
| Gateway | Attach layer (+ optional loopback listener) | Current Meshrix.js conversation path |

## Common adapter operations

Observed Meshrix.js adapter-facing behavior (reference):

- Detect: `openclaw` binary; home/config roots as evidence
- Conversation continue: load exact ACP/Gateway session; preserve native session key
- In-turn guidance: ACP cancellation then resume same Gateway session key (`bridge_interrupt_resume`)
- History: shared OpenClaw roots as above
- Manual VM: system OpenSSH stdio + ACP (strict host verification; no password/key intake by Meshrix.js)
- MCP (Meshrix.js): published client target `openclaw`

## Consumer map

| Consumer | Use |
| --- | --- |
| Meshrix.js | ACP + Gateway conversation; history; optional VM transport |
| Meshrix.js | MCP client target `openclaw` |
| Other | Path templates and ACP/Gateway attach notes as reusable reference |

## Fact sources

- `skills/meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md`
- https://docs.openclaw.ai/gateway/configuration
- https://github.com/openclaw/openclaw
- `crates/meshrix-js-native/src/domain/targets/catalog.rs`
- `crates/meshrix-js-native/src/domain/conversation/source_catalog.rs`
- `crates/meshrix-js-native/resources/agent-conversation-drivers.json`
- `docs/COMPATIBILITY.md` (access fields only)
- `packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.ts`

