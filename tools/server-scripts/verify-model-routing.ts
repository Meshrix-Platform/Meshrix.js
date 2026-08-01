#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.ts";
import { SERVER_API_OPERATIONS as GENERATED_SERVER_API_OPERATIONS } from "../../packages/contracts/src/generated/operations.generated.ts";
import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.ts";
import { KERNEL_API_OPERATION_IDS } from "../../packages/foundation/src/security/authorization/generated-capabilities.ts";
import {
  MODEL_ROUTING_PROTOCOL_VERSION,
  inspectModelRouting,
  runModelRouting
} from "../../packages/agents/src/agent-gateway/model-routing/index.ts";
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

const OPERATION_ID: any = "model_routing.health";
const SETTINGS_PORT: Readonly<Record<string, any>> = Object.freeze({
  getSettingsPath,
  loadSettings,
  normalizeSettings,
  saveSettings
});

function operationById(operations?: any, id?: any) : any {
  return operations.find((operation?: any) : any => operation.id === id) || null;
}

const tempRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-model-routing-"));

try {
  const sourceOperation: any = operationById(SERVER_API_OPERATIONS, OPERATION_ID);
  const generatedOperation: any = operationById(GENERATED_SERVER_API_OPERATIONS, OPERATION_ID);
  assert.ok(sourceOperation, `${OPERATION_ID} must exist in source operations`);
  assert.ok(generatedOperation, `${OPERATION_ID} must exist in generated operations`);
  assert.equal(sourceOperation.http.method, "GET");
  assert.equal(sourceOperation.http.path, "/api/model-routing/health");
  assert.deepEqual(sourceOperation.requiredScopes, ["console:read"]);
  assert.equal(sourceOperation.readOnly, true);
  assert.equal(sourceOperation.safety.risk, "read_only");
  assert.equal(generatedOperation.http.path, sourceOperation.http.path);
  assert.deepEqual(generatedOperation.requiredScopes, sourceOperation.requiredScopes);
  assert.equal(generatedOperation.risk, sourceOperation.safety.risk);
  assert.ok(KERNEL_API_OPERATION_IDS.includes(OPERATION_ID));
  assert.equal(operationFeatureId(sourceOperation), "agent-gateway");

  const standardRuntime: any = resolveFeatureRuntime({ edition: "standard" });
  const standardOperationIds: any = new Set<any>(
    filterOperationsForFeatures(SERVER_API_OPERATIONS, standardRuntime).map((operation?: any) : any => operation.id)
  );
  assert.ok(standardOperationIds.has(OPERATION_ID), "standard edition must include model_routing.health");

  const catalog: any = createToolCatalog({ operations: SERVER_API_OPERATIONS });
  const tool: any = catalog.tools.find((item?: any) : any => item.operationId === OPERATION_ID);
  assert.ok(tool, `${OPERATION_ID} must be exposed in Operation Permission catalog`);
  assert.equal(tool.id, "meshrix.agentGateway.modelRouting.health");
  assert.deepEqual(tool.requiredScopes, ["console:read"]);
  assert.equal(tool.risk, "read_only");
  assert.equal(tool.readOnly, true);
  assert.ok(tool.toolsets.includes("meshrix.console.read"));

  const routed: any = await runModelRouting({
    settings: {},
    input: {
      question: "route me",
      modelRouting: {
        enabled: true,
        routeId: "verify-model-routing",
        candidateChain: ["verify-model"],
        priceTable: {
          "verify-model": {
            inputUsdPer1MTokens: 1,
            outputUsdPer1MTokens: 1
          }
        }
      },
      parameters: {
        max_tokens: 8
      }
    },
    userDataPath: tempRoot,
    registry: [{ alias: "verify-model" }],
    executeCandidate: async ({ alias, input = {}, dryRun = false }: Record<string, any> = {}) : Promise<any> => ({
      config: {
        alias,
        provider: "local-model",
        model: alias
      },
      input,
      result: dryRun
        ? null
        : {
            ok: true,
            answer: "routed",
            upstream: {
              provider: "local-model",
              model: alias
            },
            usage: {
              prompt_tokens: 4,
              completion_tokens: 2
            }
          }
    })
  });
  assert.equal(routed.result.ok, true);
  assert.equal(routed.routing.protocolVersion, MODEL_ROUTING_PROTOCOL_VERSION);
  assert.equal(routed.routing.selectedAlias, "verify-model");

  const health: any = await inspectModelRouting({ userDataPath: tempRoot, limit: 5 });
  assert.equal(health.protocolVersion, MODEL_ROUTING_PROTOCOL_VERSION);
  assert.equal(health.ledgerSummary.total, 1);
  assert.equal(health.ledgerSummary.byStatus.success, 1);

  const executorResult: any = await executeSettingsAgentGatewayOperation({
    operationId: OPERATION_ID,
    input: { limit: 5 },
    context: {
      userDataPath: tempRoot,
      settingsPort: SETTINGS_PORT,
      agentRuntimeProvider: {
        async inspectAgentModelRouting(options: Record<string, any> = {}) : Promise<any> {
          return inspectModelRouting(options);
        }
      }
    }
  });
  assert.equal(executorResult.status, 200);
  assert.equal(executorResult.payload.ledgerSummary.total, 1);

  console.log("[model-routing] ok");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
