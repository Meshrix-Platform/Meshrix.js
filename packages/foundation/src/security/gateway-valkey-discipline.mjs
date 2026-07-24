const EDGE_TRAFFIC_OPERATIONS = Object.freeze([
  "gateway.policy.preview",
  "gateway.forward",
  "gateway.payload.transit",
  "gateway.artifacts.get",
  "gateway.audit",
  "gateway.metrics",
]);

const DISTRIBUTED_CACHE_OPERATIONS = Object.freeze([
  "getCacheEntry",
  "setCacheEntry",
  "deleteCacheEntry",
  "invalidateCacheNamespace",
]);

export const GATEWAY_VALKEY_DISCIPLINE = Object.freeze({
  id: "gateway-valkey",
  edgeTrafficGovernance: Object.freeze({
    capabilityId: "edge-traffic-governance",
    kind: "gateway",
    operations: EDGE_TRAFFIC_OPERATIONS,
  }),
  distributedCache: Object.freeze({
    capabilityId: "distributed-cache",
    kind: "cache",
    operations: DISTRIBUTED_CACHE_OPERATIONS,
  }),
  separation: Object.freeze({
    trafficDecisions: "edge-traffic-governance",
    cacheLayer: "distributed-cache",
    cachePromotionToAuthority: "forbidden",
  }),
});

function capabilityById(capabilities, capabilityId) {
  return capabilities.find((entry) => entry?.id === capabilityId) ?? null;
}

function operationsMatch(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((operation, index) => actual[index] === operation);
}

export function assertGatewayValkeyCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) {
    throw new Error("Gateway and Valkey capabilities must be an array.");
  }
  const governance = capabilityById(
    capabilities,
    GATEWAY_VALKEY_DISCIPLINE.edgeTrafficGovernance.capabilityId,
  );
  const cache = capabilityById(
    capabilities,
    GATEWAY_VALKEY_DISCIPLINE.distributedCache.capabilityId,
  );
  if (!governance || governance.kind !== GATEWAY_VALKEY_DISCIPLINE.edgeTrafficGovernance.kind) {
    throw new Error("Edge traffic governance must remain behind the governed gateway capability.");
  }
  if (!cache || cache.kind !== GATEWAY_VALKEY_DISCIPLINE.distributedCache.kind) {
    throw new Error("Distributed cache must remain behind the non-authoritative cache capability.");
  }
  if (!operationsMatch(governance.operations, GATEWAY_VALKEY_DISCIPLINE.edgeTrafficGovernance.operations)) {
    throw new Error("Governed gateway operations changed without updating the edge-traffic contract.");
  }
  if (!operationsMatch(cache.operations, GATEWAY_VALKEY_DISCIPLINE.distributedCache.operations)) {
    throw new Error("Distributed cache operations changed without updating the cache contract.");
  }
  return true;
}
