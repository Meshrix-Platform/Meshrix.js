import type { ConsoleLocale } from "./console-locale-state";

export type ConsolePatternContext = {
  translateDynamicConsoleName: (value: string, locale: ConsoleLocale) => string;
  localizeConsoleText: (text: string, locale: ConsoleLocale) => string;
};

export type ConsolePatternPair = {
  zh: RegExp;
  en: (match: RegExpMatchArray, context: ConsolePatternContext) => string;
  enPattern: RegExp;
  zhBack: (match: RegExpMatchArray, context: ConsolePatternContext) => string;
};
