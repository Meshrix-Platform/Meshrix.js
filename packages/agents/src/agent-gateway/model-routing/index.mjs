import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ServerConfig } from "@lico/foundation/config/server-config";
import {
  appendBoundedJsonLine,
  readJsonlTail
} from "@lico/foundation/storage/bounded-jsonl";
import {
  releaseModelRoutingTrafficSlot,
  reserveModelRoutingTrafficSlot
} from "./model-routing-traffic.mjs";

export const MODEL_ROUTING_PROTOCOL_VERSION = "v0.0.1:strategy:model-routing-1";

const DEFAULT_STATE_FILE = path.join("state", "model-routing-state.json");
const DEFAULT_LEDGER_FILE = path.join("logs", "model-routing-ledger.jsonl");
const MODEL_ROUTING_LEDGER_MAX_BYTES = 32 * 1024 * 1024;

function asObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function hashValue(value, length = 24) {
  return crypto
    .createHash("sha256")
    .update(String(value ?? ""))
    .digest("hex")
    .slice(0, length);
}

function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const cjkCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const nonCjkCount = Math.max(0, text.length - cjkCount);
  return Math.max(1, Math.ceil(cjkCount * 0.9 + nonCjkCount / 4));
}

function unique(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizePositiveNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function statePath(userDataPath = "") {
  return path.join(
    userDataPath || ServerConfig.getDataDir(),
    DEFAULT_STATE_FILE,
  );
}

function ledgerPath(userDataPath = "") {
  return path.join(
    userDataPath || ServerConfig.getDataDir(),
    DEFAULT_LEDGER_FILE,
  );
}

function stateLockPath(userDataPath = "") {
  return `${statePath(userDataPath)}.lock`;
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonFile(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function appendJsonl(filePath, payload) {
  await appendBoundedJsonLine(filePath, payload, {
    maxBytes: MODEL_ROUTING_LEDGER_MAX_BYTES,
    retainedBytes: MODEL_ROUTING_LEDGER_MAX_BYTES / 2
  });
}

async function readLedger(filePath, limit = 200) {
  return readJsonlTail(filePath, {
    limit,
    maxScanBytes: MODEL_ROUTING_LEDGER_MAX_BYTES / 2
  });
}

function normalizeState(value = {}) {
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: MODEL_ROUTING_PROTOCOL_VERSION,
    updatedAt: String(value.updatedAt || ""),
    circuits: asObject(value.circuits),
    inFlight: asObject(value.inFlight),
  };
}

export async function readModelRoutingState({ userDataPath = "" } = {}) {
  return normalizeState(await readJsonFile(statePath(userDataPath), {}));
}

async function writeModelRoutingState({ userDataPath = "", state }) {
  const next = normalizeState({
    ...state,
    updatedAt: nowIso(),
  });
  await writeJsonFile(statePath(userDataPath), next);
  return next;
}

function routeSource(settings = {}, input = {}) {
  return {
    ...asObject(settings.modelRouting),
    ...asObject(input.modelRouting),
  };
}

export function shouldUseModelRouting(input = {}, settings = {}) {
  const source = routeSource(settings, input);
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
} = {}) {
  const source = routeSource(settings, input);
  const explicitAlias = normalizeText(
    input.modelAlias || input.alias || input.agentAlias || input.model || "",
  );
  const candidateChain = unique([
    explicitAlias,
    ...asArray(source.candidateChain),
  ]);
  const maxAttempts = Math.max(
    1,
    Math.min(
      candidateChain.length || 1,
      Number(source.maxAttempts || candidateChain.length || 1),
    ),
  );
  const circuitSource =
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

function priceForCandidate(policy = {}, candidate = {}, config = {}) {
  const table = asObject(policy.priceTable);
  const keys = [
    candidate.alias,
    config.alias,
    config.model,
    config.provider,
  ].filter(Boolean);
  for (const key of keys) {
    const price = asObject(table[key]);
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

function outputTokenBudget(input = {}, policy = {}) {
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
} = {}) {
  const estimatedInputTokens = estimateTokens({
    question: input.question || input.query || "",
    messages: input.messages || [],
    systemPrompt: input.systemPrompt || "",
    tools: input.parameters?.tools || [],
  });
  const estimatedOutputTokens = outputTokenBudget(input, policy);
  const price = priceForCandidate(policy, candidate, config);
  const estimatedInputUsd =
    (estimatedInputTokens * price.inputUsdPer1MTokens) / 1_000_000;
  const estimatedOutputUsd =
    (estimatedOutputTokens * price.outputUsdPer1MTokens) / 1_000_000;
  const estimatedTotalUsd = Number(
    (estimatedInputUsd + estimatedOutputUsd).toFixed(8),
  );
  const estimatedTotalTokens = estimatedInputTokens + estimatedOutputTokens;
  const violations = [];
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

function usageFromResult(result = {}) {
  const usage = asObject(
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

function actualCostFromUsage(usage = {}, price = {}) {
  const inputUsd =
    (Number(usage.promptTokens || 0) * Number(price.inputUsdPer1MTokens || 0)) /
    1_000_000;
  const outputUsd =
    (Number(usage.completionTokens || 0) *
      Number(price.outputUsdPer1MTokens || 0)) /
    1_000_000;
  return Number((inputUsd + outputUsd).toFixed(8));
}

function circuitForAlias(state = {}, alias = "") {
  return asObject(state.circuits?.[alias]);
}

function circuitOpen(circuit = {}, nowMs = Date.now()) {
  const openUntil = Date.parse(circuit.openUntil || "");
  return (
    circuit.state === "open" && Number.isFinite(openUntil) && openUntil > nowMs
  );
}

function updateCircuitSuccess(state = {}, alias = "") {
  const circuit = {
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

function updateCircuitFailure(state = {}, alias = "", error, policy = {}) {
  const current = circuitForAlias(state, alias);
  const failureCount = Number(current.failureCount || 0) + 1;
  const shouldOpen =
    policy.circuitBreaker.enabled &&
    failureCount >= policy.circuitBreaker.failureThreshold;
  const openedAt = shouldOpen ? nowIso() : String(current.openedAt || "");
  const openUntil = shouldOpen
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
} = {}) {
  if (!policy.rateLimit.maxCalls) {
    return 0;
  }
  const rows = await readLedger(ledgerPath(userDataPath), 2000);
  const since = Date.now() - policy.rateLimit.windowMs;
  return rows.filter((row) => {
    const ts = Date.parse(row.ts || "");
    return (
      Number.isFinite(ts) &&
      ts >= since &&
      row.routeId === routeId &&
      row.status === "success"
    );
  }).length;
}

function candidateInput(input = {}, alias = "") {
  return {
    ...input,
    alias,
    modelAlias: alias,
  };
}

function publicAttempt(attempt = {}) {
  return {
    alias: attempt.alias,
    status: attempt.status,
    reason: attempt.reason || "",
    error: attempt.error || "",
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
} = {}) {
  void registry;
  const policy = normalizeModelRoutingPolicy({ settings, input });
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
  const routeCallId = crypto.randomUUID();
  const trafficReservation = await reserveModelRoutingTrafficSlot({
    userDataPath,
    policy,
    routeCallId,
    lockPath: stateLockPath,
    readState: readModelRoutingState,
    writeState: writeModelRoutingState
  });
  let state = await readModelRoutingState({ userDataPath });
  const attempts = [];
  try {
    const rateLimitCount = await recentLedgerCount({
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
      const startedAt = nowIso();
      const circuit = circuitForAlias(state, alias);
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

      const candidate = { alias };
      const nextInput = candidateInput(input, alias);
      let executed = null;
      let budget = null;
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
        const result = executed.result || {};
        const usage = usageFromResult(result);
        const actualEstimatedUsd = actualCostFromUsage(usage, budget.price);
        state = updateCircuitSuccess(state, alias);
        await writeModelRoutingState({ userDataPath, state });
        const ledgerId = crypto.randomUUID();
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
      } catch (error) {
        state = updateCircuitFailure(state, alias, error, policy);
        await writeModelRoutingState({ userDataPath, state });
        const budgetForLedger =
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
          error: error instanceof Error ? error.message : String(error),
          budget: budgetForLedger,
          inputHash: hashValue(JSON.stringify(nextInput)),
          metadata: policy.metadata,
        });
        attempts.push({
          alias,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          budget: budgetForLedger,
          startedAt,
          completedAt: nowIso(),
        });
      }
    }

    const error = new Error("Model routing found no available candidate.");
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
} = {}) {
  const state = await readModelRoutingState({ userDataPath });
  const ledger = await readLedger(ledgerPath(userDataPath), limit);
  const byStatus = {};
  const byAlias = {};
  let estimatedUsdTotal = 0;
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
