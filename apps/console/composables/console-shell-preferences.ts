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

export function useConsoleShellPreferences(options: { isAuthenticated: Readonly<Ref<boolean>> }) : any {
  const appearancePresetId: any = ref<AppearancePresetId>("default-system");
  const appearancePresetConfigs: any = ref<AppearancePresetConfig[]>(readAvailableAppearancePresetConfigs());
  const appearanceCycleScheme: any = ref<"light" | "dark">(prefersDarkColorScheme() ? "dark" : "light");
  const lastAppearancePresetByScheme: Record<string, any> = {
    light: DEFAULT_LIGHT_APPEARANCE_PRESET_ID,
    dark: DEFAULT_DARK_APPEARANCE_PRESET_ID,
  };
  const appearancePresetCatalogMessage: any = ref("");
  const appearancePresetImporting: any = ref(false);
  const languageMode: any = ref<ConsoleLocale>("zh-CN");
  let consoleDomLocalizer: ConsoleDomLocalizer | null = null;
  let unsubscribeAppearancePresetCatalogChanges: (() => void) | null = null;
  let appearancePresetCatalogPollTimer: number | null = null;
  let appearancePresetCatalogRefreshInFlight: any = false;
  let appearancePresetCatalogFingerprint: any = "";
  let appearancePreferencesMounted: any = false;

  const languageOptionBarOptions: any = computed(() : any =>
    consoleLocales.map((locale?: any) : any => ({
      value: locale.value,
      label:
        languageMode.value === "en"
          ? locale.value === "en"
            ? "English"
            : "Simplified Chinese"
          : locale.label,
    })),
  );
  const msg: any = computed(() : any => consoleMessages[languageMode.value]);
  const appearancePresetOptions: any = computed(() : any =>
    appearancePresetConfigs.value.map((config?: any) : any => ({
      value: config.id,
      label: localizedAppearancePresetLabel(config, languageMode.value),
      swatches: appearancePresetSwatches(config),
    })),
  );
  const appearanceCycleSchemeOptions: any = computed(() : any => [
    { value: "dark", label: msg.value.drawer.themeDark, icon: "moon" as const },
    { value: "light", label: msg.value.drawer.themeLight, icon: "sun" as const },
  ]);
  const appearancePresetOptionsForCycleScheme: any = computed(() : any =>
    appearancePresetConfigs.value
      .filter((config?: any) : any => config.mode === appearanceCycleScheme.value)
      .map((config?: any) : any => ({
        value: config.id,
        label: localizedAppearancePresetLabel(config, languageMode.value),
        swatches: appearancePresetSwatches(config),
      })),
  );
  const appearancePresetSelectionId: any = computed(() : any => {
    const ids: any = fixedPresetIdsForScheme(appearanceCycleScheme.value);
    return ids.includes(appearancePresetId.value)
      ? appearancePresetId.value
      : preferredPresetIdForScheme(appearanceCycleScheme.value);
  });
  const appearancePresetLabel: any = computed(() : any => {
    const config: any = appearancePresetConfigs.value.find((item?: any) : any => item.id === appearancePresetId.value);
    return config ? localizedAppearancePresetLabel(config, languageMode.value) : appearancePresetId.value;
  });
  const appearanceCycleSchemeLabel: any = computed(() : any =>
    appearanceCycleScheme.value === "dark"
      ? msg.value.topbar.appearanceCycleSchemeDarkLabel
      : msg.value.topbar.appearanceCycleSchemeLightLabel,
  );

  function prefersDarkColorScheme() : any {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  }

  function schemeForAppearancePreset(presetId: AppearancePresetId) : any {
    const config: any = findAppearancePresetConfig(presetId, appearancePresetConfigs.value);
    if (config?.mode === "light" || config?.mode === "dark") {
      return config.mode;
    }
    return prefersDarkColorScheme() ? "dark" : "light";
  }

  function fixedPresetIdsForScheme(scheme: "light" | "dark") : any {
    return appearancePresetConfigs.value
      .filter((config?: any) : any => config.mode === scheme)
      .map((config?: any) : any => config.id);
  }

  function preferredPresetIdForScheme(scheme: "light" | "dark") : any {
    const ids: any = fixedPresetIdsForScheme(scheme);
    if (ids.includes(lastAppearancePresetByScheme[scheme])) {
      return lastAppearancePresetByScheme[scheme];
    }
    return ids[0] || "default-system";
  }

  function appearancePresetSwatches(config: AppearancePresetConfig) : any {
    const tokens: any = config.tokens;
    if (!tokens) {
      return undefined;
    }
    const swatches: any = [
      tokens["bg-base"] || tokens["bg-surface"],
      tokens.brand,
      tokens["brand-strong"] || tokens.info || tokens.danger,
    ].filter((value?: any): value is string => Boolean(value));
    return swatches.length > 0 ? swatches : undefined;
  }

  function applyAppearancePreset(presetId: AppearancePresetId) : any {
    const nextPresetId: any = normalizeAppearancePresetId(presetId, appearancePresetConfigs.value);
    applyAppearancePresetDocument(nextPresetId, appearancePresetConfigs.value);
    persistAppearancePreset(nextPresetId);
    appearancePresetId.value = nextPresetId;
    const scheme: any = schemeForAppearancePreset(nextPresetId);
    appearanceCycleScheme.value = scheme;
    const config: any = findAppearancePresetConfig(nextPresetId, appearancePresetConfigs.value);
    if (config?.mode === scheme) {
      lastAppearancePresetByScheme[scheme] = nextPresetId;
    }
  }

  function cycleAppearancePreset() : any {
    const ids: any = fixedPresetIdsForScheme(appearanceCycleScheme.value);
    const currentIndex: any = ids.indexOf(appearancePresetId.value);
    const nextIndex: any = currentIndex >= 0 ? (currentIndex + 1) % ids.length : 0;
    applyAppearancePreset(ids[nextIndex] || preferredPresetIdForScheme(appearanceCycleScheme.value));
  }

  function toggleAppearanceCycleScheme() : any {
    const nextScheme: any = appearanceCycleScheme.value === "dark" ? "light" : "dark";
    setAppearanceCycleScheme(nextScheme);
  }

  function applyLanguage(mode: ConsoleLocale) : any {
    applyConsoleLanguageDocument(mode);
    persistConsoleLanguage(mode);
    setConsoleLocaleState(mode);
    languageMode.value = mode;
    void nextTick(() : any => consoleDomLocalizer?.refresh());
  }

  function setLanguage(value: string | number | boolean) : any {
    applyLanguage(value === "en" ? "en" : "zh-CN");
  }

  function setAppearancePreset(value: string | number | boolean) : any {
    applyAppearancePreset(normalizeAppearancePresetId(value, appearancePresetConfigs.value));
  }

  function setAppearanceCycleScheme(value: string | number | boolean) : any {
    const nextScheme: any = value === "light" ? "light" : "dark";
    const currentIds: any = fixedPresetIdsForScheme(nextScheme);
    if (appearanceCycleScheme.value === nextScheme && currentIds.includes(appearancePresetId.value)) {
      return;
    }
    appearanceCycleScheme.value = nextScheme;
    applyAppearancePreset(preferredPresetIdForScheme(nextScheme));
  }

  function fingerprintAppearancePresetCatalog(configs: AppearancePresetConfig[]) : any {
    return JSON.stringify(configs.map((config?: any) : any => [config.id, config]));
  }

  function applyAppearancePresetCatalog(
    configs: AppearancePresetConfig[],
    options: { silent?: boolean; preferStored?: boolean; selectedId?: string } = {},
  ) : any {
    appearancePresetCatalogFingerprint = fingerprintAppearancePresetCatalog(configs);
    appearancePresetConfigs.value = configs;
    const preferredPresetId: any =
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
  ) : Promise<any> {
    if (appearancePresetCatalogRefreshInFlight && options.silent) {
      return;
    }
    appearancePresetCatalogRefreshInFlight = true;
    try {
      if (options.refreshBuiltIn !== false) {
        await refreshAvailableAppearancePresetConfigs();
      }
      const response: any = await fetchServerAppearancePresetConfigs();
      const configs: any = setServerAppearancePresetConfigs(response.configs || []);
      if (!options.silent || fingerprintAppearancePresetCatalog(configs) !== appearancePresetCatalogFingerprint) {
        applyAppearancePresetCatalog(configs, options);
      }
      if (!options.silent && response.errors?.length) {
        appearancePresetCatalogMessage.value =
          `${appearancePresetConfigs.value.length} preset files loaded; ${response.errors.length} server preset file(s) ignored`;
      }
    } catch (error: any) {
      if (!options.silent) {
        appearancePresetCatalogMessage.value = error instanceof Error ? error.message : "Preset files failed to load";
      }
    } finally {
      appearancePresetCatalogRefreshInFlight = false;
    }
  }

  async function importAppearancePresetFileToServer(file: File) : Promise<any> {
    appearancePresetImporting.value = true;
    try {
      const response: any = await importServerAppearancePresetText(await file.text());
      const configs: any = setServerAppearancePresetConfigs(response.configs || []);
      applyAppearancePresetCatalog(configs, {
        selectedId: response.config?.id,
      });
      appearancePresetCatalogMessage.value = response.config?.id
        ? `Imported ${response.config.id} to server presets`
        : `${appearancePresetConfigs.value.length} preset files loaded`;
      if (response.errors?.length) {
        appearancePresetCatalogMessage.value += `; ${response.errors.length} server preset file(s) ignored`;
      }
    } catch (error: any) {
      appearancePresetCatalogMessage.value = error instanceof Error ? error.message : "Preset file import failed";
    } finally {
      appearancePresetImporting.value = false;
    }
  }

  function toggleLanguage() : any {
    applyLanguage(languageMode.value === "en" ? "zh-CN" : "en");
  }

  function tt(text: string) : any {
    return localizeConsoleText(text, resolveEffectiveConsoleLocale(languageMode.value));
  }

  onMounted(() : any => {
    appearancePresetConfigs.value = readAvailableAppearancePresetConfigs();
    const storedPresetId: any = readStoredAppearancePreset(appearancePresetConfigs.value);
    if (storedPresetId) {
      applyAppearancePreset(storedPresetId);
    } else {
      applyAppearancePresetDocument(appearancePresetId.value, appearancePresetConfigs.value);
    }
    applyLanguage(readStoredConsoleLanguage() || languageMode.value);
    consoleDomLocalizer = installConsoleDomLocalizer(() : any => resolveEffectiveConsoleLocale(languageMode.value));
    unsubscribeAppearancePresetCatalogChanges = subscribeAppearancePresetCatalogChanges(() : any => {
      applyAppearancePresetCatalog(readAvailableAppearancePresetConfigs());
    });
    appearancePreferencesMounted = true;
    if (options.isAuthenticated.value) {
      void refreshAppearancePresetConfigs({ silent: true, preferStored: true });
    }
    if (typeof window !== "undefined") {
      appearancePresetCatalogPollTimer = window.setInterval(() : any => {
        if (!options.isAuthenticated.value || document.visibilityState === "hidden") {
          return;
        }
        void refreshAppearancePresetConfigs({ silent: true, refreshBuiltIn: false });
      }, 2500);
    }
  });

  watch(options.isAuthenticated, (authenticated?: any) : any => {
    if (!authenticated || !appearancePreferencesMounted) {
      return;
    }
    void refreshAppearancePresetConfigs({ silent: true, preferStored: true });
  });

  watch(languageMode, async () : Promise<any> => {
    await nextTick();
    consoleDomLocalizer?.refresh();
  });

  onBeforeUnmount(() : any => {
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
