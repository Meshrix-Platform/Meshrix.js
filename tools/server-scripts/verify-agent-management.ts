#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.ts";
import { SERVER_API_OPERATIONS as GENERATED_SERVER_API_OPERATIONS } from "../../packages/contracts/src/generated/operations.generated.ts";
import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.ts";
import { KERNEL_API_OPERATION_IDS } from "../../packages/foundation/src/security/authorization/generated-capabilities.ts";
import { publicAgentGatewayRegistry } from "../../packages/agents/src/agent-gateway/index.ts";
import {
  filterOperationsForFeatures,
  operationFeatureId,
  resolveFeatureRuntime
} from "../../packages/server-runtime/src/composition/features/feature-manifest.ts";
import {
  getSettingsPath,
  loadSettings,
  normalizeSettings,
  saveSettings
} from "../../packages/server-runtime/src/composition/settings.ts";
import { executeSettingsAgentGatewayOperation } from "../../packages/server-runtime/src/composition/console-domain/operation-executors/settings-agent-gateway-executor.ts";

const EXPECTED_OPERATION_IDS: readonly any[] = Object.freeze([
  "agents.list",
  "agents.create",
  "agents.update",
  "agents.delete"
]);
const SETTINGS_PORT: Readonly<Record<string, any>> = Object.freeze({
  getSettingsPath,
  loadSettings,
  normalizeSettings,
  saveSettings
});

function operationById(operations?: any, id?: any) : any {
  return operations.find((operation?: any) : any => operation.id === id) || null;
}

function createMemoryAgentConfigRegistry() : any {
  let agents: any[] = [];
  function normalizeAgents(values: any = []) : any {
    return (Array.isArray(values) ? values : []).map((agent?: any) : any => ({
      ...agent,
      uid: String(agent.uid || agent.instanceId || agent.alias || agent.model || "").trim(),
      instanceId: String(agent.instanceId || agent.uid || agent.alias || agent.model || "").trim(),
      alias: String(agent.alias || agent.uid || agent.instanceId || agent.model || "").trim()
    }));
  }
  return {
    async refresh({ settingsFallback = {} }: Record<string, any> = {}) : Promise<any> {
      if (Array.isArray(settingsFallback.modelLibraryAgents)) {
        agents = normalizeAgents(settingsFallback.modelLibraryAgents);
      }
    },
    async replaceFromModelLibraryAgents(models: any = []) : Promise<any> {
      agents = normalizeAgents(models);
    },
    getModelLibraryAgents({ redactSecrets = false }: Record<string, any> = {}) : any {
      return agents.map((agent?: any) : any => {
        const next: Record<string, any> = { ...agent };
        if (redactSecrets) {
          if (next.apiKey) next.apiKeyConfigured = true;
          if (next.token) next.tokenConfigured = true;
          delete next.apiKey;
          delete next.token;
        }
        return next;
      });
    },
    getModelLibraryEntries() : any {
      return [...new Set<any>(agents.map((agent?: any) : any => String(agent.provider || "").trim()).filter(Boolean))];
    }
  };
}

const tempRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-agent-management-"));
const previousCredentialMasterKey: any = process.env.MESHRIX_MODEL_CREDENTIAL_MASTER_KEY;
process.env.MESHRIX_MODEL_CREDENTIAL_MASTER_KEY = crypto.randomBytes(32).toString("hex");

try {
  const sourceIds: any = EXPECTED_OPERATION_IDS.filter((id?: any) : any => operationById(SERVER_API_OPERATIONS, id));
  const generatedIds: any = EXPECTED_OPERATION_IDS.filter((id?: any) : any => operationById(GENERATED_SERVER_API_OPERATIONS, id));
  assert.deepEqual(sourceIds, EXPECTED_OPERATION_IDS);
  assert.deepEqual(generatedIds, EXPECTED_OPERATION_IDS);
  for (const operationId of EXPECTED_OPERATION_IDS) {
    assert.ok(KERNEL_API_OPERATION_IDS.includes(operationId), `${operationId} must have generated capability`);
    const sourceOperation: any = operationById(SERVER_API_OPERATIONS, operationId);
    const generatedOperation: any = operationById(GENERATED_SERVER_API_OPERATIONS, operationId);
    assert.equal(operationFeatureId(sourceOperation), "agent-management");
    assert.equal(generatedOperation.http.path, sourceOperation.http.path);
    assert.deepEqual(generatedOperation.requiredScopes, sourceOperation.requiredScopes);
    if (operationId === "agents.list") {
      assert.equal(sourceOperation.readOnly, true);
      assert.equal(sourceOperation.safety.risk, "read_only");
      assert.deepEqual(sourceOperation.requiredScopes, ["console:read"]);
    } else {
      assert.equal(sourceOperation.readOnly, false);
      assert.equal(sourceOperation.safety.risk, "repair_write");
      assert.deepEqual(sourceOperation.requiredScopes, ["runtime:admin"]);
      assert.equal(sourceOperation.concurrency?.key, "agent_management.model_library");
    }
  }

  const standardRuntime: any = resolveFeatureRuntime({ edition: "standard" });
  const standardOperationIds: any = new Set<any>(
    filterOperationsForFeatures(SERVER_API_OPERATIONS, standardRuntime).map((operation?: any) : any => operation.id)
  );
  for (const operationId of EXPECTED_OPERATION_IDS) {
    assert.equal(standardOperationIds.has(operationId), false, `${operationId} must remain default-disabled`);
  }

  const enabledRuntime: any = resolveFeatureRuntime({
    edition: "standard",
    enableFeatures: ["agent-management"]
  });
  const enabledOperationIds: any = new Set<any>(
    filterOperationsForFeatures(SERVER_API_OPERATIONS, enabledRuntime).map((operation?: any) : any => operation.id)
  );
  for (const operationId of EXPECTED_OPERATION_IDS) {
    assert.ok(enabledOperationIds.has(operationId), `${operationId} must be active when agent-management is enabled`);
  }

  const catalog: any = createToolCatalog({ operations: SERVER_API_OPERATIONS });
  const toolsByOperation: any = new Map<any, any>(catalog.tools.map((tool?: any) : any => [tool.operationId, tool]));
  assert.equal(toolsByOperation.get("agents.list")?.id, "meshrix.agentManagement.agents.list");
  assert.deepEqual(toolsByOperation.get("agents.list")?.requiredScopes, ["console:read"]);
  assert.equal(toolsByOperation.get("agents.list")?.readOnly, true);
  for (const operationId of ["agents.create", "agents.update", "agents.delete"]) {
    const tool: any = toolsByOperation.get(operationId);
    assert.ok(tool, `${operationId} must be exposed in Operation Permission catalog`);
    assert.equal(tool.risk, "repair_write");
    assert.equal(tool.readOnly, false);
    assert.deepEqual(tool.requiredScopes, ["runtime:admin"]);
    assert.ok(tool.toolsets.includes("meshrix.runtime.maintain"));
  }

  const registry: any = createMemoryAgentConfigRegistry();
  const context: Record<string, any> = {
    userDataPath: tempRoot,
    settingsPort: SETTINGS_PORT,
    protocolEventBus: {
      publish() : any {}
    },
    authSession: {
      user: {
        userId: "agent-management-verifier",
        username: "agent-management-verifier"
      }
    },
    agentRuntimeProvider: {
      getAgentConfigRegistry: () : any => registry,
      publicAgentGatewayRegistry
    }
  };

  const created: any = await executeSettingsAgentGatewayOperation({
    operationId: "agents.create",
    input: {
      provider: "local-model",
      name: "Verifier Local Model",
      model: "verify-model",
      baseUrl: "http://127.0.0.1:9/v1/chat/completions",
      token: "redacted-test-token"
    },
    context
  });
  assert.equal(created.status, 200);
  assert.equal(created.payload.ok, true);
  assert.equal(created.payload.action, "created");
  const agentId: any = created.payload.agentId;
  assert.ok(agentId);

  const listed: any = await executeSettingsAgentGatewayOperation({
    operationId: "agents.list",
    context
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.payload.agents.length, 1);
  assert.equal(listed.payload.agents[0].alias, agentId);

  const updated: any = await executeSettingsAgentGatewayOperation({
    operationId: "agents.update",
    input: {
      agentId,
      name: "Verifier Local Model Updated",
      model: "verify-model-updated"
    },
    context
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.payload.action, "updated");
  assert.equal(updated.payload.agentId, agentId);

  const deleted: any = await executeSettingsAgentGatewayOperation({
    operationId: "agents.delete",
    input: { agentId },
    context
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.payload.action, "deleted");

  const listedAfterDelete: any = await executeSettingsAgentGatewayOperation({
    operationId: "agents.list",
    context
  });
  assert.equal(listedAfterDelete.status, 200);
  assert.equal(listedAfterDelete.payload.agents.length, 0);

  console.log("[agent-management] ok");
} finally {
  if (previousCredentialMasterKey === undefined) {
    delete process.env.MESHRIX_MODEL_CREDENTIAL_MASTER_KEY;
  } else {
    process.env.MESHRIX_MODEL_CREDENTIAL_MASTER_KEY = previousCredentialMasterKey;
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
}
