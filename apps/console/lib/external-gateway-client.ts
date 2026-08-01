import { getJson, postJson } from "@meshrix/ui-console/bridge-http";
import type { ExternalGatewayState } from "../composables/console-external-gateway-controller";

export function getExternalGatewayState() : any {
  return getJson<ExternalGatewayState>("/api/runtime/external-gateway");
}

export function validateExternalGateway(payload: Record<string, unknown>) : any {
  return postJson("/api/runtime/external-gateway/validate", payload);
}

export function applyExternalGateway(payload: Record<string, unknown>) : any {
  return postJson<ExternalGatewayState & { ok: boolean }>(
    "/api/runtime/external-gateway/apply",
    payload,
    { safetyConfirm: true },
  );
}

export function switchExternalGatewayDirect(expectedGeneration: number) : any {
  return postJson<ExternalGatewayState & { ok: boolean }>(
    "/api/runtime/external-gateway/direct",
    { expectedGeneration },
    { safetyConfirm: true },
  );
}
