const target = (id: string, kind: string, script: string) : any => Object.freeze({ id, kind, script });

export const OPTIONAL_STARTUP_TARGETS: readonly any[] = Object.freeze([
  target("service:file-parser-format-convert", "service", "./targets/service-file-parser-format-convert.ts"),
  target("service:model-gateway", "service", "./targets/service-model-gateway.ts"),
  target("service:skill-hub", "service", "./targets/service-skill-hub.ts"),
  target("plugin:coding-github", "plugin", "./targets/plugin-coding-github.ts"),
  target("plugin:external-gateway", "plugin", "./targets/plugin-external-gateway.ts"),
  target("plugin:model-gateway", "plugin", "./targets/plugin-model-gateway.ts"),
  target("plugin:shared-space", "plugin", "./targets/plugin-shared-space.ts"),
  target("plugin:skill-hub", "plugin", "./targets/plugin-skill-hub.ts"),
  target("adapter:antigravity", "adapter", "./targets/adapter-antigravity.ts"),
  target("adapter:claude-code", "adapter", "./targets/adapter-claude-code.ts"),
  target("adapter:codex", "adapter", "./targets/adapter-codex.ts"),
  target("adapter:kimi", "adapter", "./targets/adapter-kimi.ts"),
  target("adapter:openclaw", "adapter", "./targets/adapter-openclaw.ts"),
  target("adapter:opencode", "adapter", "./targets/adapter-opencode.ts"),
  target("adapter:pi", "adapter", "./targets/adapter-pi.ts"),
  target("agent:self-maintenance", "agent", "./targets/agent-self-maintenance.ts"),
]);

export const OPTIONAL_STARTUP_TARGET_BY_ID: ReadonlyMap<string, any> = new Map(
  OPTIONAL_STARTUP_TARGETS.map((entry?: any) : any => [entry.id, entry]),
);
