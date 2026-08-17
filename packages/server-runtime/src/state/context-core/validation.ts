import crypto from "node:crypto";

import type { RuntimeRecord } from "./types.ts";

export function asArray<T = unknown>(value?: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function asObject(value?: unknown): RuntimeRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RuntimeRecord)
    : {};
}

export function normalizeText(value?: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeStringArray(value?: unknown): string[] {
  const items = asArray(value)
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return [...new Set<string>(items)];
}

export function estimateTokens(value?: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const cjkCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const nonCjkCount = Math.max(0, text.length - cjkCount);
  return Math.max(1, Math.ceil(cjkCount * 0.9 + nonCjkCount / 4));
}

export function compactText(value?: unknown, targetTokens?: unknown): string {
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
  const selected: Array<{
    sentence: string;
    score: number;
    tokens: number;
    index: number;
  }> = [];
  let used = 0;
  for (const sentence of sentences) {
    const score =
      /证据|结论|风险|金额|日期|负责人|未完成|冲突|decision|risk|evidence|todo/i.test(
        sentence,
      )
        ? 2
        : 1;
    const tokens = estimateTokens(sentence);
    if (used + tokens > budget) {
      continue;
    }
    selected.push({ sentence, score, tokens, index: selected.length });
    used += tokens;
    if (used >= Math.max(0, Number(budget) || 0)) {
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

export function takeItemsByBudget<T>(
  items: readonly T[] | unknown,
  budget: unknown,
  stringify: (item: T) => string = (item) => JSON.stringify(item),
): { selected: T[]; usedTokens: number; droppedCount: number } {
  const source = asArray<T>(items);
  const selected: T[] = [];
  const safeBudget = Math.max(0, Number(budget) || 0);
  let used = 0;
  for (const item of source) {
    const tokens = estimateTokens(stringify(item));
    if (used + tokens > safeBudget) {
      continue;
    }
    selected.push(item);
    used += tokens;
    if (used >= safeBudget) {
      break;
    }
  }
  return {
    selected,
    usedTokens: used,
    droppedCount: Math.max(0, source.length - selected.length),
  };
}

export function hashText(value?: unknown, length = 16): string {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, length);
}
