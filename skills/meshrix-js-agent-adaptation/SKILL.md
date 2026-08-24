---
name: meshrix-js-agent-adaptation
description: Reference index for per-agent 适配项 and claim-strength discrimination (named-inventory vs acceptance vs associated vs transcript-primary)—install/data paths, config, sessions, databases, access, operations, consumer map via meshrix-js-agent-target skills.
---

# Meshrix.js Agent Adaptation

This skill is a **reference index** for agent 适配项 (adaptation items). It does
not prescribe product workflow, implementation order, or how a consumer must
adapt an agent. When a question names an agent (for example “Cursor 需要适配哪些”,
“Codex adaptation items”), the matching `meshrix-js-agent-target-*` skill holds the
recorded facts.

These skills are not a runtime registry. Readiness and send-enabled claims stay
in Meshrix.js native inventories / `<meshrix-js>/docs/COMPATIBILITY.md`.

## 适配项 (adaptation items)

**适配项** names the per-agent fact classes recorded in each target skill:

| 适配项 | English | Meaning |
| --- | --- | --- |
| 安装/数据路径 | Install / data paths | Binary names, discovery roots, data roots |
| 配置 | Config | Config file and settings roots |
| 会话目录 | Session directories | Transcript/session store locations and shapes |
| 数据库 | Databases | sqlite/jsonl indexes and durable state meaning |
| 访问方式 | Access methods | Native interfaces products actually consume |
| 适配常用操作 | Adapter operations | Detect, continue, cancel/steer, history, MCP touch points as observed |
| 消费方映射 | Consumer map | Meshrix.js lane; Meshrix.js MCP yes/no; notes for other consumers |

Identity and fact-source sections support the reference; they are not separate
适配项 labels unless the question asks for them.

## Agent name → reference skill

| Example question topic | Reference skill |
| --- | --- |
| Cursor / cursor-agent / Desktop Agent UI | `meshrix-js-agent-target-cursor` |
| Codex / App Server | `meshrix-js-agent-target-codex` |
| Claude Code / claude | `meshrix-js-agent-target-claude-code` |
| OpenClaw / openclaw-kate | `meshrix-js-agent-target-openclaw` |
| OpenCode | `meshrix-js-agent-target-opencode` |
| Copilot / github-copilot | `meshrix-js-agent-target-copilot` |
| Kilo / kilo-code | `meshrix-js-agent-target-kilo-code` |
| Hermes | `meshrix-js-agent-target-hermes` |
| Kimi desktop / Meshrix.js kimi MCP | `meshrix-js-agent-target-kimi` |
| Kimi Code / wire.jsonl | `meshrix-js-agent-target-kimi-code` |
| Pi / pi-coding-agent | `meshrix-js-agent-target-pi` |
| Antigravity / agy | `meshrix-js-agent-target-antigravity` |
| WorkBuddy / WorkBuddy desktop | 无专用技能（未提供 `meshrix-js-agent-target-workbuddy`） |
| CodeBuddy / workbuddy CLI (`codebuddy`) | 无专用技能（未提供 `meshrix-js-agent-target-codebuddy`） |
| Trae Work / TraeWork desktop | 无专用技能（未提供 `meshrix-js-agent-target-trae-work`） |
| Trae Agent / trae-cli | 无专用技能（未提供 `meshrix-js-agent-target-trae-agent`） |

Aliases resolve through the agent index below.

## Authority boundary

| Fact class | Recorded where |
| --- | --- |
| 适配项 (paths, config, sessions, DBs, access, operations, consumers) | `meshrix-js-agent-target-*` reference skills |
| Rules for consuming a store: rows, identity, delegated lineage, bindable project directory, loading | `meshrix-js-repository/references/conversation-catalog-and-loading.md` |
| Driver mode, readiness, send-enabled, native capability inventory | Meshrix.js native JSON → `<meshrix-js>/docs/COMPATIBILITY.md` |
| Meshrix.js MCP connector allowlist and install scripts | Meshrix.js |
| Product UI and runtime detection | Owning product code |

## Privacy (what these skills record)

Path material in these skills uses portable templates only: `$HOME`,
`%APPDATA%`, `%LOCALAPPDATA%`, `$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, `$PATH`
search roots, and `<portable-data>` for Meshrix.js portable state. Absolute personal
paths, machine identity, credentials, and session plaintext are out of scope for
this reference set.

A local install on the answering machine is **not** an authority for these
skills. Presence of an app binary or Application Support tree does not upgrade
an `acceptance` claim into `named-inventory`. Skills must not leave open
`not-claimed` / `unverified` gaps; close them via
`<devkit>/skills/meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md` (vendor docs + first-party
code) in the same change.

## Claim strength (主张强度)

Every 适配项 fact—especially **数据库**—carries an explicit claim strength.
Summaries and answers must label strength; they must not collapse levels into
hedges like「可能有」. Open placeholders `not-claimed` / `unverified` are
forbidden in target skills.

| Tag | Chinese | Means | Does **not** mean |
| --- | --- | --- | --- |
| `named-inventory` | 具名库存 | Vendor docs and/or first-party code name a primary path/filename and often a table or key shape | Every machine has the file right now |
| `acceptance` | 接受规则 | First-party discovery (`accepts_file` / history catalog) **allows** listed extensions under roots when such files exist | A sqlite file is guaranteed; a schema is known |
| `associated` | 关联文件名 | First-party code references a filename under roots without a full table inventory | Complete schema or sole primary store |
| `transcript-primary` | 转录为主 | Durable conversation material is file transcripts (jsonl/md/…); no sqlite primary inventory | “No durable state at all” |
| `verified-absent` | 已核实不存在 | Inventories or vendor docs establish that the capability, path, or bridge does not exist | Soft “we did not look” |

Official vendor links and closed-gap evidence:
`<devkit>/skills/meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md`.

### Discrimination procedure (when answering or editing)

1. **Resolve** the agent → matching `meshrix-js-agent-target-*`.
2. **Locate** the 适配项 section (paths / config / sessions / databases / …).
3. **Classify** each concrete claim with one allowed tag. Prefer the strongest
   tag evidence supports; do not upgrade from local disk probes.
4. **Cite evidence**: vendor docs from the official-sources index, then Meshrix.js
   `source_catalog` / history adapters / `COMPATIBILITY` / native JSON / Meshrix.js
   allowlist. Host home scans are not fact owners.
5. **Phrase by tag**:
   - `named-inventory` → name the path/file/table (and link vendor when relevant).
   - `acceptance` → “scanners accept … under roots; no named primary DB.”
   - `associated` → “associates filename …; not a schema inventory.”
   - `transcript-primary` → “primary durable material is …; no sqlite inventory.”
   - `verified-absent` → state what is absent and which inventory/docs say so.
6. If a fact cannot yet be tagged, **stop and close it** against the official
   sources reference before shipping skill text. Do not leave a gap tag.
7. **Cross-agent tables** must include a claim-strength column or footnote per
   row.

### Forbidden substitutions

| Bad phrasing | Why | Replace with |
| --- | --- | --- |
| 「根下可能有 sqlite」 | Sounds like host presence guess | `acceptance`: 根下按接受规则可扫 sqlite |
| 「本机有 App，所以一定有库」 | Install ≠ inventory | Keep `acceptance` / `associated` until named |
| 「本机没有，所以不知道」 | Host ≠ authority | Read vendor docs + first-party maps |
| `not-claimed` / `unverified` | Open gap | Close via official-sources reference |
| Omitting strength in a DB summary | Collapses certainty | Label every row |

## Shared section schema (reference skill layout)

Each `meshrix-js-agent-target-*` skill uses this layout so 适配项 stay comparable:

1. **Identity** — canonical id, aliases, forms (supporting)
2. **Install / binary discovery** — 适配项：安装路径
3. **Data and config roots** — 适配项：数据路径、配置
4. **Session directories** — 适配项：会话目录
5. **Databases / durable state** — 适配项：数据库；open with
   `Claim strength:` / `主张强度:` and one allowed tag (never `not-claimed` /
   `unverified`)
6. **Access methods** — 适配项：访问方式
7. **Common adapter operations** — 适配项：适配常用操作（adapter-facing, not end-user tutorials）
8. **Consumer map** — 适配项：消费方映射
9. **Fact sources** — first-party pointers plus
   `meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md`

## Agent index

| Canonical id | Skill | Aliases | Meshrix.js MCP target |
| --- | --- | --- | --- |
| `openclaw` | `meshrix-js-agent-target-openclaw` | `openclaw-kate` | yes |
| `claude-code` | `meshrix-js-agent-target-claude-code` | `claude`, `claude_code`, `claudecode` | yes |
| `codex` | `meshrix-js-agent-target-codex` | — | yes |
| `antigravity` | `meshrix-js-agent-target-antigravity` | — | yes |
| `opencode` | `meshrix-js-agent-target-opencode` | `open-code`, `open_code` | yes |
| `copilot` | `meshrix-js-agent-target-copilot` | `github-copilot` | no |
| `kilo-code` | `meshrix-js-agent-target-kilo-code` | `kilo`, `kilo_code`, `kilocode` | no |
| `cursor` | `meshrix-js-agent-target-cursor` | — | no |
| `hermes` | `meshrix-js-agent-target-hermes` | `hermes-agent`, `hermes-serena` | no |
| `kimi` | `meshrix-js-agent-target-kimi` | `moonshot` | yes (id `kimi`) |
| `kimi-code` | `meshrix-js-agent-target-kimi-code` | `kimi_code`, `kimicode` | no |
| `pi` | `meshrix-js-agent-target-pi` | `pi-agent`, `pi-coding-agent` | yes |
| `workbuddy` | 无专用技能 | — | no |
| `codebuddy` | 无专用技能 | `workbuddy-cli` | no |
| `trae-work` | 无专用技能 | — | no |
| `trae-agent` | 无专用技能 | `trae-cli` | no |

`kimi` is the desktop history / Meshrix.js MCP id surface. `kimi-code` is the CLI
conversation ACP target. They are separate reference entries.

`workbuddy` (desktop) and `codebuddy` (CLI) are separate Tencent entries with
independent stores (config is **not** interchangeable between them).
`trae-work` (desktop client) and `trae-agent` (open-source CLI) are separate
ByteDance entries; neither merges with the Trae IDE family.

## Shared binary search roots

Meshrix.js discovery walks `$PATH` plus platform extras (Homebrew, npm/pnpm/Bun/Cargo
user bins, VS Code/Cursor app bins, WinGet/Chocolatey/Scoop links, Flatpak
exports). macOS filters exclude Downloads/Desktop/Documents and removable
volume mount points.
Agent-specific binaries and unique fallbacks are listed on each target skill.

## Keeping the reference current

When packaged adapters or MCP client targets change in first-party repos, the
matching target skill, this index, Meshrix.js inventories/drivers, Meshrix.js allowlists,
and the repository-owned Level 1/2 tables are the usual places that stay in
sync with those facts. This describes ownership of the reference, not a required
user workflow.

## Related reading when answering questions

Useful order when looking up 适配项: resolve the agent id → this index →
`<devkit>/skills/meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md` → apply **Claim strength**
discrimination → the matching `meshrix-js-agent-target-*` skill → Meshrix.js
`COMPATIBILITY` / native JSON for readiness or send claims → Meshrix.js installer
contracts for MCP install/uninstall. Consumers may read any subset that fits
their task; DB or cross-agent summaries always carry strength tags; never leave
`not-claimed` / `unverified` placeholders.
