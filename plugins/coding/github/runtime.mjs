import { readFile } from "node:fs/promises";

import {
  CODING_GITHUB_OPERATION_DEFINITIONS,
  PLUGIN_MCP_TOOL_BINDINGS,
  codingGithubRouteId
} from "./src/operation-definitions.mjs";
import {
  assertCurrentGovernance,
  codingGithubError,
  plainObject,
  sanitizedHttpFailure,
  validateOperationInput
} from "./runtime/contracts.mjs";
import { createExternalServiceClient } from "./runtime/external-service-client.mjs";
import { createSkillInstallState } from "./runtime/skill-install-state.mjs";

const CONFIGURATION_FIELDS = new Set(["enabled", "modules", "services"]);
const MODULE_FIELDS = new Set(["rest", "mcp", "codespaces", "skillInstaller"]);
const SERVICE_FIELDS = new Set(["rest", "mcp"]);
const SERVICE_BINDING_FIELDS = new Set(["serviceRef", "timeoutMs"]);
const CONTRIBUTION_KINDS = Object.freeze([
  "operations",
  "routes",
  "mcpTools",
  "consoleEntries",
  "stateMachines",
  "verifierHooks"
]);

function assertKnownFields(value, allowed, label) {
  if (!plainObject(value)) throw new TypeError(`${label} must be an object.`);
  const unsupported = Object.keys(value).find((field) => !allowed.has(field));
  if (unsupported) throw new TypeError(`${label} contains unsupported field ${unsupported}.`);
}

function serviceBinding(value, label) {
  assertKnownFields(value, SERVICE_BINDING_FIELDS, label);
  const serviceRef = String(value.serviceRef || "").trim();
  if (!/^[a-z][a-z0-9._:-]{2,127}$/u.test(serviceRef)) {
    throw new TypeError(`${label} serviceRef is invalid.`);
  }
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 120000) {
    throw new TypeError(`${label} timeoutMs must be between 100 and 120000.`);
  }
  return Object.freeze({ serviceRef, timeoutMs: value.timeoutMs });
}

export function validateCodingGithubConfiguration(configuration = {}) {
  assertKnownFields(configuration, CONFIGURATION_FIELDS, "Coding GitHub configuration");
  if (configuration.enabled === undefined || configuration.enabled === false) {
    if (configuration.modules !== undefined || configuration.services !== undefined) {
      throw codingGithubError("coding_github_partial_configuration");
    }
    return Object.freeze({ enabled: false });
  }
  if (configuration.enabled !== true) throw new TypeError("Coding GitHub enabled must be a boolean.");
  assertKnownFields(configuration.modules, MODULE_FIELDS, "Coding GitHub modules configuration");
  if ([...MODULE_FIELDS].some((field) => configuration.modules[field] !== true)) {
    throw codingGithubError("coding_github_partial_configuration");
  }
  assertKnownFields(configuration.services, SERVICE_FIELDS, "Coding GitHub services configuration");
  if ([...SERVICE_FIELDS].some((field) => !Object.hasOwn(configuration.services, field))) {
    throw codingGithubError("coding_github_partial_configuration");
  }
  const rest = serviceBinding(configuration.services.rest, "Coding GitHub REST service");
  const mcp = serviceBinding(configuration.services.mcp, "Coding GitHub MCP service");
  return Object.freeze({
    enabled: true,
    serviceRefs: Object.freeze({ rest: rest.serviceRef, mcp: mcp.serviceRef }),
    timeoutMs: Object.freeze({ rest: rest.timeoutMs, mcp: mcp.timeoutMs })
  });
}

function emptyContributions() {
  return Object.freeze(Object.fromEntries(
    CONTRIBUTION_KINDS.map((kind) => [kind, Object.freeze({})])
  ));
}

async function packageArtifact(relativeUrl) {
  return Object.freeze(JSON.parse(await readFile(new URL(relativeUrl, import.meta.url), "utf8")));
}

function publicCodespaceManifest(descriptor) {
  return Object.freeze({
    schemaVersion: descriptor.schemaVersion,
    kind: descriptor.kind,
    packageKind: descriptor.packageKind,
    pluginId: descriptor.pluginId,
    provider: descriptor.provider,
    name: descriptor.name,
    version: descriptor.version,
    title: descriptor.title,
    description: descriptor.description,
    source: descriptor.source,
    risk: descriptor.risk,
    toolsets: Object.freeze([...(descriptor.toolsets || [])]),
    operations: Object.freeze([...(descriptor.operations || [])]),
    promotion: Object.freeze({ ...(descriptor.promotion || {}) })
  });
}

function successResponse(operationId, response, install = undefined) {
  return Object.freeze({
    statusCode: response.status,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: Object.freeze({
      schemaVersion: "v0.0.1:coding-github:operation-result-1",
      ok: true,
      operationId,
      data: response.data,
      ...(response.pagination ? { pagination: response.pagination } : {}),
      ...(response.rateLimit ? { rateLimit: response.rateLimit } : {}),
      ...(response.receiptRef ? { receiptRef: response.receiptRef } : {}),
      ...(install ? { install } : {})
    })
  });
}

function localManifestResponse(operationId, descriptor) {
  return Object.freeze({
    statusCode: 200,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: Object.freeze({
      schemaVersion: "v0.0.1:coding-github:operation-result-1",
      ok: true,
      operationId,
      data: publicCodespaceManifest(descriptor)
    })
  });
}

export async function activatePlugin({ manifest, context = {} } = {}) {
  if (manifest?.id !== "coding-github") throw new TypeError("Coding GitHub requires the coding-github manifest.");
  const admission = validateCodingGithubConfiguration(context.configuration || {});
  if (!admission.enabled) {
    let closed = false;
    return Object.freeze({
      id: manifest.id,
      mounts: Object.freeze({}),
      contributions: emptyContributions(),
      async close() {
        const alreadyClosed = closed;
        closed = true;
        return Object.freeze({ ok: true, alreadyClosed });
      }
    });
  }

  const [codespaceDescriptor, installLifecycle] = await Promise.all([
    packageArtifact("./capability/github-codespace-provider.json"),
    packageArtifact("./state-machines/skill-install.lifecycle.json")
  ]);
  const externalServiceClient = createExternalServiceClient({
    serviceRefs: admission.serviceRefs,
    timeoutMs: admission.timeoutMs
  });
  const skillInstallState = createSkillInstallState({ pluginData: context.pluginData });
  const inFlight = new Set();
  let closed = false;
  let closePromise = null;

  async function executeOperation({ operation, input = {}, call = {}, signal = null, host = {} }) {
    try {
      assertCurrentGovernance(call);
      const normalizedInput = validateOperationInput(operation, input);
      if (operation.id === "codespace.providers.manifest") {
        return localManifestResponse(operation.id, codespaceDescriptor);
      }
      if (operation.id === "github.skills.install.apply") skillInstallState.assertPlan(normalizedInput);
      if (operation.id === "github.skills.install.rollback") {
        await skillInstallState.assertRollbackable(normalizedInput);
      }
      const response = await externalServiceClient.request({
        operation,
        input: normalizedInput,
        host,
        signal
      });
      let install;
      if (operation.id === "github.skills.install.plan") install = skillInstallState.plan(normalizedInput);
      else if (operation.id === "github.skills.install.apply") {
        install = await skillInstallState.recordInstall({ input: normalizedInput, response });
      } else if (operation.id === "github.skills.install.rollback") {
        install = await skillInstallState.recordRollback({ input: normalizedInput, response });
      }
      return successResponse(operation.id, response, install);
    } catch (error) {
      return sanitizedHttpFailure(error);
    }
  }

  const operations = {};
  const routes = {};
  const mcpTools = {};
  for (const definition of CODING_GITHUB_OPERATION_DEFINITIONS) {
    operations[definition.id] = Object.freeze({
      definition,
      requiredHostPorts: Object.freeze(definition.id === "codespace.providers.manifest" ? [] : ["externalService"]),
      execute(args = {}) {
        if (closed || !externalServiceClient.isAccepting()) {
          return Promise.resolve(sanitizedHttpFailure(codingGithubError("coding_github_runtime_closed", 503)));
        }
        const task = executeOperation({ ...args, operation: definition });
        inFlight.add(task);
        task.finally(() => inFlight.delete(task)).catch(() => {});
        return task;
      }
    });
    routes[codingGithubRouteId(definition.id)] = Object.freeze({ operationId: definition.id });
  }
  for (const [toolId, binding] of Object.entries(PLUGIN_MCP_TOOL_BINDINGS)) mcpTools[toolId] = binding;

  return Object.freeze({
    id: manifest.id,
    mounts: Object.freeze({}),
    contributions: Object.freeze({
      operations: Object.freeze(operations),
      routes: Object.freeze(routes),
      mcpTools: Object.freeze(mcpTools),
      consoleEntries: Object.freeze({
        "admin.coding-github": Object.freeze({
          label: "GitHub Connector",
          featureId: "coding-github",
          viewKey: "settings",
          slotId: "integrations.coding-github",
          componentId: "coding-github/GitHubConnectorPanel",
          assetPath: "console/index.mjs",
          assetExport: "mountPluginConsole",
          requiredScopes: Object.freeze(["repo:read"])
        })
      }),
      stateMachines: Object.freeze({
        "github-skill-install.lifecycle": Object.freeze({ definition: installLifecycle })
      }),
      verifierHooks: Object.freeze({})
    }),
    close() {
      if (closePromise) {
        return closePromise.then(() => Object.freeze({ ok: true, alreadyClosed: true }));
      }
      closed = true;
      closePromise = (async () => {
        const external = await externalServiceClient.close();
        await Promise.allSettled([...inFlight]);
        await skillInstallState.close();
        return Object.freeze({ ok: true, alreadyClosed: external.alreadyClosed });
      })();
      return closePromise;
    }
  });
}
