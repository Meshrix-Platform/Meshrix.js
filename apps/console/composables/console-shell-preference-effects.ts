import {
  CONSOLE_LANGUAGE_KEY,
  consoleMessages,
  type ConsoleLocale,
} from "../i18n/console";
import {
  readBrowserLocalStorageItem,
  writeBrowserLocalStorageItem,
} from "../lib/browser-window";
import {
  APPEARANCE_PRESET_CATALOG_CHANGED_EVENT,
  builtInAppearancePresetConfigs,
  findAppearancePresetConfig,
  hasAppearancePresetConfig,
  mergeAppearancePresetConfigs,
  refreshBuiltInAppearancePresetConfigs,
  resolveAppearancePresetConfig,
  validateAppearancePresetConfig,
  type AppearancePresetConfig,
  type AppearancePresetId,
} from "../lib/appearance-preset-config";

export type { AppearancePresetConfig, AppearancePresetId };

export const appearancePresetIds: AppearancePresetId[] = builtInAppearancePresetConfigs.map((config) => config.id);

const APPEARANCE_PRESET_KEY = "lico-appearance-preset";
const LANGUAGE_KEY = CONSOLE_LANGUAGE_KEY;
let activeSystemMediaQuery: MediaQueryList | null = null;
let activeSystemListener: (() => void) | null = null;
let activeSystemPresetId = "";
let activeSystemConfigs: AppearancePresetConfig[] = [];
let lastAppliedTokenNames = new Set<string>();
let serverAppearancePresetConfigs: AppearancePresetConfig[] = [];

function browserDocument() {
  return typeof document === "undefined" ? null : document;
}

function readStorageValue(key: string) {
  try {
    return readBrowserLocalStorageItem(key);
  } catch (e) {
    return null;
  }
}

function writeStorageValue(key: string, value: string) {
  try {
    writeBrowserLocalStorageItem(key, value);
  } catch (e) {
    // Storage can be unavailable in private browsing or SSR-like shells.
  }
}

export function isAppearancePresetId(value: unknown): value is AppearancePresetId {
  return typeof value === "string" && hasAppearancePresetConfig(value, readAvailableAppearancePresetConfigs());
}

export function normalizeAppearancePresetId(
  value: unknown,
  configs: AppearancePresetConfig[] = readAvailableAppearancePresetConfigs(),
): AppearancePresetId {
  return typeof value === "string" && hasAppearancePresetConfig(value, configs) ? value : "default-system";
}

export function readAvailableAppearancePresetConfigs() {
  return mergeAppearancePresetConfigs(serverAppearancePresetConfigs);
}

export async function refreshAvailableAppearancePresetConfigs() {
  await refreshBuiltInAppearancePresetConfigs();
  return readAvailableAppearancePresetConfigs();
}

export function setServerAppearancePresetConfigs(configs: unknown[]) {
  const validatedConfigs: AppearancePresetConfig[] = [];
  for (const config of configs) {
    const result = validateAppearancePresetConfig(config);
    if (result.ok) {
      validatedConfigs.push(result.config);
    }
  }
  serverAppearancePresetConfigs = validatedConfigs;
  return readAvailableAppearancePresetConfigs();
}

export function subscribeAppearancePresetCatalogChanges(listener: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }
  const handleCatalogChanged = () => listener();
  window.addEventListener(APPEARANCE_PRESET_CATALOG_CHANGED_EVENT, handleCatalogChanged);
  return () => window.removeEventListener(APPEARANCE_PRESET_CATALOG_CHANGED_EVENT, handleCatalogChanged);
}

export function readStoredAppearancePreset(
  configs: AppearancePresetConfig[] = readAvailableAppearancePresetConfigs(),
): AppearancePresetId | null {
  const saved = readStorageValue(APPEARANCE_PRESET_KEY);
  if (typeof saved === "string" && hasAppearancePresetConfig(saved, configs)) {
    return saved;
  }
  return null;
}

export function persistAppearancePreset(presetId: AppearancePresetId) {
  writeStorageValue(APPEARANCE_PRESET_KEY, presetId);
}

function prefersDarkColorScheme() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

function clearSystemAppearanceListener() {
  if (activeSystemMediaQuery && activeSystemListener) {
    activeSystemMediaQuery.removeEventListener?.("change", activeSystemListener);
  }
  activeSystemMediaQuery = null;
  activeSystemListener = null;
  activeSystemPresetId = "";
  activeSystemConfigs = [];
}

function applyResolvedTokens(html: HTMLElement, presetId: AppearancePresetId, configs: AppearancePresetConfig[]) {
  const resolved = resolveAppearancePresetConfig(presetId, configs, prefersDarkColorScheme());
  html.dataset.appearancePreset = resolved.selectedId;
  html.dataset.resolvedAppearancePreset = resolved.resolvedId;
  html.dataset.appearanceColorScheme = resolved.colorScheme;
  html.style.colorScheme = resolved.colorScheme;
  for (const tokenName of lastAppliedTokenNames) {
    if (!(tokenName in resolved.tokens)) {
      html.style.removeProperty(`--${tokenName}`);
    }
  }
  lastAppliedTokenNames = new Set(Object.keys(resolved.tokens));
  for (const [tokenName, value] of Object.entries(resolved.tokens)) {
    html.style.setProperty(`--${tokenName}`, value);
  }
}

export function applyAppearancePresetDocument(
  presetId: AppearancePresetId,
  configs: AppearancePresetConfig[] = readAvailableAppearancePresetConfigs(),
) {
  const html = browserDocument()?.documentElement;
  if (!html) {
    return;
  }
  html.classList.remove("theme-dark", "theme-light");
  applyResolvedTokens(html, presetId, configs);

  const selected = findAppearancePresetConfig(presetId, configs);
  if (selected?.mode !== "system") {
    clearSystemAppearanceListener();
    return;
  }

  clearSystemAppearanceListener();
  activeSystemPresetId = presetId;
  activeSystemConfigs = configs;
  activeSystemMediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  activeSystemListener = () => {
    if (activeSystemPresetId) {
      applyResolvedTokens(html, activeSystemPresetId, activeSystemConfigs);
    }
  };
  activeSystemMediaQuery?.addEventListener?.("change", activeSystemListener);
}

export function readStoredConsoleLanguage(): ConsoleLocale | null {
  const saved = readStorageValue(LANGUAGE_KEY);
  return saved === "en" || saved === "zh-CN" ? saved : null;
}

export function persistConsoleLanguage(mode: ConsoleLocale) {
  writeStorageValue(LANGUAGE_KEY, mode);
}

export function applyConsoleLanguageDocument(mode: ConsoleLocale) {
  const doc = browserDocument();
  if (!doc) {
    return;
  }
  doc.documentElement.lang = mode === "en" ? "en" : "zh-CN";
  doc.title = consoleMessages[mode].appTitle;
}
