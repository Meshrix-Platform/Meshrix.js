import type { ConsoleLocale } from "./console-locale-state";
import { consoleDynamicCountPatternPairs } from "./console-dynamic-count-patterns";
import { consoleDynamicStatusPatternPairs } from "./console-dynamic-status-patterns";
import type { ConsolePatternContext, ConsolePatternPair } from "./console-dynamic-pattern-types";

export type { ConsolePatternContext, ConsolePatternPair } from "./console-dynamic-pattern-types";

export const consoleDynamicPatternPairs: ConsolePatternPair[] = [
  ...consoleDynamicCountPatternPairs,
  ...consoleDynamicStatusPatternPairs,
];

export function applyConsolePattern(
  text: string,
  locale: ConsoleLocale,
  context: ConsolePatternContext,
) : any {
  for (const pattern of consoleDynamicPatternPairs) {
    const match: any = locale === "en" ? text.match(pattern.zh) : text.match(pattern.enPattern);
    if (match) {
      return locale === "en" ? pattern.en(match, context) : pattern.zhBack(match, context);
    }
  }
  return text;
}
