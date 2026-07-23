/// <reference types="vite/client" />
import type { ConsoleLocale } from "../i18n/console";

export type AppearancePresetMode = "system" | "light" | "dark";
export type AppearancePresetId = string;

export type AppearancePresetConfig = {
  schemaVersion: "v0.0.1:schema:definition-1";
  id: AppearancePresetId;
  label: {
    en: string;
    "zh-CN": string;
  };
  mode: AppearancePresetMode;
  lightPresetId?: string;
  darkPresetId?: string;
  tokens?: Record<string, string>;
};

export type ResolvedAppearancePreset = {
  selectedId: string;
  resolvedId: string;
  mode: Exclude<AppearancePresetMode, "system">;
  colorScheme: "light" | "dark";
  tokens: Record<string, string>;
};

export type AppearancePresetValidationResult =
  | { ok: true; config: AppearancePresetConfig }
  | { ok: false; errors: string[] };

export const DEFAULT_LIGHT_APPEARANCE_PRESET_ID = "geek-light-blue";
export const DEFAULT_DARK_APPEARANCE_PRESET_ID = "lico-crystal";
export const BUILT_IN_APPEARANCE_PRESET_ORDER = [
  "default-system",
  "lico-crystal",
  "geek-light-blue",
  "catppuccin-latte",
  "github-light",
  "one-light",
  "sunset-ember",
  "tokyo-night",
  "cappuccino-dark",
  "gruvbox-dark",
  "dracula",
  "nord",
  "monokai",
  "cyberpunk",
] as const;

const builtInAppearancePresetConfigValues = Object.entries(
  import.meta.glob("../appearance-presets/*.json", { eager: true, import: "default" }) as Record<string, unknown>,
)
  .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
  .map(([, value]) => value);

export const APPEARANCE_PRESET_CATALOG_CHANGED_EVENT = "lico:appearance-preset-catalog-changed";

const idPattern = /^[a-z0-9][a-z0-9-]{1,63}$/;
const hexColorPattern = /^#[0-9a-fA-F]{6}$/;
const allowedValuePattern = /^(#[0-9a-fA-F]{6}|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d+)\s*\)|var\(--[a-z0-9-]+\)|(?:-?\d+px\s+){2,4}rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d+)\s*\)(?:\s*,\s*(?:-?\d+px\s+){2,4}rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d+)\s*\))*)$/;

const requiredRuntimeTokens = [
  "bg-base",
  "bg-surface",
  "bg-subtle",
  "text-primary",
  "text-muted",
  "text-on-brand",
  "brand",
  "brand-strong",
  "brand-subtle",
  "success",
  "warning",
  "danger",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function rgba(hex: string, alpha: number) {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
}

function deriveTokens(mode: Exclude<AppearancePresetMode, "system">, tokens: Record<string, string>) {
  const brand = tokens.brand || "#2563eb";
  const danger = tokens.danger || (mode === "dark" ? "#fb7185" : "#b91c1c");
  const success = tokens.success || (mode === "dark" ? "#4ade80" : "#15803d");
  const textPrimary = tokens["text-primary"] || (mode === "dark" ? "#f8fafc" : "#0f172a");
  const textMuted = tokens["text-muted"] || (mode === "dark" ? "#94a3b8" : "#475569");
  const bgBase = tokens["bg-base"] || (mode === "dark" ? "#0f172a" : "#f8fafc");
  const bgSubtle = tokens["bg-subtle"] || (mode === "dark" ? "#1f2937" : "#f1f5f9");
  const borderSubtle = tokens["border-subtle"] || (mode === "dark" ? "#334155" : "#cbd5e1");

  return {
    "color-scheme": mode,
    "bg-inset": mode === "dark" ? "#0b1120" : "#e2e8f0",
    "border-subtle": borderSubtle,
    "border-strong": mode === "dark" ? "#475569" : "#94a3b8",
    "text-secondary": mode === "dark" ? "#cbd5e1" : "#334155",
    "text-disabled": mode === "dark" ? "#64748b" : "#94a3b8",
    "text-on-brand": mode === "dark" ? "#06121f" : "#ffffff",
    "text-inverse": mode === "dark" ? "#020617" : "#ffffff",
    "brand-muted": mode === "dark" ? "#0c4a6e" : "#bfdbfe",
    accent: "var(--brand)",
    info: mode === "dark" ? "#22d3ee" : "#0e7490",
    "info-surface": mode === "dark" ? "#083344" : "#cffafe",
    "info-border": mode === "dark" ? "#155e75" : "#67e8f9",
    "success-surface": mode === "dark" ? "#052e16" : "#dcfce7",
    "success-border": mode === "dark" ? "#166534" : "#86efac",
    "warning-text": mode === "dark" ? "#fde68a" : "#92400e",
    "warning-surface": mode === "dark" ? "#422006" : "#fef3c7",
    "warning-border": mode === "dark" ? "#854d0e" : "#fcd34d",
    "danger-surface": mode === "dark" ? "#4c0519" : "#fee2e2",
    "danger-border": mode === "dark" ? "#9f1239" : "#fca5a5",
    "brand-ring": rgba(brand, mode === "dark" ? 0.22 : 0.18),
    "brand-tint": rgba(brand, mode === "dark" ? 0.10 : 0.08),
    "brand-border": rgba(brand, mode === "dark" ? 0.44 : 0.42),
    "brand-glow": rgba(brand, mode === "dark" ? 0.12 : 0.12),
    "brand-shadow": rgba(brand, mode === "dark" ? 0.24 : 0.24),
    "danger-tint": rgba(danger, mode === "dark" ? 0.12 : 0.10),
    "success-tint": rgba(success, mode === "dark" ? 0.12 : 0.10),
    backdrop: mode === "dark" ? "rgba(2, 6, 23, 0.62)" : "rgba(15, 23, 42, 0.42)",
    "backdrop-strong": mode === "dark" ? "rgba(2, 6, 23, 0.74)" : "rgba(15, 23, 42, 0.58)",
    "border-soft": rgba(borderSubtle, mode === "dark" ? 0.55 : 0.32),
    "scrollbar-thumb": rgba(textMuted, mode === "dark" ? 0.38 : 0.42),
    "scrollbar-thumb-hover": rgba(textPrimary, mode === "dark" ? 0.52 : 0.60),
    "shadow-xs": mode === "dark" ? "0 1px 2px rgba(0, 0, 0, 0.44)" : "0 1px 2px rgba(15, 23, 42, 0.06)",
    "shadow-sm": mode === "dark"
      ? "0 1px 3px rgba(0, 0, 0, 0.52), 0 1px 2px rgba(0, 0, 0, 0.36)"
      : "0 1px 3px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.04)",
    "shadow-md": mode === "dark"
      ? "0 4px 12px rgba(0, 0, 0, 0.58), 0 2px 4px rgba(0, 0, 0, 0.36)"
      : "0 4px 12px rgba(15, 23, 42, 0.10), 0 2px 4px rgba(15, 23, 42, 0.05)",
    "shadow-lg": mode === "dark"
      ? "0 8px 24px rgba(0, 0, 0, 0.66), 0 4px 8px rgba(0, 0, 0, 0.36)"
      : "0 8px 24px rgba(15, 23, 42, 0.12), 0 4px 8px rgba(15, 23, 42, 0.05)",
    "shadow-xl": mode === "dark"
      ? "0 20px 48px rgba(0, 0, 0, 0.74), 0 8px 16px rgba(0, 0, 0, 0.44)"
      : "0 20px 48px rgba(15, 23, 42, 0.16), 0 8px 16px rgba(15, 23, 42, 0.07)",
    "skeleton-base": mode === "dark" ? bgSubtle : "#e2e8f0",
    "skeleton-highlight": bgBase,
    ...tokens,
  };
}

export function validateAppearancePresetConfig(value: unknown): AppearancePresetValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["config must be a JSON object"] };
  }
  if (value.schemaVersion !== "v0.0.1:schema:definition-1") {
    errors.push("schemaVersion must be v0.0.1:schema:definition-1");
  }
  if (typeof value.id !== "string" || !idPattern.test(value.id)) {
    errors.push("id must be kebab-case and 2-64 characters");
  }
  if (!isRecord(value.label) || typeof value.label.en !== "string" || typeof value.label["zh-CN"] !== "string") {
    errors.push("label.en and label.zh-CN are required");
  }
  if (value.mode !== "system" && value.mode !== "light" && value.mode !== "dark") {
    errors.push("mode must be system, light, or dark");
  }

  if (value.mode === "system") {
    if (typeof value.lightPresetId !== "string" || typeof value.darkPresetId !== "string") {
      errors.push("system presets require lightPresetId and darkPresetId");
    }
  } else if (!isRecord(value.tokens)) {
    errors.push("fixed presets require tokens");
  } else {
    for (const token of requiredRuntimeTokens) {
      if (typeof value.tokens[token] !== "string" || !hexColorPattern.test(value.tokens[token])) {
        errors.push(`tokens.${token} must be a 6-digit hex color`);
      }
    }
    for (const [key, tokenValue] of Object.entries(value.tokens)) {
      if (!/^[a-z][a-z0-9-]*$/.test(key)) {
        errors.push(`tokens.${key} has an invalid token name`);
      }
      if (typeof tokenValue !== "string" || !allowedValuePattern.test(tokenValue)) {
        errors.push(`tokens.${key} has an invalid CSS token value`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, config: value as AppearancePresetConfig };
}

function validateBuiltInAppearancePresetConfigs(values: unknown[]) {
  return sortAppearancePresetConfigs(values.map((value) => {
    const result = validateAppearancePresetConfig(value);
    if (!result.ok) {
      throw new Error(`Invalid built-in appearance preset: ${result.errors.join("; ")}`);
    }
    return result.config;
  }));
}

function appearancePresetOrderIndex(id: string) {
  const index = BUILT_IN_APPEARANCE_PRESET_ORDER.indexOf(id as (typeof BUILT_IN_APPEARANCE_PRESET_ORDER)[number]);
  return index >= 0 ? index : Number.POSITIVE_INFINITY;
}

function sortAppearancePresetConfigs(configs: AppearancePresetConfig[]) {
  return [...configs].sort((left, right) => {
    const leftIndex = appearancePresetOrderIndex(left.id);
    const rightIndex = appearancePresetOrderIndex(right.id);
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
    return left.id.localeCompare(right.id);
  });
}

export let builtInAppearancePresetConfigs = validateBuiltInAppearancePresetConfigs(builtInAppearancePresetConfigValues);

async function loadBuiltInAppearancePresetConfigsFromCurrentGlob() {
  return validateBuiltInAppearancePresetConfigs(builtInAppearancePresetConfigValues);
}

let loadBuiltInAppearancePresetConfigsImpl = loadBuiltInAppearancePresetConfigsFromCurrentGlob;

export async function loadBuiltInAppearancePresetConfigs() {
  return loadBuiltInAppearancePresetConfigsImpl();
}

export async function refreshBuiltInAppearancePresetConfigs() {
  builtInAppearancePresetConfigs = await loadBuiltInAppearancePresetConfigs();
  return builtInAppearancePresetConfigs;
}

function dispatchAppearancePresetCatalogChanged() {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(APPEARANCE_PRESET_CATALOG_CHANGED_EVENT));
}

if (import.meta.hot) {
  import.meta.hot.accept((updatedModule) => {
    const nextModule = updatedModule as
      | {
          builtInAppearancePresetConfigs?: AppearancePresetConfig[];
          loadBuiltInAppearancePresetConfigs?: () => Promise<AppearancePresetConfig[]>;
        }
      | undefined;
    const nextConfigs = nextModule?.builtInAppearancePresetConfigs;
    if (Array.isArray(nextConfigs)) {
      builtInAppearancePresetConfigs = nextConfigs;
    }
    if (typeof nextModule?.loadBuiltInAppearancePresetConfigs === "function") {
      loadBuiltInAppearancePresetConfigsImpl = nextModule.loadBuiltInAppearancePresetConfigs;
    }
    dispatchAppearancePresetCatalogChanged();
  });
}

export function mergeAppearancePresetConfigs(customConfigs: AppearancePresetConfig[] = []) {
  const byId = new Map<string, AppearancePresetConfig>();
  for (const config of builtInAppearancePresetConfigs) {
    byId.set(config.id, config);
  }
  for (const config of customConfigs) {
    byId.set(config.id, config);
  }
  return sortAppearancePresetConfigs([...byId.values()]);
}

export function findAppearancePresetConfig(id: string, configs: AppearancePresetConfig[]) {
  return configs.find((config) => config.id === id) || configs.find((config) => config.id === "default-system") || configs[0];
}

export function hasAppearancePresetConfig(id: string, configs: AppearancePresetConfig[]) {
  return configs.some((config) => config.id === id);
}

export function localizedAppearancePresetLabel(config: AppearancePresetConfig, locale: ConsoleLocale) {
  return config.label[locale] || config.label.en || config.id;
}

export function resolveAppearancePresetConfig(
  selectedId: string,
  configs: AppearancePresetConfig[],
  prefersDark: boolean,
): ResolvedAppearancePreset {
  const selected = findAppearancePresetConfig(selectedId, configs);
  if (!selected) {
    throw new Error("No appearance preset configs are available");
  }
  if (selected.mode === "system") {
    const resolvedId = prefersDark ? selected.darkPresetId : selected.lightPresetId;
    const resolved = resolveAppearancePresetConfig(
      resolvedId || (prefersDark ? DEFAULT_DARK_APPEARANCE_PRESET_ID : DEFAULT_LIGHT_APPEARANCE_PRESET_ID),
      configs,
      prefersDark,
    );
    return {
      ...resolved,
      selectedId: selected.id,
    };
  }
  const baseId = selected.mode === "dark" ? DEFAULT_DARK_APPEARANCE_PRESET_ID : DEFAULT_LIGHT_APPEARANCE_PRESET_ID;
  const base = selected.id === baseId ? undefined : findAppearancePresetConfig(baseId, builtInAppearancePresetConfigs);
  const baseTokens = base?.mode === selected.mode ? deriveTokens(base.mode, base.tokens || {}) : {};
  const tokens = deriveTokens(selected.mode, {
    ...baseTokens,
    ...(selected.tokens || {}),
  });
  return {
    selectedId,
    resolvedId: selected.id,
    mode: selected.mode,
    colorScheme: selected.mode,
    tokens,
  };
}

export function parseAppearancePresetConfigText(text: string): AppearancePresetValidationResult {
  try {
    return validateAppearancePresetConfig(JSON.parse(text));
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : "config must be valid JSON"],
    };
  }
}
