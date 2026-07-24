import { getJson, postJson } from "@meshrix/ui-console/bridge-http";
import type { AppearancePresetConfig } from "./appearance-preset-config";

export type AppearancePresetCatalogResponse = {
  ok?: boolean;
  directory?: string;
  fileName?: string;
  config?: AppearancePresetConfig;
  configs?: AppearancePresetConfig[];
  presets?: AppearancePresetConfig[];
  errors?: string[];
  error?: string;
};

function normalizeCatalogResponse(response: AppearancePresetCatalogResponse): AppearancePresetCatalogResponse {
  const configs = Array.isArray(response.configs) ? response.configs : response.presets || [];
  return {
    ...response,
    configs,
    presets: configs,
    errors: Array.isArray(response.errors) ? response.errors : [],
  };
}

export async function fetchServerAppearancePresetConfigs() {
  return normalizeCatalogResponse(await getJson<AppearancePresetCatalogResponse>("/api/appearance-presets"));
}

export async function importServerAppearancePresetConfig(config: AppearancePresetConfig) {
  return normalizeCatalogResponse(
    await postJson<AppearancePresetCatalogResponse>(
      "/api/appearance-presets/import",
      { config },
      { safetyConfirm: true },
    ),
  );
}

export async function importServerAppearancePresetText(text: string) {
  return normalizeCatalogResponse(
    await postJson<AppearancePresetCatalogResponse>(
      "/api/appearance-presets/import",
      { text },
      { safetyConfirm: true },
    ),
  );
}
