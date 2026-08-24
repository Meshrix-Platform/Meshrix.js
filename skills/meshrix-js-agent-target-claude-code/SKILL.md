---
name: meshrix-js-agent-target-claude-code
description: "Reference Claude Code 适配项 (adaptation items): install/data paths, config, session directories, databases, access methods, adapter operations, and consumer map for Meshrix.js."
---

# Agent target: claude-code

This skill is a **reference** for this agent's **适配项** (adaptation
items): install/data paths, config, session directories, databases, access
methods, adapter operations, and consumer map. It records observed first-party
facts for Meshrix.js, Meshrix.js. It does not prescribe how a
product must adapt the agent. Readiness and send-enabled claims stay in Meshrix.js
compatibility inventories, not here.

## Identity

| Field | Value |
| --- | --- |
| Canonical id | `claude-code` |
| Aliases | `claude`, `claude_code`, `claudecode` |
| Native capability ids | `cli` |


### Forms

Claude Code is recorded as a **CLI** agent. The Meshrix.js conversation lane is
streaming-input CLI (`stream-json`), not a separate ACP/RPC capability id.

| Form | What it is | Typical evidence | Notes in current first-party use |
| --- | --- | --- | --- |
| **CLI (stream-json)** | Supervised `claude` with streaming input | Binary `claude`; live stream-json transport | Current Meshrix.js conversation lane (`claude-code-cli-stream-json`) with `native_steer` |

### Forms vs history layout

One product form for attach. History is mainly `$HOME/.claude/projects`
transcripts (plus global `.claude.json` as config/prompt history, not the
project transcript tree).

## Install / binary discovery

- Binary names: `claude`
- Process names: `claude`, `claude.exe`
- Discovery: shared Meshrix.js `$PATH` and platform user-bin roots

## Data and config roots

| Kind | Template |
| --- | --- |
| Project transcripts | `$HOME/.claude/projects` |
| Global state | `$HOME/.claude.json` |
| Settings | `$HOME/.claude/settings.json` |

## Session directories

- Project transcripts under `$HOME/.claude/projects`
- Accepted browse shapes: `jsonl`, `json`, `md`, `txt`
- Delegated `subagents/agent-*.jsonl` fold into the parent in Meshrix.js history
- `tool-results/` and `workflows/` are skipped as non-conversation artifacts

### History discovery reference (Meshrix.js)

- `claude_catalog` on `claude-project-transcripts` (excludes treating
  `.claude.json` as a project session store)
- Title from bounded head probe of transcripts
- Subagent transcripts grouped under parent

## Databases / durable state

**Claim strength / 主张强度:** `transcript-primary`

No dedicated first-party sqlite inventory. Durable conversation material is the
project transcript tree; `.claude.json` is global client state.

## Session visibility in the interactive resume picker (observed)

Observed on Claude Code 2.1.211 (packaged binary) at the time this skill was
last verified. Behavior may change in later versions; re-verify against the
installed binary before relying on it. The observed behavior: Claude Code
hides SDK-spawned sessions from the interactive
`claude --resume` picker. Verified from the packaged binary:

- SDK-launched processes (`--print --input-format stream-json`) record
  `"entrypoint": "sdk-cli"` in every transcript user entry, so the Meshrix.js
  stream-json lane marks all of its sessions as SDK sessions.
- The picker filter is `LIn = {sdk-cli, sdk-ts, sdk-py}` (the current process
  entrypoint comes from `CLAUDE_CODE_ENTRYPOINT`). When the interactive process
  entrypoint (`cli`) is not in the set and the transcript entrypoint is in the
  set, the session is dropped from the picker list
  (`filtered from /resume: entrypoint=sdk-cli`).
- Consequences for Meshrix.js: Meshrix.js-driven sessions are invisible in the
  interactive resume list but remain fully on disk and resumable through the
  exact-session lookup (`claude --resume <session-id>`), which resolves by
  transcript file existence without the picker filter. Resuming a session that
  a live Meshrix.js process still owns creates a dual-writer on the transcript and
  must be avoided; continue such conversations through Meshrix.js itself.
- Interactive CLI sessions (`entrypoint: cli`) are not filtered and appear in
  the picker normally.

## Access methods

| Form | Access | Notes |
| --- | --- | --- |
| CLI stream-json | stdio streaming input | Current Meshrix.js conversation lane |

## Common adapter operations

Observed Meshrix.js adapter-facing behavior (reference):

- Detect: `claude`; `.claude/projects` or `.claude.json` as evidence
- Conversation continue: bind/continue native session on live stream-json
- In-turn guidance: write to streaming input; `native_steer` after acknowledgement
- History: project transcript tree as above
- Skill install: supported for this target in Meshrix.js
- MCP (Meshrix.js): published client target `claude-code`

## Consumer map

| Consumer | Use |
| --- | --- |
| Meshrix.js | stream-json conversation; history; skill install |
| Meshrix.js | MCP client target `claude-code` |
| Other | Path templates and stream-json notes as reusable reference |

## Fact sources

- `skills/meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md`
- https://code.claude.com/docs/en/settings
- https://github.com/anthropics/claude-code
- `crates/meshrix-js-native/src/domain/targets/catalog.rs`
- `crates/meshrix-js-native/src/domain/conversation/source_catalog.rs`
- `crates/meshrix-js-native/src/domain/conversation/history/catalog.rs`
- `crates/meshrix-js-native/resources/agent-conversation-drivers.json`
- `docs/COMPATIBILITY.md` (access fields only)
- `packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.ts`

