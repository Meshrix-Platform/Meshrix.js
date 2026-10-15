const AGENT_MCP_GATEWAY_ENVELOPE_SCHEMA_VERSION = "v0.0.1:agent-mcp-traffic:gateway-envelope-1";
const GATEWAY_CHANNELS_CONTRIBUTION_SCHEMA_VERSION = "v0.0.1:plugin:gateway-channels-1";
const PLUGIN_CONFINEMENT_SCHEMA_VERSION = "v0.0.1:plugin:confinement-1";
const TRAFFIC_MODELS = Object.freeze(["workspace_application", "gateway_transit"]);
const PLUGIN_CONFINEMENT_FORBIDDEN_AUTHORITIES = Object.freeze([
  "workspace",
  "application_stage",
  "semantics",
  "identity",
  "authorization",
  "credential",
  "policy",
  "channel_selection",
  "model_gateway_lifecycle",
  "maintenance"
]);
const CONFIGURATION_FIELDS = new Set(["enabled", "downstream", "upstream"]);
const CHANNEL_FIELDS = new Set([
  "adapter",
  "endpointRefs",
  "maxConcurrency",
  "maxRatePerSecond",
  "maxQueueDepth",
  "timeoutMs",
  "circuitFailureThreshold",
  "circuitResetMs"
]);
const DIRECTIONS = Object.freeze(["downstream", "upstream"]);
const RESULT_STATUSES = new Set(["admitted", "degraded", "shed", "timeout", "cancelled", "failed"]);
const RATE_WINDOW_MS = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function confinement(pluginId) {
  return Object.freeze({
    schemaVersion: PLUGIN_CONFINEMENT_SCHEMA_VERSION,
    pluginId,
    forbiddenAuthorities: PLUGIN_CONFINEMENT_FORBIDDEN_AUTHORITIES,
    lifecycleAuthority: "availability_only"
  });
}

function activationResult(availableChoices) {
  return Object.freeze({
    trafficChanged: false,
    availableChoices: Object.freeze([...availableChoices])
  });
}

function gatewayContribution(channels) {
  return Object.freeze({
    schemaVersion: GATEWAY_CHANNELS_CONTRIBUTION_SCHEMA_VERSION,
    kind: "gatewayChannels",
    channels: Object.freeze([...channels])
  });
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertKnownFields(value, allowed, label) {
  if (!plainObject(value)) throw new TypeError(`${label} must be an object.`);
  const unsupported = Object.keys(value).find((field) => !allowed.has(field));
  if (unsupported) throw new TypeError(`${label} contains unsupported field ${unsupported}.`);
}

function boundedInteger(value, minimum, maximum, field) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`External Gateway ${field} is out of bounds.`);
  }
  return value;
}

function scheduleAt(deadlineAt, callback) {
  let timer = null;
  let cancelled = false;
  const schedule = () => {
    if (cancelled) return;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      callback();
      return;
    }
    timer = setTimeout(schedule, Math.min(MAX_TIMER_DELAY_MS, remaining));
  };
  schedule();
  return () => {
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
  };
}

function validateChannelConfiguration(input, direction) {
  assertKnownFields(input, CHANNEL_FIELDS, `External Gateway ${direction} configuration`);
  if (!new Set(["caddy", "nginx", "direct"]).has(input.adapter)) {
    throw new TypeError(`External Gateway ${direction} adapter is invalid.`);
  }
  if (!Array.isArray(input.endpointRefs) || input.endpointRefs.length < 1 || input.endpointRefs.length > 8) {
    throw new TypeError(`External Gateway ${direction} endpointRefs are out of bounds.`);
  }
  const endpointRefs = input.endpointRefs.map((value) => String(value ?? "").trim());
  if (endpointRefs.some((value) => !/^[a-z][a-z0-9._:-]{2,127}$/u.test(value)) ||
      new Set(endpointRefs).size !== endpointRefs.length) {
    throw new TypeError(`External Gateway ${direction} endpointRefs are invalid.`);
  }
  if (input.adapter === "direct" && endpointRefs.length !== 1) {
    throw new TypeError("External Gateway direct adapter requires exactly one explicit endpointRef.");
  }
  return Object.freeze({
    adapter: input.adapter,
    endpointRefs: Object.freeze(endpointRefs),
    maxConcurrency: boundedInteger(input.maxConcurrency, 1, 1_024, "maxConcurrency"),
    maxRatePerSecond: boundedInteger(input.maxRatePerSecond, 1, 100_000, "maxRatePerSecond"),
    maxQueueDepth: boundedInteger(input.maxQueueDepth, 0, 4_096, "maxQueueDepth"),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: boundedInteger(input.timeoutMs, 10, 120_000, "timeoutMs") }),
    circuitFailureThreshold: boundedInteger(input.circuitFailureThreshold, 1, 100, "circuitFailureThreshold"),
    circuitResetMs: boundedInteger(input.circuitResetMs, 10, 300_000, "circuitResetMs")
  });
}

export function validateExternalGatewayConfiguration(configuration = {}) {
  assertKnownFields(configuration, CONFIGURATION_FIELDS, "External Gateway configuration");
  if (configuration.enabled === undefined || configuration.enabled === false) {
    if (configuration.downstream !== undefined || configuration.upstream !== undefined) {
      throw new TypeError("External Gateway channel configuration requires explicit activation.");
    }
    return Object.freeze({ enabled: false });
  }
  if (configuration.enabled !== true) throw new TypeError("External Gateway enabled must be a boolean.");
  return Object.freeze({
    enabled: true,
    downstream: validateChannelConfiguration(configuration.downstream, "downstream"),
    upstream: validateChannelConfiguration(configuration.upstream, "upstream")
  });
}

function frozenEnvelope(input, direction) {
  if (!plainObject(input) || !Object.isFrozen(input) || input.envelopeVersion !== AGENT_MCP_GATEWAY_ENVELOPE_SCHEMA_VERSION ||
      input.stage !== direction || !plainObject(input.refs) || !Object.isFrozen(input.refs)) return false;
  const refs = input.refs;
  return TRAFFIC_MODELS.includes(refs.trafficModel) &&
    Number.isSafeInteger(refs.deadlineMs) && refs.deadlineMs > 0 &&
    [refs.resourceRefs, refs.inputRefs, refs.traceRefs, refs.evidenceRefs]
      .every((values) => Array.isArray(values) && Object.isFrozen(values));
}

function result(envelope, status, errorRef = null, normalizedOutcomeRef = null, generationRef = null) {
  return Object.freeze({
    stage: envelope.stage,
    trafficModel: envelope.refs.trafficModel,
    envelopeRef: `${envelope.refs.operationId}:${envelope.refs.idempotencyKey}`,
    status,
    normalizedOutcomeRef,
    errorRef,
    generationRef
  });
}

function normalizeTransportResult(envelope, value) {
  if (!plainObject(value) || !RESULT_STATUSES.has(value.status)) {
    return result(envelope, "failed", "external_gateway_transport_result_invalid");
  }
  for (const field of ["normalizedOutcomeRef", "errorRef", "generationRef"]) {
    if (value[field] !== undefined && value[field] !== null && typeof value[field] !== "string") {
      return result(envelope, "failed", "external_gateway_transport_result_invalid");
    }
  }
  return result(
    envelope,
    value.status,
    value.errorRef ?? null,
    value.normalizedOutcomeRef ?? null,
    value.generationRef ?? null
  );
}

function createChannel(direction, configuration, transport) {
  let active = 0;
  let cursor = 0;
  let closed = false;
  let closePromise = null;
  let closeComplete = false;
  const queue = [];
  const admittedAt = [];
  const activeControllers = new Set();
  const activeSettlements = new Set();
  const circuits = new Map(configuration.endpointRefs.map((endpointRef) => [
    endpointRef,
    { failures: 0, openUntil: 0 }
  ]));

  function selectEndpoint(now) {
    const eligible = configuration.endpointRefs.filter((endpointRef) => circuits.get(endpointRef).openUntil <= now);
    if (eligible.length === 0) return null;
    const endpointRef = eligible[cursor % eligible.length];
    cursor = (cursor + 1) % Number.MAX_SAFE_INTEGER;
    return endpointRef;
  }

  function recordEndpointResult(endpointRef, outcome, now) {
    const circuit = circuits.get(endpointRef);
    if (outcome.status === "admitted") {
      circuit.failures = 0;
      circuit.openUntil = 0;
      return;
    }
    if (outcome.status === "failed" || outcome.status === "timeout") {
      circuit.failures += 1;
      if (circuit.failures >= configuration.circuitFailureThreshold) {
        circuit.openUntil = now + configuration.circuitResetMs;
        circuit.failures = 0;
      }
    }
  }

  function runNext() {
    while (!closed && active < configuration.maxConcurrency && queue.length > 0) {
      const next = queue.shift();
      next.cleanupQueue();
      if (next.signal?.aborted) {
        next.resolve(result(next.envelope, "cancelled", "external_gateway_cancelled"));
        continue;
      }
      start(next);
    }
    if (closed) {
      for (const pending of queue.splice(0)) {
        pending.cleanupQueue();
        pending.resolve(result(pending.envelope, "cancelled", "external_gateway_closed"));
      }
    }
  }

  function invoke(job) {
    const now = Date.now();
    const endpointRef = selectEndpoint(now);
    if (!endpointRef) {
      const outcome = result(job.envelope, "degraded", "external_gateway_circuit_open");
      return { outcome: Promise.resolve(outcome), settled: Promise.resolve() };
    }
    const attachment = Object.freeze({
      adapter: configuration.adapter,
      endpointRef,
      instanceOwnership: configuration.adapter === "direct" ? "operator_endpoint" : "operator_existing",
      configurationAuthority: "none",
      lifecycleAuthority: "none",
      implicitFallback: false
    });
    const controller = new AbortController();
    activeControllers.add(controller);
    const cancel = () => controller.abort("external_gateway_cancelled");
    job.signal?.addEventListener("abort", cancel, { once: true });
    const cancellation = new Promise((resolve) => {
      const resolveAborted = () => {
        if (controller.signal.reason === "external_gateway_timeout") {
          resolve(result(job.envelope, "timeout", "external_gateway_timeout"));
          return;
        }
        resolve(result(job.envelope, "cancelled",
          controller.signal.reason === "external_gateway_closed"
            ? "external_gateway_closed"
            : "external_gateway_cancelled"));
      };
      controller.signal.addEventListener("abort", resolveAborted, { once: true });
      if (job.signal?.aborted) cancel();
    });
    const cancelTimeout = scheduleAt(job.deadlineAt, () => controller.abort("external_gateway_timeout"));
    const request = Object.freeze({ attachment, envelope: job.envelope, signal: controller.signal });
    const transportTask = Promise.resolve()
      .then(() => transport(request))
      .then((value) => normalizeTransportResult(job.envelope, value))
      .catch(() => {
        if (controller.signal.aborted) {
          if (controller.signal.reason === "external_gateway_timeout") {
            return result(job.envelope, "timeout", "external_gateway_timeout");
          }
          return result(job.envelope, "cancelled", controller.signal.reason === "external_gateway_closed"
            ? "external_gateway_closed"
            : "external_gateway_cancelled");
        }
        return result(job.envelope, "failed", "external_gateway_transport_failed");
      });
    const outcome = Promise.race([transportTask, cancellation]).then((value) => {
      recordEndpointResult(endpointRef, value, Date.now());
      return value;
    });
    const settled = transportTask.finally(() => {
      cancelTimeout();
      activeControllers.delete(controller);
      job.signal?.removeEventListener("abort", cancel);
    });
    return { outcome, settled };
  }

  function start(job) {
    active += 1;
    const invocation = invoke(job);
    invocation.outcome.then(job.resolve, () => {
      job.resolve(result(job.envelope, "failed", "external_gateway_transport_failed"));
    });
    let settlement;
    settlement = invocation.settled.finally(() => {
      active -= 1;
      activeSettlements.delete(settlement);
      runNext();
    });
    activeSettlements.add(settlement);
    settlement.catch(() => {});
  }

  const channel = Object.freeze({
    channelId: `external-gateway.${configuration.adapter}.${direction}`,
    direction,
    kind: "external",
    trafficModels: TRAFFIC_MODELS,
    externalAdapter: configuration.adapter,
    capabilities: Object.freeze({
      loadDistribution: "bounded",
      maxConcurrency: configuration.maxConcurrency,
      maxRatePerSecond: configuration.maxRatePerSecond,
      circuitBreaker: true,
      overloadShedding: true,
      ...(configuration.timeoutMs === undefined ? {} : { timeoutMs: configuration.timeoutMs }),
      cancellation: true,
      streaming: true,
      backpressure: true,
      degradation: "stable_transport"
    }),
    accepts(input) {
      return frozenEnvelope(input, direction);
    },
    execute(envelope, options = {}) {
      if (!frozenEnvelope(envelope, direction)) {
        return Promise.resolve(Object.freeze({
          stage: direction,
          status: "failed",
          errorRef: "external_gateway_envelope_rejected",
          normalizedOutcomeRef: null,
          generationRef: null
        }));
      }
      if (closed) return Promise.resolve(result(envelope, "failed", "external_gateway_closed"));
      if (options.signal?.aborted) return Promise.resolve(result(envelope, "cancelled", "external_gateway_cancelled"));
      const now = Date.now();
      while (admittedAt.length > 0 && admittedAt[0] <= now - RATE_WINDOW_MS) admittedAt.shift();
      if (admittedAt.length >= configuration.maxRatePerSecond) {
        return Promise.resolve(result(envelope, "shed", "external_gateway_rate_limited"));
      }
      admittedAt.push(now);
      return new Promise((resolve) => {
        let settled = false;
        let cancelQueueDeadline;
        let queuedAbort = null;
        const deadlineAt = now + Math.min(configuration.timeoutMs ?? envelope.refs.deadlineMs, envelope.refs.deadlineMs);
        const job = {
          envelope,
          signal: options.signal ?? null,
          deadlineAt,
          resolve(value) {
            if (settled) return;
            settled = true;
            resolve(value);
          },
          cleanupQueue() {
            cancelQueueDeadline?.();
            if (queuedAbort) job.signal?.removeEventListener("abort", queuedAbort);
          }
        };
        if (active < configuration.maxConcurrency) start(job);
        else if (queue.length >= configuration.maxQueueDepth) {
          resolve(result(envelope, "shed", "external_gateway_overloaded"));
        } else {
          queue.push(job);
          const removeQueued = (outcome) => {
            const index = queue.indexOf(job);
            if (index >= 0) queue.splice(index, 1);
            job.cleanupQueue();
            job.resolve(outcome);
          };
          queuedAbort = () => removeQueued(result(envelope, "cancelled", "external_gateway_cancelled"));
          job.signal?.addEventListener("abort", queuedAbort, { once: true });
          cancelQueueDeadline = scheduleAt(deadlineAt, () => {
            removeQueued(result(envelope, "timeout", "external_gateway_timeout"));
          });
        }
      });
    }
  });

  return Object.freeze({
    channel,
    close() {
      if (closePromise) {
        if (closeComplete) return Promise.resolve(Object.freeze({ ok: true, alreadyClosed: true }));
        return closePromise;
      }
      closed = true;
      for (const controller of activeControllers) controller.abort("external_gateway_closed");
      runNext();
      closePromise = Promise.all([...activeSettlements]).then(() => {
        closeComplete = true;
        return Object.freeze({ ok: true, alreadyClosed: false });
      });
      return closePromise;
    },
    snapshot() {
      return Object.freeze({
        direction,
        active,
        queued: queue.length,
        endpointCount: configuration.endpointRefs.length,
        accepting: !closed
      });
    }
  });
}

function emptyContributions() {
  return Object.freeze({ gatewayChannels: Object.freeze({}) });
}

export function createExternalGatewayPluginRuntime({ pluginId, configuration = {}, transport } = {}) {
  const admission = validateExternalGatewayConfiguration(configuration);
  const pluginConfinement = confinement(pluginId || "external-gateway");
  if (!admission.enabled) {
    let closed = false;
    return Object.freeze({
      id: pluginId || "external-gateway",
      mounts: Object.freeze({}),
      confinement: pluginConfinement,
      activation: activationResult([]),
      contributions: emptyContributions(),
      close() {
        if (closed) return Promise.resolve(Object.freeze({ ok: true, alreadyClosed: true }));
        closed = true;
        return Promise.resolve(Object.freeze({ ok: true, alreadyClosed: false }));
      }
    });
  }
  if (typeof transport !== "function") {
    throw new TypeError("External Gateway activation requires a gatewayTransport function.");
  }
  const runtimes = DIRECTIONS.map((direction) => createChannel(direction, admission[direction], transport));
  const contribution = gatewayContribution(runtimes.map((runtime) => runtime.channel));
  let closePromise = null;
  let closeComplete = false;
  return Object.freeze({
    id: pluginId || "external-gateway",
    mounts: Object.freeze({}),
    confinement: pluginConfinement,
    activation: activationResult(contribution.channels.map((channel) => channel.channelId)),
    contributions: Object.freeze({ gatewayChannels: contribution }),
    snapshot: () => Object.freeze(runtimes.map((runtime) => runtime.snapshot())),
    close() {
      if (closePromise) {
        if (closeComplete) return Promise.resolve(Object.freeze({ ok: true, alreadyClosed: true }));
        return closePromise;
      }
      closePromise = Promise.all(runtimes.map((runtime) => runtime.close())).then(() => {
        closeComplete = true;
        return Object.freeze({ ok: true, alreadyClosed: false });
      });
      return closePromise;
    }
  });
}
