import { readFile } from "node:fs/promises";

import {
  PLUGIN_MCP_TOOL_BINDINGS,
  SHARED_SPACE_OPERATION_DEFINITIONS,
  sharedSpaceRouteId
} from "./src/operation-definitions.mjs";
import { executeSharedSpaceOperation } from "./runtime/shared-space-executor.mjs";
import { createSharedSpaceSandboxExecution } from "./runtime/sandbox-execution.mjs";
import { sharedSpaceExchangeReceipt } from "./runtime/shared-space-mcp.mjs";

const CONFIGURATION_FIELDS = new Set(["enabled", "modules"]);
const MODULE_FIELDS = new Set(["localDirectory", "controlledSandbox"]);
const CONTRIBUTION_KINDS = Object.freeze([
  "operations",
  "routes",
  "mcpTools",
  "consoleEntries",
  "stateMachines",
  "verifierHooks"
]);

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

export function validateSharedSpaceConfiguration(configuration = {}) {
  assertKnownFields(configuration, CONFIGURATION_FIELDS, "Shared Space configuration");
  if (configuration.enabled === undefined || configuration.enabled === false) {
    if (configuration.modules !== undefined) {
      const error = new Error("Shared Space modules require explicit activation.");
      error.code = "shared_space_partial_configuration";
      throw error;
    }
    return Object.freeze({ enabled: false });
  }
  if (configuration.enabled !== true) {
    throw new TypeError("Shared Space enabled must be a boolean.");
  }
  assertKnownFields(configuration.modules, MODULE_FIELDS, "Shared Space modules configuration");
  if (configuration.modules.localDirectory !== true || configuration.modules.controlledSandbox !== true) {
    const error = new Error("Shared Space activation requires the complete governed module set.");
    error.code = "shared_space_partial_configuration";
    throw error;
  }
  return Object.freeze({ enabled: true });
}

function emptyContributions() {
  return Object.freeze(Object.fromEntries(
    CONTRIBUTION_KINDS.map((kind) => [kind, Object.freeze({})])
  ));
}

function authorizedSession(call = {}) {
  const auth = call.auth || {};
  const governance = call.governance || {};
  const workspaceAuthority = call.workspaceAuthority || {};
  if (auth.authenticated !== true || governance.authorized !== true ||
      governance.current !== true || governance.revoked === true) return null;
  return Object.freeze({
    tenantRef: String(auth.tenantRef || "").trim(),
    user: Object.freeze({
      subjectId: String(auth.subjectRef || "").trim(),
      tenantId: String(auth.tenantRef || "").trim(),
      scopes: Object.freeze([...new Set(
        [...(auth.scopes || []), ...(governance.scopes || [])].map(String).filter(Boolean)
      )]),
      allowedWorkspaceIds: Object.freeze(
        workspaceAuthority.authorized === true && workspaceAuthority.workspaceRef
          ? [String(workspaceAuthority.workspaceRef)]
          : []
      )
    })
  });
}

function sanitizedFailure(error) {
  const statusCode = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 503;
  const code = /^[a-z][a-z0-9_]{2,96}$/u.test(String(error?.code || ""))
    ? String(error.code)
    : "shared_space_host_operation_failed";
  return Object.freeze({
    statusCode,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: Object.freeze({ ok: false, error: Object.freeze({ code }) })
  });
}

async function stateMachineDefinition() {
  const raw = await readFile(new URL("./state-machines/checkpoint.restore.json", import.meta.url), "utf8");
  return Object.freeze(JSON.parse(raw));
}

export async function activatePlugin({ manifest, context = {} } = {}) {
  const admission = validateSharedSpaceConfiguration(context.configuration || {});
  if (!admission.enabled) {
    let closed = false;
    return Object.freeze({
      id: manifest?.id || "shared-space",
      mounts: Object.freeze({}),
      contributions: emptyContributions(),
      async close() {
        const alreadyClosed = closed;
        closed = true;
        return Object.freeze({ ok: true, alreadyClosed });
      }
    });
  }

  const sandboxRuntime = createSharedSpaceSandboxExecution({ pluginData: context.pluginData });
  try {
    const checkpointRestoreDefinition = await stateMachineDefinition();
    const operations = {};
    const routes = {};
    const mcpTools = {};
    const operationHostPorts = Object.freeze({
      "sharedspace.snapshot.create": ["agentWorkspace"],
      "sharedspace.sandbox.input.seal": ["opaqueArtifactCustody"],
      "sharedspace.sandbox.run": ["agentWorkspace", "sandboxExecution"],
      "sharedspace.sandbox.runOpaque": ["sandboxExecution"],
      "sharedspace.sandbox.cancel": ["sandboxExecution"],
      "sharedspace.sandbox.status": ["sandboxExecution"],
      "sharedspace.output.preview": ["agentWorkspace", "sandboxExecution"],
      "sharedspace.output.approve": [],
      "sharedspace.output.reject": ["sandboxExecution"],
      "sharedspace.output.commit": ["agentWorkspace", "sandboxExecution"]
    });

    for (const definition of SHARED_SPACE_OPERATION_DEFINITIONS) {
      operations[definition.id] = Object.freeze({
        definition,
        ...(manifest?.opaqueInputPreprocessing?.[definition.id]
          ? { opaqueInputPreprocessing: manifest.opaqueInputPreprocessing[definition.id] }
          : {}),
        ...(manifest?.hostPathInputPreprocessing?.[definition.id]
          ? { hostPathInputPreprocessing: manifest.hostPathInputPreprocessing[definition.id] }
          : {}),
        requiredHostPorts: Object.freeze(operationHostPorts[definition.id] || ["agentWorkspace"]),
        async execute({ operation = definition, input = {}, call = {}, host = {} } = {}) {
          try {
            const operationId = operation.id || definition.id;
            const authSession = authorizedSession(call);
            if (!authSession) {
              return Object.freeze({
                statusCode: 403,
                headers: Object.freeze({ "content-type": "application/json" }),
                body: Object.freeze({
                  ok: false,
                  error: Object.freeze({ code: "shared_space_operation_denied" })
                })
              });
            }
            const operationResult = await executeSharedSpaceOperation({
              operationId,
              input,
              context: Object.freeze({
                authSession,
                approvalRecord: call.approval || null,
                agentWorkspace: host.agentWorkspace || null,
                sandboxExecution: host.sandboxExecution || null,
                opaqueArtifactCustody: host.opaqueArtifactCustody || null,
                executeSandboxOperation: sandboxRuntime.execute
              })
            });
            if (!operationResult) {
              return Object.freeze({
                statusCode: 501,
                headers: Object.freeze({ "content-type": "application/json" }),
                body: Object.freeze({ ok: false, error: Object.freeze({ code: "shared_space_operation_not_registered" }) })
              });
            }
            const body = operationResult.payload && typeof operationResult.payload === "object"
              ? Object.freeze({
                  ...operationResult.payload,
                  exchange: sharedSpaceExchangeReceipt({ operationId, input, payload: operationResult.payload })
                })
              : operationResult.payload;
            return Object.freeze({
              statusCode: operationResult.status,
              headers: Object.freeze({ "content-type": "application/json" }),
              body
            });
          } catch (error) {
            return sanitizedFailure(error);
          }
        }
      });
      routes[sharedSpaceRouteId(definition.id)] = Object.freeze({ operationId: definition.id });
    }
    for (const [toolId, binding] of Object.entries(PLUGIN_MCP_TOOL_BINDINGS)) {
      mcpTools[toolId] = binding;
    }

    let closed = false;
    return Object.freeze({
      id: manifest?.id || "shared-space",
      mounts: Object.freeze({}),
      contributions: Object.freeze({
        operations: Object.freeze(operations),
        routes: Object.freeze(routes),
        mcpTools: Object.freeze(mcpTools),
        consoleEntries: Object.freeze({
          "workspaces.local-directory": Object.freeze({
            label: "Shared Space local directory",
            featureId: "local-sharedspace",
            viewKey: "workspaces",
            slotId: "workspace.local-directory",
            componentId: "shared-space/WorkspaceLocalDirectoryPanel",
            assetPath: "console/index.mjs",
            toolIds: Object.freeze([
              "sharedspace.localDir.list",
              "sharedspace.localDir.connect",
              "sharedspace.sync.apply"
            ]),
            requiredScopes: Object.freeze(["workspace:read"])
          })
        }),
        stateMachines: Object.freeze({
          "checkpoint.restore": Object.freeze({ definition: checkpointRestoreDefinition })
        }),
        verifierHooks: Object.freeze({})
      }),
      async close() {
        if (closed) return Object.freeze({ ok: true, alreadyClosed: true });
        closed = true;
        await sandboxRuntime.close();
        return Object.freeze({ ok: true, alreadyClosed: false });
      }
    });
  } catch (error) {
    await sandboxRuntime.close();
    throw error;
  }
}
