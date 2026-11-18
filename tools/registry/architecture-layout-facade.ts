/**
 * Architecture Layout Registry Facade.
 *
 * All public layout facts are sourced from JSON registry files in this
 * directory. Keep this file free of product-specific capability facts; edit
 * the registries instead.
 */

import { createRequire } from "node:module";

const require: any = createRequire(import.meta.url);

const _repoLayoutData: any = require("./repo-layout.registry.json");
const _modulesData: any = require("./modules.registry.json");
const _publicApiData: any = require("./public-api.registry.json");
const _depRulesData: any = require("./dependency-rules.registry.json");
const _serverLayersData: any = require("./server-layers.registry.json");
const _mcpConnectorData: any = require("./mcp-connector.registry.json");
const _runtimePayloadsData: any = require("./runtime-payloads.registry.json");
const _scriptsData: any = require("./scripts.registry.json");
const _docsData: any = require("./docs.registry.json");

export const ARCHITECTURE_LAYOUT_MANIFEST_VERSION: any = "architecture-layout-registry-facade";

export const ROOT_ENTRIES: any = Object.freeze(
  (_repoLayoutData.entries || []).map((entry?: any) : any => Object.freeze({
    name: entry.name,
    kind: entry.kind,
    required: entry.required === true,
    generated: entry.generated === true,
    packageIncluded: entry.packageIncluded === true
  }))
);

export const ROOT_ALLOWED_ENTRIES: any = Object.freeze(ROOT_ENTRIES.map((entry?: any) : any => entry.name));
export const ROOT_REQUIRED_ENTRIES: any = Object.freeze(ROOT_ENTRIES
  .filter((entry?: any) : any => entry.required === true)
  .map((entry?: any) : any => entry.name));
export const ROOT_HYGIENE_REQUIRED_ENTRIES: any = Object.freeze(
  _repoLayoutData.rootHygiene?.requiredEntries || ROOT_REQUIRED_ENTRIES
);
export const REPO_ORGANIZATION_AUDIT_POLICY: Readonly<Record<string, any>> = Object.freeze({
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
      .map((entry?: any) : any => Object.freeze({ path: entry.path, owner: entry.owner }))),
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

export const SERVER_LAYERS: any = Object.freeze(
  (_serverLayersData.layers || []).map((layer?: any) : any => Object.freeze({
    directory: layer.directory,
    layer: layer.layer,
    role: layer.role,
    allowedDependsOn: Object.freeze([...(layer.allowedDependsOn || [])]),
    forbiddenDependsOn: Object.freeze([...(layer.forbiddenDependsOn || [])])
  }))
);
export const SERVER_TOP_LEVEL_DIRECTORIES: any = Object.freeze(SERVER_LAYERS.map((layer?: any) : any => layer.directory));
export const SERVER_TOP_LEVEL_DIRECTORY_ROLES: any = Object.freeze(
  Object.fromEntries(SERVER_LAYERS.map((layer?: any) : any => [layer.directory, { layer: layer.layer, role: layer.role }]))
);

export const CORE_FOUNDATION_MODULES: any = Object.freeze(
  (_modulesData.modules || [])
    .filter((module?: any) : any => module.kind === "foundation")
    .map((module?: any) : any => Object.freeze({
      moduleId: module.id,
      directory: module.directory,
      chinese: module.chineseName || module.id,
      role: module.description || "",
      owner: module.owner || "platform",
      publicFacade: Array.isArray(module.publicApi) ? module.publicApi[0] || null : null
    }))
);
export const CORE_MODULES: any = Object.freeze(CORE_FOUNDATION_MODULES.map((module?: any) : any => module.moduleId));
export const CORE_MODULE_ROLES: any = Object.freeze(
  Object.fromEntries(CORE_FOUNDATION_MODULES.map((module?: any) : any => [
    module.moduleId,
    { chinese: module.chinese, role: module.role }
  ]))
);

export const PUBLIC_FACADES: any = Object.freeze(
  (_publicApiData.aliases || []).map((api?: any) : any => Object.freeze({
    moduleId: api.alias.replace("#meshrix/", "").replace(/\*/gu, "star").replace(/[./-]/gu, "_"),
    importSpecifier: api.alias,
    facadePath: String(api.targetPath || "").replace(/^\.\//u, ""),
    owner: api.owner || "platform",
    layer: api.layer || "",
    privatePathPatterns: Object.freeze([...(api.privatePathPatterns || [])]),
    privatePathAllowedConsumers: Object.freeze([...(api.privatePathAllowedConsumers || [])])
  }))
);

export const PUBLIC_RESOURCES: any = Object.freeze(
  (_publicApiData.publicResources || []).map((resource?: any) : any => Object.freeze({
    resourceId: resource.resourceId,
    path: resource.path
  }))
);

export const RUNTIME_PAYLOADS: any = Object.freeze(
  (_runtimePayloadsData.payloads || []).map((payload?: any) : any => Object.freeze({
    payloadId: payload.id,
    pattern: payload.pattern || "",
    packageExclusion: payload.packageExclusion || payload.pattern || "",
    description: payload.description,
    downloadedAtRuntime: payload.downloadedAtRuntime === true,
    mayBeAbsentInSource: payload.mayBeAbsentInSource === true,
    severityIfMissing: payload.severityIfMissing || "info"
  }))
);

export const OPTIONAL_RUNTIME_LAYOUT: any = Object.freeze(_runtimePayloadsData.runtimeLayout || {});

export const DEPENDENCY_CONSTRAINTS: any = Object.freeze(
  (_depRulesData.constraints || []).map((constraint?: any) : any => {
    const from: any = Array.isArray(constraint.fromPattern)
      ? constraint.fromPattern
      : [constraint.fromPattern || "**"];
    const to: any = Array.isArray(constraint.forbiddenTargets)
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

export const MCP_CONNECTOR_CANONICAL: Readonly<Record<string, any>> = Object.freeze({
  directory: _mcpConnectorData.directory,
  names: Object.freeze(_mcpConnectorData.names || []),
  packageScripts: Object.freeze(_mcpConnectorData.packageScripts || [])
});

export const UPSTREAM_API_LAYOUT: Readonly<Record<string, any>> = Object.freeze({
  directory: "",
  subDirectories: Object.freeze([])
});

export const SCRIPT_CATEGORIES: any = Object.freeze(
  Object.fromEntries((Object.entries(_scriptsData.categories || {}) as [string, any][]).map(([key, value]: any[]) : any => [
    key,
    value.description || ""
  ]))
);

export const DOCS_DIRECTORY_ROLES: any = Object.freeze(_docsData.directoryRoles || {});

export function isCoreModule(name?: any) : any {
  return CORE_MODULES.includes(name);
}

export function getFacadeBySpecifier(specifier?: any) : any {
  return PUBLIC_FACADES.find((facade?: any) : any => facade.importSpecifier === specifier) || null;
}

export function getFacadeByModuleId(moduleId?: any) : any {
  return PUBLIC_FACADES.find((facade?: any) : any => facade.moduleId === moduleId) || null;
}

export function getServerLayer(directory?: any) : any {
  return SERVER_LAYERS.find((layer?: any) : any => layer.directory === directory) || null;
}

export function getRootEntry(name?: any) : any {
  return ROOT_ENTRIES.find((entry?: any) : any => entry.name === name) || null;
}

export function validatePackageJsonImports(imports?: any, label: any = "package.json#imports") : any {
  const missing: any = PUBLIC_FACADES
    .map((facade?: any) : any => facade.importSpecifier)
    .filter((specifier?: any) : any => !(specifier in (imports || {})));
  return {
    ok: missing.length === 0,
    label,
    missing
  };
}
