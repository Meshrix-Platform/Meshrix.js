import { Buffer } from "node:buffer";
import crypto from "node:crypto";

import type { StoredOutboxEntry } from "./store.ts";
import { PEER_CLIENT_MAX_PLAINTEXT_BYTES, assertPeerClientOpaqueId } from "./types.ts";
import type { PeerInboundMessage, PeerInboundOutcome } from "./client.ts";
import { peerClientError } from "./errors.ts";

export const PEER_APPLICATION_PROTOCOL_VERSION = 1;

export type PeerApplicationOperationStatus =
  | "delivery_pending"
  | "accepted"
  | "running"
  | "awaiting_permission"
  | "cancel_requested"
  | "completed"
  | "refused"
  | "stopped"
  | "cancelled"
  | "unknown"
  | "failed";

export type PeerApplicationRole = "caller" | "receiver";

/** Exact paired route context, directed from this device to its counterpart. */
export interface PeerApplicationAddress {
  readonly tenantId: string;
  readonly routeId: string;
  readonly localDeviceId: string;
  readonly peerDeviceId: string;
}

/** The tuple is created by the authenticated PeerClient route, never by a wire payload. */
export interface PeerApplicationInbound {
  readonly address: PeerApplicationAddress;
  readonly message: PeerInboundMessage;
}

export type PeerApplicationSendState = StoredOutboxEntry["state"];
export type PeerApplicationRouteAuthority = "current" | "unavailable" | "revoked";

/** Composition-owned route multiplexer for all per-route PeerClient instances. */
export interface PeerApplicationPeerPort {
  /** Current local permission for this exact route, independent of socket state. */
  resolvePeerAuthority(address: PeerApplicationAddress): Promise<PeerApplicationRouteAuthority>;
  isPeerReachable(address: PeerApplicationAddress): Promise<boolean>;
  sendMessage(
    address: PeerApplicationAddress,
    plaintext: Uint8Array,
    options: { readonly messageId: string }
  ): Promise<StoredOutboxEntry>;
  getSendState(address: PeerApplicationAddress, messageId: string): Promise<PeerApplicationSendState | null>;
  onInboundMessage(
    handler: (delivery: PeerApplicationInbound) => Promise<PeerInboundOutcome>
  ): () => void;
  /** Retry this exact route's locally durable pending inbox after admission frees. */
  retryPendingInbound(address: PeerApplicationAddress): Promise<void>;
}

export interface AcpAgentSummary {
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly enabled: boolean;
}

export interface AcpPermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface AcpPermissionPrompt {
  readonly sessionId: string;
  readonly toolCall: {
    readonly toolCallId: string;
    readonly title: string;
    readonly name: string | null;
    readonly kind: string | null;
    readonly status: string | null;
    readonly content: readonly { readonly type: string; readonly text?: string }[];
    readonly rawInput: unknown | null;
    readonly locations: readonly { readonly path: string; readonly line: number | null }[];
  };
  readonly options: readonly AcpPermissionOption[];
}

export type AcpPermissionResolution =
  | { readonly outcome: "cancelled" }
  | { readonly outcome: "selected"; readonly optionId: string };

/** Local-only progress retained when reading history written by earlier runs. */
export type PeerApplicationProgressKind = "state" | "message" | "tool" | "plan";

export interface PeerApplicationProgress {
  readonly revision: number;
  readonly kind: PeerApplicationProgressKind;
  readonly text: string;
  readonly createdAt: string;
}

export interface PeerApplicationPermissionRecord {
  readonly id: string;
  readonly status: "pending" | "resolved" | "unavailable";
  readonly request: AcpPermissionPrompt;
  readonly selectedOptionId: string | null;
  readonly updatedAt: string;
}

export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export interface PeerApplicationResultPart {
  readonly index: number;
  readonly text: string;
}

/** One profile-level operation record is shared by both directions of a call. */
export interface PeerApplicationRecord {
  readonly version: typeof PEER_APPLICATION_PROTOCOL_VERSION;
  /** Stable storage identity derived from origin tuple + operationId. */
  readonly key: string;
  readonly operationId: string;
  /** Always caller → receiver, including when stored on the receiving device. */
  readonly originAddress: PeerApplicationAddress;
  /** Exact local → remote route context used by this installation. */
  readonly routeAddress: PeerApplicationAddress;
  readonly role: PeerApplicationRole;
  readonly callerAgentId: string | null;
  readonly targetAgentId: string;
  readonly requestDigest: string;
  /** Locally protected journal content; never logged or sent in status updates. */
  readonly prompt: string;
  readonly status: PeerApplicationOperationStatus;
  /** Set durably immediately before invoking ACP session/prompt. */
  readonly promptReserved: boolean;
  /** Runtime generation that made the non-replayable ACP prompt reservation. */
  readonly promptExecutionId: string | null;
  /** Final output is durably prepared and may be completed after a crash. */
  readonly terminalPrepared: boolean;
  /** Monotonic revision of user-visible operation state transitions. */
  readonly stateRevision: number;
  /** Retained local history only; new ACP stream chunks are stored separately. */
  readonly progress: PeerApplicationProgress | null;
  readonly resultText: string | null;
  readonly resultDigest: string | null;
  readonly resultStopReason: AcpStopReason | null;
  readonly resultStatus: PeerApplicationOperationStatus | null;
  readonly resultPartCount: number | null;
  readonly permissionHistory: readonly PeerApplicationPermissionRecord[];
  readonly permission: PeerApplicationPermissionRecord | null;
  readonly cancelRequested: boolean;
  readonly inboundMessageId: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PeerApplicationDiscoveryRecord {
  readonly version: typeof PEER_APPLICATION_PROTOCOL_VERSION;
  readonly key: string;
  readonly requestId: string;
  /** Caller → remote Agent device. */
  readonly address: PeerApplicationAddress;
  readonly status: "pending" | "completed" | "failed";
  readonly agents: readonly AcpAgentSummary[];
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One bounded transport fragment of a deterministic application envelope. */
export interface PeerApplicationFragment {
  readonly address: PeerApplicationAddress;
  /** Deterministic transport ID of the unfragmented logical application event. */
  readonly messageId: string;
  readonly messageKind: string;
  readonly partIndex: number;
  readonly partCount: number;
  readonly totalBytes: number;
  readonly data: string;
}

export interface PeerApplicationFragmentSaveResult {
  readonly status: "incomplete" | "complete" | "applied" | "backpressured" | "conflict";
  readonly receivedParts: number;
}

export interface PeerApplicationPage<T> {
  readonly items: readonly T[];
  /** Opaque cursor for the next bounded page. */
  readonly nextAfterKey: string | null;
}

/** Small local custody projection; it deliberately contains no prompt or result body. */
export interface PeerApplicationOperationRecovery {
  readonly key: string;
  readonly role: PeerApplicationRole;
  readonly operationId: string;
  readonly originAddress: PeerApplicationAddress;
  readonly routeAddress: PeerApplicationAddress;
  readonly requestDigest: string;
  readonly cancelRequested: boolean;
  readonly terminal: boolean;
  readonly terminalPrepared: boolean;
  readonly executionPending: boolean;
  readonly resultPartCount: number | null;
  readonly stateRevision: number;
  readonly createdAt: string;
}

export interface PeerApplicationDiscoveryRecovery {
  readonly key: string;
  /** Original requester → responder address, independent of local direction. */
  readonly address: PeerApplicationAddress;
  readonly requestId: string;
  readonly action: "request" | "response";
}

/** Local-only handoff custody; payload bytes remain in the source record and Peer outbox. */
export interface PeerApplicationHandoffPlan {
  readonly key: string;
  readonly sourceKind: "operation" | "discovery";
  readonly sourceKey: string;
  readonly address: PeerApplicationAddress;
  readonly logicalId: string;
  readonly messageKind: string;
  readonly messageId: string;
  /** Zero means one direct envelope; otherwise the deterministic fragment count. */
  readonly partCount: number;
}

/** Independent application journal, intentionally separate from Peer/Signal stores. */
export interface PeerApplicationJournal {
  getOperation(key: string): Promise<PeerApplicationRecord | null>;
  listOperations(): Promise<readonly PeerApplicationRecord[]>;
  findOperationKeysById(operationId: string): Promise<readonly string[]>;
  listPendingOperationRecoveryPage(afterKey?: string | null, limit?: number): Promise<PeerApplicationPage<PeerApplicationOperationRecovery>>;
  savePendingOperationRecovery(record: PeerApplicationRecord): Promise<void>;
  clearPendingOperationRecovery(key: string, expectedStateRevision?: number): Promise<boolean>;
  saveOperation(record: PeerApplicationRecord): Promise<void>;
  getResultPart(operationKey: string, index: number): Promise<PeerApplicationResultPart | null>;
  listResultParts(operationKey: string): Promise<readonly PeerApplicationResultPart[]>;
  saveResultPart(operationKey: string, part: PeerApplicationResultPart): Promise<void>;
  savePartialResultChunk(operationKey: string, index: number, text: string): Promise<void>;
  listPartialResultChunks(operationKey: string): Promise<readonly PeerApplicationResultPart[]>;
  clearPartialResultChunks(operationKey: string): Promise<void>;
  saveApplicationFragment(fragment: PeerApplicationFragment): Promise<PeerApplicationFragmentSaveResult>;
  readApplicationFragmentMessage(address: PeerApplicationAddress, messageId: string): Promise<Uint8Array | null>;
  /** Persist the logical handler's durable commit before removing fragment files. */
  markApplicationFragmentApplied(address: PeerApplicationAddress, messageId: string): Promise<void>;
  getDiscovery(key: string): Promise<PeerApplicationDiscoveryRecord | null>;
  listDiscoveries(): Promise<readonly PeerApplicationDiscoveryRecord[]>;
  findLatestPendingDiscovery(address: PeerApplicationAddress): Promise<PeerApplicationDiscoveryRecord | null>;
  listPendingDiscoveryRecoveryPage(afterKey?: string | null, limit?: number): Promise<PeerApplicationPage<PeerApplicationDiscoveryRecovery>>;
  savePendingDiscoveryRecovery(record: Pick<PeerApplicationDiscoveryRecord, "key" | "address" | "requestId">, action: "request" | "response"): Promise<void>;
  clearPendingDiscoveryRecovery(key: string, expectedAction?: "request" | "response"): Promise<boolean>;
  saveDiscovery(record: PeerApplicationDiscoveryRecord): Promise<void>;
  listPendingHandoffPage(afterKey?: string | null, limit?: number): Promise<PeerApplicationPage<PeerApplicationHandoffPlan>>;
  getPendingHandoff(key: string): Promise<PeerApplicationHandoffPlan | null>;
  savePendingHandoff(plan: PeerApplicationHandoffPlan): Promise<void>;
  clearPendingHandoff(key: string): Promise<void>;
}

export interface PeerApplicationExecutionResult {
  readonly stopReason: AcpStopReason;
  readonly text: string;
}

export interface PeerApplicationExecutionHandlers {
  /** Must commit the prompt reservation before the adapter writes session/prompt. */
  beforePrompt(): Promise<void>;
  onProgress(progress: { readonly kind: PeerApplicationProgressKind; readonly text: string }): Promise<void>;
  requestPermission(request: AcpPermissionPrompt): Promise<AcpPermissionResolution>;
}

export interface PeerApplicationExecution {
  readonly result: Promise<PeerApplicationExecutionResult>;
  cancel(): Promise<void>;
}

export interface PeerApplicationAgentExecutor {
  readonly summary: AcpAgentSummary;
  start(input: {
    readonly operationId: string;
    readonly prompt: string;
  }, handlers: PeerApplicationExecutionHandlers): PeerApplicationExecution;
}

export interface PeerApplicationAgentDirectory {
  list(): Promise<readonly AcpAgentSummary[]>;
  get(agentId: string): PeerApplicationAgentExecutor | null;
}

export interface PeerApplicationChange {
  readonly kind: "operation" | "discovery";
  readonly operation?: PeerApplicationRecord;
  readonly discovery?: PeerApplicationDiscoveryRecord;
}

export interface PeerApplicationEngineOptions {
  readonly peer: PeerApplicationPeerPort;
  readonly journal: PeerApplicationJournal;
  readonly agents: PeerApplicationAgentDirectory;
}

export interface PeerApplicationSubmitInput {
  readonly address: PeerApplicationAddress;
  readonly operationId?: string;
  readonly callerAgentId?: string | null;
  readonly targetAgentId: string;
  readonly prompt: string;
}

export function newPeerApplicationOperationId(): string {
  return `op.${crypto.randomUUID()}`;
}

export function peerApplicationOperationKey(address: PeerApplicationAddress, operationId: string): string {
  const origin = assertAddress(address);
  const id = assertPeerClientOpaqueId(operationId, "operationId");
  return crypto.createHash("sha256")
    .update([origin.tenantId, origin.routeId, origin.localDeviceId, origin.peerDeviceId, id].join("\u0000"))
    .digest("hex");
}

export function reversePeerApplicationAddress(address: PeerApplicationAddress): PeerApplicationAddress {
  const checked = assertAddress(address);
  return Object.freeze({
    tenantId: checked.tenantId,
    routeId: checked.routeId,
    localDeviceId: checked.peerDeviceId,
    peerDeviceId: checked.localDeviceId
  });
}

export function newPeerApplicationDiscoveryId(): string {
  return `catalog.${crypto.randomUUID()}`;
}

function assertAddress(value: PeerApplicationAddress): PeerApplicationAddress {
  if (typeof value !== "object" || value === null) {
    throw peerClientError("peer_client_state", "A Peer application route address is required.");
  }
  return Object.freeze({
    tenantId: assertPeerClientOpaqueId(value.tenantId, "address.tenantId"),
    routeId: assertPeerClientOpaqueId(value.routeId, "address.routeId"),
    localDeviceId: assertPeerClientOpaqueId(value.localDeviceId, "address.localDeviceId"),
    peerDeviceId: assertPeerClientOpaqueId(value.peerDeviceId, "address.peerDeviceId")
  });
}

export function samePeerApplicationAddress(left: PeerApplicationAddress, right: PeerApplicationAddress): boolean {
  return left.tenantId === right.tenantId
    && left.routeId === right.routeId
    && left.localDeviceId === right.localDeviceId
    && left.peerDeviceId === right.peerDeviceId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertPeerApplicationString(value: unknown, field: string, max = 24_000): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > max) {
    throw peerClientError("peer_client_state", `Peer application ${field} is empty or exceeds its bound.`);
  }
  return value;
}

function nullableString(value: unknown, field: string, max = 512): string | null {
  if (value === null || value === undefined) return null;
  return assertPeerApplicationString(value, field, max);
}

export function peerApplicationRequestDigest(input: {
  readonly address: PeerApplicationAddress;
  readonly callerAgentId: string | null;
  readonly targetAgentId: string;
  readonly prompt: string;
}): string {
  return crypto.createHash("sha256")
    .update(JSON.stringify({
      address: input.address,
      callerAgentId: input.callerAgentId,
      targetAgentId: input.targetAgentId,
      prompt: input.prompt
    }))
    .digest("hex");
}

export function peerApplicationTransportMessageId(senderDeviceId: string, key: string, kind: string, revision = 0, part = 0): string {
  const hash = crypto.createHash("sha256")
    .update([senderDeviceId, key, kind, revision, part].join("\u0000"))
    .digest("base64url");
  return `app.${hash}`;
}

/** Stable child transport identity for each part of a logical envelope. */
export function peerApplicationFragmentMessageId(messageId: string, partIndex: number): string {
  if (!Number.isSafeInteger(partIndex) || partIndex < 0) {
    throw peerClientError("peer_client_state", "The Peer application fragment index is invalid.");
  }
  const hash = crypto.createHash("sha256")
    .update([assertPeerClientOpaqueId(messageId, "fragment.messageId"), partIndex].join("\u0000"))
    .digest("base64url");
  return `appf.${hash}`;
}

export function peerApplicationDiscoveryKey(address: PeerApplicationAddress, requestId: string): string {
  return crypto.createHash("sha256")
    .update([address.tenantId, address.routeId, address.localDeviceId, address.peerDeviceId, requestId].join("\u0000"))
    .digest("hex");
}

export function parsePeerApplicationAddress(value: unknown): PeerApplicationAddress | null {
  if (!isRecord(value)) return null;
  try {
    return assertAddress(value as unknown as PeerApplicationAddress);
  } catch {
    return null;
  }
}

type ApplicationEnvelope = Record<string, unknown> & {
  readonly version: typeof PEER_APPLICATION_PROTOCOL_VERSION;
  readonly kind: string;
};

function parseEnvelope(bytes: Uint8Array): ApplicationEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== PEER_APPLICATION_PROTOCOL_VERSION || typeof value.kind !== "string") return null;
  return value as ApplicationEnvelope;
}

function envelopeBytes(value: ApplicationEnvelope): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.length > PEER_CLIENT_MAX_PLAINTEXT_BYTES) {
    throw peerClientError("peer_client_state", "The Peer application envelope exceeds the encrypted message bound.");
  }
  return bytes;
}

function now(): string {
  return new Date().toISOString();
}

