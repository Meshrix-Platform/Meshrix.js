import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const KINDS = new Set(['standalone-packed-http', 'platform-default-http', 'legacy-packed-http', 'reference-fixture']);
const FIELDS = new Set(['endpoint', 'command', 'args', 'cwd', 'manifest', 'candidateKind', 'protocolVersion',
  'authorization', 'startupTimeoutMs', 'requestTimeoutMs', 'publicMapping']);

export async function resolveCandidateConfig({ argumentPath, environmentPath } = {}) {
  const path = argumentPath ?? environmentPath ?? process.env.MESHRIX_INTEROP_CONFIG;
  const source = argumentPath ? 'argument' : path ? 'environment' : 'missing';
  if (!path) return { ok: false, reason: 'explicit_candidate_required', source };
  const loaded = await readCandidateConfig(path);
  if (!loaded.ok) return { ...loaded, source };
  return { ok: true, source, config: {
    ...loaded.config,
    ...(loaded.config.cwd && !isAbsolute(loaded.config.cwd) ? { cwd: resolve(ROOT, loaded.config.cwd) } : {})
  } };
}

export async function readCandidateConfig(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    const checked = validateCandidateConfig(parsed);
    return checked.ok ? { ok: true, config: parsed } : checked;
  } catch (error) {
    return { ok: false, reason: error instanceof SyntaxError ? 'candidate_config_invalid_json' : 'candidate_config_unreadable' };
  }
}

export function validateCandidateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some(field => !FIELDS.has(field))) return { ok: false, reason: 'candidate_config_invalid' };
  const endpoint = typeof config.endpoint === 'string';
  const command = typeof config.command === 'string' && config.command.length > 0;
  if (endpoint === command) return { ok: false, reason: 'candidate_entry_missing_or_ambiguous' };
  if (endpoint && !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/mcp$/.test(config.endpoint)) {
    return { ok: false, reason: 'candidate_endpoint_not_loopback' };
  }
  if (!KINDS.has(config.candidateKind)) return { ok: false, reason: 'candidate_kind_missing' };
  if (config.candidateKind !== 'reference-fixture' && (typeof config.manifest !== 'string' || !config.manifest)) {
    return { ok: false, reason: 'candidate_manifest_missing' };
  }
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== 'string'))) {
    return { ok: false, reason: 'candidate_args_invalid' };
  }
  if (config.cwd !== undefined && (typeof config.cwd !== 'string' || !config.cwd)) return { ok: false, reason: 'candidate_cwd_invalid' };
  if (config.authorization !== undefined && typeof config.authorization !== 'string') return { ok: false, reason: 'candidate_auth_invalid' };
  if (config.publicMapping !== undefined && (!config.publicMapping || typeof config.publicMapping !== 'object' ||
      Array.isArray(config.publicMapping) || Object.keys(config.publicMapping).some(key => !['toolName', 'resourceUri', 'promptName'].includes(key)) ||
      Object.values(config.publicMapping).some(value => typeof value !== 'string' || !value))) {
    return { ok: false, reason: 'candidate_mapping_invalid' };
  }
  if (config.protocolVersion !== undefined && !['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'].includes(config.protocolVersion)) {
    return { ok: false, reason: 'candidate_version_invalid' };
  }
  for (const key of ['startupTimeoutMs', 'requestTimeoutMs']) {
    if (config[key] !== undefined && (!Number.isInteger(config[key]) || config[key] < 100 || config[key] > 120000)) {
      return { ok: false, reason: 'candidate_timeout_invalid' };
    }
  }
  return { ok: true };
}
