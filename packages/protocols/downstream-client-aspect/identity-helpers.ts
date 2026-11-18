import path from "node:path";
import {
  executableExists,
  resolveCommandCandidate as resolveHostCommandCandidate
} from "#meshrix/foundation/environment-compatibility/index";
import type { UnknownRecord } from "./types.ts";

export function asText(value?: unknown, fallback: unknown = ""): string {
  return String(value ?? fallback).trim();
}

export function asObject(value?: unknown, fallback: UnknownRecord | null = {}): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : fallback;
}

export function asArray(value?: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function uniqueStrings(values: readonly unknown[] = []): string[] {
  return [...new Set(values.map((value) => asText(value)).filter(Boolean))];
}

export function lowerToken(value: unknown = ""): string {
  return asText(value).toLowerCase().replace(/[\s_]+/g, "-");
}

export function cloneJson(value?: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

export function hasOwnField(value: UnknownRecord = {}, field = ""): boolean {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, field));
}

interface CommandResolutionOptions {
  cwd?: string;
  localBinDirs?: readonly string[];
  includeDefaultLocalBin?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

function defaultLocalBinEntries({ cwd = process.cwd(), localBinDirs = [], includeDefaultLocalBin = true }: CommandResolutionOptions = {}): string[] {
  return uniqueStrings([
    ...asArray(localBinDirs),
    ...(includeDefaultLocalBin === false ? [] : [path.join(asText(cwd, process.cwd()), "node_modules", ".bin")])
  ]);
}

export function resolveCommandCandidate(commandNames: readonly unknown[] = [], options: CommandResolutionOptions = {}) {
  const { env = process.env, platform = process.platform } = options;
  return resolveHostCommandCandidate(uniqueStrings(commandNames), {
    ...options,
    env,
    platform,
    localBinDirs: defaultLocalBinEntries(options),
    includeDefaultLocalBin: false,
    executableExistsFn: executableExists
  });
}

export function publicMetadata(metadata: UnknownRecord = {}): UnknownRecord {
  const raw = asObject(metadata) ?? {};
  return asObject(raw.public || raw.safe) ?? {};
}
