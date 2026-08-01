import fs from "node:fs/promises";
import path from "node:path";

export const SERVER_APPEARANCE_PRESETS_DIRNAME: any = "appearance-presets";

const idPattern: any = /^[a-z0-9][a-z0-9-]{1,63}$/;
const hexColorPattern: any = /^#[0-9a-fA-F]{6}$/;
const tokenNamePattern: any = /^[a-z][a-z0-9-]*$/;
const allowedValuePattern: any = /^(#[0-9a-fA-F]{6}|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d+)\s*\)|var\(--[a-z0-9-]+\)|(?:-?\d+px\s+){2,4}rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d+)\s*\)(?:\s*,\s*(?:-?\d+px\s+){2,4}rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d+)\s*\))*)$/;

const requiredRuntimeTokens: any[] = [
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
  errors: any;
  name: any;
  constructor(errors?: any) {
    super(errors.join("; "));
    this.name = "AppearancePresetConfigError";
    this.errors = errors;
  }
}

function isRecord(value?: any) : any {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value?: any) : any {
  return JSON.parse(JSON.stringify(value));
}

export function serverAppearancePresetDirectory(userDataPath?: any) : any {
  return path.join(userDataPath, SERVER_APPEARANCE_PRESETS_DIRNAME);
}

export function validateAppearancePresetConfig(value?: any) : any {
  const errors: any[] = [];
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
    for (const [key, tokenValue] of (Object.entries(value.tokens) as [string, any][])) {
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

export function assertValidAppearancePresetConfig(value?: any) : any {
  const result: any = validateAppearancePresetConfig(value);
  if (!result.ok) {
    throw new AppearancePresetConfigError(result.errors);
  }
  return result.config;
}

export function parseAppearancePresetConfigText(text?: any) : any {
  let parsed: any;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch {
    throw new AppearancePresetConfigError(["config text must be valid JSON"]);
  }
  return assertValidAppearancePresetConfig(parsed);
}

async function readDirectoryEntries(directory?: any) : Promise<any> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function listServerAppearancePresetConfigs({ userDataPath }: Record<string, any>) : Promise<any> {
  const directory: any = serverAppearancePresetDirectory(userDataPath);
  await fs.mkdir(directory, { recursive: true });

  const entries: any = await readDirectoryEntries(directory);
  const configs: any[] = [];
  const errors: any[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const filePath: any = path.join(directory, entry.name);
    try {
      const config: any = parseAppearancePresetConfigText(await fs.readFile(filePath, "utf8"));
      configs.push(config);
    } catch (error: any) {
      const message: any = error instanceof Error ? error.message : "invalid preset config";
      errors.push(`${entry.name}: ${message}`);
    }
  }
  configs.sort((left?: any, right?: any) : any => left.id.localeCompare(right.id));
  return { directory, configs, errors };
}

export async function importServerAppearancePresetConfig({ userDataPath, config }: Record<string, any>) : Promise<any> {
  const normalized: any = assertValidAppearancePresetConfig(config);
  const directory: any = serverAppearancePresetDirectory(userDataPath);
  await fs.mkdir(directory, { recursive: true });

  const filePath: any = path.join(directory, `${normalized.id}.json`);
  const tempPath: any = path.join(directory, `.${normalized.id}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);

  const list: any = await listServerAppearancePresetConfigs({ userDataPath });
  return {
    directory,
    fileName: `${normalized.id}.json`,
    config: normalized,
    configs: list.configs,
    errors: list.errors
  };
}
