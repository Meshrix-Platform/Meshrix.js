import crypto from "node:crypto";

const TOKEN_LIKE_SUMMARY_KEY_NORMALIZED: any = new Set<any>([
  "authorization",
  "auth",
  "bearer",
  "token",
  "apikey",
  "xapikey",
  "secret",
  "clientsecret",
  "password",
  "credential",
  "credentials",
  "accesstoken",
  "refreshtoken",
  "idtoken"
]);

const TOKEN_LIKE_SUMMARY_VALUE_PATTERNS: any[] = [
  /\bAuthorization\s*[:=]\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/i,
  /\b(?:api[-_\s]?key|apikey|access[-_\s]?token|refresh[-_\s]?token|id[-_\s]?token|token|secret)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i,
  /(?:^|[?&\s])(?:api[_-]?key|access_token|refresh_token|id_token|token|secret)=["']?[^&\s"']{6,}/i,
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|xoxb|xoxp|ya29)[A-Za-z0-9._-]{10,}\b/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/
];

function normalizedSummaryKey(value: any = "") : any {
  return String(value || "").replace(/[-_\s.]/g, "").toLowerCase();
}

function isTokenLikeSummaryKey(value: any = "") : any {
  const normalized: any = normalizedSummaryKey(value);
  return TOKEN_LIKE_SUMMARY_KEY_NORMALIZED.has(normalized) ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("password") ||
    normalized.endsWith("credential");
}

function isTokenLikeSummaryString(value: any = "") : any {
  const text: any = String(value || "");
  return TOKEN_LIKE_SUMMARY_VALUE_PATTERNS.some((pattern?: any) : any => pattern.test(text));
}

function safeSummaryKey(key: any = "", { redactTokenLikeValues = false }: Record<string, any> = {}) : any {
  const text: any = String(key || "");
  if (!redactTokenLikeValues) {
    return text;
  }
  return isTokenLikeSummaryKey(text) || isTokenLikeSummaryString(text)
    ? "[redacted-key]"
    : text;
}

function safeSummaryPathSegment(segment: any = "", { sensitive = false }: Record<string, any> = {}) : any {
  const text: any = String(segment || "");
  if (sensitive || isTokenLikeSummaryKey(text) || isTokenLikeSummaryString(text)) {
    return "<redacted-key>";
  }
  const cleaned: any = text.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return cleaned || "field";
}

function tokenLikeSummaryEvidence(value?: any, { path = "result", reason = "token_like_result_value" }: Record<string, any> = {}) : any {
  return {
    path,
    reason,
    valueType: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
    fingerprint: crypto.createHash("sha256").update(String(value ?? "")).digest("hex")
  };
}

function collectTokenLikeSummaryEvidence(value?: any, {
  path = ["result"],
  inheritedSensitiveKey = false,
  evidence = [],
  seen = new WeakSet<object>()
}: Record<string, any> = {}) : any {
  if (evidence.length >= 20) {
    return evidence;
  }
  if (typeof value === "string") {
    if (inheritedSensitiveKey || isTokenLikeSummaryString(value)) {
      evidence.push(tokenLikeSummaryEvidence(value, {
        path: path.join("."),
        reason: inheritedSensitiveKey ? "sensitive_result_key" : "token_like_result_value"
      }));
    }
    return evidence;
  }
  if (!value || typeof value !== "object") {
    return evidence;
  }
  if (seen.has(value)) {
    return evidence;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectTokenLikeSummaryEvidence(item, {
        path: path.concat(`[${index}]`),
        inheritedSensitiveKey,
        evidence,
        seen
      });
      if (evidence.length >= 20) {
        break;
      }
    }
    return evidence;
  }
  for (const [key, entryValue] of (Object.entries(value) as [string, any][])) {
    const keySensitive: any = isTokenLikeSummaryKey(key) || isTokenLikeSummaryString(key);
    collectTokenLikeSummaryEvidence(entryValue, {
      path: path.concat(safeSummaryPathSegment(key, { sensitive: keySensitive })),
      inheritedSensitiveKey: inheritedSensitiveKey || keySensitive,
      evidence,
      seen
    });
    if (evidence.length >= 20) {
      break;
    }
  }
  return evidence;
}

function tokenLikeSummaryRedaction(value?: any, options: Record<string, any> = {}) : any {
  if (!options.redactTokenLikeValues) {
    return null;
  }
  const evidence: any = collectTokenLikeSummaryEvidence(value);
  if (!evidence.length) {
    return null;
  }
  return {
    decision: "redacted",
    reason: "token_like_result_value",
    redactedValueCount: evidence.length,
    evidence: evidence.slice(0, 8),
    evidenceTruncated: evidence.length > 8
  };
}

export function resultSummaryFromPayload(payload?: any, options: Record<string, any> = {}) : any {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const result: any = payload.result !== undefined ? payload.result : payload;
  const redaction: any = tokenLikeSummaryRedaction(result, options);
  if (Array.isArray(result)) {
    return {
      type: "array",
      length: result.length,
      ...(redaction ? { redaction } : {})
    };
  }
  if (result && typeof result === "object") {
    return {
      type: "object",
      keys: Object.keys(result).slice(0, 40).map((key?: any) : any => safeSummaryKey(key, options)),
      ...(redaction ? { redaction } : {})
    };
  }
  return redaction
    ? { value: "[redacted]", redaction }
    : { value: result };
}

export function jsonByteLength(value?: any) : any {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  } catch {
    return 0;
  }
}
