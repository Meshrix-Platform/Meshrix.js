/** Console-facing MCP client target allowlist (mirrors gateway installer MCP_CLIENT_TARGETS). */
export const API_KEY_MCP_TARGET_OPTIONS = Object.freeze([
  { value: "openclaw", label: "OpenClaw" },
  { value: "codex", label: "Codex" },
  { value: "claude-code", label: "Claude Code" },
  { value: "antigravity", label: "Antigravity" },
  { value: "opencode", label: "OpenCode" },
  { value: "pi", label: "Pi" },
  { value: "kimi", label: "Kimi CLI" },
] as const);

export const API_KEY_DATA_CLASSIFICATION_OPTIONS = Object.freeze([
  { value: "public", labelZh: "公开", labelEn: "Public" },
  { value: "internal", labelZh: "内部", labelEn: "Internal" },
  { value: "confidential", labelZh: "机密", labelEn: "Confidential" },
  { value: "restricted", labelZh: "受限", labelEn: "Restricted" },
  { value: "secret", labelZh: "秘密", labelEn: "Secret" },
] as const);
