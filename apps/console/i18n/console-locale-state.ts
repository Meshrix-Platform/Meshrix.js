import { readonly, ref } from "vue";

export type ConsoleLocale = "en" | "zh-CN";

export const CONSOLE_LANGUAGE_KEY = "lico-language";

function readStoredInitialConsoleLocale(): ConsoleLocale | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const saved = window.localStorage?.getItem(CONSOLE_LANGUAGE_KEY);
    return saved === "en" || saved === "zh-CN" ? saved : null;
  } catch (error) {
    return null;
  }
}

function readDocumentInitialConsoleLocale(): ConsoleLocale | null {
  if (typeof document === "undefined") {
    return null;
  }
  return document.documentElement.lang === "en" ? "en" : null;
}

export function readInitialConsoleLocale(): ConsoleLocale {
  return readStoredInitialConsoleLocale() || readDocumentInitialConsoleLocale() || "zh-CN";
}

export function resolveEffectiveConsoleLocale(mode: ConsoleLocale): ConsoleLocale {
  if (mode === "en") {
    return "en";
  }
  return readDocumentInitialConsoleLocale() || mode;
}

const consoleLocaleState = ref<ConsoleLocale>(readInitialConsoleLocale());

export const currentConsoleLocale = readonly(consoleLocaleState);

export function setConsoleLocaleState(mode: ConsoleLocale) {
  consoleLocaleState.value = mode;
}

export const consoleLocales = [
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
] as const;
