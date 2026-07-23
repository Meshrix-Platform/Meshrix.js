import { canonicalJson as stableJson } from "@lico/contracts/serialization/canonical-json";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ServerConfig } from "#lico/server-config";
import { serverToken } from "#lico/client-strings";

export const DURABLE_WORKFLOW_SUBSTRATE_PROTOCOL_VERSION = "v0.0.1:workflow:core-1";

const WORKFLOW_SCHEMA_VERSION = "v0.0.1:workflow:durable-workflow-schema-1";
const TERMINAL_WORKFLOW_STATUSES = new Set(["completed", "failed", "canceled"]);
const OPEN_ACTIVITY_STATUSES = new Set(["scheduled", "running", "retrying"]);

function nowIso() {
  return new Date().toISOString();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function asObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function text(value) {
  return String(value ?? "").trim();
}


function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function hashPayload(value) {
  return sha256(stableJson(value));
}

function dataRoot(userDataPath = "") {
  return userDataPath || ServerConfig.getDataDir();
}

function workflowRoot(userDataPath = "") {
  return path.join(dataRoot(userDataPath), "workflows");
}

function workflowPath(userDataPath = "", workflowId = "") {
  return path.join(workflowRoot(userDataPath), `${safeWorkflowId(workflowId)}.json`);
}

function safeWorkflowId(value = "") {
  return text(value || workflowId("workflow", crypto.randomUUID()))
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 180);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

export function workflowId(kind = "workflow", ...parts) {
  return serverToken("workflow", kind, ...parts);
}

function appendHistory(workflow, eventType, payload = {}) {
  const sequence = asArray(workflow.history).length + 1;
  const previousEventHash = workflow.lastEventHash || "";
  const event = {
    sequence,
    eventId: serverToken("workflow_event", workflow.workflowId, sequence, eventType, nowIso(), crypto.randomUUID()),
    eventType,
    at: nowIso(),
    previousEventHash,
    payload: asObject(payload)
  };
  event.eventHash = sha256(stableJson({
    sequence,
    eventType,
    at: event.at,
    previousEventHash,
    payload: event.payload
  }));
  workflow.history.push(event);
  workflow.lastEventHash = event.eventHash;
  workflow.updatedAt = event.at;
  return event;
}

function normalizeWorkflow(input = {}) {
  const timestamp = nowIso();
  const id = text(input.workflowId) || workflowId(input.workflowType || "workflow", input.ownerId || "", input.idempotencyKey || crypto.randomUUID());
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    protocolVersion: DURABLE_WORKFLOW_SUBSTRATE_PROTOCOL_VERSION,
    workflowId: id,
    workflowType: text(input.workflowType || "long_task"),
    ownerId: text(input.ownerId || ""),
    ownerKind: text(input.ownerKind || input.workflowType || "long_task"),
    status: text(input.status || "running"),
    waitingReason: text(input.waitingReason || ""),
    idempotencyKey: text(input.idempotencyKey || ""),
    inputHash: text(input.inputHash || hashPayload(input.input || {})),
    outputHash: "",
    input: asObject(input.input),
    output: {},
    checkpointTreeId: text(input.checkpointTreeId || ""),
    attempt: Number(input.attempt || 1),
    activities: {},
    signals: [],
    timers: {},
    humanReviews: {},
    externalWrites: {},
    compensations: [],
    history: [],
    lastEventHash: "",
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    completedAt: "",
    failedAt: "",
    error: ""
  };
}

function hydrateWorkflow(value = null) {
  if (!value || value.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    return null;
  }
  return {
    ...normalizeWorkflow(value),
    ...value,
    activities: asObject(value.activities),
    signals: asArray(value.signals),
    timers: asObject(value.timers),
    humanReviews: asObject(value.humanReviews),
    externalWrites: asObject(value.externalWrites),
    compensations: asArray(value.compensations),
    history: asArray(value.history)
  };
}

function publicWorkflow(workflow = null) {
  if (!workflow) return null;
  return {
    schemaVersion: workflow.schemaVersion,
    protocolVersion: workflow.protocolVersion,
    workflowId: workflow.workflowId,
    workflowType: workflow.workflowType,
    ownerId: workflow.ownerId,
    ownerKind: workflow.ownerKind,
    status: workflow.status,
    waitingReason: workflow.waitingReason,
    idempotencyKey: workflow.idempotencyKey,
    inputHash: workflow.inputHash,
    outputHash: workflow.outputHash,
    checkpointTreeId: workflow.checkpointTreeId,
    attempt: workflow.attempt,
    activities: Object.values(asObject(workflow.activities)),
    signals: workflow.signals,
    timers: Object.values(asObject(workflow.timers)),
    humanReviews: Object.values(asObject(workflow.humanReviews)),
    externalWrites: Object.values(asObject(workflow.externalWrites)),
    compensations: workflow.compensations,
    historyLength: asArray(workflow.history).length,
    lastEventHash: workflow.lastEventHash,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    startedAt: workflow.startedAt,
    completedAt: workflow.completedAt,
    failedAt: workflow.failedAt,
    error: workflow.error
  };
}

function findActivityByIdempotencyKey(workflow, idempotencyKey = "") {
  const key = text(idempotencyKey);
  if (!key) return null;
  return Object.values(asObject(workflow.activities)).find((activity) => activity.idempotencyKey === key) || null;
}

function unresolvedHumanReviews(workflow) {
  return Object.values(asObject(workflow.humanReviews)).filter((review) => review.status === "queued");
}

function unresolvedExternalWrites(workflow) {
  return Object.values(asObject(workflow.externalWrites)).filter((write) => write.status === "partial");
}

function refreshWaitingState(workflow) {
  if (TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) {
    return workflow;
  }
  if (unresolvedExternalWrites(workflow).length > 0) {
    workflow.status = "paused";
    workflow.waitingReason = "external_partial_write_resolution";
    return workflow;
  }
  if (unresolvedHumanReviews(workflow).length > 0) {
    workflow.status = "paused";
    workflow.waitingReason = "human_review";
    return workflow;
  }
  workflow.status = "running";
  workflow.waitingReason = "";
  return workflow;
}

export function verifyWorkflowHistory(workflow = {}) {
  let previousEventHash = "";
  for (const event of asArray(workflow.history)) {
    if (event.previousEventHash !== previousEventHash) {
      return {
        ok: false,
        reason: "previous_event_hash_mismatch",
        sequence: event.sequence
      };
    }
    const expectedHash = sha256(stableJson({
      sequence: event.sequence,
      eventType: event.eventType,
      at: event.at,
      previousEventHash: event.previousEventHash,
      payload: event.payload
    }));
    if (event.eventHash !== expectedHash) {
      return {
        ok: false,
        reason: "event_hash_mismatch",
        sequence: event.sequence
      };
    }
    previousEventHash = event.eventHash;
  }
  return {
    ok: true,
    lastEventHash: previousEventHash,
    historyLength: asArray(workflow.history).length
  };
}

export function createDurableWorkflowSubstrate({ userDataPath = "" } = {}) {
  const root = workflowRoot(userDataPath);

  async function readWorkflow(workflowIdValue) {
    return hydrateWorkflow(await readJson(workflowPath(userDataPath, workflowIdValue), null));
  }

  async function writeWorkflow(workflow) {
    await writeJsonAtomic(workflowPath(userDataPath, workflow.workflowId), workflow);
    return publicWorkflow(workflow);
  }

  async function mutateWorkflow(workflowIdValue, mutator) {
    const workflow = await readWorkflow(workflowIdValue);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowIdValue}`);
    }
    const result = await mutator(workflow);
    refreshWaitingState(workflow);
    await writeWorkflow(workflow);
    if (result && typeof result === "object" && Object.hasOwn(result, "workflow")) {
      result.workflow = publicWorkflow(workflow);
    }
    return result === undefined ? publicWorkflow(workflow) : result;
  }

  return {
    protocolVersion: DURABLE_WORKFLOW_SUBSTRATE_PROTOCOL_VERSION,
    async startWorkflow(input = {}) {
      const next = normalizeWorkflow(input);
      const existing = await readWorkflow(next.workflowId);
      if (existing) {
        if (next.inputHash && existing.inputHash && next.inputHash !== existing.inputHash) {
          throw new Error(`Workflow idempotency conflict: ${next.workflowId}`);
        }
        return publicWorkflow(existing);
      }
      appendHistory(next, "workflow.started", {
        workflowType: next.workflowType,
        ownerId: next.ownerId,
        ownerKind: next.ownerKind,
        inputHash: next.inputHash,
        checkpointTreeId: next.checkpointTreeId
      });
      await writeWorkflow(next);
      return publicWorkflow(next);
    },
    async getWorkflow(workflowIdValue = "") {
      return publicWorkflow(await readWorkflow(workflowIdValue));
    },
    async getWorkflowWithHistory(workflowIdValue = "") {
      return readWorkflow(workflowIdValue);
    },
    async listWorkflows({ ownerId = "", ownerKind = "", status = "", limit = 100 } = {}) {
      await fs.mkdir(root, { recursive: true });
      const entries = await fs.readdir(root, { withFileTypes: true });
      const workflows = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const workflow = hydrateWorkflow(await readJson(path.join(root, entry.name), null));
        if (!workflow) continue;
        if (ownerId && workflow.ownerId !== ownerId) continue;
        if (ownerKind && workflow.ownerKind !== ownerKind) continue;
        if (status && workflow.status !== status) continue;
        workflows.push(publicWorkflow(workflow));
      }
      return workflows
        .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
        .slice(0, Math.max(1, Math.min(500, Number(limit || 100))));
    },
    async scheduleActivity(workflowIdValue = "", input = {}) {
      return mutateWorkflow(workflowIdValue, (workflow) => {
        const existing = findActivityByIdempotencyKey(workflow, input.idempotencyKey);
        if (existing) {
          appendHistory(workflow, "activity.idempotent_reuse", {
            activityId: existing.activityId,
            idempotencyKey: existing.idempotencyKey,
            status: existing.status
          });
          return {
            activity: existing,
            reused: true,
            workflow: publicWorkflow(workflow)
          };
        }
        const activityId = text(input.activityId) || serverToken("activity", workflow.workflowId, input.activityType || "activity", input.idempotencyKey || crypto.randomUUID());
        const timestamp = nowIso();
        const activity = {
          activityId,
          activityType: text(input.activityType || "activity"),
          status: "scheduled",
          idempotencyKey: text(input.idempotencyKey || ""),
          inputHash: text(input.inputHash || hashPayload(input.input || {})),
          outputHash: "",
          attempt: 0,
          maxAttempts: Math.max(1, Number(input.retryPolicy?.maxAttempts || input.maxAttempts || 3)),
          retryPolicy: asObject(input.retryPolicy),
          compensation: asObject(input.compensation),
          startedAt: "",
          completedAt: "",
          failedAt: "",
          updatedAt: timestamp,
          error: "",
          heartbeat: {}
        };
        workflow.activities[activityId] = activity;
        appendHistory(workflow, "activity.scheduled", {
          activityId,
          activityType: activity.activityType,
          idempotencyKey: activity.idempotencyKey,
          inputHash: activity.inputHash
        });
        return {
          activity,
          reused: false,
          workflow: publicWorkflow(workflow)
        };
      });
    },
    async startActivity(workflowIdValue = "", activityId = "") {
      return mutateWorkflow(workflowIdValue, (workflow) => {
        const activity = workflow.activities[text(activityId)];
        if (!activity) throw new Error(`Activity not found: ${activityId}`);
        activity.status = "running";
        activity.attempt += 1;
        activity.startedAt = activity.startedAt || nowIso();
        activity.updatedAt = nowIso();
        appendHistory(workflow, "activity.started", {
          activityId: activity.activityId,
          attempt: activity.attempt
        });
        return {
          activity,
          workflow: publicWorkflow(workflow)
        };
      });
    },
    async heartbeatActivity(workflowIdValue = "", activityId = "", heartbeat = {}) {
      return mutateWorkflow(workflowIdValue, (workflow) => {
        const activity = workflow.activities[text(activityId)];
        if (!activity) throw new Error(`Activity not found: ${activityId}`);
        activity.heartbeat = {
          ...asObject(heartbeat),
          at: nowIso()
        };
        activity.updatedAt = activity.heartbeat.at;
        appendHistory(workflow, "activity.heartbeat", {
          activityId: activity.activityId,
          heartbeat: activity.heartbeat
        });
        return {
          activity,
          workflow: publicWorkflow(workflow)
        };
      });
    },
    async completeActivity(workflowIdValue = "", activityId = "", output = {}) {
      return mutateWorkflow(workflowIdValue, (workflow) => {
        const activity = workflow.activities[text(activityId)];
        if (!activity) throw new Error(`Activity not found: ${activityId}`);
        activity.status = "completed";
        activity.outputHash = hashPayload(output);
        activity.completedAt = nowIso();
        activity.updatedAt = activity.completedAt;
        activity.error = "";
        appendHistory(workflow, "activity.completed", {
          activityId: activity.activityId,
          outputHash: activity.outputHash
        });
        return {
          activity,
          workflow: publicWorkflow(workflow)
        };
      });
    },
    async failActivity(workflowIdValue = "", activityId = "", error = "") {
      return mutateWorkflow(workflowIdValue, (workflow) => {
        const activity = workflow.activities[text(activityId)];
        if (!activity) throw new Error(`Activity not found: ${activityId}`);
        activity.error = text(error || "Activity failed.");
        activity.failedAt = nowIso();
        activity.updatedAt = activity.failedAt;
        activity.status = activity.attempt < activity.maxAttempts ? "retrying" : "failed";
        appendHistory(workflow, "activity.failed", {
          activityId: activity.activityId,
          attempt: activity.attempt,
          maxAttempts: activity.maxAttempts,
          retryable: activity.status === "retrying",
          error: activity.error
        });
        return {
          activity,
          workflow: publicWorkflow(workflow)
        };
      });
    },
    async requestHumanReview(workflowIdValue = "", input = {}) {
      return mutateWorkflow(workflowIdValue, (workflow) => {
        const reviewId = text(input.reviewId) || serverToken("workflow_review", workflow.workflowId, input.reviewType || "human_review", crypto.randomUUID());
        const review = {
          reviewId,
          reviewType: text(input.reviewType || "human_review"),
          status: "queued",
          reasons: asArray(input.reasons || input.reason).map(text).filter(Boolean),
          requestedBy: text(input.requestedBy || ""),
          resolvedBy: "",
          decision: "",
          createdAt: nowIso(),
          resolvedAt: ""
        };
        workflow.humanReviews[reviewId] = review;
        workflow.status = "paused";
        workflow.waitingReason = "human_review";
        appendHistory(workflow, "human_review.queued", {
          reviewId,
          reasons: review.reasons
        });
        return {
          humanReview: review,
          workflow: publicWorkflow(workflow)
        };
      });
    },
    async resolveHumanReview(workflowIdValue = "", reviewId = "", input = {}) {
      return mutateWorkflow(workflowIdValue, (workflow) => {
        const review = workflow.humanReviews[text(reviewId)];
        if (!review) throw new Error(`Human review not found: ${reviewId}`);
        review.status = text(input.status || input.decision || "approved");
        review.decision = text(input.decision || review.status);
        review.resolvedBy = text(input.resolvedBy || input.actorId || "");
        review.resolvedAt = nowIso();
        appendHistory(workflow, "human_review.resolved", {
          reviewId,
          status: review.status,
          decision: review.decision
        });
        return {
          humanReview: review,
          workflow: publicWorkflow(workflow)
        };
      });
    },
    async recordSignal(workflowIdValue = "", signalName = "", payload = {}) {
      return mutateWorkflow(workflowIdValue, (workflow) => {
        const signal = {
          signalId: serverToken("workflow_signal", workflow.workflowId, signalName, crypto.randomUUID()),
          signalName: text(signalName || "signal"),
          payload: asObject(payload),
          createdAt: nowIso()
        };
        workflow.signals.push(signal);
        appendHistory(workflow, "workflow.signal", {
          signalName: signal.signalName,
          signalId: signal.signalId
        });
        return {
          signal,
          workflow: publicWorkflow(workflow)
        };
      });
    },
    async scheduleTimer(workflowIdValue = "", input = {}) {
      return mutateWorkflow(workflowIdValue, (workflow) => {
        const timerId = text(input.timerId) || serverToken("workflow_timer", workflow.workflowId, input.timerName || "timer", input.fireAt || crypto.randomUUID());
        const timer = {
          timerId,
          timerName: text(input.timerName || "timer"),
          status: "scheduled",
          fireAt: text(input.fireAt || nowIso()),
          payload: asObject(input.payload),
          createdAt: nowIso(),
          firedAt: ""
        };
        workflow.timers[timerId] = timer;
        appendHistory(workflow, "timer.scheduled", {
          timerId,
          fireAt: timer.fireAt
        });
        return {
          timer,
          workflow: publicWorkflow(workflow)
        };
      });
    },
    async fireDueTimers({ now = nowIso() } = {}) {
      const workflows = await this.listWorkflows({ limit: 500 });
      const fired = [];
      for (const item of workflows) {
        const workflow = await readWorkflow(item.workflowId);
        if (!workflow || TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) continue;
        let changed = false;
        for (const timer of Object.values(asObject(workflow.timers))) {
          if (timer.status !== "scheduled" || String(timer.fireAt || "") > now) continue;
          timer.status = "fired";
          timer.firedAt = nowIso();
          appendHistory(workflow, "timer.fired", {
            timerId: timer.timerId,
            fireAt: timer.fireAt
          });
          workflow.signals.push({
            signalId: serverToken("workflow_signal", workflow.workflowId, "timer.fired", timer.timerId),
            signalName: "timer.fired",
            payload: { timerId: timer.timerId, timerName: timer.timerName },
            createdAt: timer.firedAt
          });
          fired.push({ workflowId: workflow.workflowId, timerId: timer.timerId });
          changed = true;
        }
        if (changed) {
          refreshWaitingState(workflow);
          await writeWorkflow(workflow);
        }
      }
      return { fired, count: fired.length };
    },
    async beginExternalWrite(workflowIdValue = "", input = {}) {
      return mutateWorkflow(workflowIdValue, (workflow) => {
        const writeId = text(input.writeId) || serverToken("external_write", workflow.workflowId, input.providerId || "external", input.idempotencyKey || crypto.randomUUID());
        const write = {
          writeId,
          status: "partial",
          providerId: text(input.providerId || ""),
          targetRef: text(input.targetRef || ""),
          idempotencyKey: text(input.idempotencyKey || ""),
          inputHash: text(input.inputHash || hashPayload(input.input || {})),
          confirmationHash: "",
          outputHash: "",
          compensation: asObject(input.compensation),
          startedAt: nowIso(),
          committedAt: "",
          failedAt: "",
          compensatedAt: "",
          error: ""
        };
        workflow.externalWrites[writeId] = write;
        workflow.status = "paused";
        workflow.waitingReason = "external_partial_write_resolution";
        appendHistory(workflow, "external_write.partial", {
          writeId,
          providerId: write.providerId,
          targetRef: write.targetRef,
          idempotencyKey: write.idempotencyKey,
          inputHash: write.inputHash
        });
        return {
          externalWrite: write,
          workflow: publicWorkflow(workflow)
        };
      });
    },
    async commitExternalWrite(workflowIdValue = "", writeId = "", input = {}) {
      return mutateWorkflow(workflowIdValue, (workflow) => {
        const write = workflow.externalWrites[text(writeId)];
        if (!write) throw new Error(`External write not found: ${writeId}`);
        write.status = "committed";
        write.confirmationHash = text(input.confirmationHash || hashPayload(input.confirmation || {}));
        write.outputHash = text(input.outputHash || hashPayload(input.output || {}));
        write.committedAt = nowIso();
        write.error = "";
        appendHistory(workflow, "external_write.committed", {
          writeId: write.writeId,
          confirmationHash: write.confirmationHash,
          outputHash: write.outputHash
        });
        return {
          externalWrite: write,
          workflow: publicWorkflow(workflow)
        };
      });
    },
    async failExternalWrite(workflowIdValue = "", writeId = "", error = "") {
      return mutateWorkflow(workflowIdValue, (workflow) => {
        const write = workflow.externalWrites[text(writeId)];
        if (!write) throw new Error(`External write not found: ${writeId}`);
        write.status = "failed";
        write.failedAt = nowIso();
        write.error = text(error || "External write failed.");
        appendHistory(workflow, "external_write.failed", {
          writeId: write.writeId,
          error: write.error
        });
        return {
          externalWrite: write,
          workflow: publicWorkflow(workflow)
        };
      });
    },
    async compensateExternalWrite(workflowIdValue = "", writeId = "", input = {}) {
      return mutateWorkflow(workflowIdValue, (workflow) => {
        const write = workflow.externalWrites[text(writeId)];
        if (!write) throw new Error(`External write not found: ${writeId}`);
        write.status = "compensated";
        write.compensatedAt = nowIso();
        const compensation = {
          compensationId: serverToken("workflow_compensation", workflow.workflowId, writeId, crypto.randomUUID()),
          writeId,
          action: text(input.action || write.compensation?.action || "manual_compensation"),
          outputHash: text(input.outputHash || hashPayload(input.output || {})),
          createdAt: nowIso()
        };
        workflow.compensations.push(compensation);
        appendHistory(workflow, "external_write.compensated", {
          writeId: write.writeId,
          compensationId: compensation.compensationId,
          action: compensation.action
        });
        return {
          externalWrite: write,
          compensation,
          workflow: publicWorkflow(workflow)
        };
      });
    },
    async recoverWorkflow(workflowIdValue = "", input = {}) {
      return mutateWorkflow(workflowIdValue, (workflow) => {
        for (const activity of Object.values(asObject(workflow.activities))) {
          if (activity.status === "running") {
            activity.status = "scheduled";
            activity.updatedAt = nowIso();
          }
          if (activity.status === "retrying") {
            activity.status = "scheduled";
            activity.updatedAt = nowIso();
          }
        }
        workflow.attempt += 1;
        appendHistory(workflow, "workflow.recovered", {
          reason: text(input.reason || "process_restart"),
          openActivities: Object.values(asObject(workflow.activities)).filter((activity) => OPEN_ACTIVITY_STATUSES.has(activity.status)).map((activity) => activity.activityId),
          unresolvedHumanReviews: unresolvedHumanReviews(workflow).map((review) => review.reviewId),
          unresolvedExternalWrites: unresolvedExternalWrites(workflow).map((write) => write.writeId)
        });
        return {
          workflow: publicWorkflow(workflow),
          historyVerification: verifyWorkflowHistory(workflow)
        };
      });
    },
    async recoverWorkflows(input = {}) {
      const workflows = await this.listWorkflows({ ownerKind: input.ownerKind || "", limit: input.limit || 500 });
      const recovered = [];
      for (const workflow of workflows) {
        if (TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) continue;
        const result = await this.recoverWorkflow(workflow.workflowId, input);
        recovered.push(result.workflow);
      }
      return { recovered, count: recovered.length };
    },
    async completeWorkflow(workflowIdValue = "", output = {}) {
      return mutateWorkflow(workflowIdValue, (workflow) => {
        if (unresolvedHumanReviews(workflow).length > 0) {
          throw new Error("Workflow has unresolved human reviews.");
        }
        if (unresolvedExternalWrites(workflow).length > 0) {
          throw new Error("Workflow has unresolved external partial writes.");
        }
        workflow.status = "completed";
        workflow.waitingReason = "";
        workflow.output = asObject(output);
        workflow.outputHash = hashPayload(output);
        workflow.completedAt = nowIso();
        workflow.error = "";
        appendHistory(workflow, "workflow.completed", {
          outputHash: workflow.outputHash
        });
        return publicWorkflow(workflow);
      });
    },
    async failWorkflow(workflowIdValue = "", error = "") {
      return mutateWorkflow(workflowIdValue, (workflow) => {
        workflow.status = "failed";
        workflow.waitingReason = "";
        workflow.error = text(error || "Workflow failed.");
        workflow.failedAt = nowIso();
        appendHistory(workflow, "workflow.failed", {
          error: workflow.error
        });
        return publicWorkflow(workflow);
      });
    },
    async verifyWorkflow(workflowIdValue = "") {
      const workflow = await readWorkflow(workflowIdValue);
      return verifyWorkflowHistory(workflow || {});
    }
  };
}
