import {
  assertGatewayValkeyCapabilities,
  GATEWAY_VALKEY_DISCIPLINE,
} from "./gateway-valkey-discipline.ts";
import type { GatewayValkeyCapability } from "./gateway-valkey-discipline.ts";

export const GATEWAY_VALKEY_PROTOCOL_VERSION = "v0.0.1:security:gateway-valkey-1";

export function createGatewayValkeyProvider() {
  return Object.freeze({
    protocolVersion: GATEWAY_VALKEY_PROTOCOL_VERSION,
    listCapabilities() {
      const capabilities: GatewayValkeyCapability[] = [
        {
          id: GATEWAY_VALKEY_DISCIPLINE.edgeTrafficGovernance.capabilityId,
          kind: GATEWAY_VALKEY_DISCIPLINE.edgeTrafficGovernance.kind,
          operations: [...GATEWAY_VALKEY_DISCIPLINE.edgeTrafficGovernance.operations],
        },
        {
          id: GATEWAY_VALKEY_DISCIPLINE.distributedCache.capabilityId,
          kind: GATEWAY_VALKEY_DISCIPLINE.distributedCache.kind,
          operations: [...GATEWAY_VALKEY_DISCIPLINE.distributedCache.operations],
        },
      ];
      assertGatewayValkeyCapabilities(capabilities);
      return {
        protocolVersion: GATEWAY_VALKEY_PROTOCOL_VERSION,
        capabilities,
      };
    },
  });
}
