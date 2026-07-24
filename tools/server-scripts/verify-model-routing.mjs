#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.mjs";
import { SERVER_API_OPERATIONS as GENERATED_SERVER_API_OPERATIONS } from "../../packages/contracts/src/generated/operations.generated.mjs";
import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.mjs";
import { KERNEL_API_OPERATION_IDS } from "../../packages/foundation/src/security/authorization/generated-capabilities.mjs";
import {
  MODEL_ROUTING_PROTOCOL_VERSION,
  inspectModelRouting,
  runModelRouting
} from "../../packages/agents/src/agent-gateway/model-routing/index.mjs";
import {
  filterOperationsForFeatures,
  operationFeatureId,
  resolveFeatureRuntime
} from "../../packages/server-runtime/src/composition/features/feature-manifest.mjs";
import {
  getSettingsPath,
  loadSettings,
  normalizeSettings,
  saveSettings
} from "../../packages/server-runtime/src/composition/settings.mjs";
import { executeSettingsAgentGatewayOperation } from "../../packages/server-runtime/src/composition/console-domain/operation-executors/settings-agent-gateway-executor.mjs";

const OPERATION_ID = "model_routing.health";
const SETTINGS_PORT = Object.freeze({
  getSettingsPath,
  loadSettings,
  normalizeSettings,
  saveSettings
});

function operationById(operations, id) {
  return operations.find((operation) => operation.id === id) || null;
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-model-routing-"));

try {
  const sourceOperation = operationById(SERVER_API_OPERATIONS, OPERATION_ID);
  const generatedOperation = operationById(GENERATED_SERVER_API_OPERATIONS, OPERATION_ID);
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

  const standardRuntime = resolveFeatureRuntime({ edition: "standard" });
  const standardOperationIds = new Set(
    filterOperationsForFeatures(SERVER_API_OPERATIONS, standardRuntime).map((operation) => operation.id)
  );
  assert.ok(standardOperationIds.has(OPERATION_ID), "standard edition must include model_routing.health");

  const catalog = createToolCatalog({ operations: SERVER_API_OPERATIONS });
  const tool = catalog.tools.find((item) => item.operationId === OPERATION_ID);
  assert.ok(tool, `${OPERATION_ID} must be exposed in Operation Permission catalog`);
  assert.equal(tool.id, "meshrix.agentGateway.modelRouting.health");
  assert.deepEqual(tool.requiredScopes, ["console:read"]);
  assert.equal(tool.risk, "read_only");
  assert.equal(tool.readOnly, true);
  assert.ok(tool.toolsets.includes("meshrix.console.read"));

  const routed = await runModelRouting({
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
    executeCandidate: async ({ alias, input = {}, dryRun = false } = {}) => ({
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

  const health = await inspectModelRouting({ userDataPath: tempRoot, limit: 5 });
  assert.equal(health.protocolVersion, MODEL_ROUTING_PROTOCOL_VERSION);
  assert.equal(health.ledgerSummary.total, 1);
  assert.equal(health.ledgerSummary.byStatus.success, 1);

  const executorResult = await executeSettingsAgentGatewayOperation({
    operationId: OPERATION_ID,
    input: { limit: 5 },
    context: {
      userDataPath: tempRoot,
      settingsPort: SETTINGS_PORT,
      agentRuntimeProvider: {
        async inspectAgentModelRouting(options = {}) {
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
