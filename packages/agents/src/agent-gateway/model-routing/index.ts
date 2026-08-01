import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ServerConfig } from "@meshrix/foundation/config/server-config";
import {
  appendBoundedJsonLine,
  readJsonlTail
} from "@meshrix/foundation/storage/bounded-jsonl";
import {
  releaseModelRoutingTrafficSlot,
  reserveModelRoutingTrafficSlot
} from "./model-routing-traffic.ts";
import {
  agentGatewayError,
  normalizeAgentGatewayError
} from "../errors.ts";

export const MODEL_ROUTING_PROTOCOL_VERSION: any = "v0.0.1:strategy:model-routing-1";

const DEFAULT_STATE_FILE: any = path.join("state", "model-routing-state.json");
const DEFAULT_LEDGER_FILE: any = path.join("logs", "model-routing-ledger.jsonl");
const MODEL_ROUTING_LEDGER_MAX_BYTES: any = 32 * 1024 * 1024;

function asObject(value?: any, fallback: Record<string, any> = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;
}

function asArray(value?: any) : any {
  return Array.isArray(value) ? value : [];
}

function nowIso() : any {
  return new Date().toISOString();
}

function normalizeText(value?: any) : any {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function hashValue(value?: any, length: any = 24) : any {
  return crypto
    .createHash("sha256")
    .update(String(value ?? ""))
    .digest("hex")
    .slice(0, length);
}

function estimateTokens(value?: any) : any {
  const text: any = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const cjkCount: any = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const nonCjkCount: any = Math.max(0, text.length - cjkCount);
  return Math.max(1, Math.ceil(cjkCount * 0.9 + nonCjkCount / 4));
}

function unique(values: any = []) : any {
  const out: any[] = [];
  const seen: any = new Set<any>();
  for (const value of values) {
    const normalized: any = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizePositiveNumber(value?: any, fallback: any = 0) : any {
  const number: any = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function statePath(userDataPath: any = "") : any {
  return path.join(
    userDataPath || ServerConfig.getDataDir(),
    DEFAULT_STATE_FILE,
  );
}

function ledgerPath(userDataPath: any = "") : any {
  return path.join(
    userDataPath || ServerConfig.getDataDir(),
    DEFAULT_LEDGER_FILE,
  );
}

function stateLockPath(userDataPath: any = "") : any {
  return `${statePath(userDataPath)}.lock`;
}

async function readJsonFile(filePath?: any, fallback?: any) : Promise<any> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonFile(filePath?: any, payload?: any) : Promise<any> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function appendJsonl(filePath?: any, payload?: any) : Promise<any> {
  await appendBoundedJsonLine(filePath, payload, {
    maxBytes: MODEL_ROUTING_LEDGER_MAX_BYTES,
    retainedBytes: MODEL_ROUTING_LEDGER_MAX_BYTES / 2
  });
}

async function readLedger(filePath?: any, limit: any = 200) : Promise<any> {
  return readJsonlTail(filePath, {
    limit,
    maxScanBytes: MODEL_ROUTING_LEDGER_MAX_BYTES / 2
  });
}

function normalizeState(value: Record<string, any> = {}) : any {
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: MODEL_ROUTING_PROTOCOL_VERSION,
    updatedAt: String(value.updatedAt || ""),
    circuits: asObject(value.circuits),
    inFlight: asObject(value.inFlight),
  };
}

export async function readModelRoutingState({ userDataPath = "" }: Record<string, any> = {}) : Promise<any> {
  return normalizeState(await readJsonFile(statePath(userDataPath), {}));
}

async function writeModelRoutingState({ userDataPath = "", state }: Record<string, any>) : Promise<any> {
  const next: any = normalizeState({
    ...state,
    updatedAt: nowIso(),
  });
  await writeJsonFile(statePath(userDataPath), next);
  return next;
}

function routeSource(settings: Record<string, any> = {}, input: Record<string, any> = {}) : any {
  return {
    ...asObject(settings.modelRouting),
    ...asObject(input.modelRouting),
  };
}

export function shouldUseModelRouting(input: Record<string, any> = {}, settings: Record<string, any> = {}) : any {
  const source: any = routeSource(settings, input);
  return Boolean(
    source.enabled === true ||
    source.candidateChain ||
    source.budget ||
    source.rateLimit ||
    source.circuitBreaker ||
    source.promptVersion ||
    source.priceTable,
  );
}

export function normalizeModelRoutingPolicy({
  settings = {},
  input = {},
}: Record<string, any> = {}) : any {
  const source: any = routeSource(settings, input);
  const explicitAlias: any = normalizeText(
    input.modelAlias || input.alias || input.agentAlias || input.model || "",
  );
  const candidateChain: any = unique([
    explicitAlias,
    ...asArray(source.candidateChain),
  ]);
  const maxAttempts: any = Math.max(
    1,
    Math.min(
      candidateChain.length || 1,
      Number(source.maxAttempts || candidateChain.length || 1),
    ),
  );
  const circuitSource: any =
    source.circuitBreaker === false
      ? { enabled: false }
      : asObject(source.circuitBreaker);
  return {
    protocolVersion: MODEL_ROUTING_PROTOCOL_VERSION,
    enabled: shouldUseModelRouting(input, settings),
    routeId: normalizeText(
      source.routeId ||
        input.routeId ||
        input.moduleId ||
        input.featureId ||
        "",
    ),
    subjectId: normalizeText(
      source.subjectId || input.userId || input.subjectId || "",
    ),
    workspaceId: normalizeText(source.workspaceId || input.workspaceId || ""),
    promptVersion: normalizeText(
      source.promptVersion ||
        input.promptVersion ||
        input.parameters?.promptVersion ||
        "",
    ),
    candidateChain: candidateChain.slice(0, maxAttempts),
    budget: {
      maxInputTokens: normalizePositiveNumber(source.budget?.maxInputTokens, 0),
      maxOutputTokens: normalizePositiveNumber(
        source.budget?.maxOutputTokens,
        0,
      ),
      maxEstimatedTotalTokens: normalizePositiveNumber(
        source.budget?.maxEstimatedTotalTokens,
        0,
      ),
      maxEstimatedUsd: normalizePositiveNumber(
        source.budget?.maxEstimatedUsd,
        0,
      ),
      currency: normalizeText(source.budget?.currency || ""),
    },
    rateLimit: {
      windowMs: normalizePositiveNumber(source.rateLimit?.windowMs, 0),
      maxCalls: normalizePositiveNumber(source.rateLimit?.maxCalls, 0),
      maxConcurrent: normalizePositiveNumber(
        source.rateLimit?.maxConcurrent,
        0,
      ),
      maxInFlightMs: normalizePositiveNumber(
        source.rateLimit?.maxInFlightMs,
        0,
      ),
    },
    circuitBreaker: {
      enabled: circuitSource.enabled === true,
      failureThreshold: normalizePositiveNumber(
        circuitSource.failureThreshold,
        0,
      ),
      openMs: normalizePositiveNumber(circuitSource.openMs, 0),
    },
    priceTable: asObject(source.priceTable),
    metadata: asObject(source.metadata),
  };
}

function priceForCandidate(policy: Record<string, any> = {}, candidate: Record<string, any> = {}, config: Record<string, any> = {}) : any {
  const table: any = asObject(policy.priceTable);
  const keys: any = [
    candidate.alias,
    config.alias,
    config.model,
    config.provider,
  ].filter(Boolean);
  for (const key of keys) {
    const price: any = asObject(table[key]);
    if (Object.keys(price).length > 0) {
      return {
        inputUsdPer1MTokens: normalizePositiveNumber(
          price.inputUsdPer1MTokens,
          0,
        ),
        outputUsdPer1MTokens: normalizePositiveNumber(
          price.outputUsdPer1MTokens,
          0,
        ),
      };
    }
  }
  return { inputUsdPer1MTokens: 0, outputUsdPer1MTokens: 0 };
}

function outputTokenBudget(input: Record<string, any> = {}, policy: Record<string, any> = {}) : any {
  return normalizePositiveNumber(
    input.parameters?.max_tokens ??
      input.parameters?.maxTokens ??
      policy.budget.maxOutputTokens,
    0,
  );
}

function buildBudgetReceipt({
  input = {},
  policy = {},
  candidate = {},
  config = {},
}: Record<string, any> = {}) : any {
  const estimatedInputTokens: any = estimateTokens({
    question: input.question || input.query || "",
    messages: input.messages || [],
    systemPrompt: input.systemPrompt || "",
    tools: input.parameters?.tools || [],
  });
  const estimatedOutputTokens: any = outputTokenBudget(input, policy);
  const price: any = priceForCandidate(policy, candidate, config);
  const estimatedInputUsd: any =
    (estimatedInputTokens * price.inputUsdPer1MTokens) / 1_000_000;
  const estimatedOutputUsd: any =
    (estimatedOutputTokens * price.outputUsdPer1MTokens) / 1_000_000;
  const estimatedTotalUsd: any = Number(
    (estimatedInputUsd + estimatedOutputUsd).toFixed(8),
  );
  const estimatedTotalTokens: any = estimatedInputTokens + estimatedOutputTokens;
  const violations: any[] = [];
  if (
    policy.budget.maxInputTokens &&
    estimatedInputTokens > policy.budget.maxInputTokens
  ) {
    violations.push("maxInputTokens");
  }
  if (
    policy.budget.maxOutputTokens &&
    estimatedOutputTokens > policy.budget.maxOutputTokens
  ) {
    violations.push("maxOutputTokens");
  }
  if (
    policy.budget.maxEstimatedTotalTokens &&
    estimatedTotalTokens > policy.budget.maxEstimatedTotalTokens
  ) {
    violations.push("maxEstimatedTotalTokens");
  }
  if (
    policy.budget.maxEstimatedUsd &&
    estimatedTotalUsd > policy.budget.maxEstimatedUsd
  ) {
    violations.push("maxEstimatedUsd");
  }
  return {
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens,
    estimatedTotalUsd,
    currency: policy.budget.currency,
    price,
    ok: violations.length === 0,
    violations,
  };
}

function usageFromResult(result: Record<string, any> = {}) : any {
  const usage: any = asObject(
    result.payload?.usage || result.payload?.payload?.usage || result.usage,
  );
  return {
    promptTokens: Number(usage.prompt_tokens || usage.promptTokens || 0),
    completionTokens: Number(
      usage.completion_tokens || usage.completionTokens || 0,
    ),
    totalTokens: Number(usage.total_tokens || usage.totalTokens || 0),
  };
}

function actualCostFromUsage(usage: Record<string, any> = {}, price: Record<string, any> = {}) : any {
  const inputUsd: any =
    (Number(usage.promptTokens || 0) * Number(price.inputUsdPer1MTokens || 0)) /
    1_000_000;
  const outputUsd: any =
    (Number(usage.completionTokens || 0) *
      Number(price.outputUsdPer1MTokens || 0)) /
    1_000_000;
  return Number((inputUsd + outputUsd).toFixed(8));
}

function circuitForAlias(state: Record<string, any> = {}, alias: any = "") : any {
  return asObject(state.circuits?.[alias]);
}

function circuitOpen(circuit: Record<string, any> = {}, nowMs: any = Date.now()) : any {
  const openUntil: any = Date.parse(circuit.openUntil || "");
  return (
    circuit.state === "open" && Number.isFinite(openUntil) && openUntil > nowMs
  );
}

function updateCircuitSuccess(state: Record<string, any> = {}, alias: any = "") : any {
  const circuit: Record<string, any> = {
    ...circuitForAlias(state, alias),
    state: "closed",
    failureCount: 0,
    lastSuccessAt: nowIso(),
    openUntil: "",
    lastError: "",
  };
  return {
    ...state,
    circuits: {
      ...asObject(state.circuits),
      [alias]: circuit,
    },
  };
}

function updateCircuitFailure(state: Record<string, any> = {}, alias: any = "", error?: any, policy: Record<string, any> = {}) : any {
  const current: any = circuitForAlias(state, alias);
  const failureCount: any = Number(current.failureCount || 0) + 1;
  const shouldOpen: any =
    policy.circuitBreaker.enabled &&
    failureCount >= policy.circuitBreaker.failureThreshold;
  const openedAt: any = shouldOpen ? nowIso() : String(current.openedAt || "");
  const openUntil: any = shouldOpen
    ? new Date(Date.now() + policy.circuitBreaker.openMs).toISOString()
    : String(current.openUntil || "");
  return {
    ...state,
    circuits: {
      ...asObject(state.circuits),
      [alias]: {
        ...current,
        state: shouldOpen ? "open" : "closed",
        failureCount,
        openedAt,
        openUntil,
        lastFailureAt: nowIso(),
        lastError: error instanceof Error ? error.message : String(error),
      },
    },
  };
}

async function recentLedgerCount({
  userDataPath = "",
  policy = {},
  routeId = "",
}: Record<string, any> = {}) : Promise<any> {
  if (!policy.rateLimit.maxCalls) {
    return 0;
  }
  const rows: any = await readLedger(ledgerPath(userDataPath), 2000);
  const since: any = Date.now() - policy.rateLimit.windowMs;
  return rows.filter((row?: any) : any => {
    const ts: any = Date.parse(row.ts || "");
    return (
      Number.isFinite(ts) &&
      ts >= since &&
      row.routeId === routeId &&
      row.status === "success"
    );
  }).length;
}

function candidateInput(input: Record<string, any> = {}, alias: any = "") : any {
  return {
    ...input,
    alias,
    modelAlias: alias,
  };
}

function publicAttempt(attempt: Record<string, any> = {}) : any {
  return {
    alias: attempt.alias,
    status: attempt.status,
    reason: attempt.reason || "",
    error: attempt.error || "",
    errorCode: attempt.errorCode || "",
    retryable: attempt.retryable === true,
    budget: attempt.budget || null,
    circuit: attempt.circuit || null,
    startedAt: attempt.startedAt || "",
    completedAt: attempt.completedAt || "",
  };
}

export async function runModelRouting({
  settings = {},
  input = {},
  userDataPath = "",
  registry = [],
  executeCandidate,
}: Record<string, any> = {}) : Promise<any> {
  void registry;
  const policy: any = normalizeModelRoutingPolicy({ settings, input });
  if (!policy.enabled) {
    throw new Error("Model routing policy is not enabled.");
  }
  if (!policy.candidateChain.length) {
    throw new Error("Model routing has no candidates.");
  }
  if (!policy.routeId) {
    throw new Error("Model routing requires an explicit routeId.");
  }
  if (policy.rateLimit.maxCalls > 0 && policy.rateLimit.windowMs <= 0) {
    throw new Error("Model routing maxCalls requires an explicit rateLimit.windowMs.");
  }
  if (policy.rateLimit.maxConcurrent > 0 && policy.rateLimit.maxInFlightMs <= 0) {
    throw new Error("Model routing maxConcurrent requires an explicit rateLimit.maxInFlightMs.");
  }
  if (policy.circuitBreaker.enabled &&
      (policy.circuitBreaker.failureThreshold <= 0 || policy.circuitBreaker.openMs <= 0)) {
    throw new Error("Enabled model routing circuit breaker requires failureThreshold and openMs.");
  }
  const routeCallId: any = crypto.randomUUID();
  const trafficReservation: any = await reserveModelRoutingTrafficSlot({
    userDataPath,
    policy,
    routeCallId,
    lockPath: stateLockPath,
    readState: readModelRoutingState,
    writeState: writeModelRoutingState
  });
  let state: any = await readModelRoutingState({ userDataPath });
  const attempts: any[] = [];
  try {
    const rateLimitCount: any = await recentLedgerCount({
      userDataPath,
      policy,
      routeId: policy.routeId,
    });
    if (
      policy.rateLimit.maxCalls &&
      rateLimitCount >= policy.rateLimit.maxCalls
    ) {
      throw new Error(
        `Model routing rate limit exceeded for ${policy.routeId}.`,
      );
    }

    for (const alias of policy.candidateChain) {
      const startedAt: any = nowIso();
      const circuit: any = circuitForAlias(state, alias);
      if (circuitOpen(circuit)) {
        attempts.push({
          alias,
          status: "skipped",
          reason: "circuit_open",
          circuit: {
            state: circuit.state,
            failureCount: Number(circuit.failureCount || 0),
            openUntil: String(circuit.openUntil || ""),
          },
          startedAt,
          completedAt: nowIso(),
        });
        continue;
      }

      const candidate: Record<string, any> = { alias };
      const nextInput: any = candidateInput(input, alias);
      let executed: any = null;
      let budget: any = null;
      try {
        executed = await executeCandidate({
          alias,
          input: nextInput,
          dryRun: true,
        });
        budget = buildBudgetReceipt({
          input: nextInput,
          policy,
          candidate,
          config: executed?.config || {},
        });
        if (!budget.ok) {
          attempts.push({
            alias,
            status: "skipped",
            reason: "budget_violation",
            budget,
            startedAt,
            completedAt: nowIso(),
          });
          await appendJsonl(ledgerPath(userDataPath), {
            schemaVersion: "v0.0.1:schema:definition-1",
            protocolVersion: MODEL_ROUTING_PROTOCOL_VERSION,
            ts: nowIso(),
            ledgerId: crypto.randomUUID(),
            routeCallId,
            routeId: policy.routeId,
            promptVersion: policy.promptVersion,
            alias,
            status: "skipped",
            reason: "budget_violation",
            budget,
            inputHash: hashValue(JSON.stringify(nextInput)),
            metadata: policy.metadata,
          });
          continue;
        }

        executed = await executeCandidate({
          alias,
          input: nextInput,
          dryRun: false,
        });
        const result: any = executed.result || {};
        const usage: any = usageFromResult(result);
        const actualEstimatedUsd: any = actualCostFromUsage(usage, budget.price);
        state = updateCircuitSuccess(state, alias);
        await writeModelRoutingState({ userDataPath, state });
        const ledgerId: any = crypto.randomUUID();
        await appendJsonl(ledgerPath(userDataPath), {
          schemaVersion: "v0.0.1:schema:definition-1",
          protocolVersion: MODEL_ROUTING_PROTOCOL_VERSION,
          ts: nowIso(),
          ledgerId,
          routeCallId,
          routeId: policy.routeId,
          subjectId: policy.subjectId,
          workspaceId: policy.workspaceId,
          promptVersion: policy.promptVersion,
          alias,
          provider:
            result.upstream?.provider || executed.config?.provider || "",
          model:
            result.upstream?.model ||
            executed.config?.model ||
            executed.config?.engine ||
            alias,
          status: "success",
          budget,
          usage,
          actualEstimatedUsd,
          inputHash: hashValue(JSON.stringify(nextInput)),
          outputHash: hashValue(result.answer || result.text || ""),
          metadata: policy.metadata,
        });
        attempts.push({
          alias,
          status: "success",
          budget,
          startedAt,
          completedAt: nowIso(),
        });
        return {
          result,
          routing: {
            protocolVersion: MODEL_ROUTING_PROTOCOL_VERSION,
            routeCallId,
            routeId: policy.routeId,
            selectedAlias: alias,
            promptVersion: policy.promptVersion,
            secondaryCandidateUsed: attempts.length > 1,
            costLedgerId: ledgerId,
            budget,
            traffic: trafficReservation.traffic,
            attempts: attempts.map(publicAttempt),
          },
        };
      } catch (error: any) {
        const failure: any = normalizeAgentGatewayError(error);
        if (failure.retryable) {
          state = updateCircuitFailure(state, alias, failure, policy);
          await writeModelRoutingState({ userDataPath, state });
        }
        const budgetForLedger: any =
          budget ||
          buildBudgetReceipt({
            input: nextInput,
            policy,
            candidate,
            config: executed?.config || {},
          });
        await appendJsonl(ledgerPath(userDataPath), {
          schemaVersion: "v0.0.1:schema:definition-1",
          protocolVersion: MODEL_ROUTING_PROTOCOL_VERSION,
          ts: nowIso(),
          ledgerId: crypto.randomUUID(),
          routeCallId,
          routeId: policy.routeId,
          subjectId: policy.subjectId,
          workspaceId: policy.workspaceId,
          promptVersion: policy.promptVersion,
          alias,
          provider: executed?.config?.provider || "",
          model: executed?.config?.model || executed?.config?.engine || alias,
          status: "failed",
          errorCode: failure.code,
          retryable: failure.retryable,
          budget: budgetForLedger,
          inputHash: hashValue(JSON.stringify(nextInput)),
          metadata: policy.metadata,
        });
        attempts.push({
          alias,
          status: "failed",
          error: failure.message,
          errorCode: failure.code,
          retryable: failure.retryable,
          budget: budgetForLedger,
          startedAt,
          completedAt: nowIso(),
        });
        if (!failure.retryable) {
          failure.modelRouting = {
            protocolVersion: MODEL_ROUTING_PROTOCOL_VERSION,
            routeCallId,
            routeId: policy.routeId,
            promptVersion: policy.promptVersion,
            traffic: trafficReservation.traffic,
            attempts: attempts.map(publicAttempt)
          };
          throw failure;
        }
      }
    }

    const error: any = agentGatewayError("agent_gateway_candidates_exhausted");
    error.modelRouting = {
      protocolVersion: MODEL_ROUTING_PROTOCOL_VERSION,
      routeCallId,
      routeId: policy.routeId,
      promptVersion: policy.promptVersion,
      traffic: trafficReservation.traffic,
      attempts: attempts.map(publicAttempt),
    };
    throw error;
  } finally {
    await releaseModelRoutingTrafficSlot({
      userDataPath,
      policy,
      routeCallId,
      reserved: trafficReservation.reserved,
      lockPath: stateLockPath,
      readState: readModelRoutingState,
      writeState: writeModelRoutingState
    });
  }
}

export async function inspectModelRouting({
  userDataPath = "",
  limit = 50,
}: Record<string, any> = {}) : Promise<any> {
  const state: any = await readModelRoutingState({ userDataPath });
  const ledger: any = await readLedger(ledgerPath(userDataPath), limit);
  const byStatus: Record<string, any> = {};
  const byAlias: Record<string, any> = {};
  let estimatedUsdTotal: any = 0;
  for (const row of ledger) {
    byStatus[row.status] = Number(byStatus[row.status] || 0) + 1;
    byAlias[row.alias] = Number(byAlias[row.alias] || 0) + 1;
    estimatedUsdTotal += Number(
      row.actualEstimatedUsd || row.budget?.estimatedTotalUsd || 0,
    );
  }
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: MODEL_ROUTING_PROTOCOL_VERSION,
    updatedAt: nowIso(),
    statePath: DEFAULT_STATE_FILE,
    ledgerPath: DEFAULT_LEDGER_FILE,
    state,
    ledgerSummary: {
      total: ledger.length,
      byStatus,
      byAlias,
      estimatedUsdTotal: Number(estimatedUsdTotal.toFixed(8)),
    },
    recentLedger: ledger,
  };
}
