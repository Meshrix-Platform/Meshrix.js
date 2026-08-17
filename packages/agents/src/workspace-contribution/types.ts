export type JsonPrimitive = string | number | boolean | null | undefined;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}
export type ContributionType =
  "gatewayPolicy" | "tool" | "script" | "file" | "sourceCode" | "codeChange";
export type ContributionVisibility =
  "private" | "workspace" | "public" | "restricted";
export interface ContributionMetrics extends JsonObject {
  acceptedCount: number;
  usageCount: number;
  successfulUseCount: number;
  uniqueWorkspaceAdoptions: number;
  executionCount: number;
  permissionRequestCount: number;
  permissionGrantCount: number;
  downloadCount: number;
  reviewCount: number;
  revocationCount: number;
  rollbackCount: number;
  maintenanceFreshness: number;
  successRate: number;
  rankScore: number;
}
export interface AssetRecord extends JsonObject {
  assetId: string;
  contributionId: string;
  workspaceId: string;
  sourceWorkspaceId: string;
  contributionType: string;
  bucket: string;
  relation: string;
  lifecycleState: string;
  assetPath: string;
  manifestHash: string;
  payloadRefs: JsonValue[];
  createdAt: string;
  updatedAt: string;
}
export interface ContributionEvent extends JsonObject {
  workspaceId?: string;
  targetWorkspaceId?: string;
  status?: string;
  state?: string;
  action?: string;
  runId?: string;
}
export interface ExecutionReceipt extends ContributionEvent {
  receiptId: string;
  runId: string;
  workloadKind: string;
  status: string;
  workloadArtifactDigest: string;
  inputDigest: string;
  packageDigest: string;
  policyDigest: string;
  cleanupStatus: string;
  outputDisposition: string;
  reasonCode: string;
  failureStage: string;
  workspaceId: string;
  createdAt: string;
}
export interface Contribution extends JsonObject {
  protocolVersion: string;
  contributionId: string;
  workspaceId: string;
  organizationId: string;
  projectId: string;
  dataClass: string;
  retention: JsonObject;
  legalHold: JsonObject;
  externalCollaboratorIds: JsonValue[];
  copyPolicy: string;
  contributorId: string;
  contributorKind: string;
  sourceAgentId: string;
  sourceAgentKind: string;
  sourceWorkspaceIds: JsonValue[];
  targetWorkspaceIds: JsonValue[];
  contributionType: string;
  title: string;
  payloadRefs: JsonValue[];
  packageSize: number;
  packageChecksum: string;
  declaredPermissions: JsonValue[];
  toolSchemaRef: string;
  scriptRefs: JsonValue[];
  fileRefs: JsonValue[];
  sourceCodeRefs: JsonValue[];
  codeChangeRefs: JsonValue[];
  gatewayPolicyRefs: JsonValue[];
  license: string;
  risk: string;
  requestedVisibility: ContributionVisibility;
  requestedActions: JsonValue[];
  reviewPolicy: JsonObject;
  status: string;
  statusHistory: ContributionEvent[];
  metrics: ContributionMetrics;
  grants: ContributionEvent[];
  permissionRequests: ContributionEvent[];
  downloadEvents: ContributionEvent[];
  usageEvents: ContributionEvent[];
  executionReceipts: ExecutionReceipt[];
  reviews: ContributionEvent[];
  adoptions: ContributionEvent[];
  assetRecords: AssetRecord[];
  currentAssetRef: AssetRecord | null;
  auditIds: JsonValue[];
  createdAt: string;
  updatedAt: string;
}
export interface AuditEvent extends JsonObject {
  auditId: string;
  eventType: string;
  workspaceId: string;
  payload: JsonObject;
  createdAt: string;
}
export interface LifecycleMatrixEntry extends JsonObject {
  from: string;
  event: string;
  result: string;
  to?: string;
  errorCode?: string;
}
export interface LifecycleDefinition extends JsonObject {
  machineId: string;
  entityType: string;
  version: string;
  description: string;
  initialState: string;
  states: JsonObject[];
  events: JsonObject[];
  allowedTerminalEvents: JsonValue[];
  invariants: JsonValue[];
  proofObligations: JsonValue[];
  proofMappings: JsonObject[];
  totalMatrix: LifecycleMatrixEntry[];
}
export interface CodedError extends Error {
  code?: string;
}
export interface RegistryInput {
  [key: string]: JsonValue;
  workspaceId?: JsonValue;
  targetWorkspaceId?: JsonValue;
  contributionId?: JsonValue;
  contributionType?: JsonValue;
  actorId?: JsonValue;
  reason?: JsonValue;
  receipt?: JsonValue;
  scanReceipt?: JsonValue;
}
export type AssetRecordProjector = (record: JsonObject) => AssetRecord;
export type AssetBucketResolver = (contributionType: unknown) => string;
export type ContributionNormalizer = (
  input?: unknown,
  defaults?: unknown,
) => Contribution;
export interface PluginDataWriter {
  writeFile(
    relativePath: string,
    value: string,
    encoding: "utf8",
  ): void | Promise<void>;
}
export type PersistenceScheduler = (write: () => void | Promise<void>) => void;
export interface AssetMaterializationContext {
  persistenceEnabled?: boolean;
  userDataPath?: string;
  lifecycleState?: string;
  targetWorkspaceId?: string;
  relation?: string;
  actorId?: JsonValue;
  reason?: JsonValue;
  assetBucketResolver?: AssetBucketResolver;
  assetBuckets?: readonly string[];
  assetRecordProjector?: AssetRecordProjector;
  pluginData?: PluginDataWriter | null;
  schedulePersistence?: PersistenceScheduler | null;
}
export type AssetMaterializer = (
  contribution: Contribution,
  input?: AssetMaterializationContext,
) => AssetRecord;
export interface ContributionRegistryOptions {
  workspaceId?: string;
  userDataPath?: string;
  registryRelativePath?: string;
  initialPersistedState?: unknown;
  schedulePersistence?: PersistenceScheduler | null;
  pluginData?: PluginDataWriter | null;
  materializeAsset?: AssetMaterializer | null;
  lifecycleDefinition?: LifecycleDefinition;
  excludedContributionTypes?: readonly unknown[];
  contributionNormalizer?: ContributionNormalizer;
  assetRecordProjector?: AssetRecordProjector;
  assetBucketResolver?: AssetBucketResolver;
  assetBuckets?: readonly string[];
}
export interface TransitionDecision extends JsonObject {
  to: string;
  event: string;
  idempotent: boolean;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "boolean"
  )
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
export function asJsonObject(value: unknown): JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue)
    ? (value as JsonObject)
    : {};
}
export function isContribution(value: unknown): value is Contribution {
  return (
    isJsonValue(value) &&
    isRecord(value) &&
    typeof value.contributionId === "string" &&
    typeof value.workspaceId === "string" &&
    typeof value.status === "string" &&
    isRecord(value.metrics) &&
    Array.isArray(value.statusHistory) &&
    Array.isArray(value.assetRecords)
  );
}
