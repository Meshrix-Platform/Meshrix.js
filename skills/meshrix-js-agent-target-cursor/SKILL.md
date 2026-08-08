---
name: meshrix-js-agent-target-cursor
description: "Reference Cursor 适配项 (adaptation items): install/data paths, config, session directories, databases, access methods, adapter operations, and consumer map for Meshrix.js."
---

# Agent target: cursor

This skill is a **reference** for this agent's **适配项** (adaptation
items): install/data paths, config, session directories, databases, access
methods, adapter operations, and consumer map. It records observed first-party
facts for Meshrix.js, Meshrix.js. It does not prescribe how a
product must adapt the agent. Readiness and send-enabled claims stay in Meshrix.js
compatibility inventories, not here.

## Identity

| Field | Value |
| --- | --- |
| Canonical id | `cursor` |
| Aliases | — |
| Native capability ids | `desktop`, `cli` (inventory); in-app Agent UI is a Desktop product entry, not a separate capability id |

### Forms

Cursor is one agent id with **at least three conversation entries**. In-window
chat is not automatically “IDE Composer”, and Desktop Agent UI is not the
Meshrix.js `cursor-agent` CLI lane.

| Form | What it is | Typical evidence | Notes in current first-party use |
| --- | --- | --- | --- |
| **Desktop Composer / IDE store** | In-app composer/chat history via IDE sqlite | `…/Cursor/User/{globalStorage,workspaceStorage/**}/state.vscdb`, table `cursorDiskKV`, keys `composerData:` / `bubbleId:`… | Meshrix.js history browse of composers; child composers with `parent_composer_id` fold into parent. Not the Meshrix.js send/resume lane. |
| **Desktop Agent UI** | In-app Agent surface inside `Cursor.app` | Same Desktop app; persistence only via IDE `state.vscdb` composers and/or project `agent-transcripts` (no third exclusive root) | User-facing agent work in the IDE app. **Verified-absent** Meshrix.js send/resume lane. IDE chat id is **verified-absent** as a CLI `--resume` bridge (Cursor staff). |
| **Agent CLI** | Headless / supervised `cursor-agent` (or probed `cursor`) | Binary on search roots; `$HOME/.cursor/cli-config.json`; `$HOME/.cursor/projects/<project>/agent-transcripts/…`; `$HOME/.cursor/chats` | Current Meshrix.js conversation lane (`cursor-agent-cli-v1`). Separate session store from IDE / Desktop Agent UI (vendor-confirmed). |

#### Desktop Agent UI — recorded characteristics

- **Host**: Desktop app UI entry; in-process with the IDE shell, not the
  supervised `cursor-agent` child Meshrix.js launches
- **Relative to CLI**: No Meshrix.js Level-1/2 attach recipe for this entry; Meshrix.js
  resume/interrupt today targets Agent CLI
- **Relative to Composer**: Product may present Agent as its own surface while
  persistence still touches composer ids or `agent-transcripts`; UI name and
  store ownership can diverge by version
- **Session isolation**: In-app Agent ids and CLI/`--resume` sessions are
  separate today
- **Workspace**: Product conversations are workspace-scoped; Meshrix.js rejects
  unbounded personal roots when projecting a CLI working directory
- **History**: Meshrix.js discovery prefers CLI chats/projects, then IDE
  `state.vscdb` composers; Desktop Agent UI has no separate driver id and may
  only appear when it wrote into those stores
- **Consumers**: Meshrix.js send path = Agent CLI; Meshrix.js has no Cursor MCP target;
  in-app-Agent↔CLI continue bridge is **verified-absent** (Cursor staff + Meshrix.js
  lane split)

## Install / binary discovery

- Binary names: `cursor-agent`, `cursor` (prefer `cursor-agent` that passes ACP
  / conversation probe; probe requires a working directory)
- Process names: `cursor-agent`, `cursor-agent.exe`, `cursor`, `cursor.exe`
- Desktop app: `Cursor.app` (hosts Composer store history **and** Desktop Agent
  UI); app-bundle `.../Resources/app/bin` for CLI shims
- Discovery: shared Meshrix.js search roots including Cursor app bins

## Data and config roots

| Kind | Template |
| --- | --- |
| CLI config (vendor) | `$HOME/.cursor/cli-config.json` (Windows `%USERPROFILE%\.cursor\cli-config.json`); project `/.cursor/cli.json`; override `CURSOR_CONFIG_DIR` |
| CLI chats | `$HOME/.cursor/chats` |
| CLI projects | `$HOME/.cursor/projects` |
| IDE workspace storage | `$HOME/Library/Application Support/Cursor/User/workspaceStorage`; `%APPDATA%/Cursor/User/workspaceStorage`; `$XDG_CONFIG_HOME/Cursor/User/workspaceStorage` |
| IDE global storage | same with `globalStorage` |

Meshrix.js `default_config_path("cursor")` still points at a legacy Cline MCP
settings file under globalStorage; that is **not** the Agent CLI config. CLI
settings are `$HOME/.cursor/cli-config.json` (vendor). Desktop Agent UI has no
third exclusive root: material appears only in IDE `state.vscdb` and/or project
`agent-transcripts`.

## Session directories

### Agent CLI

- Layout:
  `$HOME/.cursor/projects/<project>/agent-transcripts/<sessionId>/<sessionId>.jsonl`
  with optional `subagents/<childId>.jsonl` folded into the parent in Meshrix.js
  history
- `$HOME/.cursor/chats` holds CLI meta
- Meshrix.js recovers working directories from project entries and rejects unbounded
  personal roots for that projection

### Desktop Composer / IDE store

- Meshrix.js lists conversations from `state.vscdb` composers (`cursorDiskKV`), not
  from arbitrary files under Application Support

### Desktop Agent UI

- No separate first-party session-root id; overlap only with IDE composer
  metadata and/or project `agent-transcripts`
- Cross-form resume identity with Agent CLI is **verified-absent** (Cursor staff:
  IDE and CLI stores do not sync for `--resume`)

### History discovery reference (Meshrix.js)

Matches Meshrix.js `cursor_catalog` in
`crates/meshrix-js-native/src/domain/conversation/history/catalog.rs`:
form-aware, ordered, structure-based. Blind walks of all of `$HOME/.cursor` or
Application Support are not how that catalog works.

1. **Agent CLI (first in Meshrix.js)**
   - `$HOME/.cursor/chats` (CLI meta)
   - Per project under `$HOME/.cursor/projects/<project>/`, only
     `agent-transcripts/`
   - Session:
     `agent-transcripts/<sessionId>/<sessionId>.jsonl`
   - `subagents/<childId>.jsonl` folded into the parent
   - Sibling noise under the same project (`mcps/`, `terminals/`, `assets/`,
     `agent-tools/`, `canvases/`, …) is outside the conversation walk

2. **Desktop Composer / IDE store (second in Meshrix.js)**
   - Shapes:
     `…/Cursor/User/globalStorage/state.vscdb`
     `…/Cursor/User/workspaceStorage/<id>/state.vscdb`
   - Shallow walk (avoids burning budget on bundled agent-CLI installs)
   - Read-only sqlite; table `cursorDiskKV`
   - Composer sessions; rows with `parent_composer_id` fold into parent

3. **Desktop Agent UI**
   - No third exclusive root in first-party inventory (**verified-absent**)
   - Appears only via writes into CLI transcripts and/or IDE composer stores
   - Meshrix.js history tags `source_kind` (CLI vs IDE); it does not auto-label a
     hit as “Desktop Agent UI”
   - Session ids / resume isolated from Agent CLI (`--resume` is
     **verified-absent** as a cross-entry bridge)

Reference contrast: Meshrix.js tags `source_kind` (CLI vs IDE storage) rather than
merging all hits as one format.

## Databases / durable state

**Claim strength / 主张强度:** `named-inventory` (IDE `state.vscdb` / `cursorDiskKV`); CLI transcripts `transcript-primary`; Desktop Agent UI exclusive store `verified-absent`

- IDE: `state.vscdb` with table `cursorDiskKV`
- Keys of interest include prefixes/shapes `bubbleId:`, `composerData:`,
  `aichat`, `composer`
- CLI transcripts under `.cursor/projects` / `.cursor/chats`
- Desktop Agent UI: no distinct database beyond the stores above

## Access methods

| Form | Access | Notes |
| --- | --- | --- |
| Desktop Composer / IDE store | Read history via `state.vscdb` composers | Browse/hydrate only for Meshrix.js history |
| Desktop Agent UI | In-app Agent surface inside `Cursor.app` | No Meshrix.js send/resume protocol today |
| Agent CLI | Process + stream-json create/resume (`cursor-agent-cli-v1`) | Primary Meshrix.js conversation lane |

## Common adapter operations

Observed Meshrix.js adapter-facing behavior (reference, not a mandated recipe):

- Detect: Desktop app presence; `cursor-agent` for CLI lane; `.cursor` trees and
  IDE storage as evidence; in-app Agent panel ≠ live CLI process
- Conversation continue (Agent CLI): create/resume native chat ID on supervised
  CLI transport
- In-turn guidance (Agent CLI): interrupt owned CLI process tree and resume the
  same chat ID (`bridge_interrupt_resume`)
- History: see **History discovery reference** (CLI then IDE composers)
- Desktop Agent UI: Meshrix.js continue/steer for this entry is **verified-absent**
  (send lane is Agent CLI only)
- Workspace projection: Meshrix.js rejects unbounded personal roots for CLI working
  directories
- MCP: not a Meshrix.js published MCP client target

## Consumer map

| Consumer | Use |
| --- | --- |
| Meshrix.js | Agent CLI conversation attach; history from CLI trees + IDE composers; Desktop Agent UI not a send lane today |
| Meshrix.js | no published MCP target |
| Other | Form split and stores above are reusable reference; in-app-Agent↔CLI resume bridge is **verified-absent** |

## Fact sources

- `skills/meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md`
- https://cursor.com/docs/cli/reference/configuration
- https://cursor.com/docs/cli/using
- https://forum.cursor.com/t/local-ide-agent-chats-and-the-agent-cli-still-use-separate-session-stores/165486
- `crates/meshrix-js-native/src/domain/targets/catalog.rs`
- `crates/meshrix-js-native/src/domain/targets/binaries.rs`
- `crates/meshrix-js-native/src/domain/conversation/source_catalog.rs`
- `crates/meshrix-js-native/src/domain/conversation/history/catalog.rs`
- `crates/meshrix-js-native/resources/agent-conversation-drivers.json`
- `docs/COMPATIBILITY.md` (access fields only)
