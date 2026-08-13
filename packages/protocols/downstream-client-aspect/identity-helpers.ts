import path from "node:path";
import {
  executableExists,
  resolveCommandCandidate as resolveHostCommandCandidate
} from "#meshrix/foundation/environment-compatibility/index";

export function asText(value?: any, fallback: any = "") : any {
  return String(value ?? fallback).trim();
}

export function asObject(value?: any, fallback: Record<string, any> | null = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

export function asArray(value?: any) : any {
  return Array.isArray(value) ? value : [];
}

export function uniqueStrings(values: any = []) : any {
  return [...new Set<any>(values.map((value?: any) : any => asText(value)).filter(Boolean))];
}

export function lowerToken(value: any = "") : any {
  return asText(value).toLowerCase().replace(/[\s_]+/g, "-");
}

export function cloneJson(value?: any) : any {
  return JSON.parse(JSON.stringify(value));
}

export function hasOwnField(value: Record<string, any> = {}, field: any = "") : any {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, field));
}

function defaultLocalBinEntries({ cwd = process.cwd(), localBinDirs = [], includeDefaultLocalBin = true }: Record<string, any> = {}) : any {
  return uniqueStrings([
    ...asArray(localBinDirs),
    ...(includeDefaultLocalBin === false ? [] : [path.join(asText(cwd, process.cwd()), "node_modules", ".bin")])
  ]);
}

export function resolveCommandCandidate(commandNames: any = [], { env = process.env, platform = process.platform }: Record<string, any> = {}) : any {
  const options: any = arguments[1] || {};
  return resolveHostCommandCandidate(uniqueStrings(commandNames), {
    ...options,
    env,
    platform,
    localBinDirs: defaultLocalBinEntries(options),
    includeDefaultLocalBin: false,
    executableExistsFn: executableExists
  });
}

export function publicMetadata(metadata: Record<string, any> = {}) : any {
  const raw: any = asObject(metadata);
  return asObject(raw.public || raw.safe);
}
