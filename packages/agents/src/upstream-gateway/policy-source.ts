function hasConfiguredKey(value: Record<string, unknown>, key: string) : boolean {
  return Object.prototype.hasOwnProperty.call(value, key) &&
    value[key] !== undefined &&
    value[key] !== null;
}

export function hasTrafficPolicyInput(value: unknown) : boolean {
  const source: Record<string, unknown> = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return [
    "trafficPolicy",
    "rateLimit",
    "perMinute",
    "burst",
    "maxConcurrent",
    "concurrency",
    "concurrent"
  ].some((key: string) : boolean => hasConfiguredKey(source, key));
}

export function hasCircuitBreakerInput(value: unknown) : boolean {
  const source: Record<string, unknown> = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return [
    "circuitBreaker",
    "failureThreshold",
    "failuresBeforeOpen",
    "failureCount",
    "cooldownMs",
    "openMs",
    "resetAfterMs"
  ].some((key: string) : boolean => hasConfiguredKey(source, key));
}
