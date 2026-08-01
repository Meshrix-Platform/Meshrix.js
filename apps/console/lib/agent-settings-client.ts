import { getJson, postJson } from "@meshrix/ui-console/bridge-http";
import type { AgentSettings, ModelProbeResponse } from "./types";

export type ModelProbePayload = {
  provider: string;
  modelAlias?: string;
  settings?: AgentSettings;
};

export function getSettings() : any {
  return getJson<AgentSettings>("/api/settings");
}

export function saveSettings(settings: Partial<AgentSettings>) : any {
  return postJson<AgentSettings>("/api/settings", settings, { safetyConfirm: true });
}

export function probeModel(payload: ModelProbePayload) : any {
  return postJson<ModelProbeResponse>("/api/settings/model-probe", payload);
}
