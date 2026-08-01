import { postJson } from "@meshrix/ui-console/bridge-http";
import type {
  AgentSettings,
  RuntimeMountConfig,
  RuntimeMountReloadResponse,
  RuntimeMountsResponse,
} from "./types";

export function saveRuntimeMounts(payload: Partial<RuntimeMountConfig>) : any {
  return postJson<RuntimeMountsResponse>(
    "/api/runtime/mounts",
    { value: payload },
    { safetyConfirm: true },
  );
}

export function reloadRuntimeMounts(settings?: AgentSettings) : any {
  return postJson<RuntimeMountReloadResponse>(
    "/api/runtime/mounts/reload",
    settings ? { settings } : {},
    { safetyConfirm: true },
  );
}
