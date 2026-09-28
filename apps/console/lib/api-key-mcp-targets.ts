/** Optional key audience restrictions (mirrors the gateway installer's known clients). */
export const API_KEY_MCP_TARGET_OPTIONS = Object.freeze([
  { value: "openclaw", label: "OpenClaw" },
  { value: "codex", label: "Codex" },
  { value: "claude-code", label: "Claude Code" },
  { value: "antigravity", label: "Antigravity" },
  { value: "opencode", label: "OpenCode" },
  { value: "pi", label: "Pi" },
  { value: "kimi", label: "Kimi CLI" },
] as const);

/** Connection guides affect presentation only; they never add key audience restrictions. */
export const API_KEY_MCP_CLIENT_GUIDE_OPTIONS = Object.freeze([
  { value: "generic", labelZh: "标准 MCP 客户端", labelEn: "Standard MCP client" },
  ...API_KEY_MCP_TARGET_OPTIONS.map((target) => ({
    value: target.value,
    labelZh: target.label,
    labelEn: target.label,
  })),
] as const);

export const API_KEY_DATA_CLASSIFICATION_OPTIONS = Object.freeze([
  { value: "public", labelZh: "公开", labelEn: "Public" },
  { value: "internal", labelZh: "内部", labelEn: "Internal" },
  { value: "confidential", labelZh: "机密", labelEn: "Confidential" },
  { value: "restricted", labelZh: "受限", labelEn: "Restricted" },
  { value: "secret", labelZh: "秘密", labelEn: "Secret" },
] as const);
