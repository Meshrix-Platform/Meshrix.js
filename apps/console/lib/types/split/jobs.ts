import type { UnifiedRegistrationRecord } from "../ops";

export type SplitJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type SplitJob = {
  id: string;
  status: SplitJobStatus;
  queueId?: string;
  unifiedRegistration?: UnifiedRegistrationRecord;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  progressPercent: number;
  stage: string;
  checkpointTreeId?: string;
  checkpointId?: string;
  archiveBatchId?: string;
  uploadSessionId?: string;
  versionGroupId?: string;
  versionNumber?: number;
  parentJobId?: string;
  reparseFromJobId?: string;
  queueState?: Record<string, unknown>;
  error?: string;
  resultSummary?: {
    emails: number;
    transactions: number;
    people: number;
    warnings: number;
  };
};

export type SplitJobListResponse = {
  summary: {
    totalCount: number;
    queuedCount: number;
    runningCount: number;
    completedCount: number;
    failedCount: number;
    cancelledCount: number;
  };
  items: SplitJob[];
};
