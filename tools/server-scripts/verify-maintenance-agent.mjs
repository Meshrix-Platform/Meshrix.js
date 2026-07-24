#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMaintenanceAgentService } from "../../packages/agents/src/maintenance/service.mjs";
import { createMaintenanceScheduler } from "../../packages/agents/src/maintenance/scheduler.mjs";
import { createMaintenanceWorkQueueProvider } from "../../packages/server-runtime/src/composition/maintenance-work-queue-provider.mjs";
import { createQueueApplicationPort } from "../../packages/server-runtime/src/composition/queue-application-port.mjs";
import { MemoryLockManager } from "../../packages/foundation/src/concurrency/lock-manager.mjs";
import {
  bindOperationDispatcher,
  loadSettings,
  saveSettings
} from "../../packages/server-runtime/src/composition/product-api.mjs";
import { executeMaintenanceAgentOperation } from "../../packages/server-runtime/src/composition/console-domain/operation-executors/runtime-admin-executors.mjs";
import { assertMaintenanceAgentContracts } from "./lib/maintenance-agent-verifier-contract-cases.mjs";
import {
  createMaintenancePlannerGateway,
  createMaintenanceStubControllers,
  maintenanceVerifierLogger
} from "./lib/maintenance-agent-verifier-harness.mjs";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-maintenance-agent-"));
const lockManager = new MemoryLockManager();
const previousModelCredentialMasterKey = process.env.MESHRIX_MODEL_CREDENTIAL_MASTER_KEY;
process.env.MESHRIX_MODEL_CREDENTIAL_MASTER_KEY ||= crypto
  .createHash("sha256")
  .update(tempRoot)
  .digest("hex");

try {
  assertMaintenanceAgentContracts();
  const operationPermissionEvents = [];
  const controllerEvents = [];
  const compactionCalls = [];
  const contextRuntime = {
    async runCompaction(input = {}) {
      compactionCalls.push(input);
      return {
        compacted: true,
        boundary: { boundaryId: "verify-maintenance-compaction" },
        summary: "Verify maintenance planner compaction summary.",
        strategy: "verify-maintenance",
        reinjection: {
          items: [
            { key: "maintenance-context", value: { status: "ok" } }
          ]
        },
        tokenReport: {
          originalTokens: 42,
          compactedTokens: 12,
          savingsRatio: 0.71
        }
      };
    }
  };
  const operationDispatcher = bindOperationDispatcher({
    lockManager,
    concurrencyScope: "maintenance-agent-verifier"
  });
  assert.throws(
    () => createMaintenanceAgentService({
      userDataPath: tempRoot,
      operationDispatcher
    }),
    /requires a durable operationPermissionStore/u
  );
  let maintenanceAgent = null;
  const queueApplicationPort = await createQueueApplicationPort({
    userDataPath: tempRoot,
    logger: maintenanceVerifierLogger
  });
  const maintenanceWorkQueue = await createMaintenanceWorkQueueProvider({
    queueApplicationPort,
    getMaintenanceAgent: () => maintenanceAgent,
    capabilitySelected: true
  });
  queueApplicationPort.start();
  maintenanceAgent = createMaintenanceAgentService({
    userDataPath: tempRoot,
    getControllers: () => createMaintenanceStubControllers(controllerEvents),
    schedulerEnabled: false,
    contextRuntime,
    loadRuntimeSettings: loadSettings,
    logger: maintenanceVerifierLogger,
    protocolEventBus: {
      publish(topic, payload, metadata) {
        operationPermissionEvents.push({ topic, payload, metadata });
      }
    },
    operationPermissionStore: {
      appendExecution(entry) {
        operationPermissionEvents.push({ kind: "execution", entry });
      },
      appendMetric(entry) {
        operationPermissionEvents.push({ kind: "metric", entry });
      },
      close() {}
    },
    workQueuePort: maintenanceWorkQueue,
    operationDispatcher
  });

  const context = {
    maintenanceAgent,
    authSession: {
      user: {
        userId: "maintenance-agent-verifier",
        username: "maintenance-agent-verifier",
        roleId: "admin"
      }
    }
  };

  const initialConfig = await executeMaintenanceAgentOperation({
    operationId: "maintenance_agent.config.get",
    context
  });
  assert.equal(initialConfig.status, 200);
  assert.equal(initialConfig.payload.config.enabled, false);

  const savedConfig = await executeMaintenanceAgentOperation({
    operationId: "maintenance_agent.config.set",
    input: {
      enabled: false,
      plannerMode: "fixed_runbook",
      autoApproveRisk: "safe_write"
    },
    context
  });
  assert.equal(savedConfig.status, 200);
  assert.equal(savedConfig.payload.config.plannerMode, "fixed_runbook");

  const implicitRunbookChat = await executeMaintenanceAgentOperation({
    operationId: "maintenance_agent.chat",
    input: { message: "run a health check", wait: true },
    context
  });
  assert.equal(implicitRunbookChat.status, 400);

  const unknownRunbook = await executeMaintenanceAgentOperation({
    operationId: "maintenance_agent.runs.create",
    input: { runbook: "not-a-runbook", wait: true },
    context
  });
  assert.equal(unknownRunbook.status, 400);

  const compactedRunbookChat = await executeMaintenanceAgentOperation({
    operationId: "maintenance_agent.chat",
    input: {
      message: "run a health check after previous maintenance notes",
      runbook: "health_smoke",
      history: "operator asked for a safe health-only check",
      contextCompaction: { force: true, persist: false },
      wait: true
    },
    context
  });
  assert.equal(compactedRunbookChat.status, 200);
  assert.equal(compactedRunbookChat.payload.run.status, "completed");
  assert.equal(compactedRunbookChat.payload.plan.intent, "health_smoke");
  assert.ok(compactionCalls.some((call) => call.inputSource === "maintenance-agent-planner"));

  const isolatedSchedulerRoot = path.join(tempRoot, "scheduler-failure");
  await fs.mkdir(isolatedSchedulerRoot, { recursive: true });
  const staleNextRunAt = new Date(Date.now() - 60_000).toISOString();
  const schedulerEvents = [];
  const schedulerLogs = [];
  let isolatedSchedulerConfig = {
    schemaVersion: "v0.0.1:platform:maintenance-agent-schema-1",
    enabled: true,
    scheduler: { tickSeconds: 1 },
    schedules: [
      {
        id: "gateway-planner-failure",
        label: "Gateway planner failure isolation",
        enabled: true,
        runbook: "health_smoke",
        intervalMinutes: 60,
        nextRunAt: staleNextRunAt
      }
    ]
  };
  const isolatedScheduler = createMaintenanceScheduler({
    userDataPath: isolatedSchedulerRoot,
    schedulerEnabled: false,
    getConfig: () => isolatedSchedulerConfig,
    setConfig: (nextConfig) => {
      isolatedSchedulerConfig = nextConfig;
    },
    ensureStarted: async () => {},
    createScheduledRun: async () => {
      throw new Error("gateway planner unavailable");
    },
    publish: async (topic, payload, metadata) => {
      schedulerEvents.push({ topic, payload, metadata });
    },
    logMaintenance: (level, event, details) => {
      schedulerLogs.push({ level, event, details });
    },
    state: { closed: false }
  });
  await isolatedScheduler.tickScheduler();
  assert.equal(isolatedSchedulerConfig.schedules[0]?.nextRunAt, staleNextRunAt);
  assert.ok(schedulerEvents.some((event) =>
    event.topic === "maintenance.agent.scheduler" &&
    event.metadata === "maintenance.agent.scheduler.run_failed"
  ));
  assert.ok(schedulerLogs.some((entry) =>
    entry.level === "error" &&
    entry.event === "maintenance.agent.scheduler.run_failed"
  ));

  const resetFixedRunbookConfig = await executeMaintenanceAgentOperation({
    operationId: "maintenance_agent.config.set",
    input: {
      enabled: true,
      plannerMode: "fixed_runbook",
      autoApproveRisk: "safe_write"
    },
    context
  });
  assert.equal(resetFixedRunbookConfig.status, 200);
  assert.equal(resetFixedRunbookConfig.payload.config.plannerMode, "fixed_runbook");

  const created = await executeMaintenanceAgentOperation({
    operationId: "maintenance_agent.runs.create",
    input: { runbook: "health_smoke", wait: true },
    context
  });
  assert.equal(created.status, 200);
  assert.equal(created.payload.status, "completed");
  assert.equal(created.payload.intent, "health_smoke");
  assert.equal(created.payload.risk, "read_only");
  assert.equal(created.payload.steps.length, 4);
  const runId = created.payload.runId;
  assert.ok(runId);

  const listed = await executeMaintenanceAgentOperation({
    operationId: "maintenance_agent.runs.list",
    input: { limit: 5 },
    context
  });
  assert.equal(listed.status, 200);
  assert.ok(listed.payload.items.some((run) => run.runId === runId));

  const fetched = await executeMaintenanceAgentOperation({
    operationId: "maintenance_agent.runs.get",
    input: { runId },
    context
  });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.payload.run.runId, runId);

  const chat = await executeMaintenanceAgentOperation({
    operationId: "maintenance_agent.chat",
    input: { message: "run a health check", runbook: "health_smoke", wait: true },
    context
  });
  assert.equal(chat.status, 200);
  assert.equal(chat.payload.run.status, "completed");
  assert.equal(chat.payload.plan.intent, "health_smoke");

  const cancelCompleted = await executeMaintenanceAgentOperation({
    operationId: "maintenance_agent.runs.cancel",
    input: { runId, reason: "verify idempotent cancel" },
    context
  });
  assert.equal(cancelCompleted.status, 200);
  assert.equal(cancelCompleted.payload.run.runId, runId);
  assert.equal(cancelCompleted.payload.run.status, "completed");

  const missingApproval = await executeMaintenanceAgentOperation({
    operationId: "maintenance_agent.runs.approve",
    input: { runId: "maintenance_run_missing", planHash: "missing" },
    context
  });
  assert.equal(missingApproval.status, 404);

  const repairWritePlan = {
    intent: "storage_reconcile_fixture",
    summary: "验证 repair_write 维护计划审批成功路径。",
    risk: "repair_write",
    requiresApproval: true,
    approvalReason: "storage.reconcile requires explicit approval.",
    steps: [
      {
        toolId: "storage.reconcile",
        input: {
          apply: true,
          pruneOrphanObjects: false
        },
        risk: "repair_write",
        reason: "验证审批后维护代理会注入安全确认并执行修复写入工具。"
      }
    ]
  };
  const plannerGateway = await createMaintenancePlannerGateway(repairWritePlan);
  try {
    await saveSettings(tempRoot, {
      modelLibraryRevision: 0,
      modelLibraryAgents: [
        {
          uid: "maintenance-planner-stub",
          provider: "local-model",
          model: "maintenance-model-stub",
          baseUrl: plannerGateway.baseUrl,
          moduleAccess: {
            mode: "selected",
            moduleIds: ["maintenance-agent-runbooks"]
          },
          timeoutMs: 5000
        }
      ],
      moduleAgentProfiles: {
        "maintenance-agent-runbooks": {
          primaryAgent: "maintenance-planner-stub",
          agents: {
            "maintenance-planner-stub": {
              enabled: true,
              role: "primary",
              contextProfileId: "maintenance-agent-profile",
              systemPrompt: "Maintenance module profile sentinel.",
              parameters: {
                temperature: 0.17,
                max_tokens: 2048
              },
              dependencyContext: {
                verifier: "maintenance-module-profile"
              }
            }
          }
        }
      }
    });
    const gatewayPlannerConfig = await executeMaintenanceAgentOperation({
      operationId: "maintenance_agent.config.set",
      input: {
        enabled: false,
        plannerMode: "gateway",
        autoApproveRisk: "safe_write"
      },
      context
    });
    assert.equal(gatewayPlannerConfig.status, 200);
    assert.equal(gatewayPlannerConfig.payload.config.plannerMode, "gateway");

    const repairChat = await executeMaintenanceAgentOperation({
      operationId: "maintenance_agent.chat",
      input: {
        message: "repair storage consistency",
        modelAlias: "maintenance-planner-stub",
        history: "operator reviewed storage drift and asked for repair planning",
        contextCompaction: { force: true, persist: false },
        wait: true
      },
      context
    });
    assert.equal(repairChat.status, 200, JSON.stringify(repairChat.payload));
    assert.equal(repairChat.payload.run.status, "awaiting_approval");
    assert.equal(repairChat.payload.run.risk, "repair_write");
    assert.equal(repairChat.payload.run.requiresApproval, true);
    assert.equal(repairChat.payload.plan.intent, "storage_reconcile_fixture");
    assert.ok(plannerGateway.requests.length >= 1);
    const plannerRequestText = JSON.stringify(plannerGateway.requests);
    assert.match(plannerRequestText, /inputSchema/u);
    assert.match(plannerRequestText, /Verify maintenance planner compaction summary/u);
    assert.match(plannerRequestText, /Maintenance module profile sentinel/u);
    assert.match(plannerRequestText, /maintenance-agent-runbooks/u);
    assert.match(plannerRequestText, /maintenance-agent-profile/u);
    assert.match(plannerRequestText, /maintenance-module-profile/u);
    assert.equal(plannerGateway.requests[0]?.body?.temperature, 0.17);
    assert.equal(plannerGateway.requests[0]?.body?.max_tokens, 2048);

    const staleApproval = await executeMaintenanceAgentOperation({
      operationId: "maintenance_agent.runs.approve",
      input: {
        runId: repairChat.payload.run.runId,
        planHash: "stale-plan-hash",
        wait: true
      },
      context
    });
    assert.equal(staleApproval.status, 409);

    const approvedRepair = await executeMaintenanceAgentOperation({
      operationId: "maintenance_agent.runs.approve",
      input: {
        runId: repairChat.payload.run.runId,
        planHash: repairChat.payload.run.planHash,
        wait: true
      },
      context
    });
    assert.equal(approvedRepair.status, 200);
    assert.equal(approvedRepair.payload.run.status, "completed");
    assert.equal(approvedRepair.payload.run.requiresApproval, false);
    assert.ok(controllerEvents.some((event) =>
      event.type === "storage.reconcile" &&
      event.input.apply === true &&
      event.input.confirm === true &&
      event.input.safetyConfirm === true &&
      event.headers["x-meshrix-safety-confirm"] === "true"
    ));
  } finally {
    await plannerGateway.close();
  }

  assert.ok(operationPermissionEvents.some((event) => event.kind === "execution"));
  assert.ok(operationPermissionEvents.some((event) => event.kind === "metric"));
  assert.ok(operationPermissionEvents.some((event) =>
    event.kind === "execution" &&
    event.entry.operationId === "storage.reconcile" &&
    event.entry.risk === "repair_write" &&
    event.entry.status === "ok"
  ));

  await maintenanceAgent.close();
  await maintenanceWorkQueue.close();
  await queueApplicationPort.close();
  console.log("[maintenance-agent] ok");
} finally {
  if (previousModelCredentialMasterKey === undefined) {
    delete process.env.MESHRIX_MODEL_CREDENTIAL_MASTER_KEY;
  } else {
    process.env.MESHRIX_MODEL_CREDENTIAL_MASTER_KEY = previousModelCredentialMasterKey;
  }
  lockManager.destroy();
  await fs.rm(tempRoot, { recursive: true, force: true });
}
