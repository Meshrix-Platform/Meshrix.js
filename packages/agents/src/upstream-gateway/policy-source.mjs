function hasConfiguredKey(value = {}, key = "") {
  return Object.prototype.hasOwnProperty.call(value, key) &&
    value[key] !== undefined &&
    value[key] !== null;
}

export function hasTrafficPolicyInput(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return [
    "trafficPolicy",
    "rateLimit",
    "perMinute",
    "burst",
    "maxConcurrent",
    "concurrency",
    "concurrent"
  ].some((key) => hasConfiguredKey(source, key));
}

export function hasCircuitBreakerInput(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return [
    "circuitBreaker",
    "failureThreshold",
    "failuresBeforeOpen",
    "failureCount",
    "cooldownMs",
    "openMs",
    "resetAfterMs"
  ].some((key) => hasConfiguredKey(source, key));
}
