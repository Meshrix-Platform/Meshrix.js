import { canonicalJson as stableJson } from "@lico/contracts/serialization/canonical-json";
import crypto from "node:crypto";

const SENSITIVE_KEY_PATTERN =
  /token|secret|password|passwd|authorization|cookie|api[-_]?key|client[-_]?secret|csrf/i;
const SENSITIVE_TEXT_PATTERN =
  /(Bearer\s+[A-Za-z0-9._~+/=-]+|sk-[A-Za-z0-9._-]+|xox[baprs]-[A-Za-z0-9-]+|(?:(?:api[-_]?key|token|secret|password)\s*[:=]\s*)[^\s"',;]+)/gi;
const ABSOLUTE_PATH_PATTERN = new RegExp(
  `(?:[A-Za-z]:${String.raw`\\`}{2}[^\\s"'<>]+|${String.fromCharCode(47)}(?:Users|home|var|tmp|private|Volumes|opt|etc)${String.fromCharCode(47)}[^\\s"'<>]+)`,
  "g"
);

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function nowIso() {
  return new Date().toISOString();
}

export function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, number));
}

export function normalizeStrategyId(value, fallbackStrategy = "") {
  const requested = String(value || "").trim();
  return requested || String(fallbackStrategy || "").trim();
}

export function normalizeStrategyConfig(value, fallbackStrategy = "") {
  if (value !== undefined && value !== null && value !== "" && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("context_profile_config_invalid:compactionPolicy.strategy");
  }
  const source = asObject(value);
  if (source.params !== undefined && (!source.params || typeof source.params !== "object" || Array.isArray(source.params))) {
    throw new Error("context_profile_config_invalid:compactionPolicy.strategy.params");
  }
  const id = normalizeStrategyId(source.id, fallbackStrategy);
  const params = asObject(source.params);
  return {
    id,
    params
  };
}

export function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function estimateContextTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const cjkCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const nonCjkCount = Math.max(0, text.length - cjkCount);
  return Math.max(1, Math.ceil(cjkCount * 0.9 + nonCjkCount / 4));
}


export function hashValue(value, length = 32) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex").slice(0, length);
}

export function redactText(value) {
  return String(value ?? "")
    .replace(SENSITIVE_TEXT_PATTERN, (match) => {
      const prefix = match.match(/^\s*(api[-_]?key|token|secret|password)\s*[:=]/i)?.[0] || "";
      return prefix ? `${prefix}<redacted>` : "<redacted-secret>";
    })
    .replace(ABSOLUTE_PATH_PATTERN, "<redacted-path>");
}

export function redactCompactionValue(value, depth = 0) {
  if (depth > 8) {
    return "<redacted-depth>";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return {
      redacted: true,
      reason: "buffer",
      byteLength: value.length,
      sha256: crypto.createHash("sha256").update(value).digest("hex")
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactCompactionValue(item, depth + 1));
  }
  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "<redacted>"
      : redactCompactionValue(nested, depth + 1);
  }
  return output;
}

export function normalizeCompactionPolicy(profile = {}, patch = {}) {
  const profilePolicy = asObject(profile.compactionPolicy);
  const patchPolicy = asObject(patch);
  const source = {
    ...profilePolicy,
    ...patchPolicy
  };
  const strategy = normalizeStrategyConfig(source.strategy);
  const optionalNumber = (value, min, max, field) => {
    if (value === undefined || value === null || value === "") return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
      throw new Error(`context_profile_config_invalid:compactionPolicy.${field}`);
    }
    return number;
  };
  const optionalBoolean = (value) => value === true ? true : value === false ? false : null;
  return {
    enabled: optionalBoolean(source.enabled),
    strategy,
    summaryReserveTokens: optionalNumber(source.summaryReserveTokens, 0, 200000, "summaryReserveTokens"),
    reservedBufferTokens: optionalNumber(source.reservedBufferTokens, 0, 200000, "reservedBufferTokens"),
    warningBufferTokens: optionalNumber(source.warningBufferTokens, 0, 400000, "warningBufferTokens"),
    hardBufferTokens: optionalNumber(source.hardBufferTokens, 0, 100000, "hardBufferTokens"),
    hardThresholdRatio: optionalNumber(source.hardThresholdRatio, 0, 1, "hardThresholdRatio"),
    recentMessageProtectionCount: optionalNumber(source.recentMessageProtectionCount, 0, 500, "recentMessageProtectionCount"),
    recentTurnProtectionCount: optionalNumber(source.recentTurnProtectionCount, 0, 250, "recentTurnProtectionCount"),
    maxConsecutiveFailures: optionalNumber(source.maxConsecutiveFailures, 1, 20, "maxConsecutiveFailures"),
    ptlRetryLimit: optionalNumber(source.ptlRetryLimit, 0, 10, "ptlRetryLimit"),
    ptlHeadTrimRatio: optionalNumber(source.ptlHeadTrimRatio, 0, 1, "ptlHeadTrimRatio"),
    modelMaxInputTokens: optionalNumber(source.modelMaxInputTokens, 0, 2000000, "modelMaxInputTokens"),
    modelMaxOutputTokens: optionalNumber(source.modelMaxOutputTokens, 0, 200000, "modelMaxOutputTokens"),
    deterministicTargetRatio: optionalNumber(source.deterministicTargetRatio, 0, 1, "deterministicTargetRatio"),
    reinjectionBudgetTokens: optionalNumber(source.reinjectionBudgetTokens, 0, 100000, "reinjectionBudgetTokens"),
    maxToolResultTokens: optionalNumber(source.maxToolResultTokens, 0, 100000, "maxToolResultTokens"),
    maxAttachmentTokens: optionalNumber(source.maxAttachmentTokens, 0, 100000, "maxAttachmentTokens"),
    allowAttachmentDehydration: optionalBoolean(source.allowAttachmentDehydration),
    persistSessionMemory: optionalBoolean(source.persistSessionMemory),
    persistBoundaries: optionalBoolean(source.persistBoundaries),
    microCompaction: optionalBoolean(source.microCompaction)
  };
}

export function computeCompactionBudget(profile = {}, policyPatch = {}) {
  const policy = normalizeCompactionPolicy(profile, policyPatch);
  const requiredNumber = (value, field, min, max) => {
    const number = Number(value);
    if (value === undefined || value === null || value === "" || !Number.isFinite(number) || number < min || number > max) {
      throw new Error(`context_profile_config_required:${field}`);
    }
    return number;
  };
  const contextWindowTokens = requiredNumber(profile.contextWindowTokens, "contextWindowTokens", 4096, 2000000);
  const outputReserveTokens = requiredNumber(
    profile.outputReserveTokens,
    "outputReserveTokens",
    0,
    contextWindowTokens - 1
  );
  const summaryReserve = requiredNumber(policy.summaryReserveTokens, "compactionPolicy.summaryReserveTokens", 1, 200000);
  const reservedBuffer = requiredNumber(policy.reservedBufferTokens, "compactionPolicy.reservedBufferTokens", 0, 200000);
  const warningBuffer = requiredNumber(policy.warningBufferTokens, "compactionPolicy.warningBufferTokens", 0, 400000);
  const hardBuffer = requiredNumber(policy.hardBufferTokens, "compactionPolicy.hardBufferTokens", 0, 100000);
  const hardThresholdRatio = requiredNumber(policy.hardThresholdRatio, "compactionPolicy.hardThresholdRatio", 0, 1);
  if (!policy.strategy.id) {
    throw new Error("context_profile_config_required:compactionPolicy.strategy.id");
  }
  for (const [field, min, max] of [
    ["recentMessageProtectionCount", 0, 500],
    ["recentTurnProtectionCount", 0, 250],
    ["maxConsecutiveFailures", 1, 20],
    ["ptlRetryLimit", 0, 10],
    ["ptlHeadTrimRatio", 0, 1],
    ["modelMaxInputTokens", 0, 2000000],
    ["modelMaxOutputTokens", 0, 200000],
    ["deterministicTargetRatio", 0, 1],
    ["reinjectionBudgetTokens", 0, 100000],
    ["maxToolResultTokens", 0, 100000],
    ["maxAttachmentTokens", 0, 100000]
  ]) {
    requiredNumber(policy[field], `compactionPolicy.${field}`, min, max);
  }
  for (const field of [
    "enabled",
    "allowAttachmentDehydration",
    "persistSessionMemory",
    "persistBoundaries",
    "microCompaction"
  ]) {
    if (typeof policy[field] !== "boolean") {
      throw new Error(`context_profile_config_required:compactionPolicy.${field}`);
    }
  }
  const summaryReserveTokens = Math.min(
    summaryReserve,
    Math.max(0, contextWindowTokens - outputReserveTokens)
  );
  const effectiveWindowTokens = Math.max(0, contextWindowTokens - outputReserveTokens - summaryReserveTokens);
  const warningThresholdTokens = Math.max(0, effectiveWindowTokens - warningBuffer);
  const autoCompactThresholdTokens = Math.max(0, effectiveWindowTokens - reservedBuffer);
  const hardThresholdTokens = Math.max(
    autoCompactThresholdTokens,
    Math.min(
      Math.floor(contextWindowTokens * hardThresholdRatio),
      Math.max(0, effectiveWindowTokens - hardBuffer)
    )
  );
  return {
    contextWindowTokens,
    outputReserveTokens,
    summaryReserveTokens,
    effectiveWindowTokens,
    warningThresholdTokens,
    autoCompactThresholdTokens,
    hardThresholdTokens,
    policy
  };
}

export function redactEmbeddedPayloads(value) {
  return redactText(value)
    .replace(/data:(?:image|application|audio|video)\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "[embedded media payload stripped]")
    .replace(/("(?:dataBase64|base64|data|bytes|buffer)"\s*:\s*")[^"]{64,}(")/gi, "$1[large encoded payload stripped]$2")
    .replace(/\b[A-Za-z0-9+/]{240,}={0,2}\b/g, "[large encoded payload stripped]");
}

export function findSensitiveCompactionLeaks(value) {
  const text = String(value || "");
  return [
    ...(text.match(SENSITIVE_TEXT_PATTERN) || []),
    ...(text.match(ABSOLUTE_PATH_PATTERN) || [])
  ];
}

export { stableJson };
