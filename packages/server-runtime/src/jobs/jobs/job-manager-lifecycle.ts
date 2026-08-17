import fs from "node:fs/promises";
import {
  deleteCheckpointTree,
  removeImportCheckpoint,
  summarizeError,
} from "#meshrix/product-api";
import { getJobDirectory, CLOSE_ABORT_MESSAGE, RECOVERY_STAGE_MESSAGE } from "./job-manager-validation.ts";
import { runSplitJob } from "./job-runner.ts";
import { deleteUploadSession } from "../../state/upload-session-store.ts";
import type { createDurableWorkflowSubstrate } from "#meshrix/product-api";
import type { ActiveJobController, JobDocument, JobPayload, JobResult, QueueEntry, UploadConsumptionStorageProvider } from "./contracts.ts";
import type { createJobProjectionStore } from "./job-projection-store.ts";

interface LifecycleQueueEntry extends QueueEntry {
  signal?: AbortSignal;
  leaseGuard?: (input: { reason: string }) => Promise<void>;
  payload: JobPayload;
}
interface FinalizeInput { status: "completed" | "failed" | "cancelled"; stage: string; errorMessage?: string; result?: JobResult }
interface LifecycleContext {
  userDataPath: string; workerConcurrency: number; jobs: Map<string, JobDocument>;
  checkpointJobs: Map<string, string>; jobProjectionStore: ReturnType<typeof createJobProjectionStore>;
  activeControllers: Map<string, ActiveJobController>; durableWorkflows: ReturnType<typeof createDurableWorkflowSubstrate>;
  logJob(level: string, event: string, details?: Record<string, unknown>): void; state: { closed: boolean };
  updateJobCheckpointNode(job: JobDocument, node: Record<string, unknown>): Promise<unknown>;
  finishJobCheckpoint(job: JobDocument, input: Record<string, unknown>): Promise<unknown>;
  failJob(jobId: string, message: string, stage: string): Promise<unknown>; workflowIdForJob(job: JobDocument): string;
  updateJob(jobId: string, patch: Partial<JobDocument>): Promise<JobDocument | null>;
  commitJobTerminal(jobId: string, patch: Partial<JobDocument>, result: JobResult): Promise<unknown>;
  commitTerminalThenScheduleUploadCleanup(input: Record<string, unknown>): Promise<unknown>;
  forgetActiveManifestJob(job?: JobDocument | null): void; publishDeletedJobEvent(job: JobDocument): Promise<unknown>;
  cloneJobForApi(job?: JobDocument | null): JobDocument | null; resolveCurrentRuntimeOptions(): Record<string, unknown>;
  uploadSessionStore: {
    resolveUploadSessionFiles(sessionId: string, input: { owner: Record<string, string> }): Promise<unknown>;
  } | null;
  storageProvider: UploadConsumptionStorageProvider | null;
}

export function createStartQueuedJob(ctx: LifecycleContext) {
  const {
    userDataPath,
    workerConcurrency: taskConcurrency,
    jobs,
    checkpointJobs,
    jobProjectionStore,
    activeControllers,
    durableWorkflows,
    logJob,
    state,
    updateJobCheckpointNode,
    finishJobCheckpoint,
    failJob,
    workflowIdForJob,
    updateJob,
    commitJobTerminal,
    commitTerminalThenScheduleUploadCleanup,
    forgetActiveManifestJob,
    publishDeletedJobEvent,
    cloneJobForApi,
    resolveCurrentRuntimeOptions,
    uploadSessionStore,
    storageProvider
  } = ctx;

  async function startQueuedJob(nextEntry: LifecycleQueueEntry) {
    const currentJob = jobs.get(nextEntry.jobId);
    if (!currentJob || currentJob.status !== "queued") {
      logJob("warn", "jobs.task.start.skipped", {
        jobId: nextEntry?.jobId || "",
        reason: !currentJob ? "job_missing" : `status_${currentJob.status}`
      });
      return false;
    }
    if (nextEntry.signal?.aborted) {
      logJob("warn", "jobs.task.start.skipped", {
        jobId: currentJob.id,
        reason: "queue_lease_unavailable"
      });
      return false;
    }

    try {
      logJob("info", "jobs.task.start.requested", {
        jobId: currentJob.id,
        checkpointId: currentJob.checkpointId || "",
        uploadSessionId: currentJob.uploadSessionId || ""
      });
      await durableWorkflows.scheduleActivity(currentJob.workflowId || workflowIdForJob(currentJob), {
        activityId: "job-execution",
        activityType: "import_parse_task",
        idempotencyKey: `${currentJob.id}:job-execution:${currentJob.versionNumber || 1}`,
        inputHash: currentJob.checkpointId || currentJob.archiveBatchId || currentJob.id,
        retryPolicy: {
          maxAttempts: 3,
          backoff: "job_manager_requeue"
        },
        compensation: {
          action: "preserve_payload_and_requeue"
        }
      }).catch((error: unknown) => {
        logJob("warn", "jobs.workflow.activity_schedule.failed", {
          jobId: currentJob.id,
          error: summarizeError(error)
        });
      });
      await durableWorkflows.startActivity(currentJob.workflowId || workflowIdForJob(currentJob), "job-execution").catch((error: unknown) => {
        logJob("warn", "jobs.workflow.activity_start.failed", {
          jobId: currentJob.id,
          error: summarizeError(error)
        });
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "后台任务启动失败。";
      logJob("error", "jobs.task.start.failed", {
        jobId: currentJob.id,
        error: summarizeError(error)
      });
      await updateJobCheckpointNode(currentJob, {
        nodeId: "start-execution",
        parentId: "import-parse-job",
        label: "启动后台任务",
        status: "failed",
        error: message
      });
      await finishJobCheckpoint(currentJob, {
        status: "failed",
        message,
        metadata: {
          stage: "任务启动失败"
        }
      });
      await failJob(currentJob.id, message, "任务启动失败");
      return false;
    }

    let settled = false;
    let deleted = false;
    let preservingForRecovery = false;
    let preservedForRecovery = false;
    let preserveForRecoveryPromise: Promise<void | null> | null = null;
    let finalizePromise: Promise<void> | null = null;
    let resolveQueueTask: ((value: boolean) => void) | null = null;
    let queueTaskSettled = false;
    const executionController = new AbortController();
    let executionTask: Promise<boolean> | null = null;
    const backgroundTasks = new Set<Promise<unknown>>();
    const queueTaskPromise = new Promise<boolean>((resolve) => {
      resolveQueueTask = resolve;
    });
    const completeQueueTask = (value: boolean) => {
      if (queueTaskSettled) {
        return;
      }
      queueTaskSettled = true;
      resolveQueueTask?.(value);
    };
    const trackBackgroundTask = (label: string, task: PromiseLike<unknown>) => {
      const tracked = Promise.resolve(task)
        .catch((error: unknown) => {
          logJob("warn", "jobs.task.background_task.failed", {
            jobId: currentJob.id,
            label,
            error: summarizeError(error)
          });
        })
        .finally(() => {
          backgroundTasks.delete(tracked);
        });
      backgroundTasks.add(tracked);
      return tracked;
    };
    const drainBackgroundTasks = async () => {
      while (backgroundTasks.size > 0) {
        await Promise.allSettled(backgroundTasks);
      }
    };
    const finalizeJob = async ({
      status,
      stage,
      errorMessage,
      result
    }: FinalizeInput) => {
      if (finalizePromise) {
        return finalizePromise;
      }
      finalizePromise = (async () => {
      if (settled) {
        logJob("debug", "jobs.job.finalize.skipped", {
          jobId: currentJob.id,
          reason: "already_settled",
          status,
          stage
        });
        return;
      }

      settled = true;

      const completed = status === "completed";
      const cancelled = status === "cancelled";
      logJob(completed ? "info" : cancelled ? "warn" : "error", "jobs.job.finalize.started", {
        jobId: currentJob.id,
        status,
        stage,
        errorMessage,
        resultSummary: result
          ? {
              emails: result.emails?.length || 0,
              transactions: result.transactions?.length || 0,
              people: result.people?.length || 0,
              warnings: result.warnings?.length || 0
            }
          : null
      });

      if (deleted) {
        completeQueueTask(false);
        logJob("warn", "jobs.job.finalize.deleted", {
          jobId: currentJob.id,
          status,
          stage
        });
        return;
      }

      const finishedAt = new Date().toISOString();

      await updateJobCheckpointNode(currentJob, {
        nodeId: "job-execution",
        parentId: "import-parse-job",
        label: completed ? "后台任务执行完成" : cancelled ? "后台任务已取消" : "后台任务执行失败",
        status: completed ? "completed" : "failed",
        error: errorMessage || "",
        cursor: {
          progressPercent: completed ? 100 : Number(currentJob.progressPercent || 0),
          stage
        },
        metadata: result
          ? {
              emails: result.emails?.length || 0,
              transactions: result.transactions?.length || 0,
              people: result.people?.length || 0,
              warnings: result.warnings?.length || 0
            }
          : {}
      });
      await finishJobCheckpoint(currentJob, {
        status: completed ? "completed" : "failed",
        message: stage || (completed ? "Job completed." : cancelled ? "Job cancelled." : "Job failed."),
        metadata: {
          error: errorMessage || "",
          progressPercent: completed ? 100 : Number(currentJob.progressPercent || 0)
        }
      });
      if (completed) {
        await durableWorkflows.completeActivity(currentJob.workflowId || workflowIdForJob(currentJob), "job-execution", {
          resultSummary: result
            ? {
                emails: result.emails?.length || 0,
                transactions: result.transactions?.length || 0,
                people: result.people?.length || 0,
                warnings: result.warnings?.length || 0
              }
            : {}
        }).catch(() => null);
        await durableWorkflows.completeWorkflow(currentJob.workflowId || workflowIdForJob(currentJob), {
          status,
          jobId: currentJob.id
        }).catch(() => null);
      } else {
        const terminalMessage = errorMessage || stage || (cancelled ? "Job cancelled." : "Job failed.");
        await durableWorkflows.failActivity(currentJob.workflowId || workflowIdForJob(currentJob), "job-execution", terminalMessage).catch(() => null);
        await durableWorkflows.failWorkflow(currentJob.workflowId || workflowIdForJob(currentJob), terminalMessage).catch(() => null);
      }

      const terminalPatch = {
        status,
        stage,
        error: errorMessage,
        finishedAt,
        progressPercent: completed ? 100 : currentJob.progressPercent,
        resultSummary: result
          ? {
              emails: result.emails?.length || 0,
              transactions: result.transactions?.length || 0,
              people: result.people?.length || 0,
              warnings: result.warnings?.length || 0
            }
          : currentJob.resultSummary,
        eventType: completed ? "jobs.job.completed" : cancelled ? "jobs.job.cancelled" : "jobs.job.failed"
      };
      if (completed) {
        if (currentJob.uploadSessionId) {
          const receiptId = String(
            result?.uploadConsumptionReceiptId || ""
          ).trim();
          if (!receiptId) {
            throw Object.assign(
              new Error(
                "A durable upload-consumption receipt is required before terminal commit."
              ),
              { code: "upload_consumption_receipt_missing" }
            );
          }
          await commitTerminalThenScheduleUploadCleanup({
            jobId: currentJob.id,
            receiptId,
            sessionId: currentJob.uploadSessionId,
            terminalPatch,
            result
          });
        } else {
          if (!result) {
            throw new Error("Completed job result is unavailable.");
          }
          await commitJobTerminal(currentJob.id, terminalPatch, result);
        }
        await removeImportCheckpoint({
          userDataPath,
          batchId: currentJob.id
        });
      } else {
        await updateJob(currentJob.id, terminalPatch);
        if (currentJob.uploadSessionId) {
          logJob("warn", "jobs.upload_session.retained", {
            jobId: currentJob.id,
            reason: "job_not_completed"
          });
        }
      }
      await drainBackgroundTasks();
      activeControllers.delete(currentJob.id);
      completeQueueTask(status === "completed");
      logJob(completed ? "info" : cancelled ? "warn" : "error", "jobs.job.finalized", {
        jobId: currentJob.id,
        status,
        stage,
        errorMessage,
        finishedAt
      });
      })();
      return finalizePromise;
    };
    const runFinalizeJob = (input: FinalizeInput) => finalizeJob(input).catch((error: unknown) => {
        logJob("error", "jobs.job.finalize.failed", {
          jobId: currentJob.id,
          error: summarizeError(error)
        });
        activeControllers.delete(currentJob.id);
        completeQueueTask(false);
      });

    const activeController = {
      jobId: currentJob.id,
      stop: async () => {
        logJob("warn", "jobs.task.stop_requested", {
          jobId: currentJob.id
        });
        executionController.abort(new Error(CLOSE_ABORT_MESSAGE));
        await executionTask?.catch(() => null);
        await drainBackgroundTasks();
        await finalizeJob({
          status: "failed",
          stage: "任务已中止",
          errorMessage: CLOSE_ABORT_MESSAGE
        });
      },
      cancel: async () => {
        logJob("warn", "jobs.task.cancel_requested", { jobId: currentJob.id });
        executionController.abort(new Error("Job cancelled."));
        await executionTask?.catch(() => null);
        await drainBackgroundTasks();
        await finalizeJob({
          status: "cancelled",
          stage: "任务已取消",
          errorMessage: ""
        });
        return cloneJobForApi(currentJob);
      },
      fail: async ({ stage = "队列执行失败", errorMessage = "Queue execution failed." }: { stage?: string; errorMessage?: string } = {}) => {
        logJob("error", "jobs.task.queue_fail_requested", { jobId: currentJob.id, stage });
        executionController.abort(new Error(errorMessage));
        await executionTask?.catch(() => null);
        await drainBackgroundTasks();
        await finalizeJob({ status: "failed", stage, errorMessage });
        return cloneJobForApi(currentJob);
      },
      delete: async () => {
        logJob("warn", "jobs.task.delete_requested", {
          jobId: currentJob.id
        });
        deleted = true;
        settled = true;
        executionController.abort(new Error("Job deleted."));
        await executionTask?.catch(() => null);
        await drainBackgroundTasks();

        if (finalizePromise) {
          await finalizePromise.catch(() => null);
        }

        activeControllers.delete(currentJob.id);
        forgetActiveManifestJob(currentJob);
        jobs.delete(currentJob.id);
        if (currentJob.checkpointId) {
          checkpointJobs.delete(currentJob.checkpointId);
        }
        if (currentJob.uploadSessionId) {
          await deleteUploadSession(userDataPath, currentJob.uploadSessionId);
        }
        if (currentJob.checkpointTreeId) {
          await deleteCheckpointTree({
            userDataPath,
            treeId: currentJob.checkpointTreeId
          }).catch(() => null);
        }
        await durableWorkflows.failWorkflow(currentJob.workflowId || workflowIdForJob(currentJob), "Job deleted.").catch(() => null);
        jobProjectionStore.delete(currentJob.id);
        await fs.rm(getJobDirectory(userDataPath, currentJob.id), {
          recursive: true,
          force: true
        });
        jobProjectionStore.settleDeletion(currentJob.id);
        await publishDeletedJobEvent(currentJob);
        completeQueueTask(false);
        logJob("info", "jobs.job.deleted", {
          jobId: currentJob.id,
          wasRunning: true
        });
        return cloneJobForApi(currentJob);
      },
      preserveForRecovery: async () => {
        if (preserveForRecoveryPromise) {
          return preserveForRecoveryPromise;
        }
        if (finalizePromise || settled || deleted) {
          await finalizePromise?.catch(() => null);
          await drainBackgroundTasks();
          return null;
        }
        preserveForRecoveryPromise = (async () => {
          preservingForRecovery = true;
          try {
            logJob("info", "jobs.task.preserve_for_recovery.started", {
              jobId: currentJob.id
            });
            executionController.abort(new Error(RECOVERY_STAGE_MESSAGE));
            await executionTask?.catch(() => null);
            await drainBackgroundTasks();
            if (settled || deleted) {
              return null;
            }
            await updateJobCheckpointNode(currentJob, {
              nodeId: "job-execution",
              parentId: "import-parse-job",
              label: RECOVERY_STAGE_MESSAGE,
              status: "paused",
              cursor: {
                progressPercent: Number(currentJob.progressPercent || 0),
                stage: currentJob.stage || ""
              }
            });
            await finishJobCheckpoint(currentJob, {
              status: "paused",
              message: RECOVERY_STAGE_MESSAGE,
              metadata: {
                progressPercent: Number(currentJob.progressPercent || 0),
                stage: currentJob.stage || ""
              }
            });
            await updateJob(currentJob.id, {
              status: "queued",
              stage: RECOVERY_STAGE_MESSAGE,
              error: "",
              finishedAt: undefined,
              eventType: "jobs.job.recovered"
            });
            preservedForRecovery = true;
            await durableWorkflows.recordSignal(currentJob.workflowId || workflowIdForJob(currentJob), "job.preserve_for_recovery", {
              jobId: currentJob.id,
              progressPercent: Number(currentJob.progressPercent || 0),
              stage: currentJob.stage || ""
            }).catch(() => null);
            await durableWorkflows.recoverWorkflow(currentJob.workflowId || workflowIdForJob(currentJob), {
              reason: "job_execution_preserved_for_recovery"
            }).catch(() => null);
            activeControllers.delete(currentJob.id);
            completeQueueTask(false);
            logJob("info", "jobs.task.preserve_for_recovery.completed", {
              jobId: currentJob.id
            });
          } catch (error) {
            preserveForRecoveryPromise = null;
            throw error;
          } finally {
            preservingForRecovery = false;
          }
        })();
        return preserveForRecoveryPromise;
      }
    };
    activeControllers.set(currentJob.id, activeController);

    const preserveForLostLease = async (reason = "queue_lease_unavailable") => {
      logJob("warn", "jobs.task.queue_lease_lost", {
        jobId: currentJob.id,
        reason
      });
      await activeController.preserveForRecovery();
      return false;
    };
    const assertQueueLease = async (reason = "") => {
      if (nextEntry.signal?.aborted) {
        throw new Error("Queue execution lease is unavailable.");
      }
      if (typeof nextEntry.leaseGuard === "function") {
        await nextEntry.leaseGuard({ reason });
      }
      if (nextEntry.signal?.aborted) {
        throw new Error("Queue execution lease is unavailable.");
      }
    };
    const runGuardedFinalizeJob = async (input: FinalizeInput) => {
      try {
        await assertQueueLease("job_terminal_fence");
      } catch {
        if (preservingForRecovery || preservedForRecovery || executionController.signal.aborted) {
          return false;
        }
        return preserveForLostLease();
      }
      if (executionController.signal.aborted || preservingForRecovery || preservedForRecovery || deleted) {
        return false;
      }
      return runFinalizeJob(input);
    };
    const abortFromQueueLease = () => {
      void preserveForLostLease().catch((error: unknown) => {
        logJob("error", "jobs.task.queue_lease_preserve.failed", {
          jobId: currentJob.id,
          error: summarizeError(error)
        });
        completeQueueTask(false);
      });
    };
    nextEntry.signal?.addEventListener?.("abort", abortFromQueueLease, { once: true });
    void queueTaskPromise.finally(() => {
      nextEntry.signal?.removeEventListener?.("abort", abortFromQueueLease);
    });
    if (nextEntry.signal?.aborted) abortFromQueueLease();

    const preserveIfClosing = async () => {
      if (!state.closed && !preservedForRecovery) {
        return false;
      }
      await activeController.preserveForRecovery();
      return true;
    };

    if (await preserveIfClosing()) {
      return queueTaskPromise;
    }

    await updateJobCheckpointNode(currentJob, {
      nodeId: "queued",
      parentId: "import-parse-job",
      label: "等待后台任务",
      status: "completed",
      cursor: {
        taskConcurrency
      }
    });
    if (await preserveIfClosing()) {
      return queueTaskPromise;
    }
    await updateJobCheckpointNode(currentJob, {
      nodeId: "start-execution",
      parentId: "import-parse-job",
      label: "启动后台任务",
      status: "completed",
      metadata: {}
    });
    if (await preserveIfClosing()) {
      return queueTaskPromise;
    }
    await updateJobCheckpointNode(currentJob, {
      nodeId: "job-execution",
      parentId: "import-parse-job",
      label: "后台任务执行",
      status: "running",
      cursor: {
        progressPercent: 3,
        stage: "后台任务已启动"
      }
    });
    if (await preserveIfClosing()) {
      return queueTaskPromise;
    }

    await updateJob(currentJob.id, {
        status: "running",
        stage: "后台任务已启动",
        startedAt: new Date().toISOString(),
        finishedAt: undefined,
        error: "",
        progressPercent: 3,
        eventType: "jobs.job.started"
      });
    if (await preserveIfClosing()) {
      return queueTaskPromise;
    }
    logJob("info", "jobs.task.started", {
      jobId: currentJob.id
    });
    const reportProgress = (message: { progressPercent?: number; stage?: string } = {}) => {
      if (settled || deleted || preservingForRecovery || preservedForRecovery || executionController.signal.aborted) {
        logJob("debug", "jobs.task.progress.ignored", {
          jobId: currentJob.id,
          reason: settled ? "settled" : deleted ? "deleted" : "task_cancelled"
        });
        return;
      }
      logJob("debug", "jobs.task.progress", {
        jobId: currentJob.id,
        progressPercent:
          typeof message.progressPercent === "number"
            ? message.progressPercent
            : currentJob.progressPercent,
        stage: message.stage || "处理中"
      });
      trackBackgroundTask("task-progress", Promise.all([
          updateJobCheckpointNode(currentJob, {
            nodeId: "job-execution",
            parentId: "import-parse-job",
            label: message.stage || "处理中",
            status: "running",
            cursor: {
              progressPercent:
                typeof message.progressPercent === "number"
                  ? message.progressPercent
                  : currentJob.progressPercent,
              stage: message.stage || "处理中"
            }
          }),
          updateJob(currentJob.id, {
            stage: message.stage || "处理中",
            progressPercent:
              typeof message.progressPercent === "number"
                ? message.progressPercent
                : currentJob.progressPercent,
            eventType: "jobs.job.progress"
          }),
          durableWorkflows.heartbeatActivity(currentJob.workflowId || workflowIdForJob(currentJob), "job-execution", {
            progressPercent:
              typeof message.progressPercent === "number"
                ? message.progressPercent
                : currentJob.progressPercent,
            stage: message.stage || "处理中"
          }).catch(() => null),
        ]));
    };

    if (!storageProvider) {
      throw new Error("Job storage provider is unavailable.");
    }
    executionTask = runSplitJob(userDataPath, nextEntry.payload, {
      jobId: currentJob.id,
      runtimeOptions: resolveCurrentRuntimeOptions(),
      uploadSessionStore: uploadSessionStore || undefined,
      storageProvider,
      signal: executionController.signal,
      onProgress: reportProgress
    }).then(async (result) => {
      if (executionController.signal.aborted || deleted || preservingForRecovery || preservedForRecovery) {
        return false;
      }
      logJob("info", "jobs.task.completed", {
        jobId: currentJob.id,
        resultSummary: {
          emails: result?.emails?.length || 0,
          transactions: result?.transactions?.length || 0,
          people: result?.people?.length || 0,
          warnings: result?.warnings?.length || 0
        }
      });
      await runGuardedFinalizeJob({
        status: "completed",
        stage: "任务已完成",
        result
      });
      return true;
    }).catch(async (error: unknown) => {
      if (executionController.signal.aborted || deleted || preservingForRecovery || preservedForRecovery || settled) {
        return false;
      }
      const errorMessage = error instanceof Error ? error.message : "后台任务执行失败。";
      logJob("error", "jobs.task.failed", {
        jobId: currentJob.id,
        error: summarizeError(error)
      });
      await runGuardedFinalizeJob({
        status: "failed",
        stage: "执行失败",
        errorMessage
      });
      return false;
    });

    return queueTaskPromise;
  }

  return startQueuedJob;
}
