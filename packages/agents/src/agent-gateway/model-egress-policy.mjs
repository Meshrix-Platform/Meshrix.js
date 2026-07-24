const DEFAULT_ALLOWED_MODEL_EGRESS_SOURCES = Object.freeze([
  "agent_gateway.call",
  "api.agent_gateway.call",
  "settings.model_probe",
  "context-runtime",
  "summarization-runtime",
  "maintenance-agent.planner"
]);

function text(value = "") {
  return String(value || "").trim();
}

function sourceCandidates(input = {}) {
  return [
    input.source,
    input.contextCompactionSource,
    input.trustedSource
  ].map(text).filter(Boolean);
}

export function allowedModelEgressSources(extraSources = []) {
  return new Set([
    ...DEFAULT_ALLOWED_MODEL_EGRESS_SOURCES,
    ...(Array.isArray(extraSources) ? extraSources : [])
      .map(text)
      .filter(Boolean)
  ]);
}

export function evaluateModelAssistedEgress(input = {}, options = {}) {
  const allowed = allowedModelEgressSources(options.extraAllowedSources);
  const candidates = sourceCandidates(input);
  const matchedSource = candidates.find((candidate) => allowed.has(candidate)) || "";
  return {
    ok: Boolean(matchedSource),
    matchedSource,
    candidates,
    allowedSources: [...allowed].sort(),
    reason: matchedSource ? "allowed_model_assisted_source" : "model_assisted_source_not_allowed"
  };
}

export function assertModelAssistedEgressAllowed(input = {}, options = {}) {
  const decision = evaluateModelAssistedEgress(input, options);
  if (!decision.ok) {
    const error = new Error("Model-assisted egress is not allowed for this function source.");
    error.code = "model_assisted_egress_denied";
    error.decision = decision;
    throw error;
  }
  return decision;
}
