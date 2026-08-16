import { amountToMicros, validateCurrency } from "./fixed-point.mjs";

const PROTOCOLS = new Set(["openai", "anthropic", "http"]);

export function resolveModel(state, modelId) {
  const model = state.models[modelId];
  if (!model || !model.enabled) return null;
  const provider = state.providers[model.providerRef];
  const pricing = state.pricingRevisions[model.pricingRevisionRef];
  if (!provider || !provider.enabled) return null;
  return { model, provider, pricing };
}

export function validateManagedModel(state, body) {
  if (!body || typeof body.modelId !== "string" || body.modelId.length === 0) {
    return "modelId is required.";
  }
  if (typeof body.enabled !== "boolean") {
    return "enabled is required.";
  }
  if (typeof body.providerRef !== "string" || !state.providers[body.providerRef]) {
    return "providerRef must reference an existing provider.";
  }
  const pricing = state.pricingRevisions[body.pricingRevisionRef];
  if (typeof body.pricingRevisionRef !== "string" || !pricing) {
    return "pricingRevisionRef must reference an existing pricing revision.";
  }
  if (pricing.modelRef !== body.modelId) {
    return "pricingRevisionRef is bound to a different model identity.";
  }
  return null;
}

export function validateManagedProvider(body) {
  if (!body || typeof body.providerId !== "string" || body.providerId.length === 0) {
    return "providerId is required.";
  }
  if (!PROTOCOLS.has(body.protocol)) {
    return "protocol must be one of openai, anthropic, http.";
  }
  if (typeof body.enabled !== "boolean") {
    return "enabled is required.";
  }
  return null;
}

export function validatePricingRevision(existing, body) {
  if (!body || typeof body.revisionRef !== "string" || body.revisionRef.length === 0) {
    return "revisionRef is required.";
  }
  if (typeof body.modelRef !== "string" || body.modelRef.length === 0) {
    return "modelRef is required.";
  }
  if (!validateCurrency(body.currency)) {
    return "currency must be a three-letter code.";
  }
  if (body.immutable !== true) {
    return "immutable must be true.";
  }
  for (const field of ["inputTokenRate", "outputTokenRate"]) {
    try {
      amountToMicros(body[field]);
    } catch {
      return `${field} must be a fixed-point amount at scale 10^6.`;
    }
  }
  if (existing) {
    const existingShape = {
      modelRef: existing.modelRef,
      currency: existing.currency,
      inputTokenRate: existing.inputTokenRate,
      outputTokenRate: existing.outputTokenRate,
      immutable: existing.immutable
    };
    const candidateShape = {
      modelRef: body.modelRef,
      currency: body.currency,
      inputTokenRate: body.inputTokenRate,
      outputTokenRate: body.outputTokenRate,
      immutable: true
    };
    if (JSON.stringify(existingShape) !== JSON.stringify(candidateShape)) {
      return "pricing revisions are immutable and cannot be replaced.";
    }
  }
  return null;
}
