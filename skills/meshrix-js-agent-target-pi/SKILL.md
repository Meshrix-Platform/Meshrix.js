---
name: meshrix-js-agent-target-pi
description: "Reference Pi Agent 适配项 (adaptation items): install/data paths, config, session directories, databases, access methods, adapter operations, and consumer map for Meshrix.js."
---

# Agent target: pi

This skill is a **reference** for this agent's **适配项** (adaptation
items): install/data paths, config, session directories, databases, access
methods, adapter operations, and consumer map. It records observed first-party
facts for Meshrix.js, Meshrix.js. It does not prescribe how a
product must adapt the agent. Readiness and send-enabled claims stay in Meshrix.js
compatibility inventories, not here.

## Identity

| Field | Value |
| --- | --- |
| Canonical id | `pi` |
| Aliases | `pi-agent`, `pi-coding-agent`, `pi_agent`, `pi_coding_agent` |
| Native capability ids | `cli`, `rpc` |


### Forms

Pi has **CLI** and **RPC** forms. Modes are mutually exclusive (ordinary CLI vs
RPC stdio JSONL).

| Form | What it is | Typical evidence | Notes in current first-party use |
| --- | --- | --- | --- |
| **CLI** | Ordinary `pi` process | Binary `pi` | Install / presence |
| **RPC** | Structured stdio JSONL RPC | RPC transport | Current Meshrix.js conversation lane (`pi-rpc-stdio-jsonl`) with `native_steer` |

### Forms vs history layout

Attach is RPC. History is a JSONL session directory (default under
`$HOME/.pi/agent/sessions`), not a Cursor dual-store or sqlite composer catalog.

## Install / binary discovery

- Binary names: `pi`
- Process names: `pi`, `pi.exe`
- Discovery: shared Meshrix.js `$PATH` and platform user-bin roots

## Data and config roots

| Kind | Template |
| --- | --- |
| Sessions | `$PI_CODING_AGENT_SESSION_DIR` (default `$HOME/.pi/agent/sessions`; params `piSessionDir` / `piCodingAgentSessionDir`) |
| Settings | `$HOME/.pi/agent/settings.json` |

## Session directories

- Session store: JSONL files under the sessions dir
- Filename stem commonly `<prefix>_<session-id>`
- Record types observed by Meshrix.js: `session`, `session_info`, `message`
- Message content blocks may include `thinking`, `toolCall`, and text

### History discovery reference (Meshrix.js)

- `pi_catalog`: JSONL files in the session directory
- First-line `type: session` header probe for id/cwd/timestamp; mtime for recency
- No sqlite catalog for Pi

## Databases / durable state

**Claim strength / 主张强度:** `transcript-primary`

Primary durable material is the JSONL session directory.

## Access methods

| Form | Access | Notes |
| --- | --- | --- |
| CLI | Process entry | Presence / tooling |
| RPC | stdio JSONL | Current Meshrix.js conversation lane |

## Common adapter operations

Observed Meshrix.js adapter-facing behavior (reference):

- Detect: `pi`; session dir / settings as evidence
- Conversation continue: obtain/switch to/continue exact native RPC session
- In-turn guidance: exact-session/turn `steer`; delivery after matching RPC success (`native_steer`)
- History: session-directory JSONL as above
- MCP (Meshrix.js): published client target `pi`

## Consumer map

| Consumer | Use |
| --- | --- |
| Meshrix.js | RPC conversation; history |
| Meshrix.js | MCP client target `pi` |
| Other | Session-dir template and RPC steer notes as reusable reference |

## Fact sources

- `skills/meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md`
- https://pi.dev/docs/latest/settings
- https://github.com/earendil-works/pi
- `crates/meshrix-js-native/src/domain/targets/catalog.rs`
- `crates/meshrix-js-native/src/domain/conversation/source_catalog.rs`
- `crates/meshrix-js-native/resources/agent-conversation-drivers.json`
- `docs/COMPATIBILITY.md` (access fields only)
- `packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.ts`

