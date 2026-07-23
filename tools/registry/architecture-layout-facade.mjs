/**
 * Architecture Layout Registry Facade.
 *
 * All public layout facts are sourced from JSON registry files in this
 * directory. Keep this file free of product-specific capability facts; edit
 * the registries instead.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const _repoLayoutData = require("./repo-layout.registry.json");
const _modulesData = require("./modules.registry.json");
const _publicApiData = require("./public-api.registry.json");
const _depRulesData = require("./dependency-rules.registry.json");
const _serverLayersData = require("./server-layers.registry.json");
const _mcpConnectorData = require("./mcp-connector.registry.json");
const _runtimePayloadsData = require("./runtime-payloads.registry.json");
const _scriptsData = require("./scripts.registry.json");
const _docsData = require("./docs.registry.json");

export const ARCHITECTURE_LAYOUT_MANIFEST_VERSION = "architecture-layout-registry-facade";

export const ROOT_ENTRIES = Object.freeze(
  (_repoLayoutData.entries || []).map((entry) => Object.freeze({
    name: entry.name,
    kind: entry.kind,
    required: entry.required === true,
    generated: entry.generated === true,
    packageIncluded: entry.packageIncluded === true
  }))
);

export const ROOT_ALLOWED_ENTRIES = Object.freeze(ROOT_ENTRIES.map((entry) => entry.name));
export const ROOT_REQUIRED_ENTRIES = Object.freeze(ROOT_ENTRIES
  .filter((entry) => entry.required === true)
  .map((entry) => entry.name));
export const ROOT_HYGIENE_REQUIRED_ENTRIES = Object.freeze(
  _repoLayoutData.rootHygiene?.requiredEntries || ROOT_REQUIRED_ENTRIES
);
export const REPO_ORGANIZATION_AUDIT_POLICY = Object.freeze({
  ignoredPathParts: Object.freeze(_repoLayoutData.repoOrganizationAudit?.ignoredPathParts || []),
  requiredFiles: Object.freeze(_repoLayoutData.repoOrganizationAudit?.requiredFiles || []),
  sourceFileOrganization: Object.freeze({
    canonicalDocument: _repoLayoutData.repoOrganizationAudit?.sourceFileOrganization?.canonicalDocument || "",
    lineCountGate: Object.freeze({
      status: _repoLayoutData.repoOrganizationAudit?.sourceFileOrganization?.lineCountGate?.status || "",
      threshold: _repoLayoutData.repoOrganizationAudit?.sourceFileOrganization?.lineCountGate?.threshold ?? null,
      releaseBlocking: _repoLayoutData.repoOrganizationAudit?.sourceFileOrganization?.lineCountGate?.releaseBlocking === true
    }),
    decisionBasis: Object.freeze(_repoLayoutData.repoOrganizationAudit?.sourceFileOrganization?.decisionBasis || []),
    machineEnforcedRuleIds: Object.freeze(_repoLayoutData.repoOrganizationAudit?.sourceFileOrganization?.machineEnforcedRuleIds || []),
    delegatedGateIds: Object.freeze(_repoLayoutData.repoOrganizationAudit?.sourceFileOrganization?.delegatedGateIds || []),
    reviewOnlySignalIds: Object.freeze(_repoLayoutData.repoOrganizationAudit?.sourceFileOrganization?.reviewOnlySignalIds || []),
    astAdvisory: Object.freeze({
      releaseBlocking: _repoLayoutData.repoOrganizationAudit?.sourceFileOrganization?.astAdvisory?.releaseBlocking === true,
      analysisRoots: Object.freeze(_repoLayoutData.repoOrganizationAudit?.sourceFileOrganization?.astAdvisory?.analysisRoots || []),
      extensions: Object.freeze(_repoLayoutData.repoOrganizationAudit?.sourceFileOrganization?.astAdvisory?.extensions || []),
      factSourceAuthorityPath: _repoLayoutData.repoOrganizationAudit?.sourceFileOrganization?.astAdvisory?.factSourceAuthorityPath || ""
    })
  }),
  runnableEntrypointOwnership: Object.freeze({
    roots: Object.freeze((_repoLayoutData.repoOrganizationAudit?.runnableEntrypointOwnership?.roots || [])
      .map((entry) => Object.freeze({ path: entry.path, owner: entry.owner }))),
    extensions: Object.freeze(_repoLayoutData.repoOrganizationAudit?.runnableEntrypointOwnership?.extensions || []),
    sourceReferenceRoots: Object.freeze(_repoLayoutData.repoOrganizationAudit?.runnableEntrypointOwnership?.sourceReferenceRoots || []),
    workflowRoot: _repoLayoutData.repoOrganizationAudit?.runnableEntrypointOwnership?.workflowRoot || "",
    testRegistryPath: _repoLayoutData.repoOrganizationAudit?.runnableEntrypointOwnership?.testRegistryPath || "",
    packageManifestPath: _repoLayoutData.repoOrganizationAudit?.runnableEntrypointOwnership?.packageManifestPath || ""
  }),
  currentResidue: Object.freeze({
    testRoots: Object.freeze(_repoLayoutData.repoOrganizationAudit?.currentResidue?.testRoots || []),
    testStageMarkers: Object.freeze(_repoLayoutData.repoOrganizationAudit?.currentResidue?.testStageMarkers || []),
    operationDefinitionRoots: Object.freeze(_repoLayoutData.repoOrganizationAudit?.currentResidue?.operationDefinitionRoots || [])
  })
});

export const SERVER_LAYERS = Object.freeze(
  (_serverLayersData.layers || []).map((layer) => Object.freeze({
    directory: layer.directory,
    layer: layer.layer,
    role: layer.role,
    allowedDependsOn: Object.freeze([...(layer.allowedDependsOn || [])]),
    forbiddenDependsOn: Object.freeze([...(layer.forbiddenDependsOn || [])])
  }))
);
export const SERVER_TOP_LEVEL_DIRECTORIES = Object.freeze(SERVER_LAYERS.map((layer) => layer.directory));
export const SERVER_TOP_LEVEL_DIRECTORY_ROLES = Object.freeze(
  Object.fromEntries(SERVER_LAYERS.map((layer) => [layer.directory, { layer: layer.layer, role: layer.role }]))
);

export const CORE_FOUNDATION_MODULES = Object.freeze(
  (_modulesData.modules || [])
    .filter((module) => module.kind === "foundation")
    .map((module) => Object.freeze({
      moduleId: module.id,
      directory: module.directory,
      chinese: module.chineseName || module.id,
      role: module.description || "",
      owner: module.owner || "platform",
      publicFacade: Array.isArray(module.publicApi) ? module.publicApi[0] || null : null
    }))
);
export const CORE_MODULES = Object.freeze(CORE_FOUNDATION_MODULES.map((module) => module.moduleId));
export const CORE_MODULE_ROLES = Object.freeze(
  Object.fromEntries(CORE_FOUNDATION_MODULES.map((module) => [
    module.moduleId,
    { chinese: module.chinese, role: module.role }
  ]))
);

export const PUBLIC_FACADES = Object.freeze(
  (_publicApiData.aliases || []).map((api) => Object.freeze({
    moduleId: api.alias.replace("#lico/", "").replace(/\*/gu, "star").replace(/[./-]/gu, "_"),
    importSpecifier: api.alias,
    facadePath: String(api.targetPath || "").replace(/^\.\//u, ""),
    owner: api.owner || "platform",
    layer: api.layer || "",
    privatePathPatterns: Object.freeze([...(api.privatePathPatterns || [])]),
    privatePathAllowedConsumers: Object.freeze([...(api.privatePathAllowedConsumers || [])])
  }))
);

export const PUBLIC_RESOURCES = Object.freeze(
  (_publicApiData.publicResources || []).map((resource) => Object.freeze({
    resourceId: resource.resourceId,
    path: resource.path
  }))
);

export const RUNTIME_PAYLOADS = Object.freeze(
  (_runtimePayloadsData.payloads || []).map((payload) => Object.freeze({
    payloadId: payload.id,
    pattern: payload.pattern || "",
    packageExclusion: payload.packageExclusion || payload.pattern || "",
    description: payload.description,
    downloadedAtRuntime: payload.downloadedAtRuntime === true,
    mayBeAbsentInSource: payload.mayBeAbsentInSource === true,
    severityIfMissing: payload.severityIfMissing || "info"
  }))
);

export const OPTIONAL_RUNTIME_LAYOUT = Object.freeze(_runtimePayloadsData.runtimeLayout || {});

export const DEPENDENCY_CONSTRAINTS = Object.freeze(
  (_depRulesData.constraints || []).map((constraint) => {
    const from = Array.isArray(constraint.fromPattern)
      ? constraint.fromPattern
      : [constraint.fromPattern || "**"];
    const to = Array.isArray(constraint.forbiddenTargets)
      ? constraint.forbiddenTargets
      : [constraint.forbiddenTargets || "**"];
    return Object.freeze({
      id: constraint.id,
      rule: constraint.id,
      from,
      fromPatterns: from,
      to,
      forbiddenImportPatterns: to,
      allowed: false,
      severity: constraint.severity || "warning",
      reason: constraint.reason || constraint.description || "",
      description: constraint.description || constraint.reason || "",
      exceptions: Object.freeze([])
    });
  })
);

export const MCP_CONNECTOR_CANONICAL = Object.freeze({
  directory: _mcpConnectorData.directory,
  names: Object.freeze(_mcpConnectorData.names || []),
  packageScripts: Object.freeze(_mcpConnectorData.packageScripts || [])
});

export const UPSTREAM_API_LAYOUT = Object.freeze({
  directory: "",
  subDirectories: Object.freeze([])
});

export const SCRIPT_CATEGORIES = Object.freeze(
  Object.fromEntries(Object.entries(_scriptsData.categories || {}).map(([key, value]) => [
    key,
    value.description || ""
  ]))
);

export const DOCS_DIRECTORY_ROLES = Object.freeze(_docsData.directoryRoles || {});

export function isCoreModule(name) {
  return CORE_MODULES.includes(name);
}

export function getFacadeBySpecifier(specifier) {
  return PUBLIC_FACADES.find((facade) => facade.importSpecifier === specifier) || null;
}

export function getFacadeByModuleId(moduleId) {
  return PUBLIC_FACADES.find((facade) => facade.moduleId === moduleId) || null;
}

export function getServerLayer(directory) {
  return SERVER_LAYERS.find((layer) => layer.directory === directory) || null;
}

export function getRootEntry(name) {
  return ROOT_ENTRIES.find((entry) => entry.name === name) || null;
}

export function validatePackageJsonImports(imports, label = "package.json#imports") {
  const missing = PUBLIC_FACADES
    .map((facade) => facade.importSpecifier)
    .filter((specifier) => !(specifier in (imports || {})));
  return {
    ok: missing.length === 0,
    label,
    missing
  };
}
