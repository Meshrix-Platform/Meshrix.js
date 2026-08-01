function asPlainObject(value?: any, fallback: Record<string, any> = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function asArray(value?: any) : any {
  return Array.isArray(value) ? value : [];
}

function asStringList(value?: any) : any {
  if (Array.isArray(value)) {
    return value.map((item?: any) : any => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item?: any) : any => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizeTimeout(value?: any) : any {
  const parsed: any = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function nowIso() : any {
  return new Date().toISOString();
}

const MAX_AGENT_GATEWAY_RESPONSE_BYTES: any = 4 * 1024 * 1024;

function truncateText(value?: any, maxLength: any = 4000) : any {
  const text: any = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 24))}...[truncated ${text.length}]`;
}

function redactSecretText(value?: any) : any {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(authorization["']?\s*[:=]\s*["']?\s*Bearer\s+)[^"',}\s]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^"',}\s]+/gi, "$1[REDACTED]")
    .replace(/(token["']?\s*[:=]\s*["']?)[^"',}\s]+/gi, "$1[REDACTED]");
}

function safeUrlSummary(value?: any) : any {
  try {
    const parsed: any = new URL(String(value || ""));
    return {
      origin: parsed.origin,
      pathname: parsed.pathname
    };
  } catch {
    return {
      origin: "",
      pathname: String(value || "").replace(/[?#].*$/, "")
    };
  }
}

function safeJsonParse(text?: any) : any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function textFromContent(value?: any, { includeReasoning = false }: Record<string, any> = {}) : any {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item?: any) : any => textFromContent(item, { includeReasoning })).join("");
  }
  if (typeof value !== "object") {
    return "";
  }

  const type: any = String(value.type || "").toLowerCase();
  if (!includeReasoning && (type.includes("reasoning") || type.includes("thinking"))) {
    return "";
  }

  const directKeys: any[] = ["text", "content", "output_text", "value"];
  for (const key of directKeys) {
    if (value[key] !== undefined && value[key] !== null) {
      return textFromContent(value[key], { includeReasoning });
    }
  }

  if (includeReasoning) {
    for (const key of ["reasoning_content", "reasoning", "reasoning_details", "thinking", "summary"]) {
      if (value[key] !== undefined && value[key] !== null) {
        return textFromContent(value[key], { includeReasoning: true });
      }
    }
  }
  return "";
}

export {
  MAX_AGENT_GATEWAY_RESPONSE_BYTES,
  asArray,
  asPlainObject,
  asStringList,
  normalizeTimeout,
  nowIso,
  redactSecretText,
  safeJsonParse,
  safeUrlSummary,
  textFromContent,
  truncateText
};
