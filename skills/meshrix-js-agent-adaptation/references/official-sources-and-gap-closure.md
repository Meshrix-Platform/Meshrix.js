# Agent adaptation — official sources and gap closure

Normative English reference for `meshrix-js-agent-adaptation` and every
`meshrix-js-agent-target-*` skill. Skills must not retain `not-claimed` or
`unverified` placeholders. Every former gap below is closed against vendor
documentation, a public repository, and/or first-party Meshrix.js code.

Portable path templates only (`$HOME`, `%APPDATA%`, `%LOCALAPPDATA%`,
`$XDG_*`, `$COPILOT_HOME`, `$HERMES_HOME`, `$KIMI_CODE_HOME`,
`<portable-data>`). Absolute personal paths are out of scope.

## Authority order when closing a fact

1. Vendor official docs / public product repository (links in the index below).
2. First-party Meshrix.js inventories and path maps (portable templates).
3. Vendor staff statements on official forums when they settle a store or bridge
   contract (cite the thread; do not treat community speculation as authority).

A local install on the answering host never upgrades or invents skill facts.

## Claim strength (no open gaps)

Allowed tags: `named-inventory`, `acceptance`, `associated`,
`transcript-primary`, `verified-absent`.

| Tag | Meaning |
| --- | --- |
| `named-inventory` | Named path, file, table, or key shape from vendor docs and/or first-party code |
| `acceptance` | Discovery accepts listed extensions under roots; not a presence guarantee |
| `associated` | Filename or detection path referenced without a full schema inventory |
| `transcript-primary` | Durable conversation material is file transcripts |
| `verified-absent` | Inventories or vendor docs establish that the capability, path, or bridge does not exist |

Do not use `not-claimed` or `unverified`. If evidence is missing, obtain it from
the index below and update the target skill in the same change.

## Official source index

| Canonical id | Docs | Repository / source surface | Primary config / home (vendor) |
| --- | --- | --- | --- |
| `openclaw` | https://docs.openclaw.ai/ | https://github.com/openclaw/openclaw | `$HOME/.openclaw/openclaw.json` (JSON5); override `OPENCLAW_CONFIG_PATH` — [configuration](https://docs.openclaw.ai/gateway/configuration) |
| `claude-code` | https://code.claude.com/docs/en/overview | https://github.com/anthropics/claude-code | `$HOME/.claude/settings.json`; `$HOME/.claude.json` — [settings](https://code.claude.com/docs/en/settings) |
| `codex` | https://developers.openai.com/codex | https://github.com/openai/codex | `$CODEX_HOME` default `$HOME/.codex`; `$HOME/.codex/config.toml` — [config](https://developers.openai.com/codex/config-reference), [env](https://developers.openai.com/codex/environment-variables) |
| `antigravity` | https://antigravity.google/docs/home | Product closed; SDK https://github.com/google-antigravity/antigravity-sdk-python | `$HOME/.gemini/config/…`; CLI `$HOME/.gemini/antigravity-cli/settings.json` — [MCP](https://antigravity.google/docs/mcp), [CLI](https://antigravity.google/docs/cli/using) |
| `opencode` | https://opencode.ai/docs/ | https://github.com/anomalyco/opencode | `$HOME/.config/opencode/opencode.json` (and `.jsonc` variants in first-party maps) — [config](https://opencode.ai/docs/config) |
| `copilot` | https://docs.github.com/en/copilot/how-tos/copilot-cli | https://github.com/github/copilot-cli | `$COPILOT_HOME` default `$HOME/.copilot`; primary settings `$COPILOT_HOME/settings.json` — [config dir](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference) |
| `kilo-code` | https://kilo.ai/docs | https://github.com/Kilo-Org/kilocode | `$HOME/.config/kilo/kilo.jsonc`; data `$HOME/.local/share/kilo/` — [settings](https://kilo.ai/docs/getting-started/settings) |
| `cursor` | https://cursor.com/docs/cli/overview | Closed product; issues https://github.com/cursor/cursor | CLI `$HOME/.cursor/cli-config.json`; project `/.cursor/cli.json`; override `CURSOR_CONFIG_DIR` — [CLI configuration](https://cursor.com/docs/cli/reference/configuration) |
| `hermes` | https://hermes-agent.nousresearch.com/docs/ | https://github.com/NousResearch/hermes-agent | `$HERMES_HOME` default `$HOME/.hermes`; `$HERMES_HOME/config.yaml` + `.env` — [configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration); Windows native installer sets `%LOCALAPPDATA%/hermes` — [Windows](https://hermes-agent.nousresearch.com/docs/user-guide/windows-native) |
| `kimi` | https://www.kimi.com/help/kimi-work/overview | Closed desktop product (no public Moonshot desktop repo) | Desktop product help; on-disk app-state paths for adapters come from Meshrix.js `platform_paths` (see gap closure) |
| `kimi-code` | https://moonshotai.github.io/kimi-code/en/ | https://github.com/MoonshotAI/kimi-code | `$KIMI_CODE_HOME` default `$HOME/.kimi-code`; `config.toml`; sessions under `sessions/` — [config files](https://moonshotai.github.io/kimi-code/en/configuration/config-files) |
| `pi` | https://pi.dev/docs/latest | https://github.com/earendil-works/pi | `$HOME/.pi/agent/settings.json`; sessions `$HOME/.pi/agent/sessions` — [settings](https://pi.dev/docs/latest/settings) |
| `workbuddy` | https://www.codebuddy.ai/docs (desktop product) | Closed desktop product (no public repo located) | `~/.workbuddy/` — desktop; `associated` (community-documented contents) |
| `codebuddy` | https://www.codebuddy.ai/docs/cli/codebuddy-dir | npm CLI package (community-reported: `workbuddy` / `@tencent-ai/codebuddy-code`); closed core | `~/.codebuddy/` + project `.codebuddy/` — `named-inventory` (official `codebuddy-dir`) |
| `trae-work` | https://docs.trae.cn/work_what-is-trae-work | Closed desktop product | `~/.trae/`, `~/.trae-cn/` — `associated`; sessions `%USERPROFILE%\.trae\sessions` — `associated` |
| `trae-agent` | https://github.com/bytedance/trae-agent | https://github.com/bytedance/trae-agent (MIT, alpha) | repo-local `trae_config.yaml`; `trajectories/` — `named-inventory` (first-party README) |

Meshrix.js MCP allowlists remain in Meshrix.js
(`mcp-release-targets.ts` and installer contracts), not in vendor docs.

## Gap closure record (former `not-claimed` / `unverified`)

### openclaw — default config file

| Was | Closure |
| --- | --- |
| Meshrix.js `default_config_path("openclaw")` is `None`; populating it remains remaining required work | **Vendor named-inventory:** `$HOME/.openclaw/openclaw.json` (JSON5), optional; override `OPENCLAW_CONFIG_PATH` ([docs](https://docs.openclaw.ai/gateway/configuration)). Meshrix.js history roots still include `$HOME/.openclaw`, `$HOME/.config/openclaw`, XDG, and `%APPDATA%/OpenClaw`. |

### hermes — default config file; TUI Gateway locality

| Was | Closure |
| --- | --- |
| Meshrix.js `default_config_path("hermes")` is `None` | **Vendor named-inventory:** `$HERMES_HOME/config.yaml` with secrets in `$HERMES_HOME/.env`; default `$HOME/.hermes` ([configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)). Native Windows installer default `HERMES_HOME=%LOCALAPPDATA%/hermes` ([Windows](https://hermes-agent.nousresearch.com/docs/user-guide/windows-native)). |
| TUI Gateway local-gateway qualification remains remaining required work | **Verified-absent as unconditional local gateway:** Meshrix.js / `COMPATIBILITY` currently treat TUI Gateway as connection-bound manual-VM transport only. A default local gateway remains remaining required work until that evidence exists. |

### copilot — default config file

| Was | Closure |
| --- | --- |
| Meshrix.js `default_config_path("copilot")` is `None` | **Vendor named-inventory:** `$COPILOT_HOME/settings.json` (JSONC), default home `$HOME/.copilot` ([config dir reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)). Session DB remains `$COPILOT_HOME/session-store.db`. |

### kimi (desktop) — conversation create/resume/steer

| Was | Closure |
| --- | --- |
| Meshrix.js conversation send/resume/steer for desktop `kimi` remains remaining required work | **Verified-absent:** Meshrix.js conversation-driver / `COMPATIBILITY` inventories currently have no send/resume/steer lane for desktop id `kimi`. History and detection use app-state roots; Meshrix.js MCP target id `kimi` is separate. CLI ACP conversation belongs to `kimi-code`. App-state config paths in Meshrix.js: macOS `$HOME/Library/Application Support/Kimi/config.json`; Windows `%APPDATA%/Kimi/config.json`; Linux `$HOME/.config/Kimi/config.json`. |

### codex — Desktop install outside macOS

| Was | Closure |
| --- | --- |
| “other platforms unverified” | **macOS:** Meshrix.js discovers `ChatGPT.app` / process `ChatGPT`. **Windows:** Official ChatGPT desktop app; winget Store id `9PLM9XGG6VKS`; shares `%USERPROFILE%\.codex` ([Windows app](https://developers.openai.com/codex/app/windows)). **Linux desktop app:** No official OpenAI Linux desktop package; unofficial community wrappers are outside this reference. Linux agents use Codex CLI / App Server with `$HOME/.codex`. |

### cursor — Desktop Agent UI store and IDE↔CLI bridge

| Was | Closure |
| --- | --- |
| Desktop Agent UI store / cross-form identity remain remaining required work; IDE↔CLI resume remains remaining required work | **CLI config named-inventory:** `$HOME/.cursor/cli-config.json` ([CLI configuration](https://cursor.com/docs/cli/reference/configuration)); resume via `agent --resume` / `agent resume` ([using](https://cursor.com/docs/cli/using)). **Verified-absent IDE↔CLI local resume bridge:** Cursor staff on the official forum state local IDE chats (`agent-transcripts` / editor index) and CLI sessions (`$HOME/.cursor/chats`, ACP stores) are separate and do not sync for `--resume` ([forum confirmation](https://forum.cursor.com/t/local-ide-agent-chats-and-the-agent-cli-still-use-separate-session-stores/165486)). **Desktop Agent UI persistence:** No third exclusive Meshrix.js history root; material appears only when written into IDE `state.vscdb` composers and/or project `agent-transcripts` (Meshrix.js `cursor_catalog` order: CLI trees, then IDE sqlite). **Verified-absent Meshrix.js send lane** for Desktop Agent UI: conversation attach is Agent CLI (`cursor-agent-cli-v1`) only. |

### workbuddy / codebuddy / trae-work / trae-agent — new reference targets (2026-08)

| Agent | Was | Closure |
| --- | --- | --- |
| `workbuddy` (Tencent desktop) | Not in the index; desktop paths community-only | **Associated:** `~/.workbuddy/` (macOS/Linux) / `%USERPROFILE%\.workbuddy\` (Windows) with `workbuddy.db`, `settings.json`, `models.json`, `mcp.json`, `SOUL.md`, `Claw/`; filenames named in community documentation, no vendor inventory located. Desktop↔CLI store independence community-confirmed (editing `~/.codebuddy/settings.json` does not affect the desktop). |
| `codebuddy` (Tencent CLI) | Not in the index | **Named-inventory:** `~/.codebuddy/` global + project `.codebuddy/` with `history.jsonl`, `sessions/`, `projects/<project>/*.jsonl`, `file-history/`, `plans/`, `traces/` etc. per official [codebuddy-dir](https://www.codebuddy.ai/docs/cli/codebuddy-dir). **Transcript-primary** conversation material. npm package name/Node ≥ 18 remain `associated` (community-reported). No ACP/stream-json documented → conversation lane remains remaining required work. |
| `trae-work` (ByteDance desktop) | Not in the index | **Associated:** `~/.trae/` / `~/.trae-cn/` roots; sessions `%USERPROFILE%\.trae\sessions` (`*.json`) with `TRAE_DATA_DIR`/`TRAE_SESSIONS_DIR`/`TRAE_SESSION_GLOB` overrides — evidence is the community [peon-ping adapter](https://github.com/PeonPing/peon-ping/blob/main/adapters/trae.ps1), not vendor docs. Official [overview](https://docs.trae.cn/work_what-is-trae-work) names web/desktop/mobile forms; CLI launch of the client **not documented** there. Work-mode custom MCP limitation per official forum. No sqlite inventory found. |
| `trae-agent` (ByteDance CLI) | Not in the index | **Named-inventory** from first-party [README](https://github.com/bytedance/trae-agent): `trae-cli` binary, `trae_config.yaml` (from `.example`), `.env`, `trajectories/trajectory_*.json` (or `--trajectory-file`). **Transcript-primary** execution material; no sqlite. Interactive TUI (`run`/`interactive`) with no ACP/JSON-RPC/serve documented → conversation lane remains remaining required work. |

## Maintenance

When a vendor moves a path or publishes a new form:

1. Update this index and the matching `meshrix-js-agent-target-*` skill together.
2. Keep claim-strength tags aligned with the closure table.
3. Regenerate the skill lock after the change set is final.
