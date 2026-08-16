import crypto from "node:crypto";

import { createAdmissionController } from "./admission.mjs";
import { createClientAuthenticator, normalizeClients } from "./auth.mjs";
import {
  addMicros,
  amountToMicros,
  microsToAmount,
  mulMicros,
  validateCurrency
} from "./fixed-point.mjs";
import { createLedger } from "./ledger.mjs";
import { createFileStore, ensureDataRoot } from "./persistence.mjs";
import { createProviderEgress } from "./providers.mjs";
import {
  resolveModel,
  validateManagedModel,
  validateManagedProvider,
  validatePricingRevision
} from "./routing.mjs";
import { stableError } from "./stable-errors.mjs";

const STATE_SCHEMA_VERSION = "v0.0.1:model-gateway:state-1";
const DEFAULT_REQUESTED_OUTPUT_TOKENS = 1024;
const DEFAULT_BOUNDS = Object.freeze({
  maxRatePerSecond: 100,
  maxInputTokenBudget: 1_000_000,
  maxRequestedOutputTokenBudget: 200_000,
  maxTotalTokenQuota: 10_000_000,
  maxConcurrentCalls: 64,
  maxCostQuotaMicros: 100_000_000,
  currency: "USD"
});

function estimateInputTokens(messages) {
  let chars = 0;
  for (const message of messages || []) {
    chars += String(message?.content || "").length;
    chars += String(message?.role || "").length;
  }
  return Math.max(1, Math.ceil(chars / 4));
}

function fingerprintPolicy(bounds) {
  return `policy-${crypto.createHash("sha256").update(JSON.stringify(bounds)).digest("hex").slice(0, 16)}`;
}

function validateBounds(bounds) {
  const merged = { ...DEFAULT_BOUNDS, ...bounds };
  for (const key of [
    "maxRatePerSecond",
    "maxInputTokenBudget",
    "maxRequestedOutputTokenBudget",
    "maxTotalTokenQuota",
    "maxConcurrentCalls",
    "maxCostQuotaMicros"
  ]) {
    if (!Number.isSafeInteger(merged[key]) || merged[key] < 1) {
      throw new TypeError(`${key} must be a positive integer.`);
    }
  }
  if (!validateCurrency(merged.currency)) {
    throw new TypeError("currency must be a three-letter code.");
  }
  return merged;
}

export async function createModelGatewayApplication(options = {}) {
  const {
    dataRoot,
    clients: envClients = {},
    requestTimeoutMs = 30_000,
    maxAttempts = 3,
    fetchImpl = fetch,
    windowMs = 60_000,
    now = Date.now,
    bounds: boundOptions = {}
  } = options;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 16) {
    throw new TypeError("maxAttempts must be an integer between 1 and 16.");
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new TypeError("requestTimeoutMs must be a positive integer.");
  }

  await ensureDataRoot(dataRoot);
  const store = createFileStore(dataRoot);
  const state = await store.readJson("state.json", null) || {
    schemaVersion: STATE_SCHEMA_VERSION,
    clients: {},
    admissionPolicy: null,
    providers: {},
    models: {},
    pricingRevisions: {},
    ledger: {}
  };
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error("Model Gateway state schema version is unsupported.");
  }

  const bounds = validateBounds(boundOptions);
  const policyRevisionRef = fingerprintPolicy(bounds);
  let stateChanged = false;
  if (state.admissionPolicy?.revisionRef !== policyRevisionRef) {
    state.admissionPolicy = { revisionRef: policyRevisionRef, ...bounds };
    stateChanged = true;
  }

  const normalizedClients = normalizeClients(envClients);
  for (const [clientId, client] of Object.entries(normalizedClients)) {
    if (JSON.stringify(state.clients[clientId] || null) !== JSON.stringify(client)) {
      state.clients[clientId] = client;
      stateChanged = true;
    }
  }

  let persistQueue = Promise.resolve();
  function schedulePersist() {
    persistQueue = persistQueue.then(() => store.writeJsonAtomic("state.json", state));
    return persistQueue;
  }

  const ledger = createLedger({ state, persist: schedulePersist });
  await ledger.reconcile();
  if (stateChanged) await schedulePersist();

  const auth = createClientAuthenticator({ clients: state.clients });
  const admission = createAdmissionController({
    policy: { ...bounds, windowMs },
    windowMs,
    now
  });
  const egress = createProviderEgress({ fetchImpl, defaultTimeoutMs: requestTimeoutMs });
  const inflight = new Map();
  let ready = false;

  function partitionKey(client, model, provider) {
    return `${client.subject}|${model.modelId}|${provider.providerId}|${state.admissionPolicy.revisionRef}`;
  }

  async function executeCall({
    client,
    model,
    provider,
    pricing,
    body,
    headers,
    idempotencyKey,
    requestId,
    signal,
    estimateInput,
    requestedOutput
  }) {
    const currency = pricing.currency;
    const inputRate = amountToMicros(pricing.inputTokenRate);
    const outputRate = amountToMicros(pricing.outputTokenRate);
    const estimatedCostMicros = addMicros(
      mulMicros(inputRate, estimateInput),
      mulMicros(outputRate, requestedOutput)
    );
    const key = partitionKey(client, model, provider);
    const decision = admission.admit({
      partitionKey: key,
      inputTokens: estimateInput,
      requestedOutputTokens: requestedOutput,
      estimatedCostMicros
    });
    if (!decision.ok) {
      return { error: stableError(decision.code, "call denied by admission policy", requestId) };
    }

    const callId = `call_${crypto.randomUUID()}`;
    const reservationRef = `res_${crypto.randomUUID()}`;
    const created = ledger.create({
      callId,
      idempotencyKey,
      modelRef: model.modelId,
      pricingRevisionRef: pricing.revisionRef,
      currency,
      reservationRef
    });
    if (created.duplicate) {
      admission.release({ partitionKey: key });
      if (created.entry.state === "settled") {
        return { replay: created.entry.response, callId: created.entry.callId };
      }
      return { error: stableError("settlement_uncertain", "call is pending or uncertain", requestId) };
    }
    await schedulePersist();

    const controller = new AbortController();
    inflight.set(callId, controller);
    const callSignal = signal || controller.signal;
    try {
      if (callSignal.aborted) {
        await ledger.markInDoubt(callId);
        await schedulePersist();
        return { error: stableError("cancelled", "call cancelled", requestId) };
      }

      const egressConfig = await store.readJson("provider-egress.json", {});
      const secrets = await store.readJson("secrets.json", {});
      const egressEntry = egressConfig[provider.providerId];
      const credential = secrets[provider.providerId];
      if (!egressEntry?.baseUrl || typeof credential !== "string" || credential.length === 0) {
        await ledger.markInDoubt(callId);
        await schedulePersist();
        return { error: stableError("provider_unavailable", "provider egress is not configured", requestId) };
      }

      let lastError = null;
      while (true) {
        if (callSignal.aborted) {
          await ledger.markInDoubt(callId);
          await schedulePersist();
          return { error: stableError("cancelled", "call cancelled", requestId) };
        }
        try {
          const result = await egress.call({
            protocol: provider.protocol,
            baseUrl: egressEntry.baseUrl,
            credential,
            body,
            headers,
            signal: callSignal,
            timeoutMs: egressEntry.timeoutMs || requestTimeoutMs
          });
          if (result.status >= 200 && result.status < 300) {
            return { ok: true, callId, body: result.body, inputRate, outputRate, currency };
          }
          lastError = result;
        } catch (error) {
          if (callSignal.aborted) {
            await ledger.markInDoubt(callId);
            await schedulePersist();
            return { error: stableError("cancelled", "call cancelled", requestId) };
          }
          lastError = { status: error?.status || 0, body: null };
        }
        if (created.entry.attempts >= maxAttempts) break;
        const bumped = ledger.bumpAttempt(callId);
        if (bumped.changed) await schedulePersist();
      }

      await ledger.markInDoubt(callId);
      await schedulePersist();
      if (lastError?.status === 429) {
        return { error: stableError("rate_limited", "provider rate limited the call", requestId) };
      }
      return { error: stableError("provider_unavailable", "provider egress failed", requestId) };
    } finally {
      inflight.delete(callId);
      admission.release({ partitionKey: key });
    }
  }

  async function settle(callId, usage, { inputRate, outputRate, currency }) {
    const inputTokens = Number.isSafeInteger(usage?.input) ? usage.input : 0;
    const outputTokens = Number.isSafeInteger(usage?.output) ? usage.output : 0;
    const amountMicros = addMicros(
      mulMicros(inputRate, inputTokens),
      mulMicros(outputRate, outputTokens)
    );
    const settled = ledger.markSettled(callId, {
      inputTokens,
      outputTokens,
      amount: microsToAmount(currency, amountMicros),
      response: usage?.response
    });
    if (settled.changed) await schedulePersist();
    return { inputTokens, outputTokens, amountMicros };
  }

  async function callOpenAi({ client, body, idempotencyKey, requestId, signal, headers }) {
    if (!auth.hasScope(client, "model:call")) {
      return { error: stableError("unauthorized", "insufficient scope", requestId) };
    }
    if (typeof body?.model !== "string" || body.model.length === 0) {
      return { error: stableError("invalid_request", "model is required", requestId) };
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0 ||
        body.messages.some((message) => typeof message?.role !== "string" || typeof message?.content !== "string")) {
      return { error: stableError("invalid_request", "messages must be a non-empty array of role/content strings", requestId) };
    }
    if (body.max_tokens !== undefined && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1)) {
      return { error: stableError("invalid_request", "max_tokens must be a positive integer", requestId) };
    }
    const resolved = resolveModel(state, body.model);
    if (!resolved) {
      return { error: stableError("model_not_found", `model ${body.model} is unavailable`, requestId) };
    }
    if (!resolved.pricing) {
      return { error: stableError("provider_unavailable", "model has no pricing revision", requestId) };
    }
    const estimateInput = estimateInputTokens(body.messages);
    const requestedOutput = body.max_tokens ?? DEFAULT_REQUESTED_OUTPUT_TOKENS;
    const result = await executeCall({
      client,
      model: resolved.model,
      provider: resolved.provider,
      pricing: resolved.pricing,
      body,
      headers,
      idempotencyKey,
      requestId,
      signal,
      estimateInput,
      requestedOutput
    });
    if (result.error) return result;
    if (result.replay) return { status: 200, body: result.replay };
    const usage = result.body?.usage || {};
    const response = { ...result.body, service_call_id: result.callId };
    await settle(result.callId, {
      input: usage.prompt_tokens,
      output: usage.completion_tokens,
      response
    }, result);
    return { status: 200, body: response };
  }

  async function callAnthropic({ client, body, idempotencyKey, requestId, signal, headers }) {
    if (!auth.hasScope(client, "model:call")) {
      return { error: stableError("unauthorized", "insufficient scope", requestId) };
    }
    if (typeof body?.model !== "string" || body.model.length === 0) {
      return { error: stableError("invalid_request", "model is required", requestId) };
    }
    if (!Number.isSafeInteger(body?.max_tokens) || body.max_tokens < 1) {
      return { error: stableError("invalid_request", "max_tokens is required", requestId) };
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0 ||
        body.messages.some((message) =>
          typeof message?.role !== "string" || typeof message?.content !== "string")) {
      return { error: stableError("invalid_request", "messages must be a non-empty array of role/content strings", requestId) };
    }
    const resolved = resolveModel(state, body.model);
    if (!resolved) {
      return { error: stableError("model_not_found", `model ${body.model} is unavailable`, requestId) };
    }
    if (!resolved.pricing) {
      return { error: stableError("provider_unavailable", "model has no pricing revision", requestId) };
    }
    const estimateInput = estimateInputTokens(body.messages);
    const requestedOutput = body.max_tokens;
    const result = await executeCall({
      client,
      model: resolved.model,
      provider: resolved.provider,
      pricing: resolved.pricing,
      body,
      headers,
      idempotencyKey,
      requestId,
      signal,
      estimateInput,
      requestedOutput
    });
    if (result.error) return result;
    if (result.replay) return { status: 200, body: result.replay };
    const usage = result.body?.usage || {};
    const response = { ...result.body, service_call_id: result.callId };
    await settle(result.callId, {
      input: usage.input_tokens,
      output: usage.output_tokens,
      response
    }, result);
    return { status: 200, body: response };
  }

  async function createProvider(client, body, requestId) {
    if (!auth.hasScope(client, "model:manage")) {
      return { error: stableError("unauthorized", "insufficient scope", requestId) };
    }
    const message = validateManagedProvider(body);
    if (message) return { error: stableError("invalid_request", message, requestId) };
    state.providers[body.providerId] = { providerId: body.providerId, protocol: body.protocol, enabled: body.enabled };
    await schedulePersist();
    return { body: state.providers[body.providerId] };
  }

  async function createModel(client, body, requestId) {
    if (!auth.hasScope(client, "model:manage")) {
      return { error: stableError("unauthorized", "insufficient scope", requestId) };
    }
    const message = validateManagedModel(state, body);
    if (message) return { error: stableError("invalid_request", message, requestId) };
    state.models[body.modelId] = { modelId: body.modelId, providerRef: body.providerRef, pricingRevisionRef: body.pricingRevisionRef, enabled: body.enabled };
    await schedulePersist();
    return { body: state.models[body.modelId] };
  }

  async function createPricingRevision(client, body, requestId) {
    if (!auth.hasScope(client, "model:manage")) {
      return { error: stableError("unauthorized", "insufficient scope", requestId) };
    }
    const message = validatePricingRevision(state.pricingRevisions[body?.revisionRef], body);
    if (message) return { error: stableError("invalid_request", message, requestId) };
    state.pricingRevisions[body.revisionRef] = {
      revisionRef: body.revisionRef,
      modelRef: body.modelRef,
      currency: body.currency,
      inputTokenRate: body.inputTokenRate,
      outputTokenRate: body.outputTokenRate,
      immutable: true
    };
    await schedulePersist();
    return { body: state.pricingRevisions[body.revisionRef] };
  }

  async function cancelCall(client, callId, requestId) {
    if (!auth.hasScope(client, "model:call")) {
      return { error: stableError("unauthorized", "insufficient scope", requestId) };
    }
    const entry = state.ledger[callId];
    if (!entry) return { error: stableError("invalid_request", "call not found", requestId) };
    if (entry.state === "settled") return { body: { callId, state: "terminal" } };
    const controller = inflight.get(callId);
    if (controller) {
      controller.abort();
      await ledger.markInDoubt(callId);
      await schedulePersist();
      return { body: { callId, state: "requested" } };
    }
    await ledger.markInDoubt(callId);
    await schedulePersist();
    return { body: { callId, state: "cancelled" } };
  }

  async function readLedger(client, callId, requestId) {
    if (!auth.hasScope(client, "ledger:read")) {
      return { error: stableError("unauthorized", "insufficient scope", requestId) };
    }
    const entry = ledger.get(callId);
    if (!entry) return { error: stableError("invalid_request", "call not found", requestId) };
    return { body: entry };
  }

  ready = true;

  return {
    health: () => ({ status: "ok" }),
    readiness: () => ({ status: ready ? "ready" : "not_ready" }),
    authenticate: (headers) => auth.authenticate(headers),
    callOpenAi,
    callAnthropic,
    createProvider,
    createModel,
    createPricingRevision,
    cancelCall,
    readLedger,
    listProviders: () => Object.values(state.providers),
    listModels: () => Object.values(state.models),
    listPricingRevisions: () => Object.values(state.pricingRevisions),
    modelDetail: (modelId) => {
      const model = state.models[modelId];
      return model ? { id: model.modelId, object: "model", owned_by: state.providers[model.providerRef]?.providerId || "model-gateway" } : null;
    },
    state,
    store,
    close: async () => {
      for (const controller of inflight.values()) controller.abort();
      await persistQueue;
    }
  };
}
