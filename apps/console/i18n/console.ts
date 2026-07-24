import { consoleMessages } from "./console-messages";

export { consoleMessages };
export {
  CONSOLE_LANGUAGE_KEY,
  consoleLocales,
  currentConsoleLocale,
  readInitialConsoleLocale,
  resolveEffectiveConsoleLocale,
  setConsoleLocaleState,
  type ConsoleLocale,
} from "./console-locale-state";
export { localizeConsoleText } from "./console-text-localizer";

export type ConsoleMessageKey = keyof typeof consoleMessages["zh-CN"];
