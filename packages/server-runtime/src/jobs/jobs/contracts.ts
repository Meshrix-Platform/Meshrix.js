export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type QueueStatus = "pending" | "leased" | "retry_wait" | "dead_letter";

export interface UploadConsumptionStorageProvider {
  commitUploadConsumptionReceipt(...args: unknown[]): Promise<unknown> | unknown;
  getUploadConsumptionReceipt?(...args: unknown[]): Promise<{ receiptId?: string; sessionId?: string } | null> | { receiptId?: string; sessionId?: string } | null;
}

export interface JobOwner {
  subjectId?: string;
  userId?: string;
  username?: string;
  tenantId?: string;
}

export interface CheckpointFile {
  name?: string;
  path?: string;
  relativePath?: string;
  objectId?: string;
  digest?: string;
  sha256?: string;
  size?: number;
  byteCount?: number;
  byteSize?: number;
}

export interface CheckpointReceipt {
  checkpointId?: string;
  manifestSha256?: string;
  manifestDigest?: string;
  archiveBatchId?: string;
  versionGroupId?: string;
  batchId?: string;
  clientBatchId?: string;
  inputDigest?: string;
  files?: CheckpointFile[];
  fileSamples?: CheckpointFile[];
  [key: string]: unknown;
}

/** Durable, controller-facing job document. Unknown extension fields remain data, never executable values. */
export interface JobDocument {
  id: string;
  status: JobStatus;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  stage?: string;
  progress?: number;
  error?: string | null;
  archiveBatchId?: string;
  checkpointId?: string;
  manifestSha256?: string;
  batchId?: string;
  clientBatchId?: string;
  inputDigest?: string;
  versionGroupId?: string;
  parentJobId?: string;
  workflowId?: string;
  queueTaskId?: string;
  uploadSessionId?: string;
  progressPercent?: number;
  workspaceId?: string;
  workspace_id?: string;
  workspace?: string;
  ownerTenantId?: string;
  checkpointTreeId?: string;
  versionNumber?: number;
  reparseFromJobId?: string;
  workItemId?: string;
  stageCode?: string;
  errorCode?: string;
  payload?: JobPayload;
  owner?: JobOwner;
  ownerSubjectId?: string;
  ownerUserId?: string;
  ownerUsername?: string;
  ownerRoleId?: string;
  createdBySubjectId?: string;
  createdByUserId?: string;
  createdBy?: string;
  checkpointReceipt?: CheckpointReceipt | null;
  checkpoint?: CheckpointReceipt;
  result?: JobResult;
  resultSummary?: Record<string, unknown>;
  unifiedRegistration?: unknown;
  gatewaySource?: { sourceId?: string };
  trace?: unknown;
  eventType?: string;
  uploadConsumptionReceiptId?: string;
  [key: string]: unknown;
}

export interface JobResult {
  status?: string;
  jobId?: string;
  receiptId?: string;
  uploadSessionId?: string;
  emails?: unknown[];
  transactions?: unknown[];
  people?: unknown[];
  warnings?: unknown[];
  [key: string]: unknown;
}

export interface JobPayload {
  id?: string;
  owner?: JobOwner;
  ownerSubjectId?: string;
  ownerUserId?: string;
  ownerUsername?: string;
  createdBySubjectId?: string;
  createdByUserId?: string;
  createdBy?: string;
  checkpointReceipt?: CheckpointReceipt;
  checkpoint?: CheckpointReceipt;
  checkpointId?: string;
  manifestSha256?: string;
  archiveBatchId?: string;
  batchId?: string;
  clientBatchId?: string;
  inputDigest?: string;
  versionGroupId?: string;
  parseVersionGroupId?: string;
  reparseFromJobId?: string;
  parentJobId?: string;
  forceNewVersion?: boolean | number | string;
  reparse?: boolean | number | string;
  createNewVersion?: boolean | number | string;
  uploadSessionId?: string;
  ownerRoleId?: string;
  ownerTenantId?: string;
  workspaceId?: string;
  workspace?: string;
  gatewaySource?: { sourceId?: string };
  [key: string]: unknown;
}

export function isJobPayload(value: unknown): value is JobPayload {
  return isObjectRecord(value);
}

export interface CodedError extends Error {
  code?: string;
  statusCode?: number;
  jobId?: string;
  retryable?: boolean;
  [key: string]: unknown;
}

export interface ArtifactHandle {
  journalId: string;
}

export interface JobProjectionStorePort {
  readonly policy: {
    maxJobMetadataBytes: number;
    maxPayloadBytes: number;
    maxResultBytes: number;
    [key: string]: number;
  };
  upsert(job: JobDocument): JobDocument;
  get(jobId: string): JobDocument | null;
  getArtifactInfo(jobId: string): {
    payloadDigest?: string;
    payloadBytes?: number;
    resultDigest?: string;
    resultBytes?: number;
    [key: string]: unknown;
  } | null;
  beginArtifact(input: {
    jobId: string;
    kind: "payload" | "result";
    finalRef: string;
    digest: string;
    byteSize: number;
    job?: JobDocument;
  }): ArtifactHandle;
  publishArtifact(journalId: string): void;
  settleArtifact(journalId: string): void;
  abortArtifact(journalId: string): void;
}

export interface JobAccess {
  jobIds?: readonly string[];
  workspaceIds?: readonly string[];
  principalIds?: readonly string[];
}

export interface QueueEntry {
  jobId: string;
  payload?: JobPayload;
  signal?: AbortSignal | null;
  leaseGuard?: ((input: { reason: string }) => Promise<void>) | null;
  leaseId?: string;
  [key: string]: unknown;
}

export type JobPatch = Partial<JobDocument>;

export interface ActiveJobController {
  stop(): Promise<unknown>;
  cancel(): Promise<unknown>;
  fail(input?: { stage?: string; errorMessage?: string }): Promise<unknown>;
  delete(): Promise<unknown>;
  preserveForRecovery(): Promise<unknown>;
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isJobDocument(value: unknown): value is JobDocument {
  if (!isObjectRecord(value)) return false;
  const status = value.status;
  return typeof value.id === "string" &&
    (status === "queued" || status === "running" || status === "completed" ||
      status === "failed" || status === "cancelled");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "");
}

export function errorProperty(error: unknown, key: string): unknown {
  return isObjectRecord(error) ? error[key] : undefined;
}
