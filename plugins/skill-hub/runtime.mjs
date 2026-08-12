import {
  PLUGIN_MCP_TOOL_BINDINGS,
  SKILL_HUB_OPERATION_DEFINITIONS,
  skillHubRouteId
} from "./src/operation-definitions.mjs";
import { createSkillHubExternalServiceClient } from "./runtime/external-service-client.mjs";
import { executeRemoteSandboxOperation, sandboxStatusOperation } from "./runtime/remote-sandbox.mjs";

const CONFIGURATION_FIELDS = new Set(["enabled", "service"]);
const SERVICE_FIELDS = new Set(["serviceRef", "timeoutMs"]);
const SANDBOX_OPERATIONS = new Set(["skill_hub.scan", "skill_hub.build", "skill_hub.execute"]);
const SANDBOX_STATUS_OPERATIONS = new Set(["skill_hub.execution.cancel", "skill_hub.execution.status"]);
const CONTRIBUTION_KINDS = Object.freeze([
  "operations", "routes", "mcpTools", "consoleEntries", "stateMachines", "verifierHooks"
]);

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function assertKnownFields(value, allowed, label) {
  if (!plainObject(value)) throw new TypeError(`${label} must be an object.`);
  const unsupported = Object.keys(value).find((field) => !allowed.has(field));
  if (unsupported) throw new TypeError(`${label} contains unsupported field ${unsupported}.`);
}

export function validateSkillHubConfiguration(configuration = {}) {
  assertKnownFields(configuration, CONFIGURATION_FIELDS, "Skill Hub configuration");
  if (configuration.enabled === undefined || configuration.enabled === false) {
    if (configuration.service !== undefined) {
      throw Object.assign(new Error("Skill Hub service binding requires explicit activation."), {
        code: "skill_hub_partial_configuration"
      });
    }
    return Object.freeze({ enabled: false });
  }
  if (configuration.enabled !== true) throw new TypeError("Skill Hub enabled must be a boolean.");
  assertKnownFields(configuration.service, SERVICE_FIELDS, "Skill Hub service configuration");
  const serviceRef = String(configuration.service.serviceRef || "").trim();
  const timeoutMs = Number(configuration.service.timeoutMs);
  if (!/^[a-z][a-z0-9._:-]{2,127}$/u.test(serviceRef)) {
    throw new TypeError("Skill Hub serviceRef is invalid.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new TypeError("Skill Hub timeoutMs must be between 100 and 120000.");
  }
  return Object.freeze({ enabled: true, serviceRef, timeoutMs });
}

function emptyContributions() {
  return Object.freeze(Object.fromEntries(CONTRIBUTION_KINDS.map((kind) => [kind, Object.freeze({})])));
}

function failure(code, statusCode = 502) {
  return Object.freeze({
    statusCode,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: Object.freeze({ ok: false, error: Object.freeze({ code }) })
  });
}

function currentCall(call = {}) {
  return call?.auth?.authenticated === true && call?.governance?.authorized === true &&
    call?.governance?.current === true && call?.governance?.revoked !== true;
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

  const remote = createSkillHubExternalServiceClient(admission);
  const inFlight = new Set();
  let closed = false;
  let closePromise = null;

  async function executeOperation({ operation, input = {}, call = {}, signal = null, host = {} }) {
    if (!currentCall(call)) return failure("skill_hub_operation_denied", 403);
    if (SANDBOX_OPERATIONS.has(operation.id)) {
      return executeRemoteSandboxOperation({ operation, input, call, signal, host, remote });
    }
    if (SANDBOX_STATUS_OPERATIONS.has(operation.id)) {
      return sandboxStatusOperation({ operation, input, host });
    }
    if (operation.id === "skill_hub.permission.grant") {
      const prepared = await remote.request({ operation, input, call, signal, host, phase: "prepare" });
      if (prepared.statusCode >= 400) return prepared;
      const loanRecord = prepared.body?.loanRecord;
      if (!loanRecord || typeof host.operationPermissionGrant?.recordPluginGrant !== "function") {
        return failure("skill_hub_operation_permission_unavailable", 503);
      }
      let receipt;
      try {
        receipt = await host.operationPermissionGrant.recordPluginGrant({ loanRecord });
      } catch (error) {
        return failure(
          /^[a-z][a-z0-9_]{2,96}$/u.test(String(error?.code || ""))
            ? String(error.code)
            : "skill_hub_operation_permission_denied",
          400
        );
      }
      if (receipt?.ok !== true || !String(receipt.receiptId || "")) {
        return failure("skill_hub_operation_permission_denied", 400);
      }
      return remote.request({
        operation,
        input,
        call,
        signal,
        host,
        phase: "commit",
        operationPermissionReceipt: receipt
      });
    }
    return remote.request({ operation, input, call, signal, host });
  }

  const operations = {};
  const routes = {};
  const mcpTools = {};
  for (const definition of SKILL_HUB_OPERATION_DEFINITIONS) {
    const requiredHostPorts = SANDBOX_OPERATIONS.has(definition.id)
      ? ["externalService", "sandboxExecution"]
      : SANDBOX_STATUS_OPERATIONS.has(definition.id)
        ? ["sandboxExecution"]
      : definition.id === "skill_hub.permission.grant"
        ? ["externalService", "operationPermissionGrant"]
        : ["externalService"];
    operations[definition.id] = Object.freeze({
      definition,
      requiredHostPorts: Object.freeze(requiredHostPorts),
      execute(args = {}) {
        if (closed || !remote.isAccepting()) return Promise.resolve(failure("skill_hub_runtime_closed", 503));
        const task = executeOperation({ ...args, operation: definition }).catch(() =>
          failure("skill_hub_external_service_failed", 502)
        );
        inFlight.add(task);
        task.finally(() => inFlight.delete(task)).catch(() => {});
        return task;
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
      stateMachines: Object.freeze({}),
      verifierHooks: Object.freeze({})
    }),
    close() {
      if (closePromise) return closePromise.then((value) => Object.freeze({ ...value, alreadyClosed: true }));
      closed = true;
      closePromise = (async () => {
        const remoteReceipt = await remote.close();
        await Promise.allSettled([...inFlight]);
        return Object.freeze({ ok: true, alreadyClosed: remoteReceipt.alreadyClosed });
      })();
      return closePromise;
    }
  });
}
