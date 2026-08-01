import {
  asArray,
  normalizeTrafficPolicy,
  text
} from "./support.ts";

export function createEndpointTrafficController({
  trafficBuckets,
  endpointCursors,
  endpointCircuits,
  appendAudit,
  recordMetric,
  persist
}: Record<string, any>) : any {
  function trafficKey(service?: any, operation?: any) : any {
    return `${service.serviceId}::${operation.operationKey}`;
  }
  function endpointKey(service?: any, operation?: any, endpoint: Record<string, any> = {}) : any {
    return `${trafficKey(service, operation)}::${endpoint.endpointId || "primary"}`;
  }
  function endpointsFor(service?: any) : any {
    const configured: any = asArray(service.endpoints).filter(Boolean);
    const endpoints: any = configured.filter(
      (endpoint?: any) : any => endpoint.disabled !== true
    );
    if (endpoints.length > 0) return endpoints;
    if (configured.length > 0) return [];
    return [{
      endpointId: "primary",
      baseUrl: service.baseUrl,
      weight: 1,
      trafficPolicy: service.trafficPolicy,
      trafficPolicySource: "service",
      trafficPolicyInherited: true,
      circuitBreaker: service.circuitBreaker,
      circuitBreakerSource: "service",
      circuitBreakerInherited: true
    }];
  }
  function endpointHasOwnTrafficPolicy(endpoint: Record<string, any> = {}) : any {
    return endpoint.trafficPolicySource === "endpoint" && endpoint.trafficPolicyInherited !== true;
  }
  function publicEndpoint(endpoint: Record<string, any> = {}) : any {
    return {
      endpointId: endpoint.endpointId || "primary",
      weight: Number(endpoint.weight || 1),
      circuitBreakerEnabled: endpoint.circuitBreaker?.enabled !== false,
      trafficPolicySource: endpoint.trafficPolicySource || "service",
      circuitBreakerSource: endpoint.circuitBreakerSource || "service"
    };
  }
  function circuitSnapshot(key?: any, breaker: Record<string, any> = {}) : any {
    const nowMs: any = Date.now();
    const current: any = endpointCircuits.get(key) || {
      consecutiveFailures: 0,
      openedUntilMs: 0
    };
    if (Number(current.openedUntilMs || 0) > 0 && Number(current.openedUntilMs || 0) <= nowMs) {
      const reset: Record<string, any> = { consecutiveFailures: 0, openedUntilMs: 0 };
      endpointCircuits.set(key, reset);
      return {
        ...reset,
        open: false,
        openedUntil: "",
        retryAfterMs: 0
      };
    }
    const retryAfterMs: any = Math.max(0, Number(current.openedUntilMs || 0) - nowMs);
    return {
      consecutiveFailures: Number(current.consecutiveFailures || 0),
      openedUntilMs: Number(current.openedUntilMs || 0),
      open: breaker.enabled !== false && retryAfterMs > 0,
      openedUntil: retryAfterMs > 0 ? new Date(Number(current.openedUntilMs || 0)).toISOString() : "",
      retryAfterMs
    };
  }
  function recordEndpointOutcome(service?: any, operation?: any, endpoint?: any, { statusCode = 0, ok = false }: Record<string, any> = {}) : any {
    if (!endpoint?.endpointId) return;
    const breaker: any = endpoint.circuitBreaker || service.circuitBreaker || {};
    if (breaker.enabled === false) return;
    const key: any = endpointKey(service, operation, endpoint);
    if (ok === true) {
      endpointCircuits.set(key, { consecutiveFailures: 0, openedUntilMs: 0 });
      return;
    }
    const status: any = Number(statusCode || 0);
    if (!(status === 0 || status === 429 || status >= 500)) {
      return;
    }
    const current: any = circuitSnapshot(key, breaker);
    const consecutiveFailures: any = Number(current.consecutiveFailures || 0) + 1;
    const threshold: any = Number(breaker.failureThreshold || 3);
    endpointCircuits.set(key, {
      consecutiveFailures,
      openedUntilMs: consecutiveFailures >= threshold
        ? Date.now() + Number(breaker.cooldownMs || 30_000)
        : 0
    });
  }
  function trafficSnapshot(service?: any, operation?: any, policy?: any, { commit = false, endpoint = null }: Record<string, any> = {}) : any {
    const nowMs: any = Date.now();
    const key: any = endpoint ? endpointKey(service, operation, endpoint) : trafficKey(service, operation);
    const current: any = trafficBuckets.get(key) || {
      tokens: policy.burst,
      updatedAtMs: nowMs,
      inFlight: 0
    };
    const elapsedMs: any = Math.max(0, nowMs - Number(current.updatedAtMs || nowMs));
    const refillRatePerMs: any = policy.perMinute / 60_000;
    const tokens: any = Math.min(policy.burst, Number(current.tokens ?? policy.burst) + elapsedMs * refillRatePerMs);
    const next: Record<string, any> = {
      tokens,
      updatedAtMs: nowMs,
      inFlight: Math.max(0, Number(current.inFlight || 0))
    };
    if (commit) {
      trafficBuckets.set(key, next);
    }
    return next;
  }
  function trafficDecision(service?: any, operation?: any, { consume = true, endpoint = null }: Record<string, any> = {}) : any {
    const selectedEndpoint: any = endpoint || endpointsFor(service)[0];
    const policy: any = normalizeTrafficPolicy(service.trafficPolicy);
    const endpointPolicy: any = endpointHasOwnTrafficPolicy(selectedEndpoint)
      ? normalizeTrafficPolicy(selectedEndpoint?.trafficPolicy || {})
      : null;
    const key: any = endpointKey(service, operation, selectedEndpoint);
    const circuit: any = circuitSnapshot(key, selectedEndpoint?.circuitBreaker || service.circuitBreaker || {});
    const bucket: any = trafficSnapshot(service, operation, policy, { commit: false });
    const endpointBucket: any = endpointPolicy
      ? trafficSnapshot(service, operation, endpointPolicy, { commit: false, endpoint: selectedEndpoint })
      : null;
    const hasToken: any = bucket.tokens >= 1;
    const hasConcurrency: any = bucket.inFlight < policy.maxConcurrent;
    const endpointHasToken: any = endpointBucket ? endpointBucket.tokens >= 1 : true;
    const endpointHasConcurrency: any = endpointBucket ? endpointBucket.inFlight < endpointPolicy.maxConcurrent : true;
    const allowed: any = !circuit.open && hasToken && hasConcurrency && endpointHasToken && endpointHasConcurrency;
    if (consume && allowed) {
      bucket.tokens -= 1;
      bucket.inFlight += 1;
      trafficBuckets.set(trafficKey(service, operation), bucket);
      if (endpointBucket) {
        endpointBucket.tokens -= 1;
        endpointBucket.inFlight += 1;
        trafficBuckets.set(key, endpointBucket);
      }
    }
    const retryAfterMs: any = circuit.open
      ? circuit.retryAfterMs
      : !hasToken
        ? Math.ceil((1 - bucket.tokens) / (policy.perMinute / 60_000))
        : endpointBucket && !endpointHasToken
          ? Math.ceil((1 - endpointBucket.tokens) / (endpointPolicy.perMinute / 60_000))
          : 0;
    const deniedReason: any = allowed
      ? ""
      : circuit.open
        ? "circuit_open"
        : !hasToken || (endpointBucket && !endpointHasToken)
          ? "token_bucket_empty"
          : "concurrency_limit_exceeded";
    const deniedScope: any = allowed
      ? ""
      : circuit.open
        ? "endpoint"
        : !hasToken || !hasConcurrency
          ? "service"
          : "endpoint";
    return {
      allowed,
      algorithm: policy.algorithm,
      routingAlgorithm: policy.routingAlgorithm,
      endpoint: publicEndpoint(selectedEndpoint),
      circuit: {
        open: circuit.open,
        consecutiveFailures: circuit.consecutiveFailures,
        openedUntil: circuit.openedUntil,
        retryAfterMs: circuit.retryAfterMs
      },
      perMinute: policy.perMinute,
      burst: policy.burst,
      maxConcurrent: policy.maxConcurrent,
      remainingTokens: Math.max(0, Math.floor(bucket.tokens)),
      inFlight: bucket.inFlight,
      serviceLimit: {
        perMinute: policy.perMinute,
        burst: policy.burst,
        maxConcurrent: policy.maxConcurrent,
        remainingTokens: Math.max(0, Math.floor(bucket.tokens)),
        inFlight: bucket.inFlight
      },
      endpointLimit: endpointBucket
        ? {
            perMinute: endpointPolicy.perMinute,
            burst: endpointPolicy.burst,
            maxConcurrent: endpointPolicy.maxConcurrent,
            remainingTokens: Math.max(0, Math.floor(endpointBucket.tokens)),
            inFlight: endpointBucket.inFlight
          }
        : null,
      retryAfterMs: Math.max(0, retryAfterMs),
      resetAt: new Date(Date.now() + Math.max(0, retryAfterMs)).toISOString(),
      deniedReason,
      deniedScope
    };
  }
  function consumeAllowedTraffic(service?: any, operation?: any, endpoint?: any, traffic?: any) : any {
    const policy: any = normalizeTrafficPolicy(service.trafficPolicy);
    const bucket: any = trafficSnapshot(service, operation, policy, {
      commit: false
    });
    bucket.tokens -= 1;
    bucket.inFlight += 1;
    trafficBuckets.set(trafficKey(service, operation), bucket);
    let endpointLimit: any = null;
    if (endpointHasOwnTrafficPolicy(endpoint)) {
      const endpointPolicy: any = normalizeTrafficPolicy(endpoint.trafficPolicy || {});
      const endpointBucket: any = trafficSnapshot(
        service,
        operation,
        endpointPolicy,
        { commit: false, endpoint }
      );
      endpointBucket.tokens -= 1;
      endpointBucket.inFlight += 1;
      trafficBuckets.set(endpointKey(service, operation, endpoint), endpointBucket);
      endpointLimit = {
        perMinute: endpointPolicy.perMinute,
        burst: endpointPolicy.burst,
        maxConcurrent: endpointPolicy.maxConcurrent,
        remainingTokens: Math.max(0, Math.floor(endpointBucket.tokens)),
        inFlight: endpointBucket.inFlight
      };
    }
    return {
      ...traffic,
      remainingTokens: Math.max(0, Math.floor(bucket.tokens)),
      inFlight: bucket.inFlight,
      serviceLimit: {
        perMinute: policy.perMinute,
        burst: policy.burst,
        maxConcurrent: policy.maxConcurrent,
        remainingTokens: Math.max(0, Math.floor(bucket.tokens)),
        inFlight: bucket.inFlight
      },
      endpointLimit
    };
  }
  function noEnabledEndpointTraffic(service?: any, operation?: any) : any {
    const policy: any = normalizeTrafficPolicy(service.trafficPolicy);
    const bucket: any = trafficSnapshot(service, operation, policy, {
      commit: false
    });
    return {
      allowed: false,
      algorithm: policy.algorithm,
      routingAlgorithm: policy.routingAlgorithm,
      endpoint: null,
      circuit: {
        open: false,
        consecutiveFailures: 0,
        openedUntil: "",
        retryAfterMs: 0
      },
      perMinute: policy.perMinute,
      burst: policy.burst,
      maxConcurrent: policy.maxConcurrent,
      remainingTokens: Math.max(0, Math.floor(bucket.tokens)),
      inFlight: bucket.inFlight,
      serviceLimit: {
        perMinute: policy.perMinute,
        burst: policy.burst,
        maxConcurrent: policy.maxConcurrent,
        remainingTokens: Math.max(0, Math.floor(bucket.tokens)),
        inFlight: bucket.inFlight
      },
      endpointLimit: null,
      retryAfterMs: 0,
      resetAt: new Date().toISOString(),
      deniedReason: "no_enabled_endpoint",
      deniedScope: "endpoint"
    };
  }
  function selectEndpointTraffic(service?: any, operation?: any, { consume = false }: Record<string, any> = {}) : any {
    const endpoints: any = endpointsFor(service);
    const cursorKey: any = trafficKey(service, operation);
    if (endpoints.length === 0) {
      if (consume) endpointCursors.delete(cursorKey);
      return {
        endpoint: null,
        traffic: noEnabledEndpointTraffic(service, operation)
      };
    }
    const signature: any = JSON.stringify(
      endpoints.map((endpoint?: any) : any => [
        String(endpoint.endpointId || "primary"),
        Number(endpoint.weight)
      ])
    );
    const previous: any = endpointCursors.get(cursorKey);
    const currentWeights: any =
      previous?.signature === signature && previous.currentWeights
        ? { ...previous.currentWeights }
        : {};
    let fallback: any = null;
    let selected: any = null;
    let selectedTraffic: any = null;
    let selectedWeight: any = Number.NEGATIVE_INFINITY;
    let eligibleWeight: any = 0;
    for (const endpoint of endpoints) {
      const traffic: any = trafficDecision(service, operation, {
        consume: false,
        endpoint
      });
      fallback ||= { endpoint, traffic };
      const endpointId: any = String(endpoint.endpointId || "primary");
      if (!traffic.allowed) {
        currentWeights[endpointId] = 0;
        continue;
      }
      const weight: any = Number(endpoint.weight);
      const nextWeight: any = Number(currentWeights[endpointId] || 0) + weight;
      currentWeights[endpointId] = nextWeight;
      eligibleWeight += weight;
      if (nextWeight > selectedWeight) {
        selected = endpoint;
        selectedTraffic = traffic;
        selectedWeight = nextWeight;
      }
    }
    if (selected) {
      const selectedId: any = String(selected.endpointId || "primary");
      currentWeights[selectedId] -= eligibleWeight;
    }
    if (consume) {
      endpointCursors.set(cursorKey, {
        signature,
        currentWeights
      });
    }
    if (selected) {
      return {
        endpoint: selected,
        traffic: consume
          ? consumeAllowedTraffic(
              service,
              operation,
              selected,
              selectedTraffic
            )
          : selectedTraffic
      };
    }
    return fallback || {
      endpoint: endpoints[0],
      traffic: trafficDecision(service, operation, { consume: false, endpoint: endpoints[0] })
    };
  }
  function releaseTraffic(service?: any, operation?: any, endpoint: any = null) : any {
    const selectedEndpoint: any = endpoint || endpointsFor(service)[0];
    if (!selectedEndpoint) return;
    const policy: any = normalizeTrafficPolicy(service.trafficPolicy);
    const bucket: any = trafficSnapshot(service, operation, policy, { commit: false });
    bucket.inFlight = Math.max(0, bucket.inFlight - 1);
    bucket.updatedAtMs = Date.now();
    trafficBuckets.set(trafficKey(service, operation), bucket);
    if (endpointHasOwnTrafficPolicy(selectedEndpoint)) {
      const endpointPolicy: any = normalizeTrafficPolicy(selectedEndpoint.trafficPolicy || {});
      const key: any = endpointKey(service, operation, selectedEndpoint);
      const endpointBucket: any = trafficSnapshot(service, operation, endpointPolicy, {
        commit: false,
        endpoint: selectedEndpoint
      });
      endpointBucket.inFlight = Math.max(0, endpointBucket.inFlight - 1);
      endpointBucket.updatedAtMs = Date.now();
      trafficBuckets.set(key, endpointBucket);
    }
  }
  async function withTrafficSlot(service?: any, operation?: any, preview?: any, run?: any) : Promise<any> {
    const { endpoint, traffic } = selectEndpointTraffic(service, operation, { consume: true });
    if (!traffic.allowed) {
      recordMetric({ serviceId: service.serviceId, statusCode: 429, failed: true });
      const audit: any = appendAudit("upstream.traffic.denied", {
        serviceId: service.serviceId,
        operationKey: operation.operationKey,
        protocol: operation.protocol,
        reason: traffic.deniedReason || "traffic_limit_exceeded",
        traffic
      });
      persist();
      throw Object.assign(new Error("Upstream gateway traffic limit exceeded."), {
        status: 429,
        audit,
        details: {
          ...preview,
          traffic
        }
      });
    }
    try {
      return await run(traffic, endpoint);
    } finally {
      releaseTraffic(service, operation, endpoint);
    }
  }
  function retireServices(serviceIds: any = []) : any {
    const retired: any = new Set<any>(
      (Array.isArray(serviceIds) ? serviceIds : [])
        .map((serviceId?: any) : any => text(serviceId))
        .filter(Boolean)
    );
    if (retired.size === 0) return Object.freeze({ removed: 0 });
    let removed: any = 0;
    for (const state of [trafficBuckets, endpointCursors, endpointCircuits]) {
      for (const key of state.keys()) {
        const separator: any = key.indexOf("::");
        const serviceId: any = separator < 0 ? key : key.slice(0, separator);
        if (!retired.has(serviceId)) continue;
        state.delete(key);
        removed += 1;
      }
    }
    return Object.freeze({ removed });
  }
  return {
    endpointsFor,
    publicEndpoint,
    recordEndpointOutcome,
    retireServices,
    selectEndpointTraffic,
    withTrafficSlot
  };
}
