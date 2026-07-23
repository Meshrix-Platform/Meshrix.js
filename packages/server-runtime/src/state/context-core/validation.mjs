import crypto from "node:crypto";

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizeStringArray(value) {
  const items = asArray(value).map((item) => String(item || "").trim()).filter(Boolean);
  return [...new Set(items)];
}

export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const cjkCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const nonCjkCount = Math.max(0, text.length - cjkCount);
  return Math.max(1, Math.ceil(cjkCount * 0.9 + nonCjkCount / 4));
}

export function compactText(value, targetTokens) {
  const text = String(value || "").trim();
  const budget = Math.max(0, Number(targetTokens) || 0);
  if (!text || budget === 0) {
    return budget === 0 ? "" : text;
  }
  if (estimateTokens(text) <= budget) {
    return text;
  }
  const sentences = text
    .split(/(?<=[。！？.!?])\s+|\n+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  const selected = [];
  let used = 0;
  for (const sentence of sentences) {
    const score =
      /证据|结论|风险|金额|日期|负责人|未完成|冲突|decision|risk|evidence|todo/i.test(sentence)
        ? 2
        : 1;
    const tokens = estimateTokens(sentence);
    if (used + tokens > budget) {
      continue;
    }
    selected.push({ sentence, score, tokens, index: selected.length });
    used += tokens;
    if (used >= budget) {
      break;
    }
  }
  const compacted = selected
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(1, selected.length))
    .sort((left, right) => left.index - right.index)
    .map((item) => item.sentence)
    .join("\n");
  return compacted || text.slice(0, budget * 4);
}

export function takeItemsByBudget(items, budget, stringify = (item) => JSON.stringify(item)) {
  const selected = [];
  let used = 0;
  for (const item of asArray(items)) {
    const tokens = estimateTokens(stringify(item));
    if (used + tokens > Math.max(0, Number(budget) || 0)) {
      continue;
    }
    selected.push(item);
    used += tokens;
    if (used >= budget) {
      break;
    }
  }
  return {
    selected,
    usedTokens: used,
    droppedCount: Math.max(0, asArray(items).length - selected.length)
  };
}


export function hashText(value, length = 16) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, length);
}
