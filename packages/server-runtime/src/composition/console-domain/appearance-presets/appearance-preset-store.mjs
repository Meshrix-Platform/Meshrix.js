import fs from "node:fs/promises";
import path from "node:path";

export const SERVER_APPEARANCE_PRESETS_DIRNAME = "appearance-presets";

const idPattern = /^[a-z0-9][a-z0-9-]{1,63}$/;
const hexColorPattern = /^#[0-9a-fA-F]{6}$/;
const tokenNamePattern = /^[a-z][a-z0-9-]*$/;
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
  "danger"
];

export class AppearancePresetConfigError extends Error {
  constructor(errors) {
    super(errors.join("; "));
    this.name = "AppearancePresetConfigError";
    this.errors = errors;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function serverAppearancePresetDirectory(userDataPath) {
  return path.join(userDataPath, SERVER_APPEARANCE_PRESETS_DIRNAME);
}

export function validateAppearancePresetConfig(value) {
  const errors = [];
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
      if (!tokenNamePattern.test(key)) {
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
  return { ok: true, config: cloneJson(value) };
}

export function assertValidAppearancePresetConfig(value) {
  const result = validateAppearancePresetConfig(value);
  if (!result.ok) {
    throw new AppearancePresetConfigError(result.errors);
  }
  return result.config;
}

export function parseAppearancePresetConfigText(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch {
    throw new AppearancePresetConfigError(["config text must be valid JSON"]);
  }
  return assertValidAppearancePresetConfig(parsed);
}

async function readDirectoryEntries(directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function listServerAppearancePresetConfigs({ userDataPath }) {
  const directory = serverAppearancePresetDirectory(userDataPath);
  await fs.mkdir(directory, { recursive: true });

  const entries = await readDirectoryEntries(directory);
  const configs = [];
  const errors = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(directory, entry.name);
    try {
      const config = parseAppearancePresetConfigText(await fs.readFile(filePath, "utf8"));
      configs.push(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid preset config";
      errors.push(`${entry.name}: ${message}`);
    }
  }
  configs.sort((left, right) => left.id.localeCompare(right.id));
  return { directory, configs, errors };
}

export async function importServerAppearancePresetConfig({ userDataPath, config }) {
  const normalized = assertValidAppearancePresetConfig(config);
  const directory = serverAppearancePresetDirectory(userDataPath);
  await fs.mkdir(directory, { recursive: true });

  const filePath = path.join(directory, `${normalized.id}.json`);
  const tempPath = path.join(directory, `.${normalized.id}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);

  const list = await listServerAppearancePresetConfigs({ userDataPath });
  return {
    directory,
    fileName: `${normalized.id}.json`,
    config: normalized,
    configs: list.configs,
    errors: list.errors
  };
}
