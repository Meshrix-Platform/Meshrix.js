import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";
import {
  consoleLocales,
  consoleMessages,
  localizeConsoleText,
  resolveEffectiveConsoleLocale,
  setConsoleLocaleState,
  type ConsoleLocale,
} from "../i18n/console";
import { installConsoleDomLocalizer, type ConsoleDomLocalizer } from "../i18n/console-dom-localizer";
import {
  DEFAULT_DARK_APPEARANCE_PRESET_ID,
  DEFAULT_LIGHT_APPEARANCE_PRESET_ID,
  findAppearancePresetConfig,
  localizedAppearancePresetLabel,
} from "../lib/appearance-preset-config";
import {
  fetchServerAppearancePresetConfigs,
  importServerAppearancePresetText,
} from "../lib/appearance-presets-client";
import {
  applyConsoleLanguageDocument,
  applyAppearancePresetDocument,
  persistConsoleLanguage,
  persistAppearancePreset,
  readAvailableAppearancePresetConfigs,
  refreshAvailableAppearancePresetConfigs,
  readStoredAppearancePreset,
  readStoredConsoleLanguage,
  normalizeAppearancePresetId,
  setServerAppearancePresetConfigs,
  subscribeAppearancePresetCatalogChanges,
  type AppearancePresetConfig,
  type AppearancePresetId,
} from "./console-shell-preference-effects";

export function useConsoleShellPreferences(options: { isAuthenticated: Readonly<Ref<boolean>> }) {
  const appearancePresetId = ref<AppearancePresetId>("default-system");
  const appearancePresetConfigs = ref<AppearancePresetConfig[]>(readAvailableAppearancePresetConfigs());
  const appearanceCycleScheme = ref<"light" | "dark">(prefersDarkColorScheme() ? "dark" : "light");
  const lastAppearancePresetByScheme = {
    light: DEFAULT_LIGHT_APPEARANCE_PRESET_ID,
    dark: DEFAULT_DARK_APPEARANCE_PRESET_ID,
  };
  const appearancePresetCatalogMessage = ref("");
  const appearancePresetImporting = ref(false);
  const languageMode = ref<ConsoleLocale>("zh-CN");
  let consoleDomLocalizer: ConsoleDomLocalizer | null = null;
  let unsubscribeAppearancePresetCatalogChanges: (() => void) | null = null;
  let appearancePresetCatalogPollTimer: number | null = null;
  let appearancePresetCatalogRefreshInFlight = false;
  let appearancePresetCatalogFingerprint = "";
  let appearancePreferencesMounted = false;

  const languageOptionBarOptions = computed(() =>
    consoleLocales.map((locale) => ({
      value: locale.value,
      label:
        languageMode.value === "en"
          ? locale.value === "en"
            ? "English"
            : "Simplified Chinese"
          : locale.label,
    })),
  );
  const msg = computed(() => consoleMessages[languageMode.value]);
  const appearancePresetOptions = computed(() =>
    appearancePresetConfigs.value.map((config) => ({
      value: config.id,
      label: localizedAppearancePresetLabel(config, languageMode.value),
      swatches: appearancePresetSwatches(config),
    })),
  );
  const appearanceCycleSchemeOptions = computed(() => [
    { value: "dark", label: msg.value.drawer.themeDark, icon: "moon" as const },
    { value: "light", label: msg.value.drawer.themeLight, icon: "sun" as const },
  ]);
  const appearancePresetOptionsForCycleScheme = computed(() =>
    appearancePresetConfigs.value
      .filter((config) => config.mode === appearanceCycleScheme.value)
      .map((config) => ({
        value: config.id,
        label: localizedAppearancePresetLabel(config, languageMode.value),
        swatches: appearancePresetSwatches(config),
      })),
  );
  const appearancePresetSelectionId = computed(() => {
    const ids = fixedPresetIdsForScheme(appearanceCycleScheme.value);
    return ids.includes(appearancePresetId.value)
      ? appearancePresetId.value
      : preferredPresetIdForScheme(appearanceCycleScheme.value);
  });
  const appearancePresetLabel = computed(() => {
    const config = appearancePresetConfigs.value.find((item) => item.id === appearancePresetId.value);
    return config ? localizedAppearancePresetLabel(config, languageMode.value) : appearancePresetId.value;
  });
  const appearanceCycleSchemeLabel = computed(() =>
    appearanceCycleScheme.value === "dark"
      ? msg.value.topbar.appearanceCycleSchemeDarkLabel
      : msg.value.topbar.appearanceCycleSchemeLightLabel,
  );

  function prefersDarkColorScheme() {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  }

  function schemeForAppearancePreset(presetId: AppearancePresetId) {
    const config = findAppearancePresetConfig(presetId, appearancePresetConfigs.value);
    if (config?.mode === "light" || config?.mode === "dark") {
      return config.mode;
    }
    return prefersDarkColorScheme() ? "dark" : "light";
  }

  function fixedPresetIdsForScheme(scheme: "light" | "dark") {
    return appearancePresetConfigs.value
      .filter((config) => config.mode === scheme)
      .map((config) => config.id);
  }

  function preferredPresetIdForScheme(scheme: "light" | "dark") {
    const ids = fixedPresetIdsForScheme(scheme);
    if (ids.includes(lastAppearancePresetByScheme[scheme])) {
      return lastAppearancePresetByScheme[scheme];
    }
    return ids[0] || "default-system";
  }

  function appearancePresetSwatches(config: AppearancePresetConfig) {
    const tokens = config.tokens;
    if (!tokens) {
      return undefined;
    }
    const swatches = [
      tokens["bg-base"] || tokens["bg-surface"],
      tokens.brand,
      tokens["brand-strong"] || tokens.info || tokens.danger,
    ].filter((value): value is string => Boolean(value));
    return swatches.length > 0 ? swatches : undefined;
  }

  function applyAppearancePreset(presetId: AppearancePresetId) {
    const nextPresetId = normalizeAppearancePresetId(presetId, appearancePresetConfigs.value);
    applyAppearancePresetDocument(nextPresetId, appearancePresetConfigs.value);
    persistAppearancePreset(nextPresetId);
    appearancePresetId.value = nextPresetId;
    const scheme = schemeForAppearancePreset(nextPresetId);
    appearanceCycleScheme.value = scheme;
    const config = findAppearancePresetConfig(nextPresetId, appearancePresetConfigs.value);
    if (config?.mode === scheme) {
      lastAppearancePresetByScheme[scheme] = nextPresetId;
    }
  }

  function cycleAppearancePreset() {
    const ids = fixedPresetIdsForScheme(appearanceCycleScheme.value);
    const currentIndex = ids.indexOf(appearancePresetId.value);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % ids.length : 0;
    applyAppearancePreset(ids[nextIndex] || preferredPresetIdForScheme(appearanceCycleScheme.value));
  }

  function toggleAppearanceCycleScheme() {
    const nextScheme = appearanceCycleScheme.value === "dark" ? "light" : "dark";
    setAppearanceCycleScheme(nextScheme);
  }

  function applyLanguage(mode: ConsoleLocale) {
    applyConsoleLanguageDocument(mode);
    persistConsoleLanguage(mode);
    setConsoleLocaleState(mode);
    languageMode.value = mode;
    void nextTick(() => consoleDomLocalizer?.refresh());
  }

  function setLanguage(value: string | number | boolean) {
    applyLanguage(value === "en" ? "en" : "zh-CN");
  }

  function setAppearancePreset(value: string | number | boolean) {
    applyAppearancePreset(normalizeAppearancePresetId(value, appearancePresetConfigs.value));
  }

  function setAppearanceCycleScheme(value: string | number | boolean) {
    const nextScheme = value === "light" ? "light" : "dark";
    const currentIds = fixedPresetIdsForScheme(nextScheme);
    if (appearanceCycleScheme.value === nextScheme && currentIds.includes(appearancePresetId.value)) {
      return;
    }
    appearanceCycleScheme.value = nextScheme;
    applyAppearancePreset(preferredPresetIdForScheme(nextScheme));
  }

  function fingerprintAppearancePresetCatalog(configs: AppearancePresetConfig[]) {
    return JSON.stringify(configs.map((config) => [config.id, config]));
  }

  function applyAppearancePresetCatalog(
    configs: AppearancePresetConfig[],
    options: { silent?: boolean; preferStored?: boolean; selectedId?: string } = {},
  ) {
    appearancePresetCatalogFingerprint = fingerprintAppearancePresetCatalog(configs);
    appearancePresetConfigs.value = configs;
    const preferredPresetId =
      options.selectedId ||
      (options.preferStored
        ? readStoredAppearancePreset(appearancePresetConfigs.value) || appearancePresetId.value
        : appearancePresetId.value);
    applyAppearancePreset(preferredPresetId);
    if (!options.silent) {
      appearancePresetCatalogMessage.value = `${appearancePresetConfigs.value.length} preset files loaded`;
    }
  }

  async function refreshAppearancePresetConfigs(
    options: { silent?: boolean; preferStored?: boolean; refreshBuiltIn?: boolean } = {},
  ) {
    if (appearancePresetCatalogRefreshInFlight && options.silent) {
      return;
    }
    appearancePresetCatalogRefreshInFlight = true;
    try {
      if (options.refreshBuiltIn !== false) {
        await refreshAvailableAppearancePresetConfigs();
      }
      const response = await fetchServerAppearancePresetConfigs();
      const configs = setServerAppearancePresetConfigs(response.configs || []);
      if (!options.silent || fingerprintAppearancePresetCatalog(configs) !== appearancePresetCatalogFingerprint) {
        applyAppearancePresetCatalog(configs, options);
      }
      if (!options.silent && response.errors?.length) {
        appearancePresetCatalogMessage.value =
          `${appearancePresetConfigs.value.length} preset files loaded; ${response.errors.length} server preset file(s) ignored`;
      }
    } catch (error) {
      if (!options.silent) {
        appearancePresetCatalogMessage.value = error instanceof Error ? error.message : "Preset files failed to load";
      }
    } finally {
      appearancePresetCatalogRefreshInFlight = false;
    }
  }

  async function importAppearancePresetFileToServer(file: File) {
    appearancePresetImporting.value = true;
    try {
      const response = await importServerAppearancePresetText(await file.text());
      const configs = setServerAppearancePresetConfigs(response.configs || []);
      applyAppearancePresetCatalog(configs, {
        selectedId: response.config?.id,
      });
      appearancePresetCatalogMessage.value = response.config?.id
        ? `Imported ${response.config.id} to server presets`
        : `${appearancePresetConfigs.value.length} preset files loaded`;
      if (response.errors?.length) {
        appearancePresetCatalogMessage.value += `; ${response.errors.length} server preset file(s) ignored`;
      }
    } catch (error) {
      appearancePresetCatalogMessage.value = error instanceof Error ? error.message : "Preset file import failed";
    } finally {
      appearancePresetImporting.value = false;
    }
  }

  function toggleLanguage() {
    applyLanguage(languageMode.value === "en" ? "zh-CN" : "en");
  }

  function tt(text: string) {
    return localizeConsoleText(text, resolveEffectiveConsoleLocale(languageMode.value));
  }

  onMounted(() => {
    appearancePresetConfigs.value = readAvailableAppearancePresetConfigs();
    const storedPresetId = readStoredAppearancePreset(appearancePresetConfigs.value);
    if (storedPresetId) {
      applyAppearancePreset(storedPresetId);
    } else {
      applyAppearancePresetDocument(appearancePresetId.value, appearancePresetConfigs.value);
    }
    applyLanguage(readStoredConsoleLanguage() || languageMode.value);
    consoleDomLocalizer = installConsoleDomLocalizer(() => resolveEffectiveConsoleLocale(languageMode.value));
    unsubscribeAppearancePresetCatalogChanges = subscribeAppearancePresetCatalogChanges(() => {
      applyAppearancePresetCatalog(readAvailableAppearancePresetConfigs());
    });
    appearancePreferencesMounted = true;
    if (options.isAuthenticated.value) {
      void refreshAppearancePresetConfigs({ silent: true, preferStored: true });
    }
    if (typeof window !== "undefined") {
      appearancePresetCatalogPollTimer = window.setInterval(() => {
        if (!options.isAuthenticated.value || document.visibilityState === "hidden") {
          return;
        }
        void refreshAppearancePresetConfigs({ silent: true, refreshBuiltIn: false });
      }, 2500);
    }
  });

  watch(options.isAuthenticated, (authenticated) => {
    if (!authenticated || !appearancePreferencesMounted) {
      return;
    }
    void refreshAppearancePresetConfigs({ silent: true, preferStored: true });
  });

  watch(languageMode, async () => {
    await nextTick();
    consoleDomLocalizer?.refresh();
  });

  onBeforeUnmount(() => {
    appearancePreferencesMounted = false;
    unsubscribeAppearancePresetCatalogChanges?.();
    unsubscribeAppearancePresetCatalogChanges = null;
    if (appearancePresetCatalogPollTimer !== null) {
      window.clearInterval(appearancePresetCatalogPollTimer);
      appearancePresetCatalogPollTimer = null;
    }
    consoleDomLocalizer?.disconnect();
    consoleDomLocalizer = null;
  });

  return {
    appearancePresetId,
    appearancePresetConfigs,
    appearancePresetCatalogMessage,
    appearancePresetImporting,
    appearanceCycleScheme,
    appearanceCycleSchemeLabel,
    appearanceCycleSchemeOptions,
    languageMode,
    languageOptionBarOptions,
    appearancePresetOptions,
    appearancePresetOptionsForCycleScheme,
    appearancePresetSelectionId,
    appearancePresetLabel,
    msg,
    applyAppearancePreset,
    cycleAppearancePreset,
    toggleAppearanceCycleScheme,
    importAppearancePresetFileToServer,
    refreshAppearancePresetConfigs,
    setAppearancePreset,
    setAppearanceCycleScheme,
    applyLanguage,
    setLanguage,
    toggleLanguage,
    tt,
  };
}
