const DEFAULT_ALLOWED_MODEL_EGRESS_SOURCES: readonly any[] = Object.freeze([
  "agent_gateway.call",
  "api.agent_gateway.call",
  "settings.model_probe",
  "context-runtime",
  "summarization-runtime",
  "maintenance-agent.planner"
]);

function text(value: any = "") : any {
  return String(value || "").trim();
}

function sourceCandidates(input: Record<string, any> = {}) : any {
  return [
    input.source,
    input.contextCompactionSource,
    input.trustedSource
  ].map(text).filter(Boolean);
}

export function allowedModelEgressSources(extraSources: any = []) : any {
  return new Set<any>([
    ...DEFAULT_ALLOWED_MODEL_EGRESS_SOURCES,
    ...(Array.isArray(extraSources) ? extraSources : [])
      .map(text)
      .filter(Boolean)
  ]);
}

export function evaluateModelAssistedEgress(input: Record<string, any> = {}, options: Record<string, any> = {}) : any {
  const allowed: any = allowedModelEgressSources(options.extraAllowedSources);
  const candidates: any = sourceCandidates(input);
  const matchedSource: any = candidates.find((candidate?: any) : any => allowed.has(candidate)) || "";
  return {
    ok: Boolean(matchedSource),
    matchedSource,
    candidates,
    allowedSources: [...allowed].sort(),
    reason: matchedSource ? "allowed_model_assisted_source" : "model_assisted_source_not_allowed"
  };
}

export function assertModelAssistedEgressAllowed(input: Record<string, any> = {}, options: Record<string, any> = {}) : any {
  const decision: any = evaluateModelAssistedEgress(input, options);
  if (!decision.ok) {
    const error: Error & Record<string, any> = new Error("Model-assisted egress is not allowed for this function source.");
    error.code = "model_assisted_egress_denied";
    error.decision = decision;
    throw error;
  }
  return decision;
}
