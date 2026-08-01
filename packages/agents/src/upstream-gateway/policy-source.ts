function hasConfiguredKey(value: Record<string, any> = {}, key: any = "") : any {
  return Object.prototype.hasOwnProperty.call(value, key) &&
    value[key] !== undefined &&
    value[key] !== null;
}

export function hasTrafficPolicyInput(value: Record<string, any> = {}) : any {
  const source: any = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return [
    "trafficPolicy",
    "rateLimit",
    "perMinute",
    "burst",
    "maxConcurrent",
    "concurrency",
    "concurrent"
  ].some((key?: any) : any => hasConfiguredKey(source, key));
}

export function hasCircuitBreakerInput(value: Record<string, any> = {}) : any {
  const source: any = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return [
    "circuitBreaker",
    "failureThreshold",
    "failuresBeforeOpen",
    "failureCount",
    "cooldownMs",
    "openMs",
    "resetAfterMs"
  ].some((key?: any) : any => hasConfiguredKey(source, key));
}
