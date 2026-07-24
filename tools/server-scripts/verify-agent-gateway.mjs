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
import { callAgentGateway } from "../../packages/agents/src/agent-gateway/index.mjs";
import {
  inspectModelRouting,
  runModelRouting
} from "../../packages/agents/src/agent-gateway/model-routing/index.mjs";
import { executeSettingsAgentGatewayOperation } from "../../packages/server-runtime/src/composition/console-domain/operation-executors/settings-agent-gateway-executor.mjs";

const OPERATION_ID = "agent_gateway.call";
const SETTINGS_PORT = Object.freeze({
  getSettingsPath,
  loadSettings,
  normalizeSettings,
  saveSettings
});

function operationById(operations, id) {
  return operations.find((operation) => operation.id === id) || null;
}

function createNoopRegistry() {
  return {
    async refresh() {},
    async replaceFromModelLibraryAgents() {},
    getModelLibraryAgents() {
      return [];
    },
    getModelLibraryEntries() {
      return [];
    }
  };
}

async function delay(ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-agent-gateway-"));

try {
  const sourceOperation = operationById(SERVER_API_OPERATIONS, OPERATION_ID);
  const generatedOperation = operationById(GENERATED_SERVER_API_OPERATIONS, OPERATION_ID);
  assert.ok(sourceOperation, `${OPERATION_ID} must exist in source operations`);
  assert.ok(generatedOperation, `${OPERATION_ID} must exist in generated operations`);
  assert.equal(sourceOperation.http.method, "POST");
  assert.equal(sourceOperation.http.path, "/api/agent-gateway/call");
  assert.deepEqual(sourceOperation.requiredScopes, ["model:call"]);
  assert.equal(sourceOperation.readOnly, false);
  assert.equal(sourceOperation.safety.risk, "safe_write");
  assert.equal(sourceOperation.audit.recordInput, false);
  assert.equal(sourceOperation.audit.metadataOnly, true);
  assert.equal(sourceOperation.log.recordInput, false);
  assert.equal(generatedOperation.http.path, sourceOperation.http.path);
  assert.deepEqual(generatedOperation.requiredScopes, sourceOperation.requiredScopes);
  assert.equal(generatedOperation.risk, sourceOperation.safety.risk);
  assert.ok(KERNEL_API_OPERATION_IDS.includes(OPERATION_ID));
  assert.equal(operationFeatureId(sourceOperation), "agent-gateway");

  const standardRuntime = resolveFeatureRuntime({ edition: "standard" });
  const standardOperationIds = new Set(
    filterOperationsForFeatures(SERVER_API_OPERATIONS, standardRuntime).map((operation) => operation.id)
  );
  assert.ok(standardOperationIds.has(OPERATION_ID), "standard edition must include agent_gateway.call");

  const coreRuntime = resolveFeatureRuntime({ edition: "core" });
  const coreOperationIds = new Set(
    filterOperationsForFeatures(SERVER_API_OPERATIONS, coreRuntime).map((operation) => operation.id)
  );
  assert.ok(coreOperationIds.has(OPERATION_ID), "core edition must include agent_gateway.call");

  const catalog = createToolCatalog({ operations: SERVER_API_OPERATIONS });
  const tool = catalog.tools.find((item) => item.operationId === OPERATION_ID);
  assert.ok(tool, `${OPERATION_ID} must be exposed in Operation Permission catalog`);
  assert.equal(tool.id, "meshrix.agentGateway.call");
  assert.deepEqual(tool.requiredScopes, ["model:call"]);
  assert.equal(tool.risk, "safe_write");
  assert.equal(tool.readOnly, false);
  assert.ok(tool.toolsets.includes("meshrix.model.call"));

  const executorResult = await executeSettingsAgentGatewayOperation({
    operationId: OPERATION_ID,
    input: { question: "hello from verifier" },
    context: {
      userDataPath: tempRoot,
      settingsPort: SETTINGS_PORT,
      agentRuntimeProvider: {
        getAgentConfigRegistry: createNoopRegistry,
        async callAgentGateway({ input = {} } = {}) {
          return {
            ok: true,
            answer: `echo:${String(input.question || "")}`
          };
        }
      }
    }
  });
  assert.equal(executorResult.status, 200);
  assert.equal(executorResult.payload.ok, true);
  assert.equal(executorResult.payload.answer, "echo:hello from verifier");

  await assert.rejects(
    () => callAgentGateway({
      settings: {},
      input: { question: "hello from verifier" },
      userDataPath: tempRoot
    }),
    /必须显式选择已配置的智能体或模型别名/u
  );

  const concurrentRoutingSettings = {
    modelRouting: {
      enabled: true,
      routeId: "verify.agent-gateway.concurrent",
      candidateChain: ["primary"],
      rateLimit: {
        maxConcurrent: 1,
        maxInFlightMs: 5_000
      },
      circuitBreaker: false
    }
  };
  const executeConcurrentCandidate = async ({ dryRun }) => {
    if (dryRun) {
      return { config: { provider: "verifier", model: "primary" } };
    }
    await delay(120);
    return {
      config: { provider: "verifier", model: "primary" },
      result: {
        ok: true,
        answer: "model-routing-concurrency-ok",
        upstream: { provider: "verifier", model: "primary" },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }
    };
  };
  const firstRouting = runModelRouting({
    settings: concurrentRoutingSettings,
    input: { question: "first" },
    userDataPath: tempRoot,
    registry: [{ alias: "primary" }],
    executeCandidate: executeConcurrentCandidate
  });
  await delay(20);
  const secondRouting = runModelRouting({
    settings: concurrentRoutingSettings,
    input: { question: "second" },
    userDataPath: tempRoot,
    registry: [{ alias: "primary" }],
    executeCandidate: executeConcurrentCandidate
  });
  const concurrentResults = await Promise.allSettled([firstRouting, secondRouting]);
  const fulfilledRouting = concurrentResults.filter((result) => result.status === "fulfilled");
  const rejectedRouting = concurrentResults.filter((result) => result.status === "rejected");
  assert.equal(fulfilledRouting.length, 1);
  assert.equal(rejectedRouting.length, 1);
  assert.equal(fulfilledRouting[0].value.routing.traffic.algorithm, "sliding_window_success_count_with_concurrency");
  assert.equal(fulfilledRouting[0].value.routing.traffic.maxConcurrent, 1);
  assert.equal(rejectedRouting[0].reason.code, "model_routing_concurrency_limit_exceeded");
  assert.equal(rejectedRouting[0].reason.modelRoutingTraffic.deniedReason, "concurrency_limit_exceeded");
  const routingInspection = await inspectModelRouting({ userDataPath: tempRoot, limit: 10 });
  assert.deepEqual(routingInspection.state.inFlight, {});
  assert.equal(routingInspection.ledgerSummary.byStatus.success, 1);

  console.log("[agent-gateway] ok");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
