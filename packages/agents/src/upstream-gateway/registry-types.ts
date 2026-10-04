import type { TagRecordInput } from "@meshrix/foundation/security/authorization/tag-tree";
import type { ClaimFinalProtectedSinkAttemptOptions } from "@meshrix/foundation/security/final-protected-sink-permit";
import type { LocalSecretKeyProvider } from "@meshrix/foundation/security/secrets/local-secret-key-provider";
import type {
  UpstreamRequestRepresentationMode,
  UpstreamResponseRepresentationMode
} from "@meshrix/contracts/upstream-service-publishing";
import type { UpstreamSchemaPort } from "./schema-port.ts";

/**
 * Explicit types for the upstream gateway registry's public factory, its
 * cross-package ports and its single-owned runtime state. Unknown external
 * input stays `unknown` until the existing normalization narrows it.
 */

export type UpstreamGatewayServiceProtocol = "http" | "mcp";
export type UpstreamGatewayOperationProtocol = "http" | "json-rpc" | "mcp";
export type UpstreamGatewayRisk = "read_only" | "safe_write" | "repair_write" | "destructive";
export type UpstreamGatewaySessionPurpose = "discovery" | "execution" | "health";

export interface UpstreamGatewayTrafficPolicy {
  algorithm: string;
  routingAlgorithm: string;
  perMinute: number;
  burst: number;
  maxConcurrent: number;
}

export interface UpstreamGatewayCircuitBreaker {
  enabled: boolean;
  failureThreshold: number;
  cooldownMs: number;
}

export interface UpstreamGatewayCredentialReference {
  type: string;
  reference: string;
  revision: number;
  use: string;
  operationKey: string;
  host: string;
  protocol: string;
  scopes: string[];
}

export interface UpstreamGatewayTagEntityRef {
  entityType: string;
  entityId: string;
}

export interface UpstreamGatewayTagPolicy {
  entityRefs: UpstreamGatewayTagEntityRef[];
  entities?: UpstreamGatewayTagEntityRef[];
  denyTags: string[];
  allowTags: string[];
  requiredTags: string[];
  policyRevision: number;
  failOnStale: boolean;
  requireFreshRevision: boolean;
}

export interface UpstreamGatewayMcpConfig {
  protocolVersion: string;
  transport: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  protocolVersionHint: string;
  toolNamePrefix: string;
  toolsCacheTtlMs: number;
  timeoutMs?: number;
}

export interface UpstreamGatewayEndpointRecord {
  endpointId: string;
  baseUrl: string;
  weight: number;
  disabled?: boolean;
  trafficPolicy: UpstreamGatewayTrafficPolicy;
  trafficPolicySource: string;
  trafficPolicyInherited: boolean;
  circuitBreaker: UpstreamGatewayCircuitBreaker;
  circuitBreakerSource: string;
  circuitBreakerInherited: boolean;
}

export interface UpstreamGatewayCompiledPayloadTransport {
  readonly request: Readonly<{
    mode: UpstreamRequestRepresentationMode;
    maxBytes: number;
    mediaTypes: readonly string[];
    artifactArgument?: string;
    multipart?: Readonly<Record<string, unknown>>;
  }>;
  readonly response: Readonly<{
    mode: UpstreamResponseRepresentationMode;
    maxBytes: number;
    mediaTypes: readonly string[];
    allowRanges: boolean;
  }>;
}

export interface UpstreamGatewayOperationCapability {
  schemaVersion: string;
  capabilityId: string;
  tupleCapabilityIds: string[];
  serviceId: string;
  operationKey: string;
  upstreamToolName: string;
  protocol: string;
  risk: UpstreamGatewayRisk;
  requiredScopes: string[];
  toolsets: string[];
  approvalPolicy: Readonly<{
    requiresApproval: boolean;
    approvalScope: string;
    requiredApproval: Readonly<Record<string, unknown>>;
  }>;
  credentialBindingIds: string[];
  resourceContext: Readonly<Record<string, unknown>>;
}

/**
 * Operator-declared approval payload. Its members are descriptor-defined, so
 * only the known `approvalLayers` entry is modeled here.
 */
export interface UpstreamGatewayRequiredApproval {
  approvalLayers?: readonly string[];
  readonly [member: string]: unknown;
}

export interface UpstreamGatewayOperationRecord {
  operationKey: string;
  label: string;
  protocol: UpstreamGatewayOperationProtocol;
  method: string;
  path: string;
  requiredScopes: string[];
  risk: UpstreamGatewayRisk;
  requiresApproval: boolean;
  approvalScope: string;
  requiredApproval: UpstreamGatewayRequiredApproval;
  timeoutMs?: number;
  responseMaxBytes: number;
  jsonRpcMethod: string;
  sensitiveBodyFields: string[];
  publicResponseFields: string[];
  requestSchema: Readonly<Record<string, unknown>>;
  responseSchema: Readonly<Record<string, unknown>>;
  payloadTransport?: UpstreamGatewayCompiledPayloadTransport;
  dynamicCapability?: UpstreamGatewayOperationCapability;
  resourceContext?: Readonly<Record<string, unknown>>;
  safety?: Readonly<{ risk?: string; approvalScope?: string }>;
  inputSchema?: unknown;
  toolName?: string;
  upstreamToolName?: string;
}

/** Result of descriptor normalization before runtime provenance is attached. */
export interface UpstreamGatewayNormalizedService {
  protocolVersion: string;
  serviceId: string;
  serviceProtocol: UpstreamGatewayServiceProtocol;
  label: string;
  description: string;
  baseUrl: string;
  endpoints: UpstreamGatewayEndpointRecord[];
  healthPath: string;
  disabled: boolean;
  allowLocalNetwork: boolean;
  visibility: string;
  dataClass: string;
  ownerSubjectId: string;
  tags: string[];
  credentialRefs: string[];
  credentialReferences: UpstreamGatewayCredentialReference[];
  tagPolicy: UpstreamGatewayTagPolicy | null;
  redactedCredentialInput: boolean;
  defaultHeaders: Record<string, string>;
  mcp?: UpstreamGatewayMcpConfig;
  trafficPolicy: UpstreamGatewayTrafficPolicy;
  circuitBreaker: UpstreamGatewayCircuitBreaker;
  operations: UpstreamGatewayOperationRecord[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A service as it exists in the registry after a manifest snapshot commit.
 * The durable revision identity is part of the runtime record, not the
 * descriptor normalization result.
 */
export interface UpstreamGatewayServiceRecord extends UpstreamGatewayNormalizedService {
  manifestDigest: string;
  serviceRevision: number;
}

export type UpstreamGatewayExistingService = Partial<UpstreamGatewayNormalizedService> & {
  readonly [member: string]: unknown;
};

export interface UpstreamGatewayPublicMcpConfig {
  protocolVersion: string;
  transport: string;
  commandRef: string;
  argCount: number;
  envCount: number;
  urlRef: string;
  headerCount: number;
  toolNamePrefix: string;
  toolsCacheTtlMs: number;
  timeoutMs?: number;
}

/** Traffic-controller view of the selected endpoint (redacted routing facts). */
export interface UpstreamGatewayPublicEndpoint {
  endpointId: string;
  weight: number;
  circuitBreakerEnabled: boolean;
  trafficPolicySource: string;
  circuitBreakerSource: string;
}

/** Service projection view of a configured endpoint. */
export interface UpstreamGatewayServiceEndpointView {
  endpointId: string;
  endpointRef: string;
  endpointRedacted: boolean;
  weight: number;
  disabled: boolean;
  trafficPolicy: UpstreamGatewayTrafficPolicy;
  trafficPolicySource: string;
  trafficPolicyInherited: boolean;
  circuitBreaker: UpstreamGatewayCircuitBreaker;
  circuitBreakerSource: string;
  circuitBreakerInherited: boolean;
}

export interface UpstreamGatewayPublicService
  extends Omit<
    UpstreamGatewayNormalizedService,
    "baseUrl" | "endpoints" | "mcp" | "credentialRefs" | "credentialReferences"
  > {
  credentialBindingIds: readonly string[];
  credentialReferenceCount: number;
  redactedCredentialInput: boolean;
  defaultHeaders: Readonly<Record<string, string>>;
  baseUrl: "";
  endpointRef: string;
  endpointRedacted: boolean;
  endpoints: readonly UpstreamGatewayServiceEndpointView[];
  endpointCount: number;
  mcp?: UpstreamGatewayPublicMcpConfig;
  manifestDigest: string;
  serviceRevision: number;
}

/** Projected MCP tool as published to downstream MCP clients. */
export interface UpstreamGatewayPublicMcpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations: Readonly<Record<string, unknown>>;
  _meta: Readonly<Record<string, unknown>>;
}

export interface UpstreamGatewayPublicTagPolicy {
  enabled: boolean;
  allowed: boolean;
  reasonCode: string;
  entityRefs: readonly unknown[];
  policyRevision: unknown;
  inputPolicyRevision: number;
  stale: boolean;
  matchedDenyTags: string[];
  matchedAllowTags: string[];
  missingRequiredTags: string[];
}

export interface UpstreamGatewayDynamicAuthorization {
  allowed: boolean;
  reasonCode: string;
  capabilityId?: string;
}

export interface UpstreamGatewayCircuitSnapshot {
  open: boolean;
  consecutiveFailures: number;
  openedUntil: string;
  retryAfterMs: number;
}

export interface UpstreamGatewayTrafficLimit {
  perMinute: number;
  burst: number;
  maxConcurrent: number;
  remainingTokens: number;
  inFlight: number;
}

export interface UpstreamGatewayTrafficDecision {
  allowed: boolean;
  algorithm: string;
  routingAlgorithm: string;
  endpoint: UpstreamGatewayPublicEndpoint | null;
  circuit: UpstreamGatewayCircuitSnapshot;
  perMinute: number;
  burst: number;
  maxConcurrent: number;
  remainingTokens: number;
  inFlight: number;
  serviceLimit: UpstreamGatewayTrafficLimit;
  endpointLimit: UpstreamGatewayTrafficLimit | null;
  retryAfterMs: number;
  resetAt: string;
  deniedReason: string;
  deniedScope: string;
}

export interface UpstreamGatewayForwardPreviewTraffic {
  allowed: boolean;
  algorithm: string;
  routingAlgorithm: string;
  endpoint: UpstreamGatewayPublicEndpoint | null;
  circuit: UpstreamGatewayCircuitSnapshot;
  perMinute: number;
  burst: number;
  maxConcurrent: number;
  remainingTokens: number;
  inFlight: number;
  serviceLimit: UpstreamGatewayTrafficLimit;
  endpointLimit: UpstreamGatewayTrafficLimit | null;
  retryAfterMs: number;
  deniedReason: string;
  deniedScope: string;
  resetAt: string;
}

export interface UpstreamGatewayForwardPreview {
  protocolVersion: string;
  serviceId: string;
  operationKey: string;
  allowed: boolean;
  disabled: boolean;
  requiredScopes: readonly string[];
  missingScopes: readonly string[];
  risk: UpstreamGatewayRisk;
  dynamicCapability: UpstreamGatewayOperationCapability;
  dynamicAuthorization: UpstreamGatewayDynamicAuthorization;
  requiresApproval: boolean;
  traffic: UpstreamGatewayForwardPreviewTraffic;
  tagPolicy: UpstreamGatewayPublicTagPolicy;
}

export interface UpstreamGatewayTagPolicyEvaluation {
  allowed: boolean;
  decision?: Readonly<Record<string, unknown>>;
  public:
    | UpstreamGatewayPublicTagPolicy
    | Readonly<{ enabled: boolean; allowed: boolean }>;
}

export interface UpstreamGatewayStructuredTargetFacts {
  targetUrl: URL | null;
  method: string;
  protocol: string;
  rpcMethod: string;
  targetSelector: Readonly<Record<string, unknown>>;
  effect: Readonly<Record<string, unknown>>;
  resourceRevision: string;
}

// ── Cross-package ports ──────────────────────────────────────────────────

export interface UpstreamGatewaySecurityPermissionsPort {
  tagManagementStore?: UpstreamGatewayTagStorePort | null;
}

/**
 * Structural view of the tag store consumed by the shared universal tag
 * policy evaluator. The runtime implementation owns the revision source.
 */
export interface UpstreamGatewayTagStorePort {
  getTag(tagId: string): TagRecordInput | null | undefined;
  listProjections(input: { entityType: string; includeArchived: boolean }): Array<{
    entityId?: unknown;
    tagId?: unknown;
  }>;
  getPolicyRevision?(): unknown;
}

/** The credential resolver only selects by operation key and scopes. */
export interface UpstreamGatewayOperationSelection {
  readonly operationKey?: unknown;
  readonly requiredScopes?: unknown;
}

export interface UpstreamGatewayArtifactResource {
  byteLength: number;
  sha256: string;
  name?: string;
  mediaType?: string;
}

export interface UpstreamGatewayArtifactMetadata {
  name: string;
  mediaType: string;
  byteLength: number;
}

export interface UpstreamGatewayArtifactTransaction {
  writable: NodeJS.WritableStream;
}

export interface UpstreamGatewayArtifactTransitPort {
  openRead(
    reference: string,
    subject: Readonly<Record<string, unknown>>,
    mode: "download",
    range?: { start: number; end: number }
  ): Promise<{ open(): NodeJS.ReadableStream }>;
  beginWrite(
    subject: Readonly<Record<string, unknown>>,
    descriptor: { name: string; mediaType: string },
    options: { maxBytes: number }
  ): Promise<UpstreamGatewayArtifactTransaction>;
  commit(
    transaction: UpstreamGatewayArtifactTransaction,
    facts: { byteLength: number; sha256: string }
  ): Promise<UpstreamGatewayArtifactResource>;
  abort(transaction: UpstreamGatewayArtifactTransaction, reason: string): Promise<unknown>;
  resolve(
    reference: string,
    subject: Readonly<Record<string, unknown>>,
    mode: "download"
  ): Promise<UpstreamGatewayArtifactMetadata>;
}

export interface UpstreamGatewayMcpSessionOptions {
  signal?: AbortSignal | null;
  onNotification?: ((notification: unknown) => void) | null;
  beforeSend?: () => Promise<void>;
  timeoutMs?: number | null;
}

export interface UpstreamGatewayMcpToolList {
  tools: readonly unknown[];
}

export interface UpstreamGatewayMcpInvocation {
  result?: unknown;
  [member: string]: unknown;
}

/**
 * Narrow view of the MCP session manager the registry owns or receives.
 * Lifecycle methods stay optional because the registry probes them.
 */
export interface UpstreamGatewayMcpSessionManagerPort {
  listTools(
    config: UpstreamGatewayResolvedMcpServiceConfig,
    options?: UpstreamGatewayMcpSessionOptions
  ): Promise<UpstreamGatewayMcpToolList>;
  invokeGateway?(
    config: UpstreamGatewayResolvedMcpServiceConfig,
    invocation: Readonly<Record<string, unknown>>,
    options?: UpstreamGatewayMcpSessionOptions
  ): Promise<UpstreamGatewayMcpInvocation>;
  retireGrantScopes?(grantId: unknown, options?: { remove?: boolean }): Promise<unknown>;
  retireServiceScopes?(serviceId?: unknown, options?: { remove?: boolean }): Promise<unknown>;
  retireScope?(serviceId?: unknown, options?: { remove?: boolean }): Promise<unknown>;
  close(): Promise<unknown>;
}

export type UpstreamProtectedSinkClaim = (
  options: ClaimFinalProtectedSinkAttemptOptions
) => Promise<unknown>;

export interface UpstreamPlatformEffectLifecyclePreparation {
  beginDispatch(): Promise<void>;
  markDispatchStarted(): void;
  finalProtectedSinkPermit?: object;
}

export interface UpstreamPlatformEffectLifecyclePort {
  prepare(input: Readonly<Record<string, unknown>>): Promise<UpstreamPlatformEffectLifecyclePreparation>;
}

export interface UpstreamSkillHubUpdate {
  readonly schemaVersion: "v0.0.1:meshrix:skill-hub-update-1";
  readonly revision: unknown;
  readonly operationId: unknown;
}

// ── Factory options and call options ─────────────────────────────────────

export interface UpstreamGatewayRegistryOptions {
  userDataPath?: string;
  tagStore?: UpstreamGatewayTagStorePort | null;
  securityPermissions?: UpstreamGatewaySecurityPermissionsPort | null;
  mcpSessionManager?: UpstreamGatewayMcpSessionManagerPort | null;
  artifactTransitPort?: UpstreamGatewayArtifactTransitPort | null;
  secretKeyProvider?: LocalSecretKeyProvider | null;
  publishSkillHubUpdate?: ((update: UpstreamSkillHubUpdate) => unknown) | null;
  /** The registry owns this port for its lifetime and closes it after active work drains. */
  schemaPort?: UpstreamSchemaPort | null;
  claimProtectedSinkAttempt?: UpstreamProtectedSinkClaim;
}

export interface UpstreamGatewayStreamResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: NodeJS.ReadableStream;
  signal: AbortSignal;
}

export interface UpstreamGatewayCallOptions {
  signal?: AbortSignal | null;
  timeoutMs?: number | null;
  subject?: Readonly<Record<string, unknown>>;
  onNotification?: ((notification: unknown) => void) | null;
  refresh?: boolean;
  countCacheHit?: boolean;
  purpose?: UpstreamGatewaySessionPurpose;
  requestState?: unknown;
  responseAdapter?: "artifact";
  consumeResponse?: (response: UpstreamGatewayStreamResponse) => Promise<void> | void;
  platformEffectLifecycle?: UpstreamPlatformEffectLifecyclePort | null;
  finalProtectedSinkPermit?: object;
  beforeSend?: () => Promise<void>;
}

export interface UpstreamGatewayAudienceEvaluationInput {
  grant?: unknown;
  restriction?: unknown;
  subject?: Readonly<Record<string, unknown>> | null;
  tool?: Readonly<Record<string, unknown>> | null;
  purpose?: UpstreamGatewaySessionPurpose;
}

export interface UpstreamGatewayAudienceDecision {
  allowed: boolean;
  reasonCode: string;
  purpose: UpstreamGatewaySessionPurpose;
  visibleMetadata: boolean;
}

// ── Credential and MCP configuration resolution ──────────────────────────

export interface UpstreamGatewayResolvedCredentialMaterial {
  headers: Record<string, string>;
  env: Record<string, string>;
  credentialRefCount: number;
  resolvedCredentialRefCount: number;
  credentialRevisions: Array<{ secretRef: string; revision: number }>;
}

export interface UpstreamGatewayMcpSessionGeneration {
  serviceRevision: number;
  credentialRevisions: readonly Readonly<{ bindingId: string; revision: number }>[];
}

export interface UpstreamGatewayResolvedMcpServiceConfig {
  protocolVersion?: unknown;
  transport?: string;
  command?: string;
  args?: readonly string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  protocolVersionHint?: string;
  toolNamePrefix?: string;
  toolsCacheTtlMs?: number;
  timeoutMs?: number;
  gatewayServiceId: string;
  allowLocalNetwork: boolean;
  sessionKey: string;
  sessionGeneration: UpstreamGatewayMcpSessionGeneration;
  sessionScope: string;
  sessionKind: "stateful" | "ephemeral";
}

// ── Single-owned runtime state ───────────────────────────────────────────

export interface UpstreamGatewayManifestRevision {
  readonly sourceRevision: number;
  readonly sourceDigest: string;
}

export interface UpstreamGatewayProjectedOperationTarget {
  readonly serviceId: string;
  readonly operationKey: string;
}

export type UpstreamGatewayManifestSnapshotEntry = readonly [string, UpstreamGatewayServiceRecord];
export type UpstreamGatewayProjectedOperationTargetEntry = readonly [
  string,
  UpstreamGatewayProjectedOperationTarget
];

export interface UpstreamGatewayManifestSnapshotState {
  readonly setRevision: number;
  readonly setDigest: string;
  readonly serviceEntries: readonly UpstreamGatewayManifestSnapshotEntry[];
  readonly projectedOperationTargets: readonly UpstreamGatewayProjectedOperationTargetEntry[];
}

/** Snapshot as observed from durable storage before the registry consumes it. */
export interface UpstreamGatewayObservedManifestSnapshot {
  readonly setRevision: number;
  readonly setDigest: string;
  readonly serviceEntries: readonly UpstreamGatewayManifestSnapshotEntry[];
  readonly serviceCount: number;
}

export interface UpstreamGatewayManifestObserverReaderPort {
  getSnapshot(input?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface UpstreamGatewayManifestObservationError {
  reasonCode: string;
  errorCode: string;
}

export interface UpstreamGatewayManifestObserverOptions {
  readerPort: UpstreamGatewayManifestObserverReaderPort;
  onSnapshot(snapshot: UpstreamGatewayObservedManifestSnapshot): Promise<unknown> | unknown;
  onError?: ((event: UpstreamGatewayManifestObservationError) => unknown) | null;
  pollIntervalMs?: number;
}

export interface UpstreamGatewayManifestObserverState {
  acceptedSetRevision: number;
  acceptedSetDigest: string;
  building: boolean;
  pending: boolean;
  closed: boolean;
}

export interface UpstreamGatewayManifestObserver {
  start(): Promise<unknown>;
  invalidate(): boolean;
  reapplyAccepted(): Promise<unknown>;
  scan(options?: { signal?: AbortSignal; force?: boolean }): Promise<unknown>;
  state(): Readonly<UpstreamGatewayManifestObserverState>;
  close(): Promise<void>;
}

export interface UpstreamGatewayManifestSnapshotCommitterOptions {
  registry: UpstreamGatewayRegistry;
  getBaseOperations?: () => readonly unknown[];
  getOperationPermissionPlatform?: () => unknown;
  getGrants?: (() => unknown) | null;
  getTagStore?: () => unknown;
  getPolicyRevision?: () => unknown;
  getTagRevision?: () => unknown;
  protocolEventBus?: { publish(topic: string, event: unknown, options?: unknown): unknown } | null;
  onAudiencePublished?: ((input: Readonly<Record<string, unknown>>) => unknown) | null;
  now?: () => string;
}

export interface UpstreamGatewayManifestSnapshotCommitter {
  commitManifestSnapshot(snapshot: unknown): Promise<unknown>;
  refreshAudienceProjection(): Promise<unknown>;
  getLastCommittedKey(): string;
  getLastMergedOperations(): readonly unknown[];
  getAudienceProjection(): unknown;
  getPublicationFacts(): unknown;
  getAudiencePartitionKeysForGrant(grantId?: unknown): readonly string[];
  getAudienceCatalogFactsForGrant(grantId?: unknown): unknown;
  isAudienceReady(): boolean;
}

export interface UpstreamGatewayManifestSnapshotDiff {  readonly setRevision: number;
  readonly setDigest: string;
  readonly added: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
}

export interface UpstreamGatewayManifestFinalizationResult {
  readonly finalized: true;
  readonly updated: number;
  readonly removed: number;
  readonly retirements: readonly unknown[];
}

export interface UpstreamGatewayMcpToolCacheEntry {
  loadedAt: number;
  tools: readonly UpstreamGatewayPublicMcpTool[];
  byPublicName: Map<string, UpstreamGatewayPublicMcpTool>;
  byUpstreamName: Map<string, UpstreamGatewayPublicMcpTool>;
}

export interface UpstreamGatewayMcpToolCacheRecord {
  cacheKey: string;
  entry: UpstreamGatewayMcpToolCacheEntry;
}

export interface UpstreamGatewayMcpToolRefreshWaiter {
  signal: AbortSignal | null;
  onNotification: ((notification: unknown) => void) | null;
}

export interface UpstreamGatewayMcpToolRefreshFlight {
  serviceId: string;
  promise: Promise<UpstreamGatewayMcpToolCacheEntry>;
  controller: AbortController;
  waiters: Set<UpstreamGatewayMcpToolRefreshWaiter>;
}

export interface UpstreamGatewayMcpToolConfigPreparation {
  controller: AbortController;
  dispose(): boolean;
}

export interface UpstreamGatewaySkillHubSubscription {
  controller: AbortController;
  cursor: number;
  ready: Promise<boolean>;
  promise: Promise<void> | null;
}

export interface UpstreamGatewayTrafficBucket {
  tokens: number;
  updatedAtMs: number;
  inFlight: number;
}

export interface UpstreamGatewayEndpointCursor {
  signature: string;
  currentWeights: Record<string, number>;
}

export interface UpstreamGatewayEndpointCircuit {
  consecutiveFailures: number;
  openedUntilMs: number;
}

export interface UpstreamGatewayEndpointTrafficSelection {
  endpoint: UpstreamGatewayEndpointRecord | null;
  traffic: UpstreamGatewayTrafficDecision;
}

export interface UpstreamEndpointTrafficControllerDependencies {
  trafficBuckets: Map<string, UpstreamGatewayTrafficBucket>;
  endpointCursors: Map<string, UpstreamGatewayEndpointCursor>;
  endpointCircuits: Map<string, UpstreamGatewayEndpointCircuit>;
  appendAudit(eventType: string, payload: Readonly<Record<string, unknown>>): unknown;
  recordMetric(input: { serviceId: string; statusCode: number; failed: boolean }): unknown;
  persist(): unknown;
}

export interface UpstreamEndpointTrafficController {
  endpointsFor(service: UpstreamGatewayServiceRecord): readonly UpstreamGatewayEndpointRecord[];
  publicEndpoint(endpoint: UpstreamGatewayEndpointRecord): UpstreamGatewayPublicEndpoint;
  recordEndpointOutcome(
    service: UpstreamGatewayServiceRecord,
    operation: UpstreamGatewayOperationRecord,
    endpoint: UpstreamGatewayEndpointRecord | null | undefined,
    outcome?: { statusCode?: number; ok?: boolean }
  ): void;
  retireServices(serviceIds?: readonly unknown[]): Readonly<{ removed: number }>;
  selectEndpointTraffic(
    service: UpstreamGatewayServiceRecord,
    operation: UpstreamGatewayOperationRecord,
    options?: { consume?: boolean }
  ): UpstreamGatewayEndpointTrafficSelection;
  withTrafficSlot<T>(
    service: UpstreamGatewayServiceRecord,
    operation: UpstreamGatewayOperationRecord,
    preview: UpstreamGatewayForwardPreview,
    run: (
      traffic: UpstreamGatewayTrafficDecision,
      endpoint: UpstreamGatewayEndpointRecord | null
    ) => Promise<T>
  ): Promise<T>;
}

export interface UpstreamGatewaySecurityAlertPort {
  appendAlert(input: Readonly<Record<string, unknown>>): unknown;
  close?(): Promise<unknown> | unknown;
}

export interface UpstreamGatewayRuntimeOptions {
  persistenceEnabled?: boolean;
  filePath?: string;
  securityAlertStore?: UpstreamGatewaySecurityAlertPort | null;
  flushBatchSize?: number;
  walMaxBytes?: number;
  auditRingLimit?: number;
  metricDimensionLimit?: number;
}

export interface UpstreamGatewayRuntime {
  auditEvents: UpstreamGatewayAuditEvent[];
  metrics: UpstreamGatewayMetricsState;
  appendAudit(eventType?: unknown, payload?: Readonly<Record<string, unknown>>): UpstreamGatewayAuditEvent;
  appendSecurityAlert(input?: Readonly<Record<string, unknown>>): null;
  recordMetric(input?: {
    serviceId?: unknown;
    statusCode?: number;
    failed?: boolean;
  }): Readonly<Record<string, unknown>>;
  persist(): Promise<UpstreamGatewayRuntimeFlushResult>;
  close(): Promise<Readonly<{ ok: true }>>;
  getRefactorInstrumentation(): UpstreamGatewayRuntimeInstrumentation;
}

// ── Durable runtime records ──────────────────────────────────────────────

export interface UpstreamGatewayMetricsState {
  totalForwardCount: number;
  totalFailureCount: number;
  byService: Record<string, number>;
  byStatus: Record<string, number>;
}

export interface UpstreamGatewayAuditEvent {
  auditId: string;
  eventType: unknown;
  serviceId: string;
  operationKey: string;
  payload: unknown;
  createdAt: string;
}

export interface UpstreamGatewayWalSeedRecord {
  schemaVersion: string;
  protocolVersion?: string;
  sequence: number;
  kind: "seed";
  auditEvents: readonly UpstreamGatewayAuditEvent[];
  metrics: UpstreamGatewayMetricsState;
  createdAt: string;
}

export interface UpstreamGatewayWalDeltaRecord {
  schemaVersion: string;
  sequence: number;
  kind: "delta";
  auditEvents: readonly UpstreamGatewayAuditEvent[];
  metrics: UpstreamGatewayMetricsState;
  createdAt: string;
}

export type UpstreamGatewayWalRecord = UpstreamGatewayWalSeedRecord | UpstreamGatewayWalDeltaRecord;

export interface UpstreamGatewayLegacyRuntimeState {
  auditEvents: UpstreamGatewayAuditEvent[];
  metrics: UpstreamGatewayMetricsState;
}

export interface UpstreamGatewayRuntimeFlushResult {
  flushed: number;
  shedMetricDimensions: number;
}

export interface UpstreamGatewayRuntimeInstrumentation {
  schemaVersion: string;
  requestPathFullStateReads: number;
  requestPathFullStateRewrites: number;
  flushedBatchCount: number;
  shedMetricDimensions: number;
  shedAuditEvents: number;
  flushFailureCount: number;
  compactionCount: number;
  recoveryReads: number;
  migrationReads: number;
  migrationWrites: number;
  walBytes: number;
  auditRingLimit: number;
  flushBatchSize: number;
  metricDimensionLimit: number;
  closed: boolean;
}

// ── Registry results ─────────────────────────────────────────────────────

export interface UpstreamGatewayServiceListResult {
  protocolVersion: string;
  items: readonly UpstreamGatewayPublicService[];
  count: number;
}

export interface UpstreamGatewayMcpToolListResult {
  protocolVersion: string;
  items: readonly UpstreamGatewayPublicMcpTool[];
  count: number;
}

export interface UpstreamGatewayMcpToolCallResult {
  protocolVersion: string;
  ok: true;
  serviceId?: string;
  operationKey: string;
  upstream: Readonly<{ protocol: "mcp"; toolName?: string }>;
  response: unknown;
  auditId: string;
}

export interface UpstreamMcpRouteForwardResult {
  status: number;
  body: unknown;
  serviceId?: string;
  upstreamToolName?: string;
  auditId?: string;
}

export interface UpstreamGatewayInvokeTypedMcpResult {
  requestId: string;
  protocolVersion: string;
  httpFailure?: unknown;
  jsonRpcError?: unknown;
  result?: unknown;
}

export interface UpstreamGatewayForwardResult {
  protocolVersion: string;
  ok: boolean;
  serviceId: string;
  operationKey: string;
  dynamicCapability?: UpstreamGatewayOperationCapability;
  upstream: Readonly<{
    status: number;
    endpoint: UpstreamGatewayPublicEndpoint;
    contentType: string;
    responseBytes: number;
    durationMs: number;
    protocol?: "mcp";
    toolName?: string;
  }>;
  response: unknown;
  resource?: unknown;
  auditId?: string;
}

export interface UpstreamGatewayPluginCallResult {
  ok: boolean;
  status: number;
  data: unknown;
  receiptRef?: string;
}

export interface UpstreamGatewayStreamForwardResult {
  ok: boolean;
  status: number;
  requestBytes: number;
  responseBytes: number;
  auditId: string;
}

export interface UpstreamGatewayArtifactDownload {
  status: number;
  headers: Readonly<Record<string, string>>;
  name: string;
  body: NodeJS.ReadableStream;
}

export interface UpstreamGatewayEndpointHealth {
  endpoint: UpstreamGatewayPublicEndpoint;
  ok: boolean;
  status: number;
}

export interface UpstreamGatewayHealthResult {
  ok: boolean;
  serviceId: string;
  status: number;
  protocol?: string;
  toolCount?: number;
  endpointCount?: number;
  healthyEndpointCount?: number;
  endpoints?: readonly UpstreamGatewayEndpointHealth[];
  latencyMs: number;
  checkedAt: string;
  error?: string;
}

export interface UpstreamGatewayAuditListResult {
  protocolVersion: string;
  items: readonly unknown[];
  count: number;
}

export interface UpstreamGatewayBoundedRuntimeState {
  trafficBucketCount: number;
  endpointCursorCount: number;
  endpointCircuitCount: number;
  mcpToolCacheCount: number;
}

export interface UpstreamGatewayMetrics {
  protocolVersion: string;
  totalForwardCount?: number;
  totalFailureCount?: number;
  byService?: Readonly<Record<string, number>>;
  byStatus?: Readonly<Record<string, number>>;
  boundedRuntimeState: UpstreamGatewayBoundedRuntimeState;
}

export interface UpstreamGatewayRefactorInstrumentation extends UpstreamGatewayRuntimeInstrumentation {
  targetedCallMapHits: number;
  targetedServiceIndexHits: number;
  serviceDiscoveryCount: number;
}

/**
 * Public registry contract. Callers may still pass `unknown` input to the
 * ingestion methods; those methods validate before narrowing, exactly as the
 * runtime did before this contract existed.
 */
export interface UpstreamGatewayRegistry {
  readonly protocolVersion: string;
  listServices(): UpstreamGatewayServiceListResult;
  getService(serviceId?: unknown): UpstreamGatewayPublicService;
  evaluateProjectedOperationAudience(
    input?: UpstreamGatewayAudienceEvaluationInput
  ): UpstreamGatewayAudienceDecision;
  evaluateDiscoveredMcpToolAudience(
    input?: UpstreamGatewayAudienceEvaluationInput
  ): UpstreamGatewayAudienceDecision;
  listMcpTools(
    input?: { serviceId?: unknown; refresh?: boolean },
    options?: UpstreamGatewayCallOptions
  ): Promise<UpstreamGatewayMcpToolListResult>;
  getMcpServiceForPublicToolName(publicName?: unknown): UpstreamGatewayPublicService | null;
  resolveMcpToolByPublicName(
    publicName?: unknown,
    options?: UpstreamGatewayCallOptions
  ): Promise<UpstreamGatewayPublicMcpTool | null>;
  callMcpToolByPublicName(
    publicName?: unknown,
    input?: Readonly<Record<string, unknown>>,
    subject?: Readonly<Record<string, unknown>>,
    options?: UpstreamGatewayCallOptions
  ): Promise<UpstreamGatewayMcpToolCallResult>;
  executePublishedMcpRoute(
    publicName?: unknown,
    input?: Readonly<Record<string, unknown>>,
    subject?: Readonly<Record<string, unknown>>,
    options?: UpstreamGatewayCallOptions
  ): Promise<UpstreamMcpRouteForwardResult>;
  previewPolicy(
    input?: { serviceId?: unknown; operationKey?: unknown },
    subject?: Readonly<Record<string, unknown>>
  ): UpstreamGatewayForwardPreview;
  health(serviceId?: unknown): Promise<UpstreamGatewayHealthResult>;
  requestPluginExternalService(
    request?: Readonly<Record<string, unknown>>,
    options?: { subject?: Readonly<Record<string, unknown>>; signal?: AbortSignal | null }
  ): Promise<UpstreamGatewayPluginCallResult>;
  previewHttpStream(
    input?: Readonly<Record<string, unknown>>,
    subject?: Readonly<Record<string, unknown>>
  ): Readonly<{ ok: true; serviceId: string; operationKey: string }>;
  forwardHttpStream(
    input?: Readonly<Record<string, unknown>>,
    subject?: Readonly<Record<string, unknown>>,
    options?: UpstreamGatewayCallOptions
  ): Promise<UpstreamGatewayStreamForwardResult>;
  openArtifactDownload(
    input?: { artifactId?: unknown; range?: unknown },
    subject?: Readonly<Record<string, unknown>>
  ): Promise<UpstreamGatewayArtifactDownload>;
  forward(
    input?: Readonly<Record<string, unknown>>,
    subject?: Readonly<Record<string, unknown>>,
    options?: UpstreamGatewayCallOptions
  ): Promise<UpstreamGatewayForwardResult>;
  listAudit(input?: { serviceId?: unknown; limit?: unknown }): UpstreamGatewayAuditListResult;
  getMetrics(): UpstreamGatewayMetrics;
  flushRuntimeState(): Promise<unknown>;
  isClosed(): boolean;
  getManifestSnapshotRevision(): UpstreamGatewayManifestRevision;
  captureManifestSnapshotState(): UpstreamGatewayManifestSnapshotState;
  restoreManifestSnapshotState(state?: unknown): Readonly<{ ok: true }>;
  replaceFromManifestSnapshot(
    snapshot?: unknown,
    options?: { deferSideEffects?: boolean }
  ): UpstreamGatewayManifestSnapshotDiff;
  retireMcpGrantScopes(grantId?: unknown, options?: { remove?: boolean }): Promise<unknown>;
  finalizeManifestSnapshot(
    diff?: UpstreamGatewayManifestSnapshotDiff
  ): Promise<UpstreamGatewayManifestFinalizationResult>;
  forwardProjectedOperation(
    operationId?: unknown,
    input?: Readonly<Record<string, unknown>>,
    subject?: Readonly<Record<string, unknown>>,
    options?: UpstreamGatewayCallOptions
  ): Promise<UpstreamGatewayForwardResult>;
  close(): Promise<void>;
  getRefactorInstrumentation(): UpstreamGatewayRefactorInstrumentation;
}
