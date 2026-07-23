import path from "node:path";
import {
  executableExists,
  resolveCommandCandidate as resolveHostCommandCandidate
} from "#lico/foundation/environment-compatibility/index";

export function asText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

export function asObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => asText(value)).filter(Boolean))];
}

export function lowerToken(value = "") {
  return asText(value).toLowerCase().replace(/[\s_]+/g, "-");
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function hasOwnField(value = {}, field = "") {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, field));
}

function defaultLocalBinEntries({ cwd = process.cwd(), localBinDirs = [], includeDefaultLocalBin = true } = {}) {
  return uniqueStrings([
    ...asArray(localBinDirs),
    ...(includeDefaultLocalBin === false ? [] : [path.join(asText(cwd, process.cwd()), "node_modules", ".bin")])
  ]);
}

export function resolveCommandCandidate(commandNames = [], { env = process.env, platform = process.platform } = {}) {
  const options = arguments[1] || {};
  return resolveHostCommandCandidate(uniqueStrings(commandNames), {
    ...options,
    env,
    platform,
    localBinDirs: defaultLocalBinEntries(options),
    includeDefaultLocalBin: false,
    executableExistsFn: executableExists
  });
}

export function publicMetadata(metadata = {}) {
  const raw = asObject(metadata);
  return asObject(raw.public || raw.safe);
}
