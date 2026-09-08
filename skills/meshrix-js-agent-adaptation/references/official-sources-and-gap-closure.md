# Agent adaptation sources

Vendor references below were checked on 2026-09-08. They are rolling documents,
not a tested client-version matrix. Retained facts in each target entry are
limited to the linked configuration surface. Recheck an affected fact when a
client version or requested behavior changes; no scheduled audit is required.

| Target reference | Primary vendor source | Checked |
| --- | --- | --- |
| codex | [Codex](https://developers.openai.com/codex/config-basic) | 2026-09-08 |
| claude-code | [Claude Code](https://code.claude.com/docs/en/settings) | 2026-09-08 |
| openclaw | [OpenClaw](https://docs.openclaw.ai/gateway/configuration) | 2026-09-08 |
| opencode | [OpenCode](https://opencode.ai/docs/config) | 2026-09-08 |
| antigravity | [Antigravity](https://antigravity.google/docs/mcp) | 2026-09-08 |
| pi | [Pi](https://pi.dev/docs/latest/settings) | 2026-09-08 |
| kimi | [Kimi MCP adapter](https://moonshotai.github.io/kimi-code/en/configuration/config-files) | 2026-09-08 |
| kimi-code | [Kimi Code CLI](https://moonshotai.github.io/kimi-code/en/configuration/config-files) | 2026-09-08 |
| copilot | [GitHub Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference) | 2026-09-08 |
| cursor | [Cursor Agent CLI](https://cursor.com/docs/cli/reference/configuration) | 2026-09-08 |
| kilo-code | [Kilo Code](https://kilo.ai/docs/getting-started/settings) | 2026-09-08 |
| hermes | [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/configuration) | 2026-09-08 |


The [official Linux app reference](https://learn.chatgpt.com/docs/linux/linux-app)
documents the OpenAI Linux desktop preview. Vendor availability does not
establish Meshrix.js qualification.

## Evidence ownership

- Vendor documentation owns vendor configuration and supported product forms.
- Current `plugins/agents/<target>/adapter.mjs` files own packaged MCP lifecycle
  behavior; the installer catalog owns the accepted package coordinates.
- `docs/COMPATIBILITY.md` owns named-client qualification requirements.
- A missing implementation reference is not evidence that a vendor feature
  does not exist. Remove unsupported implementation claims or label the
  specific unverified scope; do not manufacture a closed-gap status.
- Use portable path templates. Do not scan personal histories, databases,
  credentials, or application data to populate these references.

When changing a fact, update this index and its target entry, then regenerate
the distribution from canonical skills. Do not edit installed projections or
introduce a separate skill lock.
