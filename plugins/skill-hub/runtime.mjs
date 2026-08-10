import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  buildSkillHubStatsDashboard,
  createSkillHubContributionRegistry
} from "./runtime/skill-hub-registry.mjs";
import { createStateMutationQueue } from "./runtime/state-mutation-queue.mjs";
import {
  callerIdClaim,
  callerKindClaim,
  errorPayload,
  objectOrNull,
  protocolPayload,
  result,
  workspaceIdFrom
} from "./runtime/operation-helpers.mjs";
import { createSkillHubOperationExecutor } from "./runtime/skill-hub-executor.mjs";
import {
  createSkillHubSandboxOperations,
  SKILL_HUB_SANDBOX_OPERATION_IDS
} from "./runtime/skill-hub-sandbox.mjs";
import { materializeSkillHubAsset } from "./runtime/skill-hub-assets.mjs";
import {
  normalizeSkillHubContribution,
  projectPublicSkillHubContribution,
  projectSkillHubAssetRecord,
  SKILL_HUB_ASSET_BUCKETS,
  skillHubAssetBucketForType
} from "./runtime/skill-hub-contribution.mjs";
import {
  PLUGIN_MCP_TOOL_BINDINGS,
  SKILL_HUB_OPERATION_DEFINITIONS,
  skillHubRouteId
} from "./src/operation-definitions.mjs";

const CONFIGURATION_FIELDS = new Set(["enabled", "modules"]);
const MODULE_FIELDS = new Set(["registry", "opaqueCustody", "controlledSandbox", "operationPermission"]);
const CONTRIBUTION_KINDS = Object.freeze([
  "operations",
  "routes",
  "mcpTools",
  "consoleEntries",
  "stateMachines",
  "verifierHooks"
]);
const MUTATING_REGISTRY_METHODS = new Set([
  "submitContribution",
  "scanContribution",
  "reviewContribution",
  "publishContribution",
  "adoptContribution",
  "deprecateContribution",
  "revokeContribution",
  "requestPermission",
  "grantPermission",
  "recordDownload",
  "recordUsage",
  "recordExecutionReceipt",
  "recordRollback"
]);
const HOST_PORTS_BY_OPERATION = Object.freeze({
  "skill_hub.submit": Object.freeze(["opaqueArtifactCustody"]),
  "skill_hub.scan": Object.freeze(["sandboxExecution"]),
  "skill_hub.build": Object.freeze(["sandboxExecution"]),
  "skill_hub.execute": Object.freeze(["sandboxExecution"]),
  "skill_hub.execution.cancel": Object.freeze(["sandboxExecution"]),
  "skill_hub.execution.status": Object.freeze(["sandboxExecution"]),
  "skill_hub.review": Object.freeze(["securityAlertStore"]),
  "skill_hub.download": Object.freeze(["securityAlertStore"]),
  "skill_hub.install": Object.freeze(["securityAlertStore"]),
  "skill_hub.permission.grant": Object.freeze(["operationPermissionGrant"])
});

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertKnownFields(value, allowed, label) {
  if (!plainObject(value)) throw new TypeError(`${label} must be an object.`);
  const unsupported = Object.keys(value).find((field) => !allowed.has(field));
  if (unsupported) throw new TypeError(`${label} contains unsupported field ${unsupported}.`);
}

export function validateSkillHubConfiguration(configuration = {}) {
  assertKnownFields(configuration, CONFIGURATION_FIELDS, "Skill Hub configuration");
  if (configuration.enabled === undefined || configuration.enabled === false) {
    if (configuration.modules !== undefined) {
      const error = new Error("Skill Hub modules require explicit activation.");
      error.code = "skill_hub_partial_configuration";
      throw error;
    }
    return Object.freeze({ enabled: false });
  }
  if (configuration.enabled !== true) throw new TypeError("Skill Hub enabled must be a boolean.");
  assertKnownFields(configuration.modules, MODULE_FIELDS, "Skill Hub modules configuration");
  if ([...MODULE_FIELDS].some((field) => configuration.modules[field] !== true)) {
    const error = new Error("Skill Hub activation requires the complete governed module set.");
    error.code = "skill_hub_partial_configuration";
    throw error;
  }
  return Object.freeze({ enabled: true });
}

function emptyContributions() {
  return Object.freeze(Object.fromEntries(
    CONTRIBUTION_KINDS.map((kind) => [kind, Object.freeze({})])
  ));
}

function filterContributionsForWorkspace(items = [], input = {}) {
  const workspaceId = String(input.workspaceId || input.workspace || "").trim();
  if (!workspaceId || !items.some((item) => Object.hasOwn(item, "workspaceId"))) return items;
  return items.filter((item) => item.workspaceId === workspaceId);
}

function runtimeClosedResponse() {
  return Object.freeze({
    statusCode: 503,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: Object.freeze({ ok: false, error: Object.freeze({ code: "skill_hub_runtime_closed" }) })
  });
}

export async function activatePlugin({ manifest, context = {} } = {}) {
  if (manifest?.id !== "skill-hub") throw new TypeError("Skill Hub requires the skill-hub manifest.");
  const admission = validateSkillHubConfiguration(context.configuration || {});
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

  const pluginData = context.pluginData;
  if (!pluginData || typeof pluginData.readFile !== "function" ||
      typeof pluginData.writeFile !== "function" || typeof pluginData.stat !== "function") {
    throw new TypeError("Skill Hub requires an opaque plugin data capability.");
  }

  const mutationQueue = createStateMutationQueue();
  const inFlight = new Set();
  let closed = false;
  let closePromise = null;
  try {
    const lifecycleDefinition = Object.freeze(JSON.parse(await readFile(
      new URL("./state-machines/contribution.lifecycle.json", import.meta.url),
      "utf8"
    )));
    const registryDescriptorFor = (input = {}, operationContext = {}) => {
      const workspaceId = workspaceIdFrom({
        workspaceId: input.registryWorkspaceId || input.contributionRegistryWorkspaceId
      }, operationContext.contributionRegistryWorkspaceId || "default");
      const registryId = crypto.createHash("sha256").update(workspaceId).digest("hex");
      return Object.freeze({
        workspaceId,
        registryRelativePath: path.posix.join("SkillHub", "registries", `${registryId}.json`),
        queueKey: `skill-hub-registry:${registryId}`
      });
    };
    const registrySessions = new Map();
    const contributionRegistryFor = async (input = {}, operationContext = {}) => {
      const descriptor = registryDescriptorFor(input, operationContext);
      if (!registrySessions.has(descriptor.registryRelativePath)) {
        registrySessions.set(descriptor.registryRelativePath, (async () => {
          let initialPersistedState;
          try {
            initialPersistedState = JSON.parse(await pluginData.readFile(descriptor.registryRelativePath, "utf8"));
          } catch (error) {
            if (error?.code !== "PLUGIN_DATA_NOT_FOUND") throw error;
          }
          let persistenceTail = Promise.resolve();
          const schedulePersistence = (operation) => {
            persistenceTail = persistenceTail.then(operation);
            return persistenceTail;
          };
          const registry = createSkillHubContributionRegistry({
            workspaceId: descriptor.workspaceId,
            registryRelativePath: descriptor.registryRelativePath,
            initialPersistedState,
            schedulePersistence,
            pluginData,
            contributionNormalizer: normalizeSkillHubContribution,
            materializeAsset: materializeSkillHubAsset,
            assetRecordProjector: projectSkillHubAssetRecord,
            assetBucketResolver: skillHubAssetBucketForType,
            assetBuckets: SKILL_HUB_ASSET_BUCKETS,
            lifecycleDefinition
          });
          const asyncRegistry = { protocolVersion: registry.protocolVersion };
          for (const [name, method] of Object.entries(registry)) {
            if (typeof method !== "function" || name.startsWith("_")) continue;
            asyncRegistry[name] = async (...args) => {
              if (!MUTATING_REGISTRY_METHODS.has(name)) {
                await persistenceTail.catch(() => {});
                return Reflect.apply(method, registry, args);
              }
              persistenceTail = Promise.resolve();
              const snapshot = registry._snapshotState();
              try {
                const value = await Reflect.apply(method, registry, args);
                await persistenceTail;
                return value;
              } catch (error) {
                registry._restoreState(snapshot);
                persistenceTail = Promise.resolve();
                throw error;
              }
            };
          }
          return Object.freeze(asyncRegistry);
        })());
      }
      return registrySessions.get(descriptor.registryRelativePath);
    };

    const executeSkillHubOperation = createSkillHubOperationExecutor({
      assetRecordProjector: projectSkillHubAssetRecord,
      buildContributionStatsDashboard: buildSkillHubStatsDashboard,
      callerIdClaim,
      callerKindClaim,
      contributionRegistryFor,
      errorPayload,
      filterContributionsForWorkspace,
      objectOrNull,
      projectPublicSkillHubContribution,
      protocolPayload,
      result,
      workspaceIdFrom
    });
    const sandboxOperations = createSkillHubSandboxOperations({ contributionRegistryFor, workspaceIdFrom });
    const operations = {};
    const routes = {};
    const mcpTools = {};

    for (const definition of SKILL_HUB_OPERATION_DEFINITIONS) {
      operations[definition.id] = Object.freeze({
        definition,
        ...(manifest.opaqueInputPreprocessing?.[definition.id]
          ? { opaqueInputPreprocessing: manifest.opaqueInputPreprocessing[definition.id] }
          : {}),
        requiredHostPorts: HOST_PORTS_BY_OPERATION[definition.id] || Object.freeze([]),
        async execute({ operation = definition, input = {}, call = {}, signal = null, host = {} } = {}) {
          if (closed || !mutationQueue.isAccepting()) return runtimeClosedResponse();
          const descriptor = registryDescriptorFor(input);
          const operationId = operation.id || definition.id;
          const auth = plainObject(call.auth) ? call.auth : {};
          const governance = plainObject(call.governance) ? call.governance : {};
          const operationContext = {
            pluginData,
            transport: String(call.transport || "internal"),
            subject: {
              type: String(auth.actorType || (auth.authenticated ? "authenticated" : "anonymous")),
              subjectId: String(auth.subjectRef || ""),
              scopes: Array.isArray(auth.scopes) ? auth.scopes.map(String).filter(Boolean) : []
            },
            governance: Object.freeze({
              authorized: governance.authorized === true,
              current: governance.current === true
            }),
            securityAlertStore: host.securityAlertStore || null,
            opaqueArtifactCustody: host.opaqueArtifactCustody || null,
            operationPermissionGrant: host.operationPermissionGrant || null,
            contributionRegistryWorkspaceId: String(input.contributionRegistryWorkspaceId || input.registryWorkspaceId || ""),
            skillId: input.skillId || input["skill-id"] || "",
            contributionId: input.contributionId || input["contribution-id"] || "",
            principal: {
              subjectRef: String(auth.subjectRef || "").trim(),
              tenantRef: String(auth.tenantRef || input.workspaceId || input.workspace || "").trim()
            },
            signal
          };
          const task = async () => {
            operationContext.contributionRegistry = await contributionRegistryFor(input, operationContext);
            let operationResult;
            if (SKILL_HUB_SANDBOX_OPERATION_IDS.has(operationId)) {
              try {
                let payload;
                if (operationId === "skill_hub.execution.cancel") {
                  payload = await sandboxOperations.cancel({ input, sandboxExecution: host.sandboxExecution });
                } else if (operationId === "skill_hub.execution.status") {
                  payload = await sandboxOperations.getStatus({ input, sandboxExecution: host.sandboxExecution });
                } else {
                  payload = await sandboxOperations.execute({
                    operationId,
                    input,
                    context: operationContext,
                    sandboxExecution: host.sandboxExecution
                  });
                }
                operationResult = result(200, protocolPayload({
                  protocolVersion: "v0.0.1:skill-hub:runtime-1",
                  ...(payload.receipt !== undefined ? { receipt: payload.receipt } : {}),
                  ...(payload.scan ? { scan: {
                    contribution: projectPublicSkillHubContribution(payload.scan.contribution),
                    lifecycleDecision: payload.scan.lifecycleDecision
                  } } : {}),
                  ...(payload.runId !== undefined ? { runId: payload.runId } : {}),
                  ...(payload.status !== undefined ? { status: payload.status } : {}),
                  ...(payload.reasonCode !== undefined ? { reasonCode: payload.reasonCode } : {}),
                  ...(payload.cleanupStatus !== undefined ? { cleanupStatus: payload.cleanupStatus } : {}),
                  ...(payload.outputDisposition !== undefined ? { outputDisposition: payload.outputDisposition } : {})
                }));
              } catch (error) {
                operationResult = result(400, errorPayload(error, "skill_hub_sandbox_operation_failed"));
              }
            } else {
              operationResult = await executeSkillHubOperation({ operationId, input, context: operationContext });
            }
            if (!operationResult) {
              return Object.freeze({
                statusCode: 501,
                headers: Object.freeze({ "content-type": "application/json" }),
                body: Object.freeze({ ok: false, error: Object.freeze({ code: "skill_hub_operation_not_registered" }) })
              });
            }
            return Object.freeze({
              statusCode: operationResult.status,
              headers: Object.freeze({ "content-type": "application/json" }),
              body: operationResult.payload
            });
          };
          const pending = mutationQueue.run(descriptor.queueKey, task);
          inFlight.add(pending);
          try {
            return await pending;
          } finally {
            inFlight.delete(pending);
          }
        }
      });
      routes[skillHubRouteId(definition.id)] = Object.freeze({ operationId: definition.id });
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
          "admin.skill-hub": Object.freeze({
            label: "Skill Hub",
            featureId: "skill-hub",
            viewKey: "skillHub",
            routePath: "/admin/skill-hub",
            componentId: "skill-hub/SkillHubView",
            assetPath: "console/index.mjs",
            assetExport: "mountPluginConsole",
            requiredScopes: Object.freeze(["console:read"])
          })
        }),
        stateMachines: Object.freeze({
          "contribution.lifecycle": Object.freeze({ definition: lifecycleDefinition })
        }),
        verifierHooks: Object.freeze({})
      }),
      async close() {
        if (closePromise) {
          const receipt = await closePromise;
          return Object.freeze({ ...receipt, alreadyClosed: true });
        }
        closed = true;
        closePromise = (async () => {
          const queueReceipt = await mutationQueue.close();
          await Promise.allSettled([...inFlight]);
          await Promise.allSettled([...registrySessions.values()]);
          return Object.freeze({ ok: queueReceipt.ok, alreadyClosed: false, drained: queueReceipt.drained });
        })();
        return closePromise;
      }
    });
  } catch (error) {
    closed = true;
    await mutationQueue.close();
    throw error;
  }
}
