import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getBackgroundProcessStatus } from "../../packages/foundation/src/observability/background-process-status.ts";
import { projectQueueObservation } from "../../packages/server-runtime/src/composition/queue-observation-projection.ts";
import {
  runMonitorAlertCycle,
  saveMonitorAlertConfig
} from "../../packages/server-runtime/src/composition/devops/monitor-alerts.ts";
import {
  AlertUnifiedRegistration,
  MonitorUnifiedRegistration,
  ProcessUnifiedRegistration,
  QueueUnifiedRegistration,
  TaskUnifiedRegistration,
  UnifiedRegistration,
  composeUnifiedSystemStatus,
  routeUnifiedRegistration
} from "../../packages/foundation/src/unified-registration-core/unified-registration.ts";

assert.throws(
  () : any => new UnifiedRegistration().getOriginalType(),
  /must be implemented/,
  "UnifiedRegistration must behave like an abstract registration interface"
);

const processRegistration: any = new ProcessUnifiedRegistration({
  role: "server-main",
  label: "Meshrix 服务端",
  status: "running",
  processType: "service",
  pid: process.pid,
  lastHeartbeatAt: new Date().toISOString()
});
const queueRegistration: any = new QueueUnifiedRegistration({
  queueId: "queue_item_verify",
  kind: "verify_queue",
  ownerId: "verify-owner",
  label: "验证队列",
  lifecycleStatus: "open",
  status: "running",
  source: "function-self-check",
  lastHeartbeatAt: new Date().toISOString()
});
const taskRegistration: any = new TaskUnifiedRegistration(
  {
    id: "verify-task",
    status: "queued",
    progressPercent: 0,
    stage: "验证任务",
    createdAt: new Date().toISOString()
  },
  {
    taskType: "verify_task",
    queueId: "queue_item_verify",
    source: "verify"
  }
);
const monitorRegistration: any = new MonitorUnifiedRegistration({
  monitorId: "verify-monitor",
  label: "验证监控",
  status: "healthy",
  summary: { activeCount: 0 }
});
const alertRegistration: any = new AlertUnifiedRegistration({
  alertId: "verify-alert",
  ruleId: "verifyRule",
  title: "验证报警",
  severity: "warning",
  status: "warning",
  active: true,
  firstSeenAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString()
});

assert.equal(processRegistration.getOriginalType(), "process");
assert.equal(queueRegistration.getOriginalType(), "queue");
assert.equal(taskRegistration.getOriginalType(), "task");
assert.equal(monitorRegistration.getOriginalType(), "monitor");
assert.equal(alertRegistration.getOriginalType(), "alert");
assert.equal(routeUnifiedRegistration(processRegistration).section, "processes");
assert.equal(routeUnifiedRegistration(queueRegistration).section, "queues");
assert.equal(routeUnifiedRegistration(taskRegistration).section, "tasks");
assert.equal(routeUnifiedRegistration(monitorRegistration).section, "monitors");
assert.equal(routeUnifiedRegistration(alertRegistration).section, "alerts");

const composed: any = composeUnifiedSystemStatus([
  processRegistration,
  queueRegistration,
  taskRegistration,
  monitorRegistration,
  alertRegistration
]);
assert.equal(composed.summary.processCount, 1);
assert.equal(composed.summary.queueCount, 1);
assert.equal(composed.summary.taskCount, 1);
assert.equal(composed.summary.monitorCount, 1);
assert.equal(composed.summary.alertCount, 1);
assert.equal(composed.registrations.length, 5);

const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-unified-registration-"));
const queueObservation: any = projectQueueObservation({
  stateCounts: [{ state: "failed", count: 1 }],
  items: [{
    workItemId: "work_item_verify",
    queueDefinitionId: "queue.verify",
    state: "failed",
    lastError: { code: "verification_failure" }
  }]
});
const workQueueObservationAdapter: Record<string, any> = { inspect: async () : Promise<any> => queueObservation };

try {
  const backgroundStatus: any = await getBackgroundProcessStatus(userDataPath);
  assert.ok(backgroundStatus.systemStatus, "background process status must publish a unified system status");
  assert.ok(
    backgroundStatus.processes.every((item?: any) : any => item.unifiedRegistration?.originalType === "process"),
    "every process must carry a process unified registration"
  );

  assert.deepEqual(queueObservation.summary.stateCounts, { failed: 1 });
  assert.equal(queueObservation.items[0].observationStatus, "interrupted");

  await saveMonitorAlertConfig(userDataPath, {
    enabled: true,
    rules: {
      supervisorStopped: { enabled: false },
      processNotRunning: { enabled: false },
      processStale: { enabled: false },
      processRestarted: { enabled: false },
      queueInterrupted: { enabled: true }
    }
  });
  const monitorState: any = await runMonitorAlertCycle(userDataPath, { workQueueObservation: workQueueObservationAdapter });
  assert.ok(monitorState.systemStatus, "monitor alerts must publish a unified system status");
  assert.ok(monitorState.systemStatus.summary.monitorCount >= 1);
  assert.ok(monitorState.systemStatus.summary.alertCount >= 1);
  assert.ok(
    monitorState.systemStatus.registrations.every((registration?: any) : any => registration.route?.section),
    "every unified registration must route to a system status section"
  );

  console.log("Unified registration verification passed.");
} finally {
  await fs.rm(userDataPath, { recursive: true, force: true });
}
