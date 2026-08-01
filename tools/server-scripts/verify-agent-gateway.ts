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
import { callAgentGateway } from "../../packages/agents/src/agent-gateway/index.ts";
import {
  inspectModelRouting,
  runModelRouting
} from "../../packages/agents/src/agent-gateway/model-routing/index.ts";
import { executeSettingsAgentGatewayOperation } from "../../packages/server-runtime/src/composition/console-domain/operation-executors/settings-agent-gateway-executor.ts";

const OPERATION_ID: any = "agent_gateway.call";
const SETTINGS_PORT: Readonly<Record<string, any>> = Object.freeze({
  getSettingsPath,
  loadSettings,
  normalizeSettings,
  saveSettings
});

function operationById(operations?: any, id?: any) : any {
  return operations.find((operation?: any) : any => operation.id === id) || null;
}

function createNoopRegistry() : any {
  return {
    async refresh() : Promise<any> {},
    async replaceFromModelLibraryAgents() : Promise<any> {},
    getModelLibraryAgents() : any {
      return [];
    },
    getModelLibraryEntries() : any {
      return [];
    }
  };
}

async function delay(ms: any = 0) : Promise<any> {
  await new Promise((resolve?: any) : any => setTimeout(resolve, ms));
}

const tempRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-agent-gateway-"));

try {
  const sourceOperation: any = operationById(SERVER_API_OPERATIONS, OPERATION_ID);
  const generatedOperation: any = operationById(GENERATED_SERVER_API_OPERATIONS, OPERATION_ID);
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

  const standardRuntime: any = resolveFeatureRuntime({ edition: "standard" });
  const standardOperationIds: any = new Set<any>(
    filterOperationsForFeatures(SERVER_API_OPERATIONS, standardRuntime).map((operation?: any) : any => operation.id)
  );
  assert.ok(standardOperationIds.has(OPERATION_ID), "standard edition must include agent_gateway.call");

  const coreRuntime: any = resolveFeatureRuntime({ edition: "core" });
  const coreOperationIds: any = new Set<any>(
    filterOperationsForFeatures(SERVER_API_OPERATIONS, coreRuntime).map((operation?: any) : any => operation.id)
  );
  assert.ok(coreOperationIds.has(OPERATION_ID), "core edition must include agent_gateway.call");

  const catalog: any = createToolCatalog({ operations: SERVER_API_OPERATIONS });
  const tool: any = catalog.tools.find((item?: any) : any => item.operationId === OPERATION_ID);
  assert.ok(tool, `${OPERATION_ID} must be exposed in Operation Permission catalog`);
  assert.equal(tool.id, "meshrix.agentGateway.call");
  assert.deepEqual(tool.requiredScopes, ["model:call"]);
  assert.equal(tool.risk, "safe_write");
  assert.equal(tool.readOnly, false);
  assert.ok(tool.toolsets.includes("meshrix.model.call"));

  const executorResult: any = await executeSettingsAgentGatewayOperation({
    operationId: OPERATION_ID,
    input: { question: "hello from verifier" },
    context: {
      userDataPath: tempRoot,
      settingsPort: SETTINGS_PORT,
      agentRuntimeProvider: {
        getAgentConfigRegistry: createNoopRegistry,
        async callAgentGateway({ input = {} }: Record<string, any> = {}) : Promise<any> {
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
    () : any => callAgentGateway({
      settings: {},
      input: { question: "hello from verifier" },
      userDataPath: tempRoot
    }),
    (error?: any) : any => (
      error?.code === "agent_gateway_not_configured" &&
      error?.statusCode === 409 &&
      error?.retryable === false
    )
  );

  const concurrentRoutingSettings: Record<string, any> = {
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
  const executeConcurrentCandidate: any = async ({ dryRun }: Record<string, any>) : Promise<any> => {
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
  const firstRouting: any = runModelRouting({
    settings: concurrentRoutingSettings,
    input: { question: "first" },
    userDataPath: tempRoot,
    registry: [{ alias: "primary" }],
    executeCandidate: executeConcurrentCandidate
  });
  await delay(20);
  const secondRouting: any = runModelRouting({
    settings: concurrentRoutingSettings,
    input: { question: "second" },
    userDataPath: tempRoot,
    registry: [{ alias: "primary" }],
    executeCandidate: executeConcurrentCandidate
  });
  const concurrentResults: any = await Promise.allSettled([firstRouting, secondRouting]);
  const fulfilledRouting: any = concurrentResults.filter((result?: any) : any => result.status === "fulfilled");
  const rejectedRouting: any = concurrentResults.filter((result?: any) : any => result.status === "rejected");
  assert.equal(fulfilledRouting.length, 1);
  assert.equal(rejectedRouting.length, 1);
  assert.equal(fulfilledRouting[0].value.routing.traffic.algorithm, "sliding_window_success_count_with_concurrency");
  assert.equal(fulfilledRouting[0].value.routing.traffic.maxConcurrent, 1);
  assert.equal(rejectedRouting[0].reason.code, "model_routing_concurrency_limit_exceeded");
  assert.equal(rejectedRouting[0].reason.modelRoutingTraffic.deniedReason, "concurrency_limit_exceeded");
  const routingInspection: any = await inspectModelRouting({ userDataPath: tempRoot, limit: 10 });
  assert.deepEqual(routingInspection.state.inFlight, {});
  assert.equal(routingInspection.ledgerSummary.byStatus.success, 1);

  console.log("[agent-gateway] ok");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
