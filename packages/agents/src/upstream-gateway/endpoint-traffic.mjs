import {
  asArray,
  normalizeTrafficPolicy,
  text
} from "./support.mjs";

export function createEndpointTrafficController({
  trafficBuckets,
  endpointCursors,
  endpointCircuits,
  appendAudit,
  recordMetric,
  persist
}) {
  function trafficKey(service, operation) {
    return `${service.serviceId}::${operation.operationKey}`;
  }
  function endpointKey(service, operation, endpoint = {}) {
    return `${trafficKey(service, operation)}::${endpoint.endpointId || "primary"}`;
  }
  function endpointsFor(service) {
    const configured = asArray(service.endpoints).filter(Boolean);
    const endpoints = configured.filter(
      (endpoint) => endpoint.disabled !== true
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
  function endpointHasOwnTrafficPolicy(endpoint = {}) {
    return endpoint.trafficPolicySource === "endpoint" && endpoint.trafficPolicyInherited !== true;
  }
  function publicEndpoint(endpoint = {}) {
    return {
      endpointId: endpoint.endpointId || "primary",
      weight: Number(endpoint.weight || 1),
      circuitBreakerEnabled: endpoint.circuitBreaker?.enabled !== false,
      trafficPolicySource: endpoint.trafficPolicySource || "service",
      circuitBreakerSource: endpoint.circuitBreakerSource || "service"
    };
  }
  function circuitSnapshot(key, breaker = {}) {
    const nowMs = Date.now();
    const current = endpointCircuits.get(key) || {
      consecutiveFailures: 0,
      openedUntilMs: 0
    };
    if (Number(current.openedUntilMs || 0) > 0 && Number(current.openedUntilMs || 0) <= nowMs) {
      const reset = { consecutiveFailures: 0, openedUntilMs: 0 };
      endpointCircuits.set(key, reset);
      return {
        ...reset,
        open: false,
        openedUntil: "",
        retryAfterMs: 0
      };
    }
    const retryAfterMs = Math.max(0, Number(current.openedUntilMs || 0) - nowMs);
    return {
      consecutiveFailures: Number(current.consecutiveFailures || 0),
      openedUntilMs: Number(current.openedUntilMs || 0),
      open: breaker.enabled !== false && retryAfterMs > 0,
      openedUntil: retryAfterMs > 0 ? new Date(Number(current.openedUntilMs || 0)).toISOString() : "",
      retryAfterMs
    };
  }
  function recordEndpointOutcome(service, operation, endpoint, { statusCode = 0, ok = false } = {}) {
    if (!endpoint?.endpointId) return;
    const breaker = endpoint.circuitBreaker || service.circuitBreaker || {};
    if (breaker.enabled === false) return;
    const key = endpointKey(service, operation, endpoint);
    if (ok === true) {
      endpointCircuits.set(key, { consecutiveFailures: 0, openedUntilMs: 0 });
      return;
    }
    const status = Number(statusCode || 0);
    if (!(status === 0 || status === 429 || status >= 500)) {
      return;
    }
    const current = circuitSnapshot(key, breaker);
    const consecutiveFailures = Number(current.consecutiveFailures || 0) + 1;
    const threshold = Number(breaker.failureThreshold || 3);
    endpointCircuits.set(key, {
      consecutiveFailures,
      openedUntilMs: consecutiveFailures >= threshold
        ? Date.now() + Number(breaker.cooldownMs || 30_000)
        : 0
    });
  }
  function trafficSnapshot(service, operation, policy, { commit = false, endpoint = null } = {}) {
    const nowMs = Date.now();
    const key = endpoint ? endpointKey(service, operation, endpoint) : trafficKey(service, operation);
    const current = trafficBuckets.get(key) || {
      tokens: policy.burst,
      updatedAtMs: nowMs,
      inFlight: 0
    };
    const elapsedMs = Math.max(0, nowMs - Number(current.updatedAtMs || nowMs));
    const refillRatePerMs = policy.perMinute / 60_000;
    const tokens = Math.min(policy.burst, Number(current.tokens ?? policy.burst) + elapsedMs * refillRatePerMs);
    const next = {
      tokens,
      updatedAtMs: nowMs,
      inFlight: Math.max(0, Number(current.inFlight || 0))
    };
    if (commit) {
      trafficBuckets.set(key, next);
    }
    return next;
  }
  function trafficDecision(service, operation, { consume = true, endpoint = null } = {}) {
    const selectedEndpoint = endpoint || endpointsFor(service)[0];
    const policy = normalizeTrafficPolicy(service.trafficPolicy);
    const endpointPolicy = endpointHasOwnTrafficPolicy(selectedEndpoint)
      ? normalizeTrafficPolicy(selectedEndpoint?.trafficPolicy || {})
      : null;
    const key = endpointKey(service, operation, selectedEndpoint);
    const circuit = circuitSnapshot(key, selectedEndpoint?.circuitBreaker || service.circuitBreaker || {});
    const bucket = trafficSnapshot(service, operation, policy, { commit: false });
    const endpointBucket = endpointPolicy
      ? trafficSnapshot(service, operation, endpointPolicy, { commit: false, endpoint: selectedEndpoint })
      : null;
    const hasToken = bucket.tokens >= 1;
    const hasConcurrency = bucket.inFlight < policy.maxConcurrent;
    const endpointHasToken = endpointBucket ? endpointBucket.tokens >= 1 : true;
    const endpointHasConcurrency = endpointBucket ? endpointBucket.inFlight < endpointPolicy.maxConcurrent : true;
    const allowed = !circuit.open && hasToken && hasConcurrency && endpointHasToken && endpointHasConcurrency;
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
    const retryAfterMs = circuit.open
      ? circuit.retryAfterMs
      : !hasToken
        ? Math.ceil((1 - bucket.tokens) / (policy.perMinute / 60_000))
        : endpointBucket && !endpointHasToken
          ? Math.ceil((1 - endpointBucket.tokens) / (endpointPolicy.perMinute / 60_000))
          : 0;
    const deniedReason = allowed
      ? ""
      : circuit.open
        ? "circuit_open"
        : !hasToken || (endpointBucket && !endpointHasToken)
          ? "token_bucket_empty"
          : "concurrency_limit_exceeded";
    const deniedScope = allowed
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
  function consumeAllowedTraffic(service, operation, endpoint, traffic) {
    const policy = normalizeTrafficPolicy(service.trafficPolicy);
    const bucket = trafficSnapshot(service, operation, policy, {
      commit: false
    });
    bucket.tokens -= 1;
    bucket.inFlight += 1;
    trafficBuckets.set(trafficKey(service, operation), bucket);
    let endpointLimit = null;
    if (endpointHasOwnTrafficPolicy(endpoint)) {
      const endpointPolicy = normalizeTrafficPolicy(endpoint.trafficPolicy || {});
      const endpointBucket = trafficSnapshot(
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
  function noEnabledEndpointTraffic(service, operation) {
    const policy = normalizeTrafficPolicy(service.trafficPolicy);
    const bucket = trafficSnapshot(service, operation, policy, {
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
  function selectEndpointTraffic(service, operation, { consume = false } = {}) {
    const endpoints = endpointsFor(service);
    const cursorKey = trafficKey(service, operation);
    if (endpoints.length === 0) {
      if (consume) endpointCursors.delete(cursorKey);
      return {
        endpoint: null,
        traffic: noEnabledEndpointTraffic(service, operation)
      };
    }
    const signature = JSON.stringify(
      endpoints.map((endpoint) => [
        String(endpoint.endpointId || "primary"),
        Number(endpoint.weight)
      ])
    );
    const previous = endpointCursors.get(cursorKey);
    const currentWeights =
      previous?.signature === signature && previous.currentWeights
        ? { ...previous.currentWeights }
        : {};
    let fallback = null;
    let selected = null;
    let selectedTraffic = null;
    let selectedWeight = Number.NEGATIVE_INFINITY;
    let eligibleWeight = 0;
    for (const endpoint of endpoints) {
      const traffic = trafficDecision(service, operation, {
        consume: false,
        endpoint
      });
      fallback ||= { endpoint, traffic };
      const endpointId = String(endpoint.endpointId || "primary");
      if (!traffic.allowed) {
        currentWeights[endpointId] = 0;
        continue;
      }
      const weight = Number(endpoint.weight);
      const nextWeight = Number(currentWeights[endpointId] || 0) + weight;
      currentWeights[endpointId] = nextWeight;
      eligibleWeight += weight;
      if (nextWeight > selectedWeight) {
        selected = endpoint;
        selectedTraffic = traffic;
        selectedWeight = nextWeight;
      }
    }
    if (selected) {
      const selectedId = String(selected.endpointId || "primary");
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
  function releaseTraffic(service, operation, endpoint = null) {
    const selectedEndpoint = endpoint || endpointsFor(service)[0];
    if (!selectedEndpoint) return;
    const policy = normalizeTrafficPolicy(service.trafficPolicy);
    const bucket = trafficSnapshot(service, operation, policy, { commit: false });
    bucket.inFlight = Math.max(0, bucket.inFlight - 1);
    bucket.updatedAtMs = Date.now();
    trafficBuckets.set(trafficKey(service, operation), bucket);
    if (endpointHasOwnTrafficPolicy(selectedEndpoint)) {
      const endpointPolicy = normalizeTrafficPolicy(selectedEndpoint.trafficPolicy || {});
      const key = endpointKey(service, operation, selectedEndpoint);
      const endpointBucket = trafficSnapshot(service, operation, endpointPolicy, {
        commit: false,
        endpoint: selectedEndpoint
      });
      endpointBucket.inFlight = Math.max(0, endpointBucket.inFlight - 1);
      endpointBucket.updatedAtMs = Date.now();
      trafficBuckets.set(key, endpointBucket);
    }
  }
  async function withTrafficSlot(service, operation, preview, run) {
    const { endpoint, traffic } = selectEndpointTraffic(service, operation, { consume: true });
    if (!traffic.allowed) {
      recordMetric({ serviceId: service.serviceId, statusCode: 429, failed: true });
      const audit = appendAudit("upstream.traffic.denied", {
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
  function retireServices(serviceIds = []) {
    const retired = new Set(
      (Array.isArray(serviceIds) ? serviceIds : [])
        .map((serviceId) => text(serviceId))
        .filter(Boolean)
    );
    if (retired.size === 0) return Object.freeze({ removed: 0 });
    let removed = 0;
    for (const state of [trafficBuckets, endpointCursors, endpointCircuits]) {
      for (const key of state.keys()) {
        const separator = key.indexOf("::");
        const serviceId = separator < 0 ? key : key.slice(0, separator);
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
