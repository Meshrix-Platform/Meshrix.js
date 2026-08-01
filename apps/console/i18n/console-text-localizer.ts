import type { ConsoleLocale } from "./console-locale-state";
import { applyConsolePattern } from "./console-dynamic-patterns";
import { consolePhrasePairs, consoleSegmentPairs } from "./console-phrases";
import type { ConsolePatternContext } from "./console-dynamic-pattern-types";

const zhToEn: any = new Map<string, string>();
const enToZh: any = new Map<string, string>();

for (const [zh, en] of consolePhrasePairs) {
  zhToEn.set(zh, en);
  enToZh.set(en, zh);
}

function translateDynamicConsoleName(value: string, locale: ConsoleLocale) : any {
  const trimmed: any = value.trim();
  if (locale === "en") {
    return zhToEn.get(trimmed) || trimmed;
  }
  return enToZh.get(trimmed) || trimmed;
}

function hasHan(text: string) : any {
  return /[\u3400-\u9fff]/u.test(text);
}

function preserveOuterWhitespace(original: string, translated: string) : any {
  const prefix: any = original.match(/^\s*/)?.[0] || "";
  const suffix: any = original.match(/\s*$/)?.[0] || "";
  return `${prefix}${translated}${suffix}`;
}

function applyConsoleSegments(text: string, locale: ConsoleLocale) : any {
  let translated: any = text;
  const phraseSegments: any = [...consolePhrasePairs]
    .filter(([zh, en]: readonly any[]) : any => zh.length >= 4 && en.length >= 2)
    .sort((a?: any, b?: any) : any => b[0].length - a[0].length);
  if (locale === "en") {
    for (const [zh, en] of phraseSegments) {
      translated = translated.split(zh).join(en);
    }
    const segmentPairs: any = [...consoleSegmentPairs].sort((a?: any, b?: any) : any => b[0].length - a[0].length);
    for (const [zh, en] of segmentPairs) {
      translated = translated.split(zh).join(en);
    }
    translated = translated
      .replace(/，/g, ", ")
      .replace(/。/g, ".")
      .replace(/：/g, ": ")
      .replace(/；/g, "; ")
      .replace(/、/g, ", ")
      .replace(/（/g, " (")
      .replace(/）/g, ")")
      .replace(/“|”/g, '"')
      .replace(/\s{2,}/g, " ")
      .trim();
  } else {
    const reversePhraseSegments: any = [...phraseSegments].sort((a?: any, b?: any) : any => b[1].length - a[1].length);
    for (const [zh, en] of reversePhraseSegments) {
      translated = translated.split(en).join(zh);
    }
    const reverseSegmentPairs: any = [...consoleSegmentPairs].sort((a?: any, b?: any) : any => b[1].length - a[1].length);
    for (const [zh, en] of reverseSegmentPairs) {
      translated = translated.split(en).join(zh);
    }
  }
  return translated;
}

const consolePatternContext: ConsolePatternContext = {
  translateDynamicConsoleName,
  localizeConsoleText: (text?: any, locale?: any) : any => localizeConsoleText(text, locale),
};

export function localizeConsoleText(text: string, locale: ConsoleLocale) : any {
  if (!text || !text.trim()) {
    return text;
  }
  const trimmed: any = text.trim();
  const exact: any = locale === "en" ? zhToEn.get(trimmed) : enToZh.get(trimmed);
  if (exact) {
    return preserveOuterWhitespace(text, exact);
  }
  const patternTranslated: any = applyConsolePattern(trimmed, locale, consolePatternContext);
  if (patternTranslated !== trimmed) {
    return preserveOuterWhitespace(text, patternTranslated);
  }
  if (locale === "en" && hasHan(trimmed)) {
    return preserveOuterWhitespace(text, applyConsoleSegments(trimmed, locale));
  }
  if (locale === "zh-CN" && !hasHan(trimmed)) {
    const zh: any = enToZh.get(trimmed);
    if (zh) {
      return preserveOuterWhitespace(text, zh);
    }
  }
  return text;
}
