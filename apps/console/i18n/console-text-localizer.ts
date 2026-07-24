import type { ConsoleLocale } from "./console-locale-state";
import { applyConsolePattern } from "./console-dynamic-patterns";
import { consolePhrasePairs, consoleSegmentPairs } from "./console-phrases";
import type { ConsolePatternContext } from "./console-dynamic-pattern-types";

const zhToEn = new Map<string, string>();
const enToZh = new Map<string, string>();

for (const [zh, en] of consolePhrasePairs) {
  zhToEn.set(zh, en);
  enToZh.set(en, zh);
}

function translateDynamicConsoleName(value: string, locale: ConsoleLocale) {
  const trimmed = value.trim();
  if (locale === "en") {
    return zhToEn.get(trimmed) || trimmed;
  }
  return enToZh.get(trimmed) || trimmed;
}

function hasHan(text: string) {
  return /[\u3400-\u9fff]/u.test(text);
}

function preserveOuterWhitespace(original: string, translated: string) {
  const prefix = original.match(/^\s*/)?.[0] || "";
  const suffix = original.match(/\s*$/)?.[0] || "";
  return `${prefix}${translated}${suffix}`;
}

function applyConsoleSegments(text: string, locale: ConsoleLocale) {
  let translated = text;
  const phraseSegments = [...consolePhrasePairs]
    .filter(([zh, en]) => zh.length >= 4 && en.length >= 2)
    .sort((a, b) => b[0].length - a[0].length);
  if (locale === "en") {
    for (const [zh, en] of phraseSegments) {
      translated = translated.split(zh).join(en);
    }
    const segmentPairs = [...consoleSegmentPairs].sort((a, b) => b[0].length - a[0].length);
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
    const reversePhraseSegments = [...phraseSegments].sort((a, b) => b[1].length - a[1].length);
    for (const [zh, en] of reversePhraseSegments) {
      translated = translated.split(en).join(zh);
    }
    const reverseSegmentPairs = [...consoleSegmentPairs].sort((a, b) => b[1].length - a[1].length);
    for (const [zh, en] of reverseSegmentPairs) {
      translated = translated.split(en).join(zh);
    }
  }
  return translated;
}

const consolePatternContext: ConsolePatternContext = {
  translateDynamicConsoleName,
  localizeConsoleText: (text, locale) => localizeConsoleText(text, locale),
};

export function localizeConsoleText(text: string, locale: ConsoleLocale) {
  if (!text || !text.trim()) {
    return text;
  }
  const trimmed = text.trim();
  const exact = locale === "en" ? zhToEn.get(trimmed) : enToZh.get(trimmed);
  if (exact) {
    return preserveOuterWhitespace(text, exact);
  }
  const patternTranslated = applyConsolePattern(trimmed, locale, consolePatternContext);
  if (patternTranslated !== trimmed) {
    return preserveOuterWhitespace(text, patternTranslated);
  }
  if (locale === "en" && hasHan(trimmed)) {
    return preserveOuterWhitespace(text, applyConsoleSegments(trimmed, locale));
  }
  if (locale === "zh-CN" && !hasHan(trimmed)) {
    const zh = enToZh.get(trimmed);
    if (zh) {
      return preserveOuterWhitespace(text, zh);
    }
  }
  return text;
}
