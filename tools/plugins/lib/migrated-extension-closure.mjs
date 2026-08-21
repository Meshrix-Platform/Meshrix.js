export const MIGRATED_RUNTIME_PLUGIN_IDS = Object.freeze([
  "coding-github",
  "shared-space",
  "skill-hub"
]);

export const MIGRATED_CLIENT_ADAPTER_IDS = Object.freeze([
  "agent-antigravity",
  "agent-claude-code",
  "agent-codex",
  "agent-kimi",
  "agent-openclaw",
  "agent-opencode",
  "agent-pi"
]);

export function assertMigratedExtensionClosure(registry) {
  const plugins = Array.isArray(registry?.plugins) ? registry.plugins : [];
  const byId = new Map(plugins.map((entry) => [entry.id, entry]));
  if (MIGRATED_RUNTIME_PLUGIN_IDS.some((id) => {
    const entry = byId.get(id);
    return entry?.runtime !== true || entry?.release !== true;
  })) throw new Error("migrated runtime plugin catalog entries are incomplete");
  if (MIGRATED_CLIENT_ADAPTER_IDS.some((id) => {
    const entry = byId.get(id);
    return entry?.adapter !== true || entry?.release !== true;
  })) throw new Error("migrated client adapter catalog entries are incomplete");
  return Object.freeze({
    runtimeCount: plugins.filter((entry) => entry.runtime === true).length,
    adapterCount: plugins.filter((entry) => entry.adapter === true).length,
    migratedRuntimeCount: MIGRATED_RUNTIME_PLUGIN_IDS.length,
    migratedAdapterCount: MIGRATED_CLIENT_ADAPTER_IDS.length
  });
}
