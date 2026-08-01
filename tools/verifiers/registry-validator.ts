#!/usr/bin/env node
/**
 * registry-validator.ts — Validates all registry JSON files against their schemas
 * and checks cross-registry consistency.
 *
 * Usage:
 *   node tools/verifiers/registry-validator.ts
 *   node tools/verifiers/registry-validator.ts --verbose
 */

import { access, readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFactSourceAuthorityRegistry } from './registry-fact-source-authority.ts';
import { validateReleaseAuthorityBaselineRegistry } from './registry-release-authority-baseline.ts';
import { validateLocalJsonSchemaReference } from './registry-json-schema.ts';
import { validateOpenPlatformCapabilityMatrix } from './registry-open-platform-capability-matrix.ts';
import { validateOperationRegistryProjectionParity } from './registry-operation-parity.ts';
import { validateRepoLayout } from './registry-repo-layout.ts';
import { testSuiteReachabilityIssues } from '../registry/test-suite-reachability.ts';

const __dirname: any = dirname(fileURLToPath(import.meta.url));
const ROOT: any = resolve(__dirname, '..', '..');
const REGISTRY_DIR: any = resolve(ROOT, 'tools/registry');

const REQUIRED_REGISTRIES: any[] = [
  'repo-layout.registry.json',
  'modules.registry.json',
  'public-api.registry.json',
  'dependency-rules.registry.json',
];

const ADDITIONAL_REGISTRY_FILES: any[] = [
  'operations/operations.registry.json',
  'capabilities/capabilities.registry.json',
  'state-machines/state-machine-integrity.registry.json',
];

const STRUCTURED_REGISTRY_FILES: any[] = [
  'open-platform-capability-matrix.json',
];

function validateBasicStructure(data?: any, name?: any, { requireVersion = true }: Record<string, any> = {}) : any {
  const issues: any[] = [];
  if (!data || typeof data !== 'object') {
    issues.push(`${name}: not a valid JSON object`);
    return issues;
  }
  if (requireVersion && !data.version) {
    issues.push(`${name}: missing version field`);
  }
  if (!data.$schema) {
    issues.push(`${name}: missing $schema field`);
  }
  return issues;
}

function validateModules(data?: any) : any {
  const issues: any[] = [];
  if (!Array.isArray(data.modules)) {
    issues.push('modules: modules must be an array');
    return issues;
  }
  const ids: any = new Set<any>();
  const validKinds: any = new Set<any>(['foundation', 'domain', 'protocol', 'runtime', 'app', 'ui']);
  for (const mod of data.modules) {
    if (!mod.id) issues.push('modules: module missing id');
    else if (ids.has(mod.id)) issues.push(`modules: duplicate module "${mod.id}"`);
    else ids.add(mod.id);

    if (mod.kind && !validKinds.has(mod.kind)) {
      issues.push(`modules: module "${mod.id}" has invalid kind "${mod.kind}"`);
    }
    if (!mod.owner) issues.push(`modules: module "${mod.id}" missing owner`);
    if (!mod.directory) issues.push(`modules: module "${mod.id}" missing directory`);
  }

  // Cross-validation: all foundation modules should have a chineseName
  const foundationModules: any = data.modules.filter((m?: any) : any => m.kind === 'foundation');
  const missingChinese: any = foundationModules.filter((m?: any) : any => !m.chineseName);
  for (const mod of missingChinese) {
    issues.push(`modules: foundation module "${mod.id}" missing chineseName`);
  }

  return issues;
}

function validatePublicApi(data?: any) : any {
  const issues: any[] = [];
  if (!Array.isArray(data.aliases)) {
    issues.push('public-api: aliases must be an array');
    return issues;
  }
  const validStatuses: any = new Set<any>(['active']);
  for (const alias of data.aliases) {
    if (!alias.alias) issues.push('public-api: alias missing alias field');
    else if (!alias.alias.startsWith('#meshrix/')) issues.push(`public-api: alias "${alias.alias}" does not start with #meshrix/`);

    if (!alias.targetPath) issues.push(`public-api: alias "${alias.alias}" missing targetPath`);
    if (!alias.status || !validStatuses.has(alias.status)) {
      issues.push(`public-api: alias "${alias.alias}" has invalid status "${alias.status}"`);
    }
    // Cross-validate: private path rules must name their allowed consumers.
    if (alias.privatePathPatterns && alias.privatePathPatterns.length > 0) {
      if (!alias.privatePathAllowedConsumers || alias.privatePathAllowedConsumers.length === 0) {
        issues.push(`public-api: alias "${alias.alias}" has privatePathPatterns but no privatePathAllowedConsumers`);
      }
    }

    // Cross-validate: aliases with layer should have owner.
    if (alias.layer && !alias.owner) {
      issues.push(`public-api: alias "${alias.alias}" has layer but missing owner`);
    }
  }

  // Cross-validate: publicResources entries must have resourceId and path
  if (data.publicResources) {
    if (!Array.isArray(data.publicResources)) {
      issues.push('public-api: publicResources must be an array');
    } else {
      for (const res of data.publicResources) {
        if (!res.resourceId) issues.push(`public-api: publicResources entry missing resourceId`);
        if (!res.path) issues.push(`public-api: publicResources entry "${res.resourceId || '(unnamed)'}" missing path`);
      }
    }
  }

  return issues;
}

export function validateDependencyRules(data?: any) : any {
  const issues: any[] = [];
  if (!Array.isArray(data?.layers) || data.layers.length === 0) {
    return ['dependency-rules: layers must be a non-empty array'];
  }

  const ids: any = new Set<any>();
  const directories: any = new Set<any>();
  for (const layer of data.layers) {
    const id: any = String(layer?.id || '').trim();
    const directory: any = String(layer?.directory || '').replace(/\/+$/u, '');
    if (!id) {
      issues.push('dependency-rules: layer missing id');
    } else if (ids.has(id)) {
      issues.push(`dependency-rules: duplicate layer id "${id}"`);
    } else {
      ids.add(id);
    }
    if (!directory) {
      issues.push(`dependency-rules: layer "${id || '(unnamed)'}" missing directory`);
    } else if (directories.has(directory)) {
      issues.push(`dependency-rules: duplicate layer directory "${directory}"`);
    } else {
      directories.add(directory);
    }
    for (const field of ['allowedDependsOn', 'forbiddenDependsOn']) {
      if (!Array.isArray(layer?.[field])) {
        issues.push(`dependency-rules: layer "${id || '(unnamed)'}" ${field} must be an array`);
      }
    }
    if ((layer?.allowedDependsOn?.length || 0) + (layer?.forbiddenDependsOn?.length || 0) === 0) {
      issues.push(`dependency-rules: layer "${id || '(unnamed)'}" must declare at least one effective dependency rule`);
    }
  }

  let effectiveRuleCount: any = 0;
  for (const layer of data.layers) {
    const id: any = String(layer?.id || '').trim();
    const allowed: any = Array.isArray(layer?.allowedDependsOn) ? layer.allowedDependsOn : [];
    const forbidden: any = Array.isArray(layer?.forbiddenDependsOn) ? layer.forbiddenDependsOn : [];
    effectiveRuleCount += allowed.length + forbidden.length;
    for (const referencedId of [...allowed, ...forbidden]) {
      if (!ids.has(referencedId)) {
        issues.push(`dependency-rules: layer "${id}" references unknown layer "${referencedId}"`);
      }
      if (referencedId === id) {
        issues.push(`dependency-rules: layer "${id}" cannot depend on itself`);
      }
    }
    for (const referencedId of allowed) {
      if (forbidden.includes(referencedId)) {
        issues.push(`dependency-rules: layer "${id}" both allows and forbids "${referencedId}"`);
      }
    }
  }
  if (effectiveRuleCount === 0) {
    issues.push('dependency-rules: registry must contain at least one effective dependency rule');
  }
  return issues;
}

function validateServerLayers(data?: any) : any {
  const issues: any[] = [];
  if (!Array.isArray(data.layers)) {
    issues.push('server-layers: layers must be an array');
    return issues;
  }
  const directories: any = new Set<any>();
  for (const layer of data.layers) {
    if (!layer.directory) issues.push('server-layers: layer missing directory');
    else if (directories.has(layer.directory)) issues.push(`server-layers: duplicate directory "${layer.directory}"`);
    else directories.add(layer.directory);

    if (!layer.layer) issues.push(`server-layers: layer "${layer.directory}" missing layer name`);
    if (!layer.role) issues.push(`server-layers: layer "${layer.directory}" missing role`);
    if (!Array.isArray(layer.allowedDependsOn)) issues.push(`server-layers: layer "${layer.directory}" missing allowedDependsOn (array)`);
    if (!Array.isArray(layer.forbiddenDependsOn)) issues.push(`server-layers: layer "${layer.directory}" missing forbiddenDependsOn (array)`);
  }
  return issues;
}

function validateMcpConnector(data?: any) : any {
  const issues: any[] = [];
  if (!data.directory) issues.push('mcp-connector: missing directory');
  if (data.names !== undefined && !Array.isArray(data.names)) issues.push('mcp-connector: names must be an array when present');
  if (!Array.isArray(data.packageScripts)) issues.push('mcp-connector: packageScripts must be an array');
  return issues;
}

function validateRuntimePayloads(data?: any) : any {
  const issues: any[] = [];
  if (!Array.isArray(data.payloads)) {
    issues.push('runtime-payloads: payloads must be an array');
    return issues;
  }
  for (const p of data.payloads) {
    if (!p.id) issues.push('runtime-payloads: payload missing id');
    if (!p.description) issues.push(`runtime-payloads: payload "${p.id || '(unnamed)'}" missing description`);

    // Pattern-based payloads must have pattern field
    if (p.pattern && !p.severityIfMissing) {
      issues.push(`runtime-payloads: pattern-based payload "${p.id}" missing severityIfMissing`);
    }
    // Provider-based payloads must have requiredFor
    if (!p.pattern && !p.requiredFor) {
      issues.push(`runtime-payloads: provider-based payload "${p.id}" missing requiredFor`);
    }
  }

  return issues;
}

function validateScriptRegistry(data?: any) : any {
  const issues: any[] = [];
  if (data.categories && typeof data.categories !== 'object') {
    issues.push('scripts: categories must be an object');
  } else if (data.categories) {
    for (const [key, cat] of (Object.entries(data.categories) as [string, any][])) {
      if (!cat.description) {
        issues.push(`scripts: category "${key}" missing description`);
      }
    }
  }
  return issues;
}

function validateTestSuiteRegistry(data?: any) : any {
  const issues: any[] = [];
  const suites: any = Array.isArray(data.suites) ? data.suites : [];
  const suiteIds: any = new Set<any>();
  const artifactOwners: any = new Map<any, any>();
  for (const suite of suites) {
    const suiteId: any = String(suite?.id || '').trim();
    if (!suiteId) {
      issues.push('tests: suite missing id');
      continue;
    }
    if (suiteIds.has(suiteId)) {
      issues.push(`tests: duplicate suite "${suiteId}"`);
    }
    suiteIds.add(suiteId);

    const sideEffects: any = String(suite.sideEffects || 'none');
    const artifacts: any = Array.isArray(suite.artifacts) ? suite.artifacts.map(String) : [];
    if (sideEffects === 'reports') {
      issues.push(`tests: suite "${suiteId}" uses sideEffects=reports; use artifacts for exact report paths and sideEffects=build-output for persistent outputs`);
    }
    if (sideEffects === 'none' && artifacts.length > 0) {
      issues.push(`tests: suite "${suiteId}" declares artifacts but sideEffects=none`);
    }
    if (sideEffects === 'build-output' && artifacts.length === 0) {
      issues.push(`tests: suite "${suiteId}" uses sideEffects=build-output without declaring artifacts`);
    }

    for (const artifact of artifacts) {
      if (!artifact.startsWith('build/')) {
        issues.push(`tests: suite "${suiteId}" artifact "${artifact}" must be under build/`);
      }
      const owner: any = artifactOwners.get(artifact);
      if (owner) {
        issues.push(`tests: artifact "${artifact}" is declared by both "${owner}" and "${suiteId}"`);
      } else {
        artifactOwners.set(artifact, suiteId);
      }
    }

    const artifactSemantics: any = suite.artifactSemantics && typeof suite.artifactSemantics === 'object'
      ? suite.artifactSemantics
      : {};
    for (const semanticArtifact of Object.keys(artifactSemantics)) {
      if (!artifacts.includes(semanticArtifact)) {
        issues.push(`tests: suite "${suiteId}" artifactSemantics key "${semanticArtifact}" is not declared in artifacts`);
      }
    }
  }

  const profiles: any = data.profiles && typeof data.profiles === 'object' ? data.profiles : {};
  for (const [profileName, profile] of (Object.entries(profiles) as [string, any][])) {
    for (const suiteId of Array.isArray(profile.suites) ? profile.suites : []) {
      if (!suiteIds.has(suiteId)) {
        issues.push(`tests: profile "${profileName}" references missing suite "${suiteId}"`);
      }
    }
  }
  issues.push(...testSuiteReachabilityIssues(data));
  return issues;
}

function validateDocsRegistry(data?: any) : any {
  const issues: any[] = [];
  if (!Array.isArray(data.entries)) {
    issues.push('docs: entries must be an array');
    return issues;
  }
  const ids: any = new Set<any>();
  const paths: any = new Set<any>();
  for (const entry of data.entries) {
    if (!entry.id) {
      issues.push('docs: entry missing id');
    } else if (ids.has(entry.id)) {
      issues.push(`docs: duplicate entry id "${entry.id}"`);
    } else {
      ids.add(entry.id);
    }
    if (!entry.path) {
      issues.push(`docs: entry "${entry.id || '(unnamed)'}" missing path`);
    } else if (paths.has(entry.path)) {
      issues.push(`docs: duplicate entry path "${entry.path}"`);
    } else {
      paths.add(entry.path);
    }
    if (!entry.source) {
      issues.push(`docs: entry "${entry.id || '(unnamed)'}" missing source`);
    }
    if (!entry.description) {
      issues.push(`docs: entry "${entry.id || '(unnamed)'}" missing description`);
    }
  }
  if (data.directoryRoles && typeof data.directoryRoles !== 'object') {
    issues.push('docs: directoryRoles must be an object');
  } else if (data.directoryRoles) {
    for (const [key, entry] of (Object.entries(data.directoryRoles) as [string, any][])) {
      if (!entry.role) {
        issues.push(`docs: directoryRoles entry "${key}" missing role`);
      }
    }
  }
  return issues;
}

function docsRegistryTokens(value: any = '') : any {
  const stopWords: any = new Set<any>([
    'and',
    'the',
    'for',
    'with',
    'from',
    'into',
    'docs',
    'functionality',
    'verification',
    'boundary'
  ]);
  return [...new Set<any>(String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/u)
    .filter((token?: any) : any => token.length >= 4 && !stopWords.has(token)))]
    .slice(0, 8);
}

async function pathExists(relativePath?: any) : Promise<any> {
  try {
    await access(resolve(ROOT, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function validateDocsRegistryAgainstSources(dataCache?: any) : Promise<any> {
  const issues: any[] = [];
  const docsData: any = dataCache.get('docs.registry.json');
  if (!docsData?.entries) {
    return issues;
  }

  const matrix: any = dataCache.get('open-platform-capability-matrix.json');
  const matrixDocPaths: any = new Set<any>((matrix?.capabilities || []).flatMap((capability?: any) : any => capability.docs || []));
  const registeredPaths: any = new Set<any>(docsData.entries.map((entry?: any) : any => entry.path));

  for (const entry of docsData.entries) {
    if (!await pathExists(entry.path)) {
      issues.push(`docs-registry: entry "${entry.id}" path is missing: ${entry.path}`);
      continue;
    }
    if (entry.source && !/^[a-z]+:\/\//i.test(entry.source) && !await pathExists(entry.source)) {
      issues.push(`docs-registry: entry "${entry.id}" source is missing: ${entry.source}`);
    }

    const content: any = await readFile(resolve(ROOT, entry.path), 'utf-8');
    if (entry.path.startsWith('docs/functionality/')) {
      if (!/^## Verification\b/mu.test(content)) {
        issues.push(`docs-registry: functionality doc "${entry.path}" is missing a Verification section`);
      }
      if (!/```bash[\s\S]*?\b(?:npm|node)\s+/u.test(content)) {
        issues.push(`docs-registry: functionality doc "${entry.path}" is missing executable verification commands`);
      }
    }

    const terms: any = docsRegistryTokens(`${entry.id} ${entry.description}`);
    const missingTerms: any = terms.filter((token?: any) : any => !content.toLowerCase().includes(token));
    if (missingTerms.length > 0) {
      issues.push(`docs-registry: entry "${entry.id}" terms not found in ${entry.path}: ${missingTerms.join(', ')}`);
    }

    if (entry.source === 'tools/registry/open-platform-capability-matrix.json' && !matrixDocPaths.has(entry.path)) {
      issues.push(`docs-registry: matrix-sourced entry "${entry.id}" is not referenced by any capability docs list`);
    }
  }

  for (const matrixPath of [...matrixDocPaths].filter((item?: any) : any => item.startsWith('docs/functionality/'))) {
    if (!registeredPaths.has(matrixPath)) {
      issues.push(`docs-registry: capability matrix functionality doc is not registered: ${matrixPath}`);
    }
  }

  return issues;
}

function validateOperationRegistry(data?: any) : any {
  const issues: any[] = [];
  if (!Array.isArray(data.operations)) {
    issues.push('operations: operations must be an array');
    return issues;
  }
  const ids: any = new Set<any>();
  for (const operation of data.operations) {
    if (!operation.id) {
      issues.push('operations: operation missing id');
      continue;
    }
    if (ids.has(operation.id)) {
      issues.push(`operations: duplicate operation "${operation.id}"`);
    }
    ids.add(operation.id);
    if (!operation.feature) issues.push(`operations: operation "${operation.id}" missing feature`);
    if (!Array.isArray(operation.requiredScopes)) issues.push(`operations: operation "${operation.id}" missing requiredScopes array`);
    if (!operation.http?.method || !operation.http?.path) issues.push(`operations: operation "${operation.id}" missing http method/path`);
    if (!operation.rpc?.method) issues.push(`operations: operation "${operation.id}" missing rpc method`);
  }
  return issues;
}

function validateCapabilityRegistry(data?: any) : any {
  const issues: any[] = [];
  if (!Array.isArray(data.capabilities)) {
    issues.push('capabilities: capabilities must be an array');
    return issues;
  }
  const ids: any = new Set<any>();
  const operationIds: any = new Set<any>();
  const validRisks: any = new Set<any>(['read_only', 'safe_write', 'repair_write', 'destructive']);
  for (const capability of data.capabilities) {
    if (!capability.id) issues.push('capabilities: capability missing id');
    else if (ids.has(capability.id)) issues.push(`capabilities: duplicate capability "${capability.id}"`);
    else ids.add(capability.id);
    if (!capability.operationId) issues.push(`capabilities: capability "${capability.id || '(unnamed)'}" missing operationId`);
    else if (operationIds.has(capability.operationId)) issues.push(`capabilities: duplicate operationId "${capability.operationId}"`);
    else operationIds.add(capability.operationId);
    if (capability.kind !== 'api') issues.push(`capabilities: capability "${capability.id || '(unnamed)'}" has invalid kind "${capability.kind}"`);
    if (!validRisks.has(capability.risk)) issues.push(`capabilities: capability "${capability.id || '(unnamed)'}" has invalid risk "${capability.risk}"`);
  }
  if (data.toolCapabilities !== undefined) {
    if (!Array.isArray(data.toolCapabilities)) {
      issues.push('capabilities: toolCapabilities must be an array when present');
    } else {
      const toolIds: any = new Set<any>();
      const capabilityIds: any = new Set<any>(ids);
      for (const capability of data.toolCapabilities) {
        if (!capability.id) issues.push('capabilities: tool capability missing id');
        else if (capabilityIds.has(capability.id)) issues.push(`capabilities: duplicate capability "${capability.id}"`);
        else capabilityIds.add(capability.id);
        if (!capability.toolId) issues.push(`capabilities: tool capability "${capability.id || '(unnamed)'}" missing toolId`);
        else if (toolIds.has(capability.toolId)) issues.push(`capabilities: duplicate toolId "${capability.toolId}"`);
        else toolIds.add(capability.toolId);
        if (capability.kind !== 'tool') issues.push(`capabilities: tool capability "${capability.id || '(unnamed)'}" has invalid kind "${capability.kind}"`);
        if (!validRisks.has(capability.risk)) issues.push(`capabilities: tool capability "${capability.id || '(unnamed)'}" has invalid risk "${capability.risk}"`);
      }
    }
  }
  return issues;
}

/**
 * Cross-validate facade vs registry: ensure no hardcoded facts remain.
 * Checks that the facade derives from JSON and doesn't contain hardcoded
 * literal data arrays that should be in registries.
 */
async function validateFacadeAgainstRegistries() : Promise<any> {
  const issues: any[] = [];
  const facadePath: any = resolve(REGISTRY_DIR, 'architecture-layout-facade.ts');
  const source: any = await readFile(facadePath, 'utf-8');
  for (const registryFile of [
    'repo-layout.registry.json',
    'modules.registry.json',
    'public-api.registry.json',
    'dependency-rules.registry.json',
    'server-layers.registry.json',
    'mcp-connector.registry.json',
    'runtime-payloads.registry.json',
    'scripts.registry.json',
    'docs.registry.json',
  ]) {
    if (!source.includes(`./${registryFile}`)) {
      issues.push(`architecture-layout-facade: missing registry source ${registryFile}`);
    }
  }
  if (source.includes('tools/registry/compat') || source.includes("require('../")) {
    issues.push('architecture-layout-facade: references non-current registry layout');
  }
  return issues;
}

async function validateCrossRegistry(dataCache?: any) : Promise<any> {
  const issues: any[] = [];

  // 1. public-api aliases match modules.registry.json publicApi arrays
  const modulesData: any = dataCache.get('modules.registry.json');
  const publicApiData: any = dataCache.get('public-api.registry.json');
  if (modulesData && publicApiData) {
    const moduleAliases: any = new Set<any>(
      modulesData.modules.flatMap((m?: any) : any => m.publicApi || [])
    );
    for (const alias of publicApiData.aliases) {
      // Non-wildcard aliases should be referenced by at least one module.
      if (!alias.alias.includes('*')) {
        if (!moduleAliases.has(alias.alias)) {
          issues.push(`cross-registry: public-api alias "${alias.alias}" is not referenced by any module's publicApi array`);
        }
      }
    }

    // 2. Module chineseNames match expected patterns for foundation modules
    for (const mod of modulesData.modules) {
      if (mod.kind === 'foundation' && mod.chineseName) {
        if (typeof mod.chineseName !== 'string' || mod.chineseName.length < 2) {
          issues.push(`cross-registry: module "${mod.id}" has suspiciously short chineseName "${mod.chineseName}"`);
        }
      }
    }
  }

  // 5. mcp-connector directory should be referenced by a module directory
  const mcpConnectorData: any = dataCache.get('mcp-connector.registry.json');
  if (mcpConnectorData && modulesData) {
    const protocolModule: any = modulesData.modules.find((m?: any) : any => m.id === 'protocols-mcp');
    if (protocolModule && mcpConnectorData.directory) {
      if (!mcpConnectorData.directory.startsWith(protocolModule.directory)) {
        issues.push(`cross-registry: mcp-connector directory "${mcpConnectorData.directory}" does not start with protocols-mcp module directory "${protocolModule.directory}"`);
      }
    }
  }

  // 6. scripts categories are non-empty
  const scriptsData: any = dataCache.get('scripts.registry.json');
  if (scriptsData && scriptsData.categories) {
    const categoryCount: any = Object.keys(scriptsData.categories).length;
    if (categoryCount === 0) {
      issues.push('cross-registry: scripts.registry.json has empty categories');
    }
  }

  // 7. docs registry directoryRoles is non-empty
  const docsData: any = dataCache.get('docs.registry.json');
  if (docsData && docsData.directoryRoles) {
    const roleCount: any = Object.keys(docsData.directoryRoles).length;
    if (roleCount === 0) {
      issues.push('cross-registry: docs.registry.json has empty directoryRoles');
    }
  }

  issues.push(...await validateDocsRegistryAgainstSources(dataCache));
  issues.push(...validateOperationRegistryProjectionParity(dataCache));

  return issues;
}

async function main() : Promise<any> {
  const verbose: any = process.argv.includes('--verbose');
  let totalIssues: any = 0;
  const results: any[] = [];
  const dataCache: any = new Map<any, any>();
  const allFiles: any = await readdir(REGISTRY_DIR);

  for (const filename of REQUIRED_REGISTRIES) {
    if (!allFiles.includes(filename)) {
      totalIssues++;
      results.push({ file: filename, status: 'MISSING', issues: ['required registry file is missing'] });
    }
  }

  // Read and validate all registry files
  const registryFiles: any[] = [
    ...allFiles
    .filter((f?: any) : any => f.endsWith('.registry.json'))
    .sort(),
    ...ADDITIONAL_REGISTRY_FILES,
  ];

  for (const filename of registryFiles) {
    const path: any = resolve(REGISTRY_DIR, filename);
    try {
      const raw: any = await readFile(path, 'utf-8');
      const data: any = JSON.parse(raw);
      dataCache.set(filename, data);

      let issues: any = validateBasicStructure(data, filename);
      issues = issues.concat(await validateLocalJsonSchemaReference(data, filename, { registryDir: REGISTRY_DIR }));

      // Type-specific validation
      if (filename === 'repo-layout.registry.json') {
        issues = issues.concat(validateRepoLayout(data));
      } else if (filename === 'modules.registry.json') {
        issues = issues.concat(validateModules(data));
      } else if (filename === 'public-api.registry.json') {
        issues = issues.concat(validatePublicApi(data));
      } else if (filename === 'dependency-rules.registry.json') {
        issues = issues.concat(validateDependencyRules(data));
      } else if (filename === 'server-layers.registry.json') {
        issues = issues.concat(validateServerLayers(data));
      } else if (filename === 'mcp-connector.registry.json') {
        issues = issues.concat(validateMcpConnector(data));
      } else if (filename === 'runtime-payloads.registry.json') {
        issues = issues.concat(validateRuntimePayloads(data));
      } else if (filename === 'scripts.registry.json') {
        issues = issues.concat(validateScriptRegistry(data));
      } else if (filename === 'tests.registry.json') {
        issues = issues.concat(validateTestSuiteRegistry(data));
      } else if (filename === 'docs.registry.json') {
        issues = issues.concat(validateDocsRegistry(data));
      } else if (filename === 'fact-source-authority.registry.json') {
        issues = issues.concat(await validateFactSourceAuthorityRegistry(data));
      } else if (filename === 'release-authority-baseline.registry.json') {
        issues = issues.concat(await validateReleaseAuthorityBaselineRegistry(data));
      } else if (filename === 'operations/operations.registry.json') {
        issues = issues.concat(validateOperationRegistry(data));
      } else if (filename === 'capabilities/capabilities.registry.json') {
        issues = issues.concat(validateCapabilityRegistry(data));
      }

      if (issues.length > 0) {
        totalIssues += issues.length;
        results.push({ file: filename, status: 'ISSUES', issues });
      } else {
        results.push({ file: filename, status: 'OK', issues: [] });
      }

      if (verbose) {
        console.log(`${filename}: ${issues.length > 0 ? issues.length + ' issues' : '✓'}`);
      }
    } catch (err: any) {
      results.push({ file: filename, status: 'MISSING', issues: [err.message] });
      totalIssues++;
      console.error(`${filename}: MISSING — ${err.message}`);
    }
  }

  for (const filename of STRUCTURED_REGISTRY_FILES) {
    const path: any = resolve(REGISTRY_DIR, filename);
    try {
      const raw: any = await readFile(path, 'utf-8');
      const data: any = JSON.parse(raw);
      dataCache.set(filename, data);
      let issues: any = validateBasicStructure(data, filename, { requireVersion: false });
      issues = issues.concat(await validateLocalJsonSchemaReference(data, filename, { registryDir: REGISTRY_DIR }));
      if (filename === 'open-platform-capability-matrix.json') {
        issues = issues.concat(validateOpenPlatformCapabilityMatrix(data));
      }
      if (issues.length > 0) {
        totalIssues += issues.length;
        results.push({ file: filename, status: 'ISSUES', issues });
      } else {
        results.push({ file: filename, status: 'OK', issues: [] });
      }
      if (verbose) {
        console.log(`${filename}: ${issues.length > 0 ? issues.length + ' issues' : '✓'}`);
      }
    } catch (err: any) {
      results.push({ file: filename, status: 'MISSING', issues: [err.message] });
      totalIssues++;
      console.error(`${filename}: MISSING — ${err.message}`);
    }
  }

  // Cross-registry validation
  const crossIssues: any = await validateCrossRegistry(dataCache);
  for (const issue of crossIssues) {
    totalIssues++;
    results.push({ file: '(cross-registry)', status: 'ISSUES', issues: [issue] });
    if (verbose) {
      console.log(`(cross-registry): ${issue}`);
    }
  }

  // Facade integrity check
  const facadeIssues: any = await validateFacadeAgainstRegistries();
  if (facadeIssues.length > 0) {
    totalIssues += facadeIssues.length;
    results.push({ file: 'architecture-layout-facade.ts', status: 'ISSUES', issues: facadeIssues });
  }

  // Summary
  const ok: any = results.filter((r?: any) : any => r.status === 'OK').length;
  const withIssues: any = results.filter((r?: any) : any => r.status === 'ISSUES').length;
  const missing: any = results.filter((r?: any) : any => r.status === 'MISSING').length;

  console.log(`\nRegistry validation: ${ok} OK, ${withIssues} with issues, ${missing} missing, ${crossIssues.length} cross-registry checks`);

  if (totalIssues > 0) {
    console.error(`\n${totalIssues} issues found:`);
    for (const r of results) {
      if (r.issues.length > 0) {
        for (const issue of r.issues) {
          console.error(`  [${r.file}] ${issue}`);
        }
      }
    }
    process.exit(1);
  }

  console.log('All registries valid. Registry projections are aligned with their registered fact authorities.');
}

main().catch((err?: any) : any => {
  console.error('Registry validator error:', err.message);
  process.exit(1);
});
