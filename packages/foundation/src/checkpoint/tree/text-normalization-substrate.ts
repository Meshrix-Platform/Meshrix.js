export function normalizeWhitespace(value?: any) : any {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function truncateText(value?: any, maxChars: any = 180) : any {
  const normalized: any = normalizeWhitespace(value);

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

export function clamp(value?: any, min?: any, max?: any) : any {
  return Math.max(min, Math.min(max, value));
}

export function clampLimit(value?: any, fallback: any = 20, max: any = 200) : any {
  const parsed: any = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

export function escapeRegExp(value?: any) : any {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function uniqueNormalizedStrings(values: any = []) : any {
  const seen: any = new Set<any>();
  const output: any[] = [];

  for (const value of values) {
    const normalized: any = normalizeWhitespace(value);
    if (!normalized) {
      continue;
    }

    const key: any = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(normalized);
  }

  return output;
}
