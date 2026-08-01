import crypto from "node:crypto";

export function asArray(value?: any) : any {
  return Array.isArray(value) ? value : [];
}

export function asObject(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeText(value?: any) : any {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizeStringArray(value?: any) : any {
  const items: any = asArray(value).map((item?: any) : any => String(item || "").trim()).filter(Boolean);
  return [...new Set<any>(items)];
}

export function estimateTokens(value?: any) : any {
  const text: any = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const cjkCount: any = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const nonCjkCount: any = Math.max(0, text.length - cjkCount);
  return Math.max(1, Math.ceil(cjkCount * 0.9 + nonCjkCount / 4));
}

export function compactText(value?: any, targetTokens?: any) : any {
  const text: any = String(value || "").trim();
  const budget: any = Math.max(0, Number(targetTokens) || 0);
  if (!text || budget === 0) {
    return budget === 0 ? "" : text;
  }
  if (estimateTokens(text) <= budget) {
    return text;
  }
  const sentences: any = text
    .split(/(?<=[。！？.!?])\s+|\n+/u)
    .map((item?: any) : any => item.trim())
    .filter(Boolean);
  const selected: any[] = [];
  let used: any = 0;
  for (const sentence of sentences) {
    const score: any =
      /证据|结论|风险|金额|日期|负责人|未完成|冲突|decision|risk|evidence|todo/i.test(sentence)
        ? 2
        : 1;
    const tokens: any = estimateTokens(sentence);
    if (used + tokens > budget) {
      continue;
    }
    selected.push({ sentence, score, tokens, index: selected.length });
    used += tokens;
    if (used >= budget) {
      break;
    }
  }
  const compacted: any = selected
    .sort((left?: any, right?: any) : any => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(1, selected.length))
    .sort((left?: any, right?: any) : any => left.index - right.index)
    .map((item?: any) : any => item.sentence)
    .join("\n");
  return compacted || text.slice(0, budget * 4);
}

export function takeItemsByBudget(items?: any, budget?: any, stringify: any = (item?: any) : any => JSON.stringify(item)) : any {
  const selected: any[] = [];
  let used: any = 0;
  for (const item of asArray(items)) {
    const tokens: any = estimateTokens(stringify(item));
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


export function hashText(value?: any, length: any = 16) : any {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, length);
}
