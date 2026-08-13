import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ServerConfig } from "#meshrix/server-config";
import { serverToken } from "#meshrix/client-strings";

export const DURABLE_WORKFLOW_SUBSTRATE_PROTOCOL_VERSION: any = "v0.0.1:workflow:core-1";

const WORKFLOW_SCHEMA_VERSION: any = "v0.0.1:workflow:durable-workflow-schema-1";
const TERMINAL_WORKFLOW_STATUSES: any = new Set<any>(["completed", "failed", "canceled"]);
const OPEN_ACTIVITY_STATUSES: any = new Set<any>(["scheduled", "running", "retrying"]);

function nowIso() : any {
  return new Date().toISOString();
}

function asArray(value?: any) : any {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function asObject(value?: any, fallback: Record<string, any> | null = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function text(value?: any) : any {
  return String(value ?? "").trim();
}


function sha256(value?: any) : any {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function hashPayload(value?: any) : any {
  return sha256(stableJson(value));
}

function dataRoot(userDataPath: any = "") : any {
  return userDataPath || ServerConfig.getDataDir();
}

function workflowRoot(userDataPath: any = "") : any {
  return path.join(dataRoot(userDataPath), "workflows");
}

function workflowPath(userDataPath: any = "", workflowId: any = "") : any {
  return path.join(workflowRoot(userDataPath), `${safeWorkflowId(workflowId)}.json`);
}

function safeWorkflowId(value: any = "") : any {
  return text(value || workflowId("workflow", crypto.randomUUID()))
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 180);
}

async function readJson(filePath?: any, fallback: any = null) : Promise<any> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath?: any, value?: any) : Promise<any> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath: any = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

export function workflowId(kind: any = "workflow", ...parts: any[]) : any {
  return serverToken("workflow", kind, ...parts);
}

function appendHistory(workflow?: any, eventType?: any, payload: Record<string, any> = {}) : any {
  const sequence: any = asArray(workflow.history).length + 1;
  const previousEventHash: any = workflow.lastEventHash || "";
  const event: Record<string, any> = {
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

function normalizeWorkflow(input: Record<string, any> = {}) : any {
  const timestamp: any = nowIso();
  const id: any = text(input.workflowId) || workflowId(input.workflowType || "workflow", input.ownerId || "", input.idempotencyKey || crypto.randomUUID());
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

function hydrateWorkflow(value: any = null) : any {
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

function publicWorkflow(workflow: any = null) : any {
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
    activities: (Object.values(asObject(workflow.activities)) as any[]),
    signals: workflow.signals,
    timers: (Object.values(asObject(workflow.timers)) as any[]),
    humanReviews: (Object.values(asObject(workflow.humanReviews)) as any[]),
    externalWrites: (Object.values(asObject(workflow.externalWrites)) as any[]),
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

function findActivityByIdempotencyKey(workflow?: any, idempotencyKey: any = "") : any {
  const key: any = text(idempotencyKey);
  if (!key) return null;
  return (Object.values(asObject(workflow.activities)) as any[]).find((activity?: any) : any => activity.idempotencyKey === key) || null;
}

function unresolvedHumanReviews(workflow?: any) : any {
  return (Object.values(asObject(workflow.humanReviews)) as any[]).filter((review?: any) : any => review.status === "queued");
}

function unresolvedExternalWrites(workflow?: any) : any {
  return (Object.values(asObject(workflow.externalWrites)) as any[]).filter((write?: any) : any => write.status === "partial");
}

function refreshWaitingState(workflow?: any) : any {
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

export function verifyWorkflowHistory(workflow: Record<string, any> = {}) : any {
  let previousEventHash: any = "";
  for (const event of asArray(workflow.history)) {
    if (event.previousEventHash !== previousEventHash) {
      return {
        ok: false,
        reason: "previous_event_hash_mismatch",
        sequence: event.sequence
      };
    }
    const expectedHash: any = sha256(stableJson({
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

export function createDurableWorkflowSubstrate({ userDataPath = "" }: Record<string, any> = {}) : any {
  const root: any = workflowRoot(userDataPath);

  async function readWorkflow(workflowIdValue?: any) : Promise<any> {
    return hydrateWorkflow(await readJson(workflowPath(userDataPath, workflowIdValue), null));
  }

  async function writeWorkflow(workflow?: any) : Promise<any> {
    await writeJsonAtomic(workflowPath(userDataPath, workflow.workflowId), workflow);
    return publicWorkflow(workflow);
  }

  async function mutateWorkflow(workflowIdValue?: any, mutator?: any) : Promise<any> {
    const workflow: any = await readWorkflow(workflowIdValue);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowIdValue}`);
    }
    const result: any = await mutator(workflow);
    refreshWaitingState(workflow);
    await writeWorkflow(workflow);
    if (result && typeof result === "object" && Object.hasOwn(result, "workflow")) {
      result.workflow = publicWorkflow(workflow);
    }
    return result === undefined ? publicWorkflow(workflow) : result;
  }

  return {
    protocolVersion: DURABLE_WORKFLOW_SUBSTRATE_PROTOCOL_VERSION,
    async startWorkflow(input: Record<string, any> = {}) : Promise<any> {
      const next: any = normalizeWorkflow(input);
      const existing: any = await readWorkflow(next.workflowId);
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
    async getWorkflow(workflowIdValue: any = "") : Promise<any> {
      return publicWorkflow(await readWorkflow(workflowIdValue));
    },
    async getWorkflowWithHistory(workflowIdValue: any = "") : Promise<any> {
      return readWorkflow(workflowIdValue);
    },
    async listWorkflows({ ownerId = "", ownerKind = "", status = "", limit = 100 }: Record<string, any> = {}) : Promise<any> {
      await fs.mkdir(root, { recursive: true });
      const entries: any = await fs.readdir(root, { withFileTypes: true });
      const workflows: any[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const workflow: any = hydrateWorkflow(await readJson(path.join(root, entry.name), null));
        if (!workflow) continue;
        if (ownerId && workflow.ownerId !== ownerId) continue;
        if (ownerKind && workflow.ownerKind !== ownerKind) continue;
        if (status && workflow.status !== status) continue;
        workflows.push(publicWorkflow(workflow));
      }
      return workflows
        .sort((left?: any, right?: any) : any => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
        .slice(0, Math.max(1, Math.min(500, Number(limit || 100))));
    },
    async scheduleActivity(workflowIdValue: any = "", input: Record<string, any> = {}) : Promise<any> {
      return mutateWorkflow(workflowIdValue, (workflow?: any) : any => {
        const existing: any = findActivityByIdempotencyKey(workflow, input.idempotencyKey);
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
        const activityId: any = text(input.activityId) || serverToken("activity", workflow.workflowId, input.activityType || "activity", input.idempotencyKey || crypto.randomUUID());
        const timestamp: any = nowIso();
        const activity: Record<string, any> = {
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
    async startActivity(workflowIdValue: any = "", activityId: any = "") : Promise<any> {
      return mutateWorkflow(workflowIdValue, (workflow?: any) : any => {
        const activity: any = workflow.activities[text(activityId)];
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
    async heartbeatActivity(workflowIdValue: any = "", activityId: any = "", heartbeat: Record<string, any> = {}) : Promise<any> {
      return mutateWorkflow(workflowIdValue, (workflow?: any) : any => {
        const activity: any = workflow.activities[text(activityId)];
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
    async completeActivity(workflowIdValue: any = "", activityId: any = "", output: Record<string, any> = {}) : Promise<any> {
      return mutateWorkflow(workflowIdValue, (workflow?: any) : any => {
        const activity: any = workflow.activities[text(activityId)];
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
    async failActivity(workflowIdValue: any = "", activityId: any = "", error: any = "") : Promise<any> {
      return mutateWorkflow(workflowIdValue, (workflow?: any) : any => {
        const activity: any = workflow.activities[text(activityId)];
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
    async requestHumanReview(workflowIdValue: any = "", input: Record<string, any> = {}) : Promise<any> {
      return mutateWorkflow(workflowIdValue, (workflow?: any) : any => {
        const reviewId: any = text(input.reviewId) || serverToken("workflow_review", workflow.workflowId, input.reviewType || "human_review", crypto.randomUUID());
        const review: Record<string, any> = {
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
    async resolveHumanReview(workflowIdValue: any = "", reviewId: any = "", input: Record<string, any> = {}) : Promise<any> {
      return mutateWorkflow(workflowIdValue, (workflow?: any) : any => {
        const review: any = workflow.humanReviews[text(reviewId)];
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
    async recordSignal(workflowIdValue: any = "", signalName: any = "", payload: Record<string, any> = {}) : Promise<any> {
      return mutateWorkflow(workflowIdValue, (workflow?: any) : any => {
        const signal: Record<string, any> = {
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
    async scheduleTimer(workflowIdValue: any = "", input: Record<string, any> = {}) : Promise<any> {
      return mutateWorkflow(workflowIdValue, (workflow?: any) : any => {
        const timerId: any = text(input.timerId) || serverToken("workflow_timer", workflow.workflowId, input.timerName || "timer", input.fireAt || crypto.randomUUID());
        const timer: Record<string, any> = {
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
    async fireDueTimers({ now = nowIso() }: Record<string, any> = {}) : Promise<any> {
      const workflows: any = await this.listWorkflows({ limit: 500 });
      const fired: any[] = [];
      for (const item of workflows) {
        const workflow: any = await readWorkflow(item.workflowId);
        if (!workflow || TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) continue;
        let changed: any = false;
        for (const timer of (Object.values(asObject(workflow.timers)) as any[])) {
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
    async beginExternalWrite(workflowIdValue: any = "", input: Record<string, any> = {}) : Promise<any> {
      return mutateWorkflow(workflowIdValue, (workflow?: any) : any => {
        const writeId: any = text(input.writeId) || serverToken("external_write", workflow.workflowId, input.providerId || "external", input.idempotencyKey || crypto.randomUUID());
        const write: Record<string, any> = {
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
    async commitExternalWrite(workflowIdValue: any = "", writeId: any = "", input: Record<string, any> = {}) : Promise<any> {
      return mutateWorkflow(workflowIdValue, (workflow?: any) : any => {
        const write: any = workflow.externalWrites[text(writeId)];
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
    async failExternalWrite(workflowIdValue: any = "", writeId: any = "", error: any = "") : Promise<any> {
      return mutateWorkflow(workflowIdValue, (workflow?: any) : any => {
        const write: any = workflow.externalWrites[text(writeId)];
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
    async compensateExternalWrite(workflowIdValue: any = "", writeId: any = "", input: Record<string, any> = {}) : Promise<any> {
      return mutateWorkflow(workflowIdValue, (workflow?: any) : any => {
        const write: any = workflow.externalWrites[text(writeId)];
        if (!write) throw new Error(`External write not found: ${writeId}`);
        write.status = "compensated";
        write.compensatedAt = nowIso();
        const compensation: Record<string, any> = {
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
    async recoverWorkflow(workflowIdValue: any = "", input: Record<string, any> = {}) : Promise<any> {
      return mutateWorkflow(workflowIdValue, (workflow?: any) : any => {
        for (const activity of (Object.values(asObject(workflow.activities)) as any[])) {
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
          openActivities: (Object.values(asObject(workflow.activities)) as any[]).filter((activity?: any) : any => OPEN_ACTIVITY_STATUSES.has(activity.status)).map((activity?: any) : any => activity.activityId),
          unresolvedHumanReviews: unresolvedHumanReviews(workflow).map((review?: any) : any => review.reviewId),
          unresolvedExternalWrites: unresolvedExternalWrites(workflow).map((write?: any) : any => write.writeId)
        });
        return {
          workflow: publicWorkflow(workflow),
          historyVerification: verifyWorkflowHistory(workflow)
        };
      });
    },
    async recoverWorkflows(input: Record<string, any> = {}) : Promise<any> {
      const workflows: any = await this.listWorkflows({ ownerKind: input.ownerKind || "", limit: input.limit || 500 });
      const recovered: any[] = [];
      for (const workflow of workflows) {
        if (TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) continue;
        const result: any = await this.recoverWorkflow(workflow.workflowId, input);
        recovered.push(result.workflow);
      }
      return { recovered, count: recovered.length };
    },
    async completeWorkflow(workflowIdValue: any = "", output: Record<string, any> = {}) : Promise<any> {
      return mutateWorkflow(workflowIdValue, (workflow?: any) : any => {
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
    async failWorkflow(workflowIdValue: any = "", error: any = "") : Promise<any> {
      return mutateWorkflow(workflowIdValue, (workflow?: any) : any => {
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
    async verifyWorkflow(workflowIdValue: any = "") : Promise<any> {
      const workflow: any = await readWorkflow(workflowIdValue);
      return verifyWorkflowHistory(workflow || {});
    }
  };
}
