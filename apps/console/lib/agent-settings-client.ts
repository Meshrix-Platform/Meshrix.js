import { getJson, postJson } from "@meshrix/ui-console/bridge-http";
import type { AgentSettings } from "./types";

export function getSettings() : any {
  return getJson<AgentSettings>("/api/settings");
}

export function saveSettings(settings: Partial<AgentSettings>) : any {
  return postJson<AgentSettings>("/api/settings", settings, { safetyConfirm: true });
}
