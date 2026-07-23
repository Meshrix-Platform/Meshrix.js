/**
 * Registry Loader — unified access to all machine-readable registries.
 *
 * Import this module to read any registry.  All verifiers, generators,
 * and profile runners MUST go through this loader rather than reading
 * registry files directly.
 *
 * Usage:
 *   import { loadRegistry, validateRegistry } from '#lico/tools/registry';
 *   const modules = await loadRegistry('modules');
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REGISTRY_FILES = Object.freeze({
  'repo-layout':           'repo-layout.registry.json',
  'modules':               'modules.registry.json',
  'public-api':            'public-api.registry.json',
  'dependency-rules':      'dependency-rules.registry.json',
  'scripts':               'scripts.registry.json',
  'tests':                 'tests.registry.json',
  'docs':                  'docs.registry.json',
  'runtime-payloads':      'runtime-payloads.registry.json',
  'operations':            'operations/operations.registry.json',
  'capabilities':          'capabilities/capabilities.registry.json',
  'open-platform-capability-matrix': 'open-platform-capability-matrix.json',
  'state-machine-integrity': 'state-machines/state-machine-integrity.registry.json',
});

const SCHEMA_FILES = Object.freeze({
  'repo-layout':           'schema/repo-layout.schema.json',
  'modules':               'schema/module.schema.json',
  'public-api':            'schema/public-api.schema.json',
  'dependency-rules':      'schema/dependency-rule.schema.json',
  'scripts':               'schema/script.schema.json',
  'tests':                 'schema/test-suite.schema.json',
  'docs':                  'schema/docs.schema.json',
  'runtime-payloads':      'schema/runtime-payload.schema.json',
  'operations':            'schema/operation.schema.json',
  'capabilities':          'schema/capability.schema.json',
  'open-platform-capability-matrix': 'schema/open-platform-capability-matrix.schema.json',
  'state-machine-integrity': 'schema/state-machine-integrity.schema.json',
});

/**
 * @param {keyof typeof REGISTRY_FILES} registryName
 * @returns {Promise<object>}
 */
export async function loadRegistry(registryName) {
  const filename = REGISTRY_FILES[registryName];
  if (!filename) {
    throw new Error(`Unknown registry: ${registryName}. Valid: ${Object.keys(REGISTRY_FILES).join(', ')}`);
  }
  const path = resolve(__dirname, filename);
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw);
}

/**
 * @param {keyof typeof REGISTRY_FILES} registryName
 * @returns {Promise<object>}
 */
export async function loadSchema(registryName) {
  const filename = SCHEMA_FILES[registryName];
  if (!filename) {
    throw new Error(`Unknown schema: ${registryName}. Valid: ${Object.keys(SCHEMA_FILES).join(', ')}`);
  }
  const path = resolve(__dirname, filename);
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Sync load for modules that need registry data at import time (limited support).
 * @param {keyof typeof REGISTRY_FILES} registryName
 * @returns {object}
 */
export function loadRegistrySync(registryName) {
  const filename = REGISTRY_FILES[registryName];
  if (!filename) {
    throw new Error(`Unknown registry: ${registryName}`);
  }
  // Only works for small registries loaded via createRequire or fs.readFileSync
  const { readFileSync } = require('node:fs');
  const path = resolve(__dirname, filename);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * List all available registry names.
 * @returns {string[]}
 */
export function listRegistries() {
  return Object.keys(REGISTRY_FILES);
}

export { REGISTRY_FILES, SCHEMA_FILES };
