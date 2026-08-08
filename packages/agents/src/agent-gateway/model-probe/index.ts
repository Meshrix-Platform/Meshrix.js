import { callAgentGateway } from "../index.ts";
import { modelLibraryAgentReadiness } from "../policy-validation.ts";
import { assertModelAssistedEgressAllowed } from "../model-egress-policy.ts";
import { redactSecretText, truncateText } from "../shared.ts";

const PROBE_EXPECTED_ANSWER: any = "MeshrixProbeOK";
const PROBE_PROMPT: any = `This is a Meshrix.js model connectivity probe. Reply only with: ${PROBE_EXPECTED_ANSWER}`;
const SUPPORTED_MODEL_PROVIDERS: any = new Set<any>([
  "openai",
  "deepseek",
  "openrouter",
  "copilot",
  "local-model"
]);

function asPlainObject(value?: any, fallback: Record<string, any> = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function elapsedSince(startedAt?: any) : any {
  return Math.max(0, Date.now() - startedAt);
}

function shortText(value?: any, maxLength: any = 240) : any {
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
}: Record<string, any>) : any {
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

function modelIdentity(entry: Record<string, any> = {}) : any {
  return String(entry.uid || entry.instanceId || entry.alias || "").trim();
}

function findSelectedModel(settings: Record<string, any> = {}, provider: any = "", modelAlias: any = "") : any {
  const matches: any = (Array.isArray(settings.modelLibraryAgents)
    ? settings.modelLibraryAgents
    : []).filter((entry?: any) : any => (
    String(entry?.provider || "").trim() === provider &&
    modelIdentity(entry) === modelAlias
  ));
  return matches.length === 1 ? matches[0] : null;
}

function gatewayAnswer(resultValue: Record<string, any> = {}) : any {
  const direct: any = String(resultValue.answer || resultValue.text || "").trim();
  if (direct) {
    return direct;
  }
  const chunks: any = asPlainObject(resultValue.chunks);
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
}: Record<string, any> = {}) : Promise<any> {
  assertModelAssistedEgressAllowed({
    source: contextCompactionSource,
    contextCompactionSource
  });
  const startedAt: any = Date.now();
  const normalizedProvider: any = String(provider || "").trim();
  const normalizedAlias: any = String(modelAlias || "").trim();
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

  const normalizedSettings: any = asPlainObject(settings);
  const selected: any = findSelectedModel(
    normalizedSettings,
    normalizedProvider,
    normalizedAlias
  );
  const model: any = String(selected?.model || selected?.engine || "").trim();
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
  const readiness: any = modelLibraryAgentReadiness(selected);
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
    const gatewayResult: any = await callAgentGateway({
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
    const answer: any = gatewayAnswer(gatewayResult);
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
    const answerSnippet: any = shortText(answer, 120);
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
  } catch (error: any) {
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
