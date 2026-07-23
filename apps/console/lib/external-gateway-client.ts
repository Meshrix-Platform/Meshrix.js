import { getJson, postJson } from "@lico/ui-console/bridge-http";
import type { ExternalGatewayState } from "../composables/console-external-gateway-controller";

export function getExternalGatewayState() {
  return getJson<ExternalGatewayState>("/api/runtime/external-gateway");
}

export function validateExternalGateway(payload: Record<string, unknown>) {
  return postJson("/api/runtime/external-gateway/validate", payload);
}

export function applyExternalGateway(payload: Record<string, unknown>) {
  return postJson<ExternalGatewayState & { ok: boolean }>(
    "/api/runtime/external-gateway/apply",
    payload,
    { safetyConfirm: true },
  );
}

export function switchExternalGatewayDirect(expectedGeneration: number) {
  return postJson<ExternalGatewayState & { ok: boolean }>(
    "/api/runtime/external-gateway/direct",
    { expectedGeneration },
    { safetyConfirm: true },
  );
}
