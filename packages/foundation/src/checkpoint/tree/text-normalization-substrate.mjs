export function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function truncateText(value, maxChars = 180) {
  const normalized = normalizeWhitespace(value);

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function clampLimit(value, fallback = 20, max = 200) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

export function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function uniqueNormalizedStrings(values = []) {
  const seen = new Set();
  const output = [];

  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(normalized);
  }

  return output;
}
