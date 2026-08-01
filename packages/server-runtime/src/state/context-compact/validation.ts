import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import crypto from "node:crypto";

const SENSITIVE_KEY_PATTERN: any =
  /token|secret|password|passwd|authorization|cookie|api[-_]?key|client[-_]?secret|csrf/i;
const SENSITIVE_TEXT_PATTERN: any =
  /(Bearer\s+[A-Za-z0-9._~+/=-]+|sk-[A-Za-z0-9._-]+|xox[baprs]-[A-Za-z0-9-]+|(?:(?:api[-_]?key|token|secret|password)\s*[:=]\s*)[^\s"',;]+)/gi;
const ABSOLUTE_PATH_PATTERN: any = new RegExp(
  `(?:[A-Za-z]:${String.raw`\\`}{2}[^\\s"'<>]+|${String.fromCharCode(47)}(?:Users|home|var|tmp|private|Volumes|opt|etc)${String.fromCharCode(47)}[^\\s"'<>]+)`,
  "g"
);

export function asArray(value?: any) : any {
  return Array.isArray(value) ? value : [];
}

export function asObject(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function nowIso() : any {
  return new Date().toISOString();
}

export function clampNumber(value?: any, fallback?: any, min?: any, max?: any) : any {
  const number: any = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, number));
}

export function normalizeStrategyId(value?: any, fallbackStrategy: any = "") : any {
  const requested: any = String(value || "").trim();
  return requested || String(fallbackStrategy || "").trim();
}

export function normalizeStrategyConfig(value?: any, fallbackStrategy: any = "") : any {
  if (value !== undefined && value !== null && value !== "" && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("context_profile_config_invalid:compactionPolicy.strategy");
  }
  const source: any = asObject(value);
  if (source.params !== undefined && (!source.params || typeof source.params !== "object" || Array.isArray(source.params))) {
    throw new Error("context_profile_config_invalid:compactionPolicy.strategy.params");
  }
  const id: any = normalizeStrategyId(source.id, fallbackStrategy);
  const params: any = asObject(source.params);
  return {
    id,
    params
  };
}

export function normalizeText(value?: any) : any {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function estimateContextTokens(value?: any) : any {
  const text: any = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const cjkCount: any = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const nonCjkCount: any = Math.max(0, text.length - cjkCount);
  return Math.max(1, Math.ceil(cjkCount * 0.9 + nonCjkCount / 4));
}


export function hashValue(value?: any, length: any = 32) : any {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex").slice(0, length);
}

export function redactText(value?: any) : any {
  return String(value ?? "")
    .replace(SENSITIVE_TEXT_PATTERN, (match?: any) : any => {
      const prefix: any = match.match(/^\s*(api[-_]?key|token|secret|password)\s*[:=]/i)?.[0] || "";
      return prefix ? `${prefix}<redacted>` : "<redacted-secret>";
    })
    .replace(ABSOLUTE_PATH_PATTERN, "<redacted-path>");
}

export function redactCompactionValue(value?: any, depth: any = 0) : any {
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
    return value.map((item?: any) : any => redactCompactionValue(item, depth + 1));
  }
  const output: Record<string, any> = {};
  for (const [key, nested] of (Object.entries(value) as [string, any][])) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "<redacted>"
      : redactCompactionValue(nested, depth + 1);
  }
  return output;
}

export function normalizeCompactionPolicy(profile: Record<string, any> = {}, patch: Record<string, any> = {}) : any {
  const profilePolicy: any = asObject(profile.compactionPolicy);
  const patchPolicy: any = asObject(patch);
  const source: Record<string, any> = {
    ...profilePolicy,
    ...patchPolicy
  };
  const strategy: any = normalizeStrategyConfig(source.strategy);
  const optionalNumber: any = (value?: any, min?: any, max?: any, field?: any) : any => {
    if (value === undefined || value === null || value === "") return null;
    const number: any = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
      throw new Error(`context_profile_config_invalid:compactionPolicy.${field}`);
    }
    return number;
  };
  const optionalBoolean: any = (value?: any) : any => value === true ? true : value === false ? false : null;
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

export function computeCompactionBudget(profile: Record<string, any> = {}, policyPatch: Record<string, any> = {}) : any {
  const policy: any = normalizeCompactionPolicy(profile, policyPatch);
  const requiredNumber: any = (value?: any, field?: any, min?: any, max?: any) : any => {
    const number: any = Number(value);
    if (value === undefined || value === null || value === "" || !Number.isFinite(number) || number < min || number > max) {
      throw new Error(`context_profile_config_required:${field}`);
    }
    return number;
  };
  const contextWindowTokens: any = requiredNumber(profile.contextWindowTokens, "contextWindowTokens", 4096, 2000000);
  const outputReserveTokens: any = requiredNumber(
    profile.outputReserveTokens,
    "outputReserveTokens",
    0,
    contextWindowTokens - 1
  );
  const summaryReserve: any = requiredNumber(policy.summaryReserveTokens, "compactionPolicy.summaryReserveTokens", 1, 200000);
  const reservedBuffer: any = requiredNumber(policy.reservedBufferTokens, "compactionPolicy.reservedBufferTokens", 0, 200000);
  const warningBuffer: any = requiredNumber(policy.warningBufferTokens, "compactionPolicy.warningBufferTokens", 0, 400000);
  const hardBuffer: any = requiredNumber(policy.hardBufferTokens, "compactionPolicy.hardBufferTokens", 0, 100000);
  const hardThresholdRatio: any = requiredNumber(policy.hardThresholdRatio, "compactionPolicy.hardThresholdRatio", 0, 1);
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
  const summaryReserveTokens: any = Math.min(
    summaryReserve,
    Math.max(0, contextWindowTokens - outputReserveTokens)
  );
  const effectiveWindowTokens: any = Math.max(0, contextWindowTokens - outputReserveTokens - summaryReserveTokens);
  const warningThresholdTokens: any = Math.max(0, effectiveWindowTokens - warningBuffer);
  const autoCompactThresholdTokens: any = Math.max(0, effectiveWindowTokens - reservedBuffer);
  const hardThresholdTokens: any = Math.max(
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

export function redactEmbeddedPayloads(value?: any) : any {
  return redactText(value)
    .replace(/data:(?:image|application|audio|video)\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "[embedded media payload stripped]")
    .replace(/("(?:dataBase64|base64|data|bytes|buffer)"\s*:\s*")[^"]{64,}(")/gi, "$1[large encoded payload stripped]$2")
    .replace(/\b[A-Za-z0-9+/]{240,}={0,2}\b/g, "[large encoded payload stripped]");
}

export function findSensitiveCompactionLeaks(value?: any) : any {
  const text: any = String(value || "");
  return [
    ...(text.match(SENSITIVE_TEXT_PATTERN) || []),
    ...(text.match(ABSOLUTE_PATH_PATTERN) || [])
  ];
}

export { stableJson };
