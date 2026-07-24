import { callAgentGateway } from "../index.mjs";
import { modelLibraryAgentReadiness } from "../policy-validation.mjs";
import { assertModelAssistedEgressAllowed } from "../model-egress-policy.mjs";
import { redactSecretText, truncateText } from "../shared.mjs";

const PROBE_EXPECTED_ANSWER = "MeshrixProbeOK";
const PROBE_PROMPT = `This is a Meshrix model connectivity probe. Reply only with: ${PROBE_EXPECTED_ANSWER}`;
const SUPPORTED_MODEL_PROVIDERS = new Set([
  "openai",
  "deepseek",
  "openrouter",
  "copilot",
  "local-model"
]);

function asPlainObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function elapsedSince(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

function shortText(value, maxLength = 240) {
  return truncateText(
    redactSecretText(String(value || "").replace(/\s+/gu, " ").trim()),
    maxLength
  );
}

function result({
  ok,
  configured,
  provider,
  model = "",
  startedAt,
  statusCode = 0,
  message,
  answerSnippet = ""
}) {
  return {
    ok: ok === true,
    configured: configured === true,
    provider,
    model,
    statusCode,
    latencyMs: elapsedSince(startedAt),
    checkedAt: new Date().toISOString(),
    message: String(message || ""),
    ...(answerSnippet ? { answerSnippet } : {})
  };
}

function modelIdentity(entry = {}) {
  return String(entry.uid || entry.instanceId || entry.alias || "").trim();
}

function findSelectedModel(settings = {}, provider = "", modelAlias = "") {
  const matches = (Array.isArray(settings.modelLibraryAgents)
    ? settings.modelLibraryAgents
    : []).filter((entry) => (
    String(entry?.provider || "").trim() === provider &&
    modelIdentity(entry) === modelAlias
  ));
  return matches.length === 1 ? matches[0] : null;
}

function gatewayAnswer(resultValue = {}) {
  const direct = String(resultValue.answer || resultValue.text || "").trim();
  if (direct) {
    return direct;
  }
  const chunks = asPlainObject(resultValue.chunks);
  return [
    ...(Array.isArray(chunks.answer) ? chunks.answer : []),
    ...(Array.isArray(chunks.text) ? chunks.text : [])
  ].join("").trim();
}

export async function probeModelConnection({
  provider,
  settings,
  modelAlias,
  userDataPath = "",
  fetchImpl = fetch,
  contextCompactionSource = "settings.model_probe",
  egressLookup
} = {}) {
  assertModelAssistedEgressAllowed({
    source: contextCompactionSource,
    contextCompactionSource
  });
  const startedAt = Date.now();
  const normalizedProvider = String(provider || "").trim();
  const normalizedAlias = String(modelAlias || "").trim();
  if (!normalizedProvider || !normalizedAlias) {
    return result({
      ok: false,
      configured: false,
      provider: normalizedProvider || "unknown",
      startedAt,
      message: "Model probe requires an explicit provider and modelAlias."
    });
  }
  if (!SUPPORTED_MODEL_PROVIDERS.has(normalizedProvider)) {
    return result({
      ok: false,
      configured: false,
      provider: normalizedProvider,
      startedAt,
      message: `Unsupported model provider: ${normalizedProvider}`
    });
  }

  const normalizedSettings = asPlainObject(settings);
  const selected = findSelectedModel(
    normalizedSettings,
    normalizedProvider,
    normalizedAlias
  );
  const model = String(selected?.model || selected?.engine || "").trim();
  if (!selected || !model) {
    return result({
      ok: false,
      configured: false,
      provider: normalizedProvider,
      model,
      startedAt,
      message: "The explicitly selected model configuration was not found or has no model ID."
    });
  }
  const readiness = modelLibraryAgentReadiness(selected);
  if (!readiness.ready) {
    return result({
      ok: false,
      configured: false,
      provider: normalizedProvider,
      model,
      startedAt,
      message: `The explicitly selected model configuration is incomplete: ${readiness.reason}.`
    });
  }

  try {
    const gatewayResult = await callAgentGateway({
      settings: normalizedSettings,
      input: {
        provider: normalizedProvider,
        alias: normalizedAlias,
        question: PROBE_PROMPT,
        engine: model
      },
      fetchImpl,
      userDataPath,
      contextCompactionSource,
      egressLookup
    });
    const answer = gatewayAnswer(gatewayResult);
    if (!answer) {
      return result({
        ok: false,
        configured: true,
        provider: normalizedProvider,
        model,
        startedAt,
        statusCode: Number(gatewayResult?.upstream?.status || 200),
        message: "The model endpoint responded without a usable answer."
      });
    }
    const answerSnippet = shortText(answer, 120);
    return result({
      ok: true,
      configured: true,
      provider: normalizedProvider,
      model: String(gatewayResult?.upstream?.model || model),
      startedAt,
      statusCode: Number(gatewayResult?.upstream?.status || 200),
      message: `Model returned an answer: ${answerSnippet}`,
      answerSnippet
    });
  } catch (error) {
    return result({
      ok: false,
      configured: true,
      provider: normalizedProvider,
      model,
      startedAt,
      message: shortText(error instanceof Error ? error.message : "Model probe failed.")
    });
  }
}
