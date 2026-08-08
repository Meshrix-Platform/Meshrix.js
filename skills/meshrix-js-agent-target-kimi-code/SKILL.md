---
name: meshrix-js-agent-target-kimi-code
description: "Reference Kimi Code 适配项 (adaptation items): install/data paths, config, session directories, databases, access methods, adapter operations, and consumer map for Meshrix.js."
---

# Agent target: kimi-code

This skill is a **reference** for this agent's **适配项** (adaptation
items): install/data paths, config, session directories, databases, access
methods, adapter operations, and consumer map. It records observed first-party
facts for Meshrix.js, Meshrix.js. It does not prescribe how a
product must adapt the agent. Readiness and send-enabled claims stay in Meshrix.js
compatibility inventories, not here.

## Identity

| Field | Value |
| --- | --- |
| Canonical id | `kimi-code` |
| Aliases | `kimi_code`, `kimicode` |
| Native capability ids | `cli`, `acp`, `web-server` |


### Forms

Kimi Code has **CLI**, **ACP**, and **Web Server** forms. Modes are mutually
exclusive by command tokens. Separate from desktop `kimi`.

| Form | What it is | Typical evidence | Notes in current first-party use |
| --- | --- | --- | --- |
| **CLI** | `kimi` binary as Kimi Code CLI | Binary; `$KIMI_CODE_HOME` | Install / presence (same binary name as desktop — distinguish by target id / home) |
| **ACP** | ACP over stdio NDJSON | ACP transport | Current Meshrix.js conversation lane (`kimi-code-acp-v1-stdio-ndjson`) |
| **Web Server** | Optional control plane / browser UI | Loopback TCP when running | Optional; not the primary Meshrix.js conversation attach path |

### Forms vs history layout

Attach is ACP. History is isolated under `$KIMI_CODE_HOME/sessions` with a
strict `wire.jsonl` acceptance rule — not desktop Kimi app-state roots.

## Install / binary discovery

- Binary names: `kimi`
- Process names: `kimi`, `kimi.exe`, `kimi-code`, `kimi-code.exe`
- Discovery: shared Meshrix.js `$PATH` and platform user-bin roots

## Data and config roots

| Kind | Template |
| --- | --- |
| Home | `$KIMI_CODE_HOME` (default `$HOME/.kimi-code`; param `kimiCodeHome`) |
| Config | `$KIMI_CODE_HOME/config.toml` |
| Sessions | `$KIMI_CODE_HOME/sessions` |

## Session directories

- Session store: `$KIMI_CODE_HOME/sessions`
- Accepted history file: `agents/<agent-id>/wire.jsonl` under a session
- Wire event shapes observed by Meshrix.js include `turn.prompt`,
  `context.append_message`, `context.append_loop_event`
- Non-`main` agents may fold as delegated subagents into the parent session

### History discovery reference (Meshrix.js)

- Strict `accepts_file` gate: only `wire.jsonl` under an `agents` path segment
- `kimi_code_catalog`: session dirs with `state.json`; hydrate `agents/*/wire.jsonl`
- Isolated from desktop `kimi` history roots

## Databases / durable state

**Claim strength / 主张强度:** `transcript-primary` (`named-inventory` for `wire.jsonl` path shape)

Primary durable conversation material is the session `wire.jsonl` tree, not a
first-party sqlite catalog.

## Access methods

| Form | Access | Notes |
| --- | --- | --- |
| CLI | Process entry | Presence / tooling |
| ACP | stdio NDJSON | Current Meshrix.js conversation lane |
| Web Server | optional loopback control plane | Not primary Meshrix.js attach |

## Common adapter operations

Observed Meshrix.js adapter-facing behavior (reference):

- Detect: `kimi`; `$KIMI_CODE_HOME` and `sessions/` as evidence
- Conversation continue: create/load/resume exact native ACP session
- In-turn guidance: `session/cancel` then resume exact native ID (`bridge_interrupt_resume`)
- History: `wire.jsonl` under `agents/` only
- MCP: not published as `kimi-code` in Meshrix.js; Meshrix.js `kimi` is a different id (see `meshrix-js-agent-target-kimi`)
- Optional ACP `session/mcp` may appear in Meshrix.js runtime

## Consumer map

| Consumer | Use |
| --- | --- |
| Meshrix.js | ACP conversation; history |
| Meshrix.js | no `kimi-code` MCP id (see `kimi`) |
| Other | Keep CLI ACP distinct from desktop `kimi` |

## Fact sources

- `skills/meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md`
- https://moonshotai.github.io/kimi-code/en/configuration/config-files
- https://github.com/MoonshotAI/kimi-code
- `crates/meshrix-js-native/src/domain/targets/catalog.rs`
- `crates/meshrix-js-native/src/domain/conversation/source_catalog.rs`
- `crates/meshrix-js-native/src/domain/conversation/history/kimi.rs`
- `crates/meshrix-js-native/resources/agent-conversation-drivers.json`
- `docs/COMPATIBILITY.md` (access fields only)

