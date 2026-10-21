import { Buffer } from "node:buffer";
import crypto from "node:crypto";

import {
  assertPeerClientOpaqueId,
  PEER_CLIENT_MAX_PLAINTEXT_BYTES
} from "./types.ts";
import { isPeerClientError, peerClientError } from "./errors.ts";
import type { PeerInboundOutcome } from "./client.ts";
import {
  PEER_APPLICATION_PROTOCOL_VERSION,
  assertPeerApplicationString,
  newPeerApplicationDiscoveryId,
  newPeerApplicationOperationId,
  peerApplicationDiscoveryKey,
  peerApplicationFragmentMessageId,
  peerApplicationOperationKey,
  peerApplicationRequestDigest,
  peerApplicationTransportMessageId,
  reversePeerApplicationAddress,
  samePeerApplicationAddress
} from "./application.ts";
import type {
  AcpPermissionPrompt,
  AcpPermissionResolution,
  AcpStopReason,
  PeerApplicationAddress,
  PeerApplicationAgentDirectory,
  PeerApplicationChange,
  PeerApplicationDiscoveryRecovery,
  PeerApplicationDiscoveryRecord,
  PeerApplicationEngineOptions,
  PeerApplicationExecution,
  PeerApplicationFragment,
  PeerApplicationHandoffPlan,
  PeerApplicationInbound,
  PeerApplicationOperationStatus,
  PeerApplicationOperationRecovery,
  PeerApplicationRecord,
  PeerApplicationResultPart,
  PeerApplicationSubmitInput
} from "./application.ts";

type Envelope = Record<string, unknown> & {
  readonly version: typeof PEER_APPLICATION_PROTOCOL_VERSION;
  readonly kind: string;
};

const TERMINAL = new Set<PeerApplicationOperationStatus>([
  "completed", "refused", "stopped", "cancelled", "unknown", "failed"
]);
const STATUS_VALUES = new Set<PeerApplicationOperationStatus>([
  "delivery_pending", "accepted", "running", "awaiting_permission", "cancel_requested",
  "completed", "refused", "stopped", "cancelled", "unknown", "failed"
]);
const STOP_REASON_VALUES = new Set<AcpStopReason>(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]);
const MAX_CONCURRENT_EXECUTIONS = 2;
const MAX_QUEUED_EXECUTIONS = 32;
const MAX_OUTSTANDING_EXECUTIONS = MAX_CONCURRENT_EXECUTIONS + MAX_QUEUED_EXECUTIONS;
const APPLICATION_RECOVERY_RETRY_INITIAL_DELAY_MS = 1_000;
const APPLICATION_RECOVERY_RETRY_MAX_DELAY_MS = 30_000;
const APPLICATION_RECOVERY_PAGE_SIZE = 32;
interface EngineExecution {
  readonly cancel: () => Promise<void>;
}

interface PendingPermission {
  readonly permissionId: string;
  readonly resolve: (decision: AcpPermissionResolution) => void;
}

type RequestAdmission =
  | { readonly kind: "existing" | "accepted" | "unavailable_agent"; readonly record: PeerApplicationRecord }
  | { readonly kind: "deferred" };

class DeferredApplicationDispatch extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvelope(plaintext: Uint8Array): Envelope | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== PEER_APPLICATION_PROTOCOL_VERSION || typeof value.kind !== "string") return null;
  return value as Envelope;
}

function serializeEnvelope(envelope: Envelope): Uint8Array {
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

function bytesFor(envelope: Envelope): Uint8Array {
  const bytes = serializeEnvelope(envelope);
  if (bytes.length > PEER_CLIENT_MAX_PLAINTEXT_BYTES) {
    throw peerClientError("peer_client_state", "The Peer application fragment exceeds the encrypted transport bound.");
  }
  return bytes;
}

function base64urlLength(byteLength: number): number {
  return Math.floor(byteLength / 3) * 4 + (byteLength % 3 === 0 ? 0 : byteLength % 3 + 1);
}

function maxRawFragmentBytes(messageId: string, messageKind: string, partCount: number, totalBytes: number): number {
  const header: Envelope = {
    version: PEER_APPLICATION_PROTOCOL_VERSION,
    kind: "application_fragment",
    messageId,
    messageKind,
    partIndex: partCount - 1,
    partCount,
    totalBytes,
    data: ""
  };
  const availableBase64Chars = PEER_CLIENT_MAX_PLAINTEXT_BYTES - Buffer.byteLength(JSON.stringify(header), "utf8");
  if (availableBase64Chars < 2) throw peerClientError("peer_client_state", "The Peer fragment header exceeds the encrypted transport bound.");
  let candidate = Math.floor(availableBase64Chars / 4) * 3;
  const remainder = availableBase64Chars % 4;
  if (remainder === 2) candidate += 1;
  else if (remainder === 3) candidate += 2;
  while (candidate > 0 && base64urlLength(candidate) > availableBase64Chars) candidate -= 1;
  if (candidate < 1) throw peerClientError("peer_client_state", "The Peer fragment header exceeds the encrypted transport bound.");
  return candidate;
}

function* fragmentLogicalEnvelope(messageId: string, messageKind: string, bytes: Uint8Array): Generator<{
  readonly messageId: string;
  readonly plaintext: Uint8Array;
  readonly partIndex: number;
  readonly partCount: number;
}> {
  let partCount = 1;
  let partBytes = maxRawFragmentBytes(messageId, messageKind, partCount, bytes.byteLength);
  for (;;) {
    const nextPartCount = Math.ceil(bytes.byteLength / partBytes);
    if (!Number.isSafeInteger(nextPartCount) || nextPartCount < 1) {
      throw peerClientError("peer_client_state", "The Peer application envelope is too large to fragment safely.");
    }
    if (nextPartCount === partCount) break;
    partCount = nextPartCount;
    partBytes = maxRawFragmentBytes(messageId, messageKind, partCount, bytes.byteLength);
  }
  for (let partIndex = 0, offset = 0; offset < bytes.byteLength; partIndex += 1, offset += partBytes) {
    const fragment = {
      version: PEER_APPLICATION_PROTOCOL_VERSION,
      kind: "application_fragment",
      messageId,
      messageKind,
      partIndex,
      partCount,
      totalBytes: bytes.byteLength,
      data: Buffer.from(bytes.subarray(offset, Math.min(bytes.byteLength, offset + partBytes))).toString("base64url")
    } satisfies Envelope;
    const plaintext = bytesFor(fragment);
    yield Object.freeze({
      messageId: peerApplicationFragmentMessageId(messageId, partIndex),
      plaintext,
      partIndex,
      partCount
    });
  }
}

function dateNow(): string {
  return new Date().toISOString();
}

function sameRecordAddress(left: PeerApplicationAddress, right: PeerApplicationAddress): boolean {
  return samePeerApplicationAddress(left, right);
}

function resultParts(text: string, createEnvelope: (index: number, text: string) => Envelope): readonly PeerApplicationResultPart[] {
  const output: PeerApplicationResultPart[] = [];
  let current = "";
  let encodedBytes = Buffer.byteLength(JSON.stringify(createEnvelope(0, "")), "utf8");
  for (const character of text) {
    const escaped = JSON.stringify(character).slice(1, -1);
    const nextBytes = encodedBytes + Buffer.byteLength(escaped, "utf8");
    if (current.length > 0 && nextBytes > PEER_CLIENT_MAX_PLAINTEXT_BYTES) {
      const index = output.length;
      output.push(Object.freeze({ index, text: current }));
      current = "";
      encodedBytes = Buffer.byteLength(JSON.stringify(createEnvelope(index + 1, "")), "utf8");
    }
    const characterBytes = Buffer.byteLength(escaped, "utf8");
    if (encodedBytes + characterBytes > PEER_CLIENT_MAX_PLAINTEXT_BYTES) {
      throw peerClientError("peer_client_state", "A single result character exceeds the encrypted transport bound.");
    }
    current += character;
    encodedBytes += characterBytes;
  }
  if (current.length > 0 || output.length === 0) output.push(Object.freeze({ index: output.length, text: current }));
  return Object.freeze(output);
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  if (error instanceof Error && error.name) return error.name;
  return "peer_application_failed";
}

function eventDetail(code: string): Uint8Array {
  return Buffer.from(code, "utf8");
}

function makeOperationRecord(input: {
  key: string;
  operationId: string;
  originAddress: PeerApplicationAddress;
  routeAddress: PeerApplicationAddress;
  role: "caller" | "receiver";
  callerAgentId: string | null;
  targetAgentId: string;
  requestDigest: string;
  prompt: string;
  model?: string;
  effort?: string;
  status: PeerApplicationOperationStatus;
  inboundMessageId: string | null;
}): PeerApplicationRecord {
  const timestamp = dateNow();
  return Object.freeze({
    version: PEER_APPLICATION_PROTOCOL_VERSION,
    key: input.key,
    operationId: input.operationId,
    originAddress: input.originAddress,
    routeAddress: input.routeAddress,
    role: input.role,
    callerAgentId: input.callerAgentId,
    targetAgentId: input.targetAgentId,
    requestDigest: input.requestDigest,
    prompt: input.prompt,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    status: input.status,
    promptReserved: false,
    promptExecutionId: null,
    terminalPrepared: false,
    stateRevision: input.status === "accepted" ? 1 : 0,
    progress: null,
    resultText: null,
    resultDigest: null,
    resultStopReason: null,
    resultStatus: null,
    resultPartCount: null,
    permissionHistory: Object.freeze([]),
    permission: null,
    cancelRequested: false,
    inboundMessageId: input.inboundMessageId,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function updateRecord(record: PeerApplicationRecord, patch: Partial<PeerApplicationRecord>): PeerApplicationRecord {
  const status = patch.status ?? record.status;
  const stateRevision = patch.stateRevision ?? (status === record.status ? record.stateRevision : record.stateRevision + 1);
  return Object.freeze({ ...record, ...patch, stateRevision, updatedAt: dateNow() });
}

function parseStatus(value: unknown): PeerApplicationOperationStatus | null {
  return typeof value === "string" && STATUS_VALUES.has(value as PeerApplicationOperationStatus)
    ? value as PeerApplicationOperationStatus
    : null;
}

function canFollowOperationState(current: PeerApplicationOperationStatus, next: PeerApplicationOperationStatus): boolean {
  if (next === "cancel_requested") return true;
  if (next === "accepted") return current === "delivery_pending" || current === "accepted";
  if (next === "running") return current === "delivery_pending" || current === "accepted"
    || current === "running" || current === "awaiting_permission";
  if (next === "awaiting_permission") return current === "delivery_pending" || current === "accepted"
    || current === "running" || current === "awaiting_permission";
  return false;
}

function validSummary(value: unknown): value is { id: string; displayName: string; description: string | null; enabled: boolean } {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.displayName === "string"
    && (value.description === null || typeof value.description === "string")
    && typeof value.enabled === "boolean";
}

/**
 * Durable MCP-to-ACP operation router. The profile owns one engine; route
 * multiplexing and PeerClient lifetimes remain in the host.
 */
export class PeerApplicationEngine {
  readonly #options: PeerApplicationEngineOptions;
  readonly #listeners = new Set<(change: PeerApplicationChange) => void>();
  readonly #keyTails = new Map<string, Promise<void>>();
  readonly #deferredRoutes = new Map<string, PeerApplicationAddress>();
  readonly #running = new Map<string, EngineExecution>();
  readonly #started = new Set<string>();
  readonly #executionQueue = new Set<string>();
  readonly #partialResultChunkCounts = new Map<string, number>();
  readonly #permissionWaiters = new Map<string, PendingPermission>();
  readonly #permissionQueues = new Map<string, Promise<void>>();
  readonly #removeInbound: () => void;
  readonly #executionId = crypto.randomUUID();
  #disposed = false;
  #executionPumpScheduled = false;
  #admissionTail: Promise<void> = Promise.resolve();
  #recoveryRetryRunning = false;
  #recoveryRetryRequested = false;
  #recoveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #recoveryRetryDelayMs = APPLICATION_RECOVERY_RETRY_INITIAL_DELAY_MS;
  #operationRecoveryRetryCursor: string | null = null;
  #discoveryRecoveryRetryCursor: string | null = null;
  #handoffRetryCursor: string | null = null;
  #recoveryRetrySweepFailed = false;

  constructor(options: PeerApplicationEngineOptions) {
    this.#options = options;
    this.#removeInbound = options.peer.onInboundMessage((delivery) => this.#handleInbound(delivery));
  }

  onChange(listener: (change: PeerApplicationChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(change: PeerApplicationChange): void {
    for (const listener of this.#listeners) {
      try { listener(change); } catch { /* UI observers cannot break durable execution. */ }
    }
  }

  #defer(task: () => Promise<unknown>, retryDurableFailure = true): void {
    setImmediate(() => {
      void task().catch(() => {
        if (retryDurableFailure) this.#scheduleRecoveryRetry(false, true);
      });
    });
  }

  #scheduleRecoveryRetry(increaseDelay = false, recoveryFailure = false): void {
    if (this.#disposed) return;
    if (recoveryFailure) this.#recoveryRetrySweepFailed = true;
    if (increaseDelay) {
      this.#recoveryRetryDelayMs = Math.min(
        this.#recoveryRetryDelayMs * 2,
        APPLICATION_RECOVERY_RETRY_MAX_DELAY_MS
      );
    }
    if (this.#recoveryRetryRunning) {
      this.#recoveryRetryRequested = true;
      return;
    }
    if (this.#recoveryRetryTimer !== null) return;
    this.#recoveryRetryTimer = setTimeout(() => {
      this.#recoveryRetryTimer = null;
      if (this.#operationRecoveryRetryCursor === null
        && this.#discoveryRecoveryRetryCursor === null
        && this.#handoffRetryCursor === null) {
        // A null cursor starts a fresh bounded pass. Failures discovered while
        // a prior pass was still active are retained until that pass wraps.
        this.#recoveryRetrySweepFailed = false;
      }
      this.#recoveryRetryRunning = true;
      void this.#retryPendingRecoveryPage()
        .catch(() => this.#scheduleRecoveryRetry(true, true))
        .finally(() => {
          this.#recoveryRetryRunning = false;
          if (this.#recoveryRetryRequested) {
            this.#recoveryRetryRequested = false;
            this.#scheduleRecoveryRetry();
          }
        });
    }, this.#recoveryRetryDelayMs);
    this.#recoveryRetryTimer.unref?.();
  }

  #resetRecoveryRetry(): void {
    if (this.#recoveryRetryTimer !== null) clearTimeout(this.#recoveryRetryTimer);
    this.#recoveryRetryTimer = null;
    if (this.#disposed) this.#recoveryRetryRequested = false;
    this.#recoveryRetryDelayMs = APPLICATION_RECOVERY_RETRY_INITIAL_DELAY_MS;
    this.#operationRecoveryRetryCursor = null;
    this.#discoveryRecoveryRetryCursor = null;
    this.#handoffRetryCursor = null;
    this.#recoveryRetrySweepFailed = false;
  }

  async #retryPendingRecoveryPage(): Promise<void> {
    if (this.#disposed) return;
    let failed = false;
    let more = false;
    try {
      const page = await this.#options.journal.listPendingOperationRecoveryPage(
        this.#operationRecoveryRetryCursor,
        APPLICATION_RECOVERY_PAGE_SIZE
      );
      for (const recovery of page.items) {
        try { await this.#resumeOperationRecovery(recovery); }
        catch { failed = true; }
      }
      this.#operationRecoveryRetryCursor = page.nextAfterKey;
      more ||= page.nextAfterKey !== null;
    } catch {
      failed = true;
    }
    if (this.#disposed) return;
    try {
      const page = await this.#options.journal.listPendingDiscoveryRecoveryPage(
        this.#discoveryRecoveryRetryCursor,
        APPLICATION_RECOVERY_PAGE_SIZE
      );
      for (const recovery of page.items) {
        try { await this.#resumeDiscoveryRecovery(recovery); }
        catch { failed = true; }
      }
      this.#discoveryRecoveryRetryCursor = page.nextAfterKey;
      more ||= page.nextAfterKey !== null;
    } catch {
      failed = true;
    }
    if (this.#disposed) return;
    try {
      const page = await this.#options.journal.listPendingHandoffPage(
        this.#handoffRetryCursor,
        APPLICATION_RECOVERY_PAGE_SIZE
      );
      for (const plan of page.items) {
        try { await this.#resumeHandoff(plan); }
        catch { failed = true; }
      }
      this.#handoffRetryCursor = page.nextAfterKey;
      more ||= page.nextAfterKey !== null;
    } catch {
      failed = true;
    }
    if (this.#disposed) return;
    if (failed) {
      this.#recoveryRetrySweepFailed = true;
      this.#recoveryRetryDelayMs = Math.min(
        this.#recoveryRetryDelayMs * 2,
        APPLICATION_RECOVERY_RETRY_MAX_DELAY_MS
      );
    }
    if (more) {
      if (!this.#recoveryRetrySweepFailed) {
        this.#recoveryRetryDelayMs = APPLICATION_RECOVERY_RETRY_INITIAL_DELAY_MS;
      }
      this.#scheduleRecoveryRetry();
    } else if (this.#recoveryRetrySweepFailed) {
      // Continue past failed rows for fairness, then wrap the cursors to retry
      // them without needing another inbound message or reconnect.
      this.#operationRecoveryRetryCursor = null;
      this.#discoveryRecoveryRetryCursor = null;
      this.#handoffRetryCursor = null;
      this.#recoveryRetrySweepFailed = false;
      this.#scheduleRecoveryRetry();
    } else {
      this.#recoveryRetryDelayMs = APPLICATION_RECOVERY_RETRY_INITIAL_DELAY_MS;
      this.#resetRecoveryRetry();
    }
  }

  async #withKeyLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#keyTails.get(key) ?? Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.then(() => gate);
    this.#keyTails.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#keyTails.get(key) === current) this.#keyTails.delete(key);
    }
  }

  async #withAdmissionLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#admissionTail;
    let release = (): void => {};
    this.#admissionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #routeKey(address: PeerApplicationAddress): string {
    return [address.tenantId, address.routeId, address.localDeviceId, address.peerDeviceId].join("\u0000");
  }

  #wakeDeferredRoutes(): void {
    if (this.#disposed || this.#deferredRoutes.size === 0) return;
    const routes = [...this.#deferredRoutes.values()];
    this.#deferredRoutes.clear();
    for (const address of routes) {
      this.#defer(() => this.#options.peer.retryPendingInbound(address), false);
    }
  }

  async #saveOperation(record: PeerApplicationRecord): Promise<void> {
    // Publish recovery responsibility before the main record. A crash can
    // leave a harmless marker, but never an accepted task without one.
    if (record.role === "receiver"
      ? !TERMINAL.has(record.status) || record.terminalPrepared || record.resultPartCount !== null
      : record.status === "delivery_pending" || (record.cancelRequested && !TERMINAL.has(record.status))) {
      await this.#options.journal.savePendingOperationRecovery(record);
    }
    await this.#options.journal.saveOperation(record);
    this.#emit({ kind: "operation", operation: record });
  }

  async #clearOperationRecovery(recovery: PeerApplicationOperationRecovery): Promise<boolean> {
    return this.#withKeyLock(recovery.key, async () =>
      this.#options.journal.clearPendingOperationRecovery(recovery.key, recovery.stateRevision));
  }

  async #clearDiscoveryRecovery(recovery: PeerApplicationDiscoveryRecovery): Promise<boolean> {
    return this.#withKeyLock(`discovery:${recovery.key}`, async () =>
      this.#options.journal.clearPendingDiscoveryRecovery(recovery.key, recovery.action));
  }

  async #callerOperation(operationId: string): Promise<PeerApplicationRecord | null> {
    const records = await this.#recordsForOperationId(operationId);
    const matches = records.filter((record) => record.role === "caller");
    if (matches.length > 1) throw peerClientError("peer_client_state", "The caller operation id is already bound to multiple requests.");
    return matches[0] ?? null;
  }

  async #recordsForOperationId(operationId: string): Promise<readonly PeerApplicationRecord[]> {
    const keys = await this.#options.journal.findOperationKeysById(operationId);
    const records: PeerApplicationRecord[] = [];
    for (const key of keys) {
      const record = await this.#options.journal.getOperation(key);
      if (record) records.push(record);
    }
    return records;
  }

  async #getByOperationId(operationId: string): Promise<PeerApplicationRecord | null> {
    const records = await this.#recordsForOperationId(operationId);
    const caller = records.filter((record) => record.role === "caller");
    if (caller.length > 1) throw peerClientError("peer_client_state", "The caller operation id is already bound to multiple requests.");
    if (caller[0]) return caller[0];
    const receivers = records.filter((record) => record.role === "receiver");
    if (receivers.length > 1) throw peerClientError("peer_client_state", "The operation id is ambiguous across paired routes.");
    return receivers[0] ?? null;
  }

  async localAgents(): Promise<Awaited<ReturnType<PeerApplicationAgentDirectory["list"]>>> {
    return this.#options.agents.list();
  }

  async listOperations(): Promise<readonly PeerApplicationRecord[]> {
    return this.#options.journal.listOperations();
  }

  async #countOutstandingExecutions(): Promise<number> {
    let count = 0;
    let afterKey: string | null = null;
    do {
      const page = await this.#options.journal.listPendingOperationRecoveryPage(afterKey, 32);
      for (const record of page.items) {
        if (record.executionPending) count += 1;
      }
      afterKey = page.nextAfterKey;
    } while (afterKey !== null);
    return count;
  }

  async getOperation(operationId: string): Promise<PeerApplicationRecord | null> {
    const checkedId = assertPeerClientOpaqueId(operationId, "operationId");
    return this.#getByOperationId(checkedId);
  }

  /** Reject known-offline new work before creating any durable operation row. */
  async submit(input: PeerApplicationSubmitInput): Promise<PeerApplicationRecord> {
    const operationId = assertPeerClientOpaqueId(input.operationId ?? newPeerApplicationOperationId(), "operationId");
    const routeAddress = this.#readAddress(input.address);
    const targetAgentId = assertPeerClientOpaqueId(input.targetAgentId, "targetAgentId");
    const callerAgentId = input.callerAgentId == null ? null : assertPeerClientOpaqueId(input.callerAgentId, "callerAgentId");
    const prompt = assertPeerApplicationString(input.prompt, "prompt", 32_000);
    const model = input.model == null ? undefined : assertPeerApplicationString(input.model, "model");
    const effort = input.effort == null ? undefined : assertPeerApplicationString(input.effort, "effort");
    const digest = peerApplicationRequestDigest({ address: routeAddress, callerAgentId, targetAgentId, prompt, model, effort });
    const key = peerApplicationOperationKey(routeAddress, operationId);
    // A caller ID names one immutable local submission across all destinations.
    // The durable operation-id index keeps this check bounded without scanning
    // retained operation history on admission.
    return this.#withKeyLock(`caller-operation:${operationId}`, async () => {
      const existing = await this.#callerOperation(operationId);
      if (existing) {
        if (existing.requestDigest !== digest
          || !sameRecordAddress(existing.originAddress, routeAddress)
          || existing.callerAgentId !== callerAgentId
          || existing.targetAgentId !== targetAgentId
          || existing.prompt !== prompt
          || existing.model !== model
          || existing.effort !== effort) {
          throw peerClientError("peer_client_state", "This operation id is already bound to different immutable request data.");
        }
        return existing;
      }
      if (!await this.#options.peer.isPeerReachable(routeAddress)) {
        throw peerClientError("peer_client_transport", "The paired Agent device is not reachable; the operation was not accepted.");
      }
      const request = {
        version: PEER_APPLICATION_PROTOCOL_VERSION,
        kind: "operation_request",
        operationId,
        originAddress: routeAddress,
        callerAgentId,
        targetAgentId,
        prompt,
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        requestDigest: digest,
        deliveryId: "request"
      } satisfies Envelope;
      // Validate the transport encoding before durable acceptance.
      const encoded = serializeEnvelope(request);
      const acceptedRecord = makeOperationRecord({
        key,
        operationId,
        originAddress: routeAddress,
        routeAddress,
        role: "caller",
        callerAgentId,
        targetAgentId,
        requestDigest: digest,
        prompt,
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        status: "delivery_pending",
        inboundMessageId: null
      });
      await this.#withKeyLock(key, () => this.#saveOperation(acceptedRecord));
      // Once saved, transport failure is delivery_pending and remains accepted.
      this.#defer(async () => { await this.#resumeCaller(acceptedRecord); });
      return acceptedRecord;
    });
  }

  async discoverAgents(
    addressInput: PeerApplicationAddress,
    options: { readonly requestId?: string } = {}
  ): Promise<PeerApplicationDiscoveryRecord> {
    const requestId = assertPeerClientOpaqueId(options.requestId ?? newPeerApplicationDiscoveryId(), "requestId");
    const address = this.#readAddress(addressInput);
    const key = peerApplicationDiscoveryKey(address, requestId);
    return this.#withKeyLock(`discovery:${key}`, async () => {
      const existing = await this.#options.journal.getDiscovery(key);
      if (existing) return existing;
      if (!await this.#options.peer.isPeerReachable(address)) {
        throw peerClientError("peer_client_transport", "The paired Agent device is not reachable; discovery was not accepted.");
      }
      const timestamp = dateNow();
      const record: PeerApplicationDiscoveryRecord = Object.freeze({
        version: PEER_APPLICATION_PROTOCOL_VERSION,
        key,
        requestId,
        address,
        status: "pending",
        agents: Object.freeze([]),
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp
      });
      await this.#options.journal.savePendingDiscoveryRecovery(record, "request");
      await this.#options.journal.saveDiscovery(record);
      this.#emit({ kind: "discovery", discovery: record });
      const envelope: Envelope = { version: PEER_APPLICATION_PROTOCOL_VERSION, kind: "catalog_request", requestId, address, deliveryId: "catalog:request" };
      this.#defer(async () => { await this.#resumeDiscovery(record); });
      return record;
    });
  }

  async getDiscovery(address: PeerApplicationAddress, requestId: string): Promise<PeerApplicationDiscoveryRecord | null> {
    const route = this.#readAddress(address);
    const id = assertPeerClientOpaqueId(requestId, "requestId");
    return this.#options.journal.getDiscovery(peerApplicationDiscoveryKey(route, id));
  }

  async remoteAgents(address: PeerApplicationAddress): Promise<readonly { readonly id: string; readonly displayName: string; readonly description: string | null; readonly enabled: boolean }[]> {
    const route = this.#readAddress(address);
    const rows = (await this.#options.journal.listDiscoveries())
      .filter((record) => record.status === "completed" && sameRecordAddress(record.address, route))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return rows[0]?.agents ?? Object.freeze([]);
  }

  async cancel(operationId: string): Promise<PeerApplicationRecord> {
    const record = await this.getOperation(operationId);
    if (!record) throw peerClientError("peer_client_state", "The requested operation does not exist.");
    return this.#withKeyLock(record.key, async () => {
      const current = await this.#options.journal.getOperation(record.key);
      if (!current) throw peerClientError("peer_client_state", "The requested operation does not exist.");
      if (TERMINAL.has(current.status)) return current;
      const cancelled = updateRecord(current, { cancelRequested: true, status: "cancel_requested", lastError: null });
      await this.#saveOperation(cancelled);
      if (current.role === "caller") {
        this.#defer(async () => { await this.#resumeCaller(cancelled); });
      } else {
        this.#defer(() => this.#publishReceiverState(cancelled));
        this.#resolvePermissionWaiter(current.key, { outcome: "cancelled" });
        const running = this.#running.get(current.key);
        if (running) this.#defer(() => running.cancel());
      }
      return cancelled;
    });
  }

  async resolvePermission(input: {
    readonly operationId: string;
    readonly permissionId: string;
    readonly resolution: AcpPermissionResolution;
  }): Promise<PeerApplicationRecord> {
    const record = await this.getOperation(input.operationId);
    if (!record || record.role !== "receiver") throw peerClientError("peer_client_state", "The local permission request does not exist.");
    return this.#withKeyLock(record.key, async () => {
      const current = await this.#options.journal.getOperation(record.key);
      if (!current || current.permission?.id !== input.permissionId || current.permission.status !== "pending") {
        throw peerClientError("peer_client_state", "The permission request is no longer pending.");
      }
      if (!this.#permissionWaiters.has(record.key)) throw peerClientError("peer_client_state", "The local ACP process is no longer waiting for this permission.");
      let selectedOptionId: string | null = null;
      if (input.resolution.outcome === "selected") {
        const optionId = assertPeerClientOpaqueId(input.resolution.optionId, "permission.optionId");
        if (!current.permission.request.options.some((option) => option.optionId === optionId)) {
          throw peerClientError("peer_client_state", "The selected permission option does not belong to this request.");
        }
        selectedOptionId = optionId;
      }
      const updated = updateRecord(current, {
        permission: Object.freeze({ ...current.permission, status: "resolved", selectedOptionId, updatedAt: dateNow() }),
        permissionHistory: Object.freeze(current.permissionHistory.map((permission) => permission.id === input.permissionId
          ? Object.freeze({ ...permission, status: "resolved" as const, selectedOptionId, updatedAt: dateNow() })
          : permission)),
        status: current.cancelRequested ? "cancel_requested" : "running"
      });
      await this.#saveOperation(updated);
      if (updated.role === "receiver") this.#defer(() => this.#publishReceiverState(updated));
      this.#resolvePermissionWaiter(record.key, input.resolution);
      return updated;
    });
  }

  /** Reconnect path: redeliver exact accepted operations/results, never ACP prompts. */
  async resume(): Promise<void> {
    if (this.#disposed) return;
    try {
      const operations: PeerApplicationOperationRecovery[] = [];
      let operationCursor: string | null = null;
      do {
        const page = await this.#options.journal.listPendingOperationRecoveryPage(operationCursor, APPLICATION_RECOVERY_PAGE_SIZE);
        operations.push(...page.items);
        operationCursor = page.nextAfterKey;
      } while (operationCursor !== null);
      const waiting = operations.filter((record) => record.executionPending)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.key.localeCompare(right.key));
      // Rebuild only the bounded waiting set in durable FIFO order. The live
      // pump follows Set insertion order and does keyed reads only.
      for (const record of waiting) this.#scheduleExecution(record.key);
      const tasks: Promise<unknown>[] = operations.map((record) => this.#resumeOperationRecovery(record));
      const discoveries: PeerApplicationDiscoveryRecovery[] = [];
      let discoveryCursor: string | null = null;
      do {
        const page = await this.#options.journal.listPendingDiscoveryRecoveryPage(discoveryCursor, APPLICATION_RECOVERY_PAGE_SIZE);
        discoveries.push(...page.items);
        discoveryCursor = page.nextAfterKey;
      } while (discoveryCursor !== null);
      for (const discovery of discoveries) tasks.push(this.#resumeDiscoveryRecovery(discovery));
      const taskResults = await Promise.all(tasks.map(async (task) => {
        try { await task; return true; }
        catch { return false; }
      }));
      const operationHandoffsOkay = await this.#resumeHandoffPages(false);
      const resultHandoffsOkay = await this.#resumeHandoffPages(true);
      this.#wakeDeferredRoutes();
      this.#pumpExecutionQueue();
      if (taskResults.some((result) => !result) || !operationHandoffsOkay || !resultHandoffsOkay) {
        this.#scheduleRecoveryRetry(false, true);
      } else if (!this.#recoveryRetryRunning && this.#recoveryRetryTimer === null) {
        this.#resetRecoveryRetry();
      }
    } catch (error: unknown) {
      this.#scheduleRecoveryRetry(false, true);
      throw error;
    }
  }

  async #resumeOperationRecovery(recovery: PeerApplicationOperationRecovery): Promise<void> {
    if (recovery.terminal && recovery.role === "receiver" && !recovery.terminalPrepared
      && recovery.resultPartCount === null) {
      await this.#clearOperationRecovery(recovery);
      return;
    }
    if (recovery.role === "caller" && recovery.terminal) {
      await this.#clearOperationRecovery(recovery);
      return;
    }
    if (recovery.role === "caller") {
      const requestId = peerApplicationTransportMessageId(recovery.routeAddress.localDeviceId, recovery.key, "request");
      const requestState = await this.#options.peer.getSendState(recovery.routeAddress, requestId);
      if (requestState === "conflict") throw peerClientError("peer_client_state", "A Peer operation request id has a sender-scope conflict.");
      if (requestState !== null) {
        if (recovery.cancelRequested) {
          const cancelId = peerApplicationTransportMessageId(recovery.routeAddress.localDeviceId, recovery.key, "cancel");
          const cancelState = await this.#options.peer.getSendState(recovery.routeAddress, cancelId);
          if (cancelState === "conflict") throw peerClientError("peer_client_state", "A Peer cancellation id has a sender-scope conflict.");
          if (cancelState !== null) {
            await this.#clearOperationRecovery(recovery);
            return;
          }
          const cancel: Envelope = {
            version: PEER_APPLICATION_PROTOCOL_VERSION,
            kind: "operation_cancel",
            operationId: recovery.operationId,
            originAddress: recovery.originAddress,
            requestDigest: recovery.requestDigest,
            deliveryId: "cancel"
          };
          await this.#sendLogical({
            operationKey: recovery.key,
            address: recovery.routeAddress,
            logicalId: "cancel",
            kind: "operation_cancel",
            envelope: cancel,
            recovery: true,
            sourceKind: "operation",
            serialize: serializeEnvelope,
            send: this.#options.peer.sendMessage.bind(this.#options.peer),
            getState: this.#options.peer.getSendState.bind(this.#options.peer),
            retainPlan: false
          });
          await this.#clearOperationRecovery(recovery);
          return;
        }
        await this.#clearOperationRecovery(recovery);
        return;
      }
    } else if (recovery.resultPartCount !== null && !recovery.terminalPrepared
      && await this.#resultHandoffsDurable(recovery)) {
      await this.#clearOperationRecovery(recovery);
      await this.#clearResultHandoffPlans(recovery);
      await this.#options.journal.clearPartialResultChunks(recovery.key);
      this.#wakeDeferredRoutes();
      return;
    }

    const record = await this.#withKeyLock(recovery.key, async () => {
      const current = await this.#options.journal.getOperation(recovery.key);
      if (!current) {
        await this.#options.journal.clearPendingOperationRecovery(recovery.key, recovery.stateRevision);
      }
      return current;
    });
    if (!record) return;
    if (record.role === "caller") await this.#resumeCaller(record);
    else await this.#resumeReceiver(record);
  }

  async #resumeDiscoveryRecovery(recovery: PeerApplicationDiscoveryRecovery): Promise<void> {
    const logicalId = recovery.action === "request" ? "catalog:request" : "catalog:response";
    const address = recovery.action === "request" ? recovery.address : reversePeerApplicationAddress(recovery.address);
    const messageId = peerApplicationTransportMessageId(address.localDeviceId, recovery.key, logicalId);
    const plan = await this.#options.journal.getPendingHandoff(messageId);
    if (plan && await this.#handoffIsDurable(plan)) {
      await this.#options.journal.clearPendingHandoff(plan.key);
      await this.#clearDiscoveryRecovery(recovery);
      return;
    }
    if (!plan) {
      const state = await this.#options.peer.getSendState(address, messageId);
      if (state === "conflict") throw peerClientError("peer_client_state", "A Peer catalog message id has a sender-scope conflict.");
      if (state !== null) {
        await this.#clearDiscoveryRecovery(recovery);
        return;
      }
    }
    const record = await this.#withKeyLock(`discovery:${recovery.key}`, async () => {
      const current = await this.#options.journal.getDiscovery(recovery.key);
      if (!current) await this.#options.journal.clearPendingDiscoveryRecovery(recovery.key, recovery.action);
      return current;
    });
    if (!record) return;
    if (recovery.action === "request") await this.#resumeDiscovery(record);
    else await this.#resumeCatalogResponse(record);
  }

  async #resumeHandoffPages(includeResultEvents: boolean): Promise<boolean> {
    let failed = false;
    let cursor: string | null = null;
    do {
      const page = await this.#options.journal.listPendingHandoffPage(cursor, 32);
      for (const plan of page.items) {
        const resultEvent = plan.messageKind === "operation_result_part" || plan.messageKind === "operation_result_end";
        if (resultEvent !== includeResultEvents) continue;
        try { await this.#resumeHandoff(plan); }
        catch { failed = true; }
      }
      cursor = page.nextAfterKey;
    } while (cursor !== null);
    return !failed;
  }

  dispose(): void {
    this.#disposed = true;
    this.#resetRecoveryRetry();
    this.#removeInbound();
    this.#deferredRoutes.clear();
    // Healthy work and subprocesses intentionally remain alive on window close.
  }

  async #resumeCaller(record: PeerApplicationRecord): Promise<void> {
    let current = await this.#options.journal.getOperation(record.key);
    if (!current || current.role !== "caller") return;
    if (!TERMINAL.has(current.status)) {
      const request: Envelope = {
        version: PEER_APPLICATION_PROTOCOL_VERSION,
        kind: "operation_request",
        operationId: current.operationId,
        originAddress: current.originAddress,
        callerAgentId: current.callerAgentId,
        targetAgentId: current.targetAgentId,
        prompt: current.prompt,
        ...(current.model === undefined ? {} : { model: current.model }),
        ...(current.effort === undefined ? {} : { effort: current.effort }),
        requestDigest: current.requestDigest,
        deliveryId: "request"
      };
      await this.#sendOperationEvent(current, "request", "operation_request", request, true);
    }
    current = await this.#options.journal.getOperation(record.key);
    if (current?.cancelRequested && !TERMINAL.has(current.status)) {
      const cancel: Envelope = {
        version: PEER_APPLICATION_PROTOCOL_VERSION,
        kind: "operation_cancel",
        operationId: current.operationId,
        originAddress: current.originAddress,
        requestDigest: current.requestDigest,
        deliveryId: "cancel"
      };
      await this.#sendOperationEvent(current, "cancel", "operation_cancel", cancel, true);
    }
    await this.#withKeyLock(record.key, async () => {
      const latest = await this.#options.journal.getOperation(record.key);
      if (!latest || latest.role !== "caller") {
        await this.#options.journal.clearPendingOperationRecovery(record.key);
        return;
      }
      if (latest.cancelRequested && !TERMINAL.has(latest.status)) {
        const cancelId = peerApplicationTransportMessageId(latest.routeAddress.localDeviceId, latest.key, "cancel");
        const state = await this.#options.peer.getSendState(latest.routeAddress, cancelId);
        if (state === "conflict") throw peerClientError("peer_client_state", "A Peer transport cancellation id has a sender-scope conflict.");
        if (state === null) return;
      }
      await this.#options.journal.clearPendingOperationRecovery(record.key, latest.stateRevision);
    });
  }

  async #resumeReceiver(record: PeerApplicationRecord): Promise<void> {
    let current = await this.#options.journal.getOperation(record.key);
    if (!current) return;
    if (current.terminalPrepared) {
      await this.#completePreparedTerminal(current);
      current = await this.#options.journal.getOperation(record.key) ?? current;
    }
    if (!TERMINAL.has(current.status)) {
      if (current.promptReserved && !this.#running.has(current.key)) {
        const savedParts = await this.#options.journal.listResultParts(current.key);
        const partialChunks = savedParts.length === 0
          ? await this.#options.journal.listPartialResultChunks(current.key)
          : savedParts;
        const partial = partialChunks.map((part) => part.text).join("");
        await this.#setTerminal(current, "unknown", "execution_outcome_unknown", partial);
        current = await this.#options.journal.getOperation(record.key) ?? current;
      } else if (current.status === "accepted" || current.status === "running" || current.status === "awaiting_permission") {
        if (!current.promptReserved) this.#scheduleExecution(current.key);
      } else if (current.cancelRequested && !current.promptReserved) {
        this.#scheduleExecution(current.key);
      }
    }
    current = await this.#options.journal.getOperation(record.key);
    if (!current) return;
    if (TERMINAL.has(current.status)) {
      await this.#sendStoredResult(current, true);
      await this.#options.journal.clearPartialResultChunks(current.key);
    } else {
      await this.#publishReceiverState(current);
    }
  }

  async #resumeDiscovery(record: PeerApplicationDiscoveryRecord): Promise<void> {
    const envelope: Envelope = { version: PEER_APPLICATION_PROTOCOL_VERSION, kind: "catalog_request", requestId: record.requestId, address: record.address, deliveryId: "catalog:request" };
    await this.#sendDiscoveryEvent(record, envelope, true);
    await this.#clearDiscoveryRecovery({ key: record.key, address: record.address, requestId: record.requestId, action: "request" });
  }

  async #resumeCatalogResponse(record: PeerApplicationDiscoveryRecord): Promise<void> {
    await this.#options.journal.savePendingDiscoveryRecovery(record, "response");
    const envelope: Envelope = {
      version: PEER_APPLICATION_PROTOCOL_VERSION,
      kind: "catalog_response",
      requestId: record.requestId,
      address: record.address,
      agents: record.agents,
      deliveryId: "catalog:response"
    };
    await this.#sendDiscoveryEvent(record, envelope, true, true);
    await this.#clearDiscoveryRecovery({ key: record.key, address: record.address, requestId: record.requestId, action: "response" });
  }

  async #sendOperationEvent(
    record: PeerApplicationRecord,
    logicalId: string,
    kind: string,
    envelope: Envelope,
    recovery: boolean,
    prepared?: Uint8Array,
    retainPlan = false
  ): Promise<void> {
    await this.#sendLogical({
      operationKey: record.key,
      address: record.routeAddress,
      logicalId,
      kind,
      envelope,
      recovery,
      sourceKind: "operation",
      serialize: serializeEnvelope,
      send: this.#options.peer.sendMessage.bind(this.#options.peer),
      getState: this.#options.peer.getSendState.bind(this.#options.peer),
      prepared,
      retainPlan
    });
  }

  async #sendDiscoveryEvent(
    record: PeerApplicationDiscoveryRecord,
    envelope: Envelope,
    recovery: boolean,
    response = false
  ): Promise<void> {
    const logicalId = response ? "catalog:response" : "catalog:request";
    await this.#sendLogical({
      operationKey: record.key,
      address: response ? reversePeerApplicationAddress(record.address) : record.address,
      logicalId,
      kind: envelope.kind,
      envelope,
      recovery,
      sourceKind: "discovery",
      serialize: serializeEnvelope,
      send: this.#options.peer.sendMessage.bind(this.#options.peer),
      getState: this.#options.peer.getSendState.bind(this.#options.peer),
      retainPlan: false
    });
  }

  async #sendLogical(input: {
    readonly operationKey: string;
    readonly address: PeerApplicationAddress;
    readonly logicalId: string;
    readonly kind: string;
    readonly envelope: Envelope;
    readonly recovery: boolean;
    readonly sourceKind: "operation" | "discovery";
    readonly serialize: (envelope: Envelope) => Uint8Array;
    readonly send: PeerApplicationEngineOptions["peer"]["sendMessage"];
    readonly getState: PeerApplicationEngineOptions["peer"]["getSendState"];
    readonly prepared?: Uint8Array;
    readonly retainPlan: boolean;
  }): Promise<void> {
    const messageId = peerApplicationTransportMessageId(input.address.localDeviceId, input.operationKey, input.logicalId);
    const state = await input.getState(input.address, messageId);
    if (state === "conflict") throw peerClientError("peer_client_state", "A Peer transport message id has a sender-scope conflict.");
    if (state === "delivered" || state === "pending") {
      if (!input.retainPlan) await this.#options.journal.clearPendingHandoff(messageId);
      return;
    }
    const plaintext = input.prepared ?? input.serialize(input.envelope);
    if (plaintext.byteLength <= PEER_CLIENT_MAX_PLAINTEXT_BYTES) {
      const plan = this.#handoffPlan(input, messageId, 0);
      await this.#options.journal.savePendingHandoff(plan);
      await input.send(input.address, plaintext, { messageId });
      if (!input.retainPlan) await this.#options.journal.clearPendingHandoff(messageId);
      return;
    }
    let savedPlan = false;
    let partCount = 0;
    for (const fragment of fragmentLogicalEnvelope(messageId, input.kind, plaintext)) {
      if (!savedPlan) {
        partCount = fragment.partCount;
        await this.#options.journal.savePendingHandoff(this.#handoffPlan(input, messageId, partCount));
        savedPlan = true;
      } else if (partCount !== fragment.partCount) {
        throw peerClientError("peer_client_state", "A Peer application fragment count changed during one logical handoff.");
      }
      const fragmentState = await input.getState(input.address, fragment.messageId);
      if (fragmentState === "conflict") {
        throw peerClientError("peer_client_state", "A Peer application fragment id has a sender-scope conflict.");
      }
      if (fragmentState === "delivered" || fragmentState === "pending") continue;
      await input.send(input.address, fragment.plaintext, { messageId: fragment.messageId });
    }
    if (!savedPlan) throw peerClientError("peer_client_state", "A Peer application envelope produced no transport fragments.");
    if (!input.retainPlan) await this.#options.journal.clearPendingHandoff(messageId);
  }

  #handoffPlan(input: {
    readonly sourceKind: "operation" | "discovery";
    readonly operationKey: string;
    readonly address: PeerApplicationAddress;
    readonly logicalId: string;
    readonly kind: string;
  }, messageId: string, partCount: number): PeerApplicationHandoffPlan {
    return Object.freeze({
      key: messageId,
      sourceKind: input.sourceKind,
      sourceKey: input.operationKey,
      address: Object.freeze({ ...input.address }),
      logicalId: input.logicalId,
      messageKind: input.kind,
      messageId,
      partCount
    });
  }

  async #resumeHandoff(plan: PeerApplicationHandoffPlan): Promise<void> {
    if (await this.#handoffIsDurable(plan)) {
      await this.#options.journal.clearPendingHandoff(plan.key);
      return;
    }

    if (plan.sourceKind === "operation") {
      const record = await this.#options.journal.getOperation(plan.sourceKey);
      if (!record || !sameRecordAddress(record.routeAddress, plan.address)) {
        throw peerClientError("peer_client_state", "A pending Peer handoff has no matching durable operation source.");
      }
      const envelope = await this.#operationEnvelopeForHandoff(record, plan);
      await this.#sendOperationEvent(record, plan.logicalId, plan.messageKind, envelope, true);
      return;
    }

    const record = await this.#options.journal.getDiscovery(plan.sourceKey);
    if (!record) throw peerClientError("peer_client_state", "A pending Peer handoff has no matching durable discovery source.");
    const response = plan.messageKind === "catalog_response";
    const expectedAddress = response ? reversePeerApplicationAddress(record.address) : record.address;
    if (!sameRecordAddress(expectedAddress, plan.address)) {
      throw peerClientError("peer_client_state", "A pending Peer catalog handoff has a mismatched route.");
    }
    const envelope: Envelope = response
      ? {
        version: PEER_APPLICATION_PROTOCOL_VERSION,
        kind: "catalog_response",
        requestId: record.requestId,
        address: record.address,
        agents: record.agents,
        deliveryId: "catalog:response"
      }
      : {
        version: PEER_APPLICATION_PROTOCOL_VERSION,
        kind: "catalog_request",
        requestId: record.requestId,
        address: record.address,
        deliveryId: "catalog:request"
      };
    await this.#sendDiscoveryEvent(record, envelope, true, response);
  }

  async #handoffIsDurable(plan: PeerApplicationHandoffPlan): Promise<boolean> {
    const transportIds = plan.partCount === 0
      ? [plan.messageId]
      : Array.from({ length: plan.partCount }, (_unused, index) => peerApplicationFragmentMessageId(plan.messageId, index));
    for (const messageId of transportIds) {
      const state = await this.#options.peer.getSendState(plan.address, messageId);
      if (state === "conflict") throw peerClientError("peer_client_state", "A durable Peer handoff conflicts with its fixed transport identity.");
      if (state === null) return false;
    }
    return true;
  }

  async #operationEnvelopeForHandoff(record: PeerApplicationRecord, plan: PeerApplicationHandoffPlan): Promise<Envelope> {
    const base = {
      version: PEER_APPLICATION_PROTOCOL_VERSION,
      operationId: record.operationId,
      originAddress: record.originAddress,
      requestDigest: record.requestDigest
    } as const;
    if (plan.messageKind === "operation_request" && plan.logicalId === "request" && record.role === "caller") {
      return {
        ...base,
        kind: "operation_request",
        callerAgentId: record.callerAgentId,
        targetAgentId: record.targetAgentId,
        prompt: record.prompt,
        ...(record.model === undefined ? {} : { model: record.model }),
        ...(record.effort === undefined ? {} : { effort: record.effort }),
        deliveryId: "request"
      };
    }
    if (plan.messageKind === "operation_cancel" && plan.logicalId === "cancel") {
      return { ...base, kind: "operation_cancel", deliveryId: "cancel" };
    }
    if (plan.messageKind === "operation_state") {
      const match = /^state:(\d+):([a-z_]+)$/.exec(plan.logicalId);
      const revision = match ? Number(match[1]) : 0;
      const status = match?.[2];
      if (!Number.isSafeInteger(revision) || revision < 1 || !status || !STATUS_VALUES.has(status as PeerApplicationOperationStatus)
        || plan.logicalId !== `state:${revision}:${status}`) {
        throw peerClientError("peer_client_state", "A pending Peer state handoff has an invalid revision.");
      }
      return { ...base, kind: "operation_state", status, stateRevision: revision, deliveryId: plan.logicalId };
    }
    if (plan.messageKind === "operation_result_part") {
      const match = /^result:part:(\d+)$/.exec(plan.logicalId);
      const index = match ? Number(match[1]) : -1;
      const part = Number.isSafeInteger(index) && index >= 0 ? await this.#options.journal.getResultPart(record.key, index) : null;
      if (!part) throw peerClientError("peer_client_state", "A pending Peer result handoff has no matching durable result part.");
      return { ...base, kind: "operation_result_part", index: part.index, text: part.text, deliveryId: plan.logicalId };
    }
    if (plan.messageKind === "operation_result_end" && plan.logicalId === "result:end"
      && record.resultStatus && record.resultPartCount !== null && record.resultDigest) {
      return {
        ...base,
        kind: "operation_result_end",
        status: record.resultStatus,
        stopReason: record.resultStopReason,
        partCount: record.resultPartCount,
        resultDigest: record.resultDigest,
        deliveryId: "result:end"
      };
    }
    throw peerClientError("peer_client_state", "A pending Peer operation handoff has no matching durable event source.");
  }

  async #handleInbound(delivery: PeerApplicationInbound): Promise<PeerInboundOutcome> {
    if (this.#disposed) return { kind: "deferred" };
    const message = delivery.message;
    if (message.senderDeviceId !== delivery.address.peerDeviceId) return { kind: "rejected", detail: eventDetail("sender_mismatch") };
    try {
      const parsedEnvelope = parseEnvelope(message.plaintext);
      if (!parsedEnvelope) return { kind: "rejected", detail: eventDetail("invalid_application_envelope") };
      let envelope: Envelope = parsedEnvelope;
      let fragmentMessageId: string | null = null;
      if (parsedEnvelope.kind === "application_fragment") {
        fragmentMessageId = assertPeerClientOpaqueId(parsedEnvelope.messageId, "fragment.messageId");
        const assembled = await this.#receiveApplicationFragment(delivery, parsedEnvelope);
        if (assembled.kind === "backpressured") {
          this.#deferredRoutes.set(this.#routeKey(delivery.address), delivery.address);
          return { kind: "deferred" };
        }
        if (assembled.kind === "applied") return "accepted_by_agent";
        if (assembled.kind === "incomplete") return "accepted_by_agent";
        if (assembled.kind === "conflict") return { kind: "rejected", detail: eventDetail("application_fragment_conflict") };
        if (assembled.kind !== "complete") return { kind: "deferred" };
        envelope = assembled.envelope;
      }
      await this.#dispatchInboundEnvelope(delivery, envelope);
      if (fragmentMessageId !== null) {
        await this.#options.journal.markApplicationFragmentApplied(delivery.address, fragmentMessageId);
      }
      this.#wakeDeferredRoutes();
      return "accepted_by_agent";
    } catch (error: unknown) {
      if (error instanceof DeferredApplicationDispatch || !isPeerClientError(error)) {
        this.#deferredRoutes.set(this.#routeKey(delivery.address), delivery.address);
        return { kind: "deferred" };
      }
      return { kind: "rejected", detail: eventDetail(safeErrorCode(error)) };
    }
  }

  async #dispatchInboundEnvelope(delivery: PeerApplicationInbound, envelope: Envelope): Promise<void> {
    switch (envelope.kind) {
        case "operation_request": {
          const admission = await this.#receiveRequest(delivery, envelope);
          if (admission === "deferred") {
            this.#deferredRoutes.set(this.#routeKey(delivery.address), delivery.address);
            throw new DeferredApplicationDispatch();
          }
          break;
        }
        case "operation_state":
          await this.#receiveState(delivery, envelope);
          break;
        case "operation_result_part":
          await this.#receiveResultPart(delivery, envelope);
          break;
        case "operation_result_end":
          await this.#receiveResultEnd(delivery, envelope);
          break;
        case "operation_cancel":
          await this.#receiveCancel(delivery, envelope);
          break;
        case "catalog_request":
          await this.#receiveCatalogRequest(delivery, envelope);
          break;
        case "catalog_response":
          await this.#receiveCatalogResponse(delivery, envelope);
          break;
        default:
          throw peerClientError("peer_client_state", "The Peer application message kind is unsupported.");
    }
  }

  async #receiveApplicationFragment(
    delivery: PeerApplicationInbound,
    envelope: Envelope
  ): Promise<{ readonly kind: "incomplete" | "applied" | "backpressured" | "conflict" } | { readonly kind: "complete"; readonly envelope: Envelope }> {
    const messageId = assertPeerClientOpaqueId(envelope.messageId, "fragment.messageId");
    const messageKind = assertPeerApplicationString(envelope.messageKind, "fragment.messageKind", 64);
    const partIndex = envelope.partIndex;
    const partCount = envelope.partCount;
    const totalBytes = envelope.totalBytes;
    if (!Number.isSafeInteger(partIndex) || (partIndex as number) < 0
      || !Number.isSafeInteger(partCount) || (partCount as number) < 1 || (partIndex as number) >= (partCount as number)
      || !Number.isSafeInteger(totalBytes) || (totalBytes as number) < 1
      || typeof envelope.data !== "string") {
      throw peerClientError("peer_client_state", "The Peer application fragment declaration is malformed.");
    }
    const data = envelope.data;
    const bytes = Buffer.from(data, "base64url");
    if (bytes.byteLength === 0 || bytes.toString("base64url") !== data) {
      throw peerClientError("peer_client_state", "The Peer application fragment data is malformed.");
    }
    if (delivery.message.messageId !== peerApplicationFragmentMessageId(messageId, partIndex as number)) {
      throw peerClientError("peer_client_state", "The Peer application fragment transport id does not match its part index.");
    }
    const fragment: PeerApplicationFragment = Object.freeze({
      address: delivery.address,
      messageId,
      messageKind,
      partIndex: partIndex as number,
      partCount: partCount as number,
      totalBytes: totalBytes as number,
      data
    });
    const saved = await this.#options.journal.saveApplicationFragment(fragment);
    if (saved.status === "backpressured") return { kind: "backpressured" };
    if (saved.status === "conflict") return { kind: "conflict" };
    if (saved.status === "applied") return { kind: "applied" };
    if (saved.status !== "complete") return { kind: "incomplete" };
    const bytesForEnvelope = await this.#options.journal.readApplicationFragmentMessage(delivery.address, messageId);
    if (!bytesForEnvelope) throw new DeferredApplicationDispatch();
    const logicalEnvelope = parseEnvelope(bytesForEnvelope);
    if (!logicalEnvelope || logicalEnvelope.kind !== messageKind) {
      throw peerClientError("peer_client_state", "The completed Peer application fragments do not form their declared envelope.");
    }
    const expectedMessageId = this.#expectedLogicalMessageId(delivery, logicalEnvelope);
    if (expectedMessageId === null || expectedMessageId !== messageId) {
      throw peerClientError("peer_client_state", "The Peer application fragment set is not bound to its authenticated logical message.");
    }
    return { kind: "complete", envelope: logicalEnvelope };
  }

  #expectedLogicalMessageId(delivery: PeerApplicationInbound, envelope: Envelope): string | null {
    const senderDeviceId = delivery.address.peerDeviceId;
    switch (envelope.kind) {
      case "operation_request": {
        const origin = this.#readAddress(envelope.originAddress);
        const operationId = assertPeerClientOpaqueId(envelope.operationId, "operationId");
        if (envelope.deliveryId !== "request") return null;
        return peerApplicationTransportMessageId(senderDeviceId, peerApplicationOperationKey(origin, operationId), "request");
      }
      case "operation_state":
      case "operation_result_part":
      case "operation_result_end":
      case "operation_cancel": {
        const origin = this.#readAddress(envelope.originAddress);
        const operationId = assertPeerClientOpaqueId(envelope.operationId, "operationId");
        if (typeof envelope.deliveryId !== "string") return null;
        return peerApplicationTransportMessageId(senderDeviceId, peerApplicationOperationKey(origin, operationId), envelope.deliveryId);
      }
      case "catalog_request":
      case "catalog_response": {
        const address = this.#readAddress(envelope.address);
        const requestId = assertPeerClientOpaqueId(envelope.requestId, "requestId");
        const expected = envelope.kind === "catalog_request" ? "catalog:request" : "catalog:response";
        if (envelope.deliveryId !== expected) return null;
        return peerApplicationTransportMessageId(senderDeviceId, peerApplicationDiscoveryKey(address, requestId), expected);
      }
      default:
        return null;
    }
  }

  async #receiveRequest(inbound: PeerApplicationInbound, envelope: Envelope): Promise<"accepted" | "deferred"> {
    const originAddress = this.#readAddress(envelope.originAddress);
    if (!sameRecordAddress(originAddress, reversePeerApplicationAddress(inbound.address))) {
      throw peerClientError("peer_client_state", "The operation request route is out of scope.");
    }
    const operationId = assertPeerClientOpaqueId(envelope.operationId, "operationId");
    const targetAgentId = assertPeerClientOpaqueId(envelope.targetAgentId, "targetAgentId");
    const callerAgentId = envelope.callerAgentId === null ? null : assertPeerClientOpaqueId(envelope.callerAgentId, "callerAgentId");
    const prompt = assertPeerApplicationString(envelope.prompt, "prompt", 32_000);
    const model = envelope.model == null ? undefined : assertPeerApplicationString(envelope.model, "model");
    const effort = envelope.effort == null ? undefined : assertPeerApplicationString(envelope.effort, "effort");
    const digest = assertPeerApplicationString(envelope.requestDigest, "requestDigest", 128);
    const expectedDigest = peerApplicationRequestDigest({ address: originAddress, callerAgentId, targetAgentId, prompt, model, effort });
    if (digest !== expectedDigest || envelope.deliveryId !== "request") {
      throw peerClientError("peer_client_state", "The operation request is immutable or malformed.");
    }
    const key = peerApplicationOperationKey(originAddress, operationId);

    const validateExisting = (existing: PeerApplicationRecord | null): PeerApplicationRecord | null => {
      if (existing && (existing.requestDigest !== digest
        || !sameRecordAddress(existing.originAddress, originAddress)
        || !sameRecordAddress(existing.routeAddress, inbound.address))) {
        throw peerClientError("peer_client_state", "The operation id is already bound to different request data.");
      }
      return existing;
    };

    // Re-delivery of work already accepted by this receiver is not a new
    // admission. It must remain idempotent even if its route was revoked
    // after acceptance, so check the journal before consulting live authority.
    let existing = validateExisting(await this.#options.journal.getOperation(key));
    if (!existing) {
      const authority = await this.#resolveExecutionAuthority(inbound.address);
      if (authority !== "current") {
        // A concurrent copy may have completed admission while the authority
        // lookup was in flight. Preserve duplicate semantics without holding
        // either admission or operation locks over the external lookup.
        existing = validateExisting(await this.#options.journal.getOperation(key));
        if (!existing) {
          if (authority === "unavailable") return "deferred";
          throw peerClientError("peer_application_route_revoked", "The paired route was revoked before this request was accepted.");
        }
      }
    }

    let admission: RequestAdmission;
    try {
      admission = await this.#withAdmissionLock(() => this.#withKeyLock(key, async () => {
      const existing = validateExisting(await this.#options.journal.getOperation(key));
      if (existing) {
        return { kind: "existing" as const, record: existing };
      }

      let agents;
      try {
        agents = await this.#options.agents.list();
      } catch {
        return { kind: "deferred" as const };
      }
      const agent = agents.some((item) => item.id === targetAgentId && item.enabled)
        ? this.#options.agents.get(targetAgentId)
        : null;
      const acceptedRecord = makeOperationRecord({
        key,
        operationId,
        originAddress,
        routeAddress: inbound.address,
        role: "receiver",
        callerAgentId,
        targetAgentId,
        requestDigest: digest,
        prompt,
        model,
        effort,
        status: "accepted",
        inboundMessageId: inbound.message.messageId
      });
      if (agent === null) {
        await this.#saveOperation(acceptedRecord);
        return { kind: "unavailable_agent" as const, record: acceptedRecord };
      }

      const outstanding = await this.#countOutstandingExecutions();
      if (outstanding >= MAX_OUTSTANDING_EXECUTIONS) return { kind: "deferred" as const };

      await this.#saveOperation(acceptedRecord);
      return { kind: "accepted" as const, record: acceptedRecord };
      }));
    } catch (error: unknown) {
      if (isPeerClientError(error)) throw error;
      return "deferred";
    }

    if (admission.kind === "deferred") return "deferred";
    const acceptedRecord = admission.record;
    if (admission.kind === "unavailable_agent") {
      await this.#setTerminal(acceptedRecord, "refused", "agent_unavailable", "The requested local Agent is unavailable.", "refusal");
    } else if (!acceptedRecord.promptReserved && !TERMINAL.has(acceptedRecord.status)) {
      this.#scheduleExecution(key);
    }
    this.#defer(async () => this.#publishReceiverState(acceptedRecord));
    return "accepted";
  }

  async #publishReceiverState(record: PeerApplicationRecord): Promise<void> {
    if (TERMINAL.has(record.status)) {
      await this.#sendStoredResult(record, true);
      return;
    }
    const logicalId = `state:${record.stateRevision}:${record.status}`;
    const state: Envelope = {
      version: PEER_APPLICATION_PROTOCOL_VERSION,
      kind: "operation_state",
      operationId: record.operationId,
      originAddress: record.originAddress,
      requestDigest: record.requestDigest,
      status: record.status,
      stateRevision: record.stateRevision,
      deliveryId: logicalId
    };
    await this.#sendOperationEvent(record, logicalId, "operation_state", state, true);
  }

  async #receiveState(inbound: PeerApplicationInbound, envelope: Envelope): Promise<void> {
    const record = await this.#findMatchingOperation(inbound, envelope, "caller");
    const status = parseStatus(envelope.status);
    if (!status || status === "delivery_pending" || TERMINAL.has(status)) {
      throw peerClientError("peer_client_state", "The remote operation state is invalid.");
    }
    const revision = envelope.stateRevision;
    if (!Number.isSafeInteger(revision) || (revision as number) < 1 || envelope.deliveryId !== `state:${revision}:${status}`) {
      throw peerClientError("peer_client_state", "The remote operation state revision is invalid.");
    }
    await this.#withKeyLock(record.key, async () => {
      const current = await this.#options.journal.getOperation(record.key);
      if (!current || TERMINAL.has(current.status)) return;
      if ((revision as number) < current.stateRevision) return;
      if ((revision as number) === current.stateRevision) {
        if (status !== current.status) throw peerClientError("peer_client_state", "The remote operation state revision conflicts with durable state.");
        return;
      }
      if (!canFollowOperationState(current.status, status)) {
        throw peerClientError("peer_client_state", "The remote operation state transition is invalid.");
      }
      await this.#saveOperation(updateRecord(current, { status, stateRevision: revision as number }));
    });
  }

  async #receiveResultPart(inbound: PeerApplicationInbound, envelope: Envelope): Promise<void> {
    const record = await this.#findMatchingOperation(inbound, envelope, "caller");
    if (!Number.isSafeInteger(envelope.index) || (envelope.index as number) < 0 || typeof envelope.text !== "string") {
      throw peerClientError("peer_client_state", "The operation result part is invalid.");
    }
    const part: PeerApplicationResultPart = Object.freeze({ index: envelope.index as number, text: envelope.text });
    await this.#options.journal.saveResultPart(record.key, part);
  }

  async #receiveResultEnd(inbound: PeerApplicationInbound, envelope: Envelope): Promise<void> {
    const record = await this.#findMatchingOperation(inbound, envelope, "caller");
    const status = parseStatus(envelope.status);
    const digest = assertPeerApplicationString(envelope.resultDigest, "resultDigest", 128);
    const partCount = envelope.partCount;
    const stopReason = envelope.stopReason === null ? null : envelope.stopReason;
    if (!status || !Number.isSafeInteger(partCount) || (partCount as number) < 0
      || !TERMINAL.has(status)
      || (stopReason !== null && (typeof stopReason !== "string" || !STOP_REASON_VALUES.has(stopReason as AcpStopReason)))
      || envelope.deliveryId !== "result:end") {
      throw peerClientError("peer_client_state", "The operation result terminator is invalid.");
    }
    const parts = await this.#options.journal.listResultParts(record.key);
    if (parts.length > (partCount as number) || parts.some((part) => part.index >= (partCount as number))) {
      throw peerClientError("peer_client_state", "The operation result contains parts outside its declared range.");
    }
    if (parts.length !== partCount) throw new DeferredApplicationDispatch();
    let text = "";
    for (let index = 0; index < parts.length; index += 1) {
      if (parts[index]?.index !== index) throw new DeferredApplicationDispatch();
      text += parts[index]?.text ?? "";
    }
    const actualDigest = crypto.createHash("sha256").update(text, "utf8").digest("hex");
    if (actualDigest !== digest) throw peerClientError("peer_client_state", "The operation result digest does not match.");
    await this.#withKeyLock(record.key, async () => {
      const current = await this.#options.journal.getOperation(record.key);
      if (!current) return;
      if (TERMINAL.has(current.status)) {
        if (current.resultDigest !== digest) throw peerClientError("peer_client_state", "A terminal result conflicts with durable content.");
        return;
      }
      await this.#saveOperation(updateRecord(current, {
        status,
        resultText: text,
        resultDigest: digest,
        resultStopReason: stopReason as AcpStopReason | null,
        resultStatus: status,
        resultPartCount: partCount as number,
        lastError: status === "unknown" ? "execution_outcome_unknown" : null
      }));
    });
  }

  async #receiveCancel(inbound: PeerApplicationInbound, envelope: Envelope): Promise<void> {
    const record = await this.#findMatchingOperation(inbound, envelope, "receiver");
    if (envelope.deliveryId !== "cancel") throw peerClientError("peer_client_state", "The operation cancellation id is invalid.");
    let cancelledBeforePrompt: PeerApplicationRecord | null = null;
    await this.#withKeyLock(record.key, async () => {
      const current = await this.#options.journal.getOperation(record.key);
      if (!current || TERMINAL.has(current.status)) return;
      const updated = updateRecord(current, { cancelRequested: true, status: "cancel_requested" });
      await this.#saveOperation(updated);
      if (!current.promptReserved) cancelledBeforePrompt = updated;
      this.#resolvePermissionWaiter(record.key, { outcome: "cancelled" });
      const running = this.#running.get(record.key);
      if (running) this.#defer(() => running.cancel());
    });
    const current = await this.#options.journal.getOperation(record.key);
    if (current && current.status === "cancel_requested") this.#defer(() => this.#publishReceiverState(current));
    if (cancelledBeforePrompt) this.#defer(() => this.#setTerminal(cancelledBeforePrompt as PeerApplicationRecord, "cancelled", null, "", "cancelled"));
  }

  async #receiveCatalogRequest(inbound: PeerApplicationInbound, envelope: Envelope): Promise<void> {
    const requestId = assertPeerClientOpaqueId(envelope.requestId, "requestId");
    const origin = this.#readAddress(envelope.address);
    if (!sameRecordAddress(origin, reversePeerApplicationAddress(inbound.address)) || envelope.deliveryId !== "catalog:request") {
      throw peerClientError("peer_client_state", "The Agent catalog request route is invalid.");
    }
    const key = peerApplicationDiscoveryKey(origin, requestId);
    let responseRecord: PeerApplicationDiscoveryRecord | null = null;
    await this.#withKeyLock(`discovery:${key}`, async () => {
      const existing = await this.#options.journal.getDiscovery(key);
      if (existing?.status === "completed") {
        await this.#options.journal.savePendingDiscoveryRecovery(existing, "response");
        responseRecord = existing;
        return;
      }
      const agents = await this.#options.agents.list();
      const timestamp = dateNow();
      const record: PeerApplicationDiscoveryRecord = Object.freeze({
        version: PEER_APPLICATION_PROTOCOL_VERSION,
        key,
        requestId,
        address: origin,
        status: "completed",
        agents,
        lastError: null,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      });
      await this.#options.journal.savePendingDiscoveryRecovery(record, "response");
      await this.#options.journal.saveDiscovery(record);
      this.#emit({ kind: "discovery", discovery: record });
      responseRecord = record;
    });
    if (responseRecord) this.#defer(() => this.#resumeCatalogResponse(responseRecord as PeerApplicationDiscoveryRecord));
  }

  async #receiveCatalogResponse(inbound: PeerApplicationInbound, envelope: Envelope): Promise<void> {
    const requestId = assertPeerClientOpaqueId(envelope.requestId, "requestId");
    const origin = this.#readAddress(envelope.address);
    if (!sameRecordAddress(origin, inbound.address) || !Array.isArray(envelope.agents) || envelope.deliveryId !== "catalog:response") {
      throw peerClientError("peer_client_state", "The Agent catalog response route is invalid.");
    }
    if (!envelope.agents.every(validSummary)) throw peerClientError("peer_client_state", "The Agent catalog response contains an invalid item.");
    const key = peerApplicationDiscoveryKey(origin, requestId);
    await this.#withKeyLock(`discovery:${key}`, async () => {
      const current = await this.#options.journal.getDiscovery(key);
      if (!current) throw peerClientError("peer_client_state", "The Agent catalog response has no matching request.");
      const updated: PeerApplicationDiscoveryRecord = Object.freeze({
        ...current,
        status: "completed",
        agents: Object.freeze(envelope.agents as PeerApplicationDiscoveryRecord["agents"]),
        updatedAt: dateNow(),
        lastError: null
      });
      await this.#options.journal.saveDiscovery(updated);
      this.#emit({ kind: "discovery", discovery: updated });
    });
  }


  async #findMatchingOperation(
    inbound: PeerApplicationInbound,
    envelope: Envelope,
    role: "caller" | "receiver"
  ): Promise<PeerApplicationRecord> {
    const originAddress = this.#readAddress(envelope.originAddress);
    const operationId = assertPeerClientOpaqueId(envelope.operationId, "operationId");
    const digest = assertPeerApplicationString(envelope.requestDigest, "requestDigest", 128);
    const record = role === "caller"
      ? await this.#callerOperationForAddress(operationId, originAddress, inbound.address, digest)
      : await this.#options.journal.getOperation(peerApplicationOperationKey(originAddress, operationId));
    if (!record || record.requestDigest !== digest) throw peerClientError("peer_client_state", "The application message has no matching durable operation.");
    if (record.role !== role) throw peerClientError("peer_client_state", "The application message has the wrong operation role.");
    const expectedRoute = record.role === "caller" ? record.originAddress : reversePeerApplicationAddress(record.originAddress);
    if (!sameRecordAddress(inbound.address, expectedRoute) || inbound.message.senderDeviceId !== inbound.address.peerDeviceId) {
      throw peerClientError("peer_client_state", "The application message does not match its authenticated route.");
    }
    return record;
  }

  async #callerOperationForAddress(
    operationId: string,
    originAddress: PeerApplicationAddress,
    inboundAddress: PeerApplicationAddress,
    requestDigest: unknown
  ): Promise<PeerApplicationRecord> {
    const record = await this.#options.journal.getOperation(peerApplicationOperationKey(originAddress, operationId));
    if (!record
      || record.role !== "caller"
      || record.requestDigest !== requestDigest
      || !sameRecordAddress(record.originAddress, originAddress)
      || !sameRecordAddress(inboundAddress, record.originAddress)) {
      throw peerClientError("peer_client_state", "The application message has no matching durable caller operation.");
    }
    return record;
  }

  #readAddress(value: unknown): PeerApplicationAddress {
    if (!isRecord(value)) throw peerClientError("peer_client_state", "The application route address is invalid.");
    return Object.freeze({
      tenantId: assertPeerClientOpaqueId(value.tenantId, "address.tenantId"),
      routeId: assertPeerClientOpaqueId(value.routeId, "address.routeId"),
      localDeviceId: assertPeerClientOpaqueId(value.localDeviceId, "address.localDeviceId"),
      peerDeviceId: assertPeerClientOpaqueId(value.peerDeviceId, "address.peerDeviceId")
    });
  }

  #scheduleExecution(key: string): void {
    if (this.#started.has(key) || this.#disposed) return;
    this.#executionQueue.add(key);
    this.#pumpExecutionQueue();
  }

  #pumpExecutionQueue(): void {
    if (this.#disposed || this.#executionPumpScheduled) return;
    this.#executionPumpScheduled = true;
    setImmediate(() => {
      this.#executionPumpScheduled = false;
      void (async () => {
        while (this.#started.size < MAX_CONCURRENT_EXECUTIONS && this.#executionQueue.size > 0) {
          let next: PeerApplicationRecord | null = null;
          for (const key of this.#executionQueue) {
            const record = await this.#options.journal.getOperation(key);
            if (!record || record.role !== "receiver" || record.promptReserved || record.terminalPrepared || TERMINAL.has(record.status)) {
              this.#executionQueue.delete(key);
              continue;
            }
            next = record;
            break;
          }
          if (!next) return;
          this.#executionQueue.delete(next.key);
          if (this.#started.has(next.key)) continue;
          this.#started.add(next.key);
          void this.#execute(next.key).catch(() => {
            this.#scheduleRecoveryRetry(false, true);
          }).finally(() => {
            this.#started.delete(next.key);
            this.#executionQueue.delete(next.key);
            this.#pumpExecutionQueue();
            this.#wakeDeferredRoutes();
          });
        }
      })().catch(() => this.#scheduleRecoveryRetry(false, true));
    });
  }

  async #execute(key: string): Promise<void> {
    const record = await this.#options.journal.getOperation(key);
    if (!record || record.role !== "receiver" || record.promptReserved || TERMINAL.has(record.status)) return;
    if (record.cancelRequested) {
      await this.#setTerminal(record, "cancelled", null, "", "cancelled");
      return;
    }
    const authority = await this.#resolveExecutionAuthority(record.routeAddress);
    if (authority === "unavailable") return;
    if (authority === "revoked") {
      await this.#setTerminal(record, "refused", "peer_route_revoked", "The paired route was revoked before Agent execution.", "refusal");
      return;
    }
    let agent: ReturnType<PeerApplicationAgentDirectory["get"]>;
    try {
      await this.#options.agents.list();
      agent = this.#options.agents.get(record.targetAgentId);
    } catch {
      // The accepted journal row remains queued for resume when local authority
      // returns; do not terminalize it or reserve the paid prompt.
      return;
    }
    if (!agent) {
      await this.#finish(record, { stopReason: "refusal", text: "" }, "refused", "agent_unavailable");
      return;
    }
    let execution: PeerApplicationExecution;
    try {
      execution = agent.start({
        operationId: record.operationId,
        prompt: record.prompt,
        ...(record.model === undefined ? {} : { model: record.model }),
        ...(record.effort === undefined ? {} : { effort: record.effort })
      }, {
      beforePrompt: async () => {
        const currentAuthority = await this.#resolveExecutionAuthority(record.routeAddress);
        if (currentAuthority === "unavailable") {
          throw peerClientError("peer_application_authority_unavailable", "The paired route authority is temporarily unavailable.");
        }
        if (currentAuthority === "revoked") {
          throw peerClientError("peer_application_route_revoked", "The paired route was revoked before Agent execution.");
        }
        await this.#withKeyLock(key, async () => {
          const current = await this.#options.journal.getOperation(key);
          if (!current || current.promptReserved || TERMINAL.has(current.status) || current.cancelRequested) {
            throw peerClientError("peer_client_state", "The durable ACP prompt reservation is no longer available.");
          }
          const reserved = updateRecord(current, {
            promptReserved: true,
            promptExecutionId: this.#executionId,
            status: current.cancelRequested ? "cancel_requested" : "running"
          });
          await this.#saveOperation(reserved);
          this.#defer(() => this.#publishReceiverState(reserved));
        });
      },
      onProgress: async (item) => {
        await this.#recordProgress(key, item.kind, item.text);
      },
      requestPermission: (request) => this.#requestPermission(key, request)
      });
    } catch (error: unknown) {
      await this.#setTerminal(record, "failed", safeErrorCode(error), "");
      return;
    }
    this.#running.set(key, execution);
    try {
      const result = await execution.result;
      const status: PeerApplicationOperationStatus = result.stopReason === "end_turn"
        ? "completed"
        : result.stopReason === "refusal"
          ? "refused"
          : result.stopReason === "cancelled"
            ? "cancelled"
            : "stopped";
      await this.#finish(record, result, status, null);
    } catch (error: unknown) {
      const current = await this.#options.journal.getOperation(key);
      if (!current) return;
      if (current.terminalPrepared) {
        await this.#completePreparedTerminal(current);
      } else if (current.promptReserved) {
        // The ACP write may have crossed the process boundary before a lost
        // response; never risk invoking a paid prompt a second time.
        const savedParts = await this.#options.journal.listResultParts(key);
        const partialChunks = savedParts.length === 0
          ? await this.#options.journal.listPartialResultChunks(key)
          : savedParts;
        const partial = partialChunks.map((part) => part.text).join("");
        await this.#setTerminal(current, "unknown", "execution_outcome_unknown", partial);
      } else if (current.cancelRequested) {
        await this.#setTerminal(current, "cancelled", null, "", "cancelled");
      } else if (safeErrorCode(error) === "peer_application_authority_unavailable") {
        // Keep the accepted request queued without a prompt reservation. A
        // route-restoration event will call resume() and schedule it again.
        return;
      } else if (safeErrorCode(error) === "peer_application_route_revoked") {
        await this.#setTerminal(current, "refused", "peer_route_revoked", "The paired route was revoked before Agent execution.", "refusal");
      } else {
        await this.#setTerminal(current, "failed", safeErrorCode(error), "");
      }
    } finally {
      this.#running.delete(key);
      this.#resolvePermissionWaiter(key, { outcome: "cancelled" });
    }
  }

  async #resolveExecutionAuthority(address: PeerApplicationAddress): Promise<"current" | "unavailable" | "revoked"> {
    try {
      const result = await this.#options.peer.resolvePeerAuthority(address);
      return result === "current" || result === "revoked" ? result : "unavailable";
    } catch {
      // A failed authority lookup is not evidence of revocation. Preserve the
      // accepted operation and wait for the host's authority-restoration wake.
      return "unavailable";
    }
  }

  async #recordProgress(key: string, kind: string, text: string): Promise<void> {
    if (kind !== "message" || text.length === 0) return;
    await this.#withKeyLock(key, async () => {
      const current = await this.#options.journal.getOperation(key);
      if (!current || TERMINAL.has(current.status)) return;
      let index = this.#partialResultChunkCounts.get(key);
      if (index === undefined) {
        const saved = await this.#options.journal.listPartialResultChunks(key);
        index = (saved[saved.length - 1]?.index ?? -1) + 1;
      }
      await this.#options.journal.savePartialResultChunk(key, index, text);
      this.#partialResultChunkCounts.set(key, index + 1);
    });
  }

  async #requestPermission(key: string, request: AcpPermissionPrompt): Promise<AcpPermissionResolution> {
    const previous = this.#permissionQueues.get(key) ?? Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const currentTail = previous.then(() => gate);
    this.#permissionQueues.set(key, currentTail);
    await previous;
    try {
      return await this.#waitForPermission(key, request);
    } finally {
      release();
      if (this.#permissionQueues.get(key) === currentTail) this.#permissionQueues.delete(key);
    }
  }

  async #waitForPermission(key: string, request: AcpPermissionPrompt): Promise<AcpPermissionResolution> {
    const permissionId = `permission.${crypto.randomUUID()}`;
    let pending: Promise<AcpPermissionResolution> | null = null;
    let stateToSend: PeerApplicationRecord | null = null;
    await this.#withKeyLock(key, async () => {
      const current = await this.#options.journal.getOperation(key);
      if (!current || TERMINAL.has(current.status) || current.cancelRequested) return;
      const permission = Object.freeze({ id: permissionId, status: "pending" as const, request, selectedOptionId: null, updatedAt: dateNow() });
      const updated = updateRecord(current, { status: current.cancelRequested ? "cancel_requested" : "awaiting_permission", permission });
      stateToSend = updateRecord(updated, { permissionHistory: Object.freeze([...current.permissionHistory, permission]) });
      await this.#saveOperation(stateToSend);
      pending = new Promise<AcpPermissionResolution>((resolve) => {
        this.#permissionWaiters.set(key, { permissionId, resolve });
      });
    });
    if (stateToSend) this.#defer(() => this.#publishReceiverState(stateToSend as PeerApplicationRecord));
    return pending ?? { outcome: "cancelled" };
  }

  #resolvePermissionWaiter(key: string, resolution: AcpPermissionResolution): void {
    const waiter = this.#permissionWaiters.get(key);
    if (!waiter) return;
    this.#permissionWaiters.delete(key);
    waiter.resolve(resolution);
  }

  async #finish(
    record: PeerApplicationRecord,
    result: { readonly stopReason: AcpStopReason; readonly text: string },
    status: PeerApplicationOperationStatus,
    errorCode: string | null
  ): Promise<void> {
    const current = await this.#options.journal.getOperation(record.key);
    if (!current || current.status === "unknown") return;
    await this.#setTerminal(current, status, errorCode, result.text, result.stopReason);
  }

  async #setTerminal(
    record: PeerApplicationRecord,
    status: PeerApplicationOperationStatus,
    errorCode: string | null,
    resultText: string,
    stopReason: AcpStopReason | null = null
  ): Promise<void> {
    const digest = crypto.createHash("sha256").update(resultText, "utf8").digest("hex");
    const parts = resultParts(resultText, (index, text) => ({
      version: PEER_APPLICATION_PROTOCOL_VERSION,
      kind: "operation_result_part",
      operationId: record.operationId,
      originAddress: record.originAddress,
      requestDigest: record.requestDigest,
      index,
      text,
      deliveryId: `result:part:${index}`
    }));
    let prepared: PeerApplicationRecord | null = null;
    await this.#withKeyLock(record.key, async () => {
      const current = await this.#options.journal.getOperation(record.key);
      if (!current || TERMINAL.has(current.status)) return;
      if (current.terminalPrepared) {
        if (current.resultDigest !== digest || current.resultStatus !== status) {
          throw peerClientError("peer_client_state", "A prepared application result conflicts with the durable result.");
        }
        prepared = current;
        return;
      }
      const updated = updateRecord(current, {
        terminalPrepared: true,
        resultStatus: status,
        resultText,
        resultDigest: digest,
        resultStopReason: stopReason,
        resultPartCount: parts.length,
        lastError: errorCode
      });
      await this.#saveOperation(updated);
      prepared = updated;
    });
    if (prepared) await this.#completePreparedTerminal(prepared);
  }

  async #completePreparedTerminal(record: PeerApplicationRecord): Promise<void> {
    if (!record.terminalPrepared || record.resultText === null || record.resultDigest === null
      || record.resultPartCount === null || record.resultStatus === null) return;
    const digest = crypto.createHash("sha256").update(record.resultText, "utf8").digest("hex");
    const parts = resultParts(record.resultText, (index, text) => ({
      version: PEER_APPLICATION_PROTOCOL_VERSION,
      kind: "operation_result_part",
      operationId: record.operationId,
      originAddress: record.originAddress,
      requestDigest: record.requestDigest,
      index,
      text,
      deliveryId: `result:part:${index}`
    }));
    if (digest !== record.resultDigest || parts.length !== record.resultPartCount) {
      throw peerClientError("peer_client_state", "The prepared application result is malformed.");
    }
    for (const part of parts) await this.#options.journal.saveResultPart(record.key, part);
    await this.#withKeyLock(record.key, async () => {
      const current = await this.#options.journal.getOperation(record.key);
      if (!current || TERMINAL.has(current.status) || !current.terminalPrepared) return;
      const updated = updateRecord(current, {
        status: current.resultStatus as PeerApplicationOperationStatus,
        terminalPrepared: false,
        permission: current.permission?.status === "pending"
          ? Object.freeze({ ...current.permission, status: "unavailable", updatedAt: dateNow() })
          : current.permission,
        permissionHistory: Object.freeze(current.permissionHistory.map((permission) => permission.status === "pending"
          ? Object.freeze({ ...permission, status: "unavailable" as const, updatedAt: dateNow() })
          : permission))
      });
      await this.#saveOperation(updated);
    });
    await this.#options.journal.clearPartialResultChunks(record.key);
    this.#partialResultChunkCounts.delete(record.key);
    const completed = await this.#options.journal.getOperation(record.key);
    if (completed) this.#defer(() => this.#sendStoredResult(completed, false));
    this.#wakeDeferredRoutes();
  }

  async #sendStoredResult(record: PeerApplicationRecord, recovery: boolean): Promise<void> {
    if (!record.resultStatus || record.resultPartCount === null || !record.resultDigest) return;
    await this.#options.journal.savePendingOperationRecovery(record);
    if (await this.#resultHandoffsDurable(record)) {
      await this.#finishResultHandoff(record);
      return;
    }
    const parts = await this.#options.journal.listResultParts(record.key);
    for (const part of parts) {
      const logicalId = `result:part:${part.index}`;
      const envelope: Envelope = {
        version: PEER_APPLICATION_PROTOCOL_VERSION,
        kind: "operation_result_part",
        operationId: record.operationId,
        originAddress: record.originAddress,
        requestDigest: record.requestDigest,
        index: part.index,
        text: part.text,
        deliveryId: logicalId
      };
      await this.#sendOperationEvent(record, logicalId, "operation_result_part", envelope, recovery, undefined, true);
    }
    const end: Envelope = {
      version: PEER_APPLICATION_PROTOCOL_VERSION,
      kind: "operation_result_end",
      operationId: record.operationId,
      originAddress: record.originAddress,
      requestDigest: record.requestDigest,
      status: record.resultStatus,
      stopReason: record.resultStopReason,
      partCount: record.resultPartCount,
      resultDigest: record.resultDigest,
      deliveryId: "result:end"
    };
    await this.#sendOperationEvent(record, "result:end", "operation_result_end", end, recovery, undefined, true);
    await this.#finishResultHandoff(record);
  }

  async #resultHandoffsDurable(record: Pick<PeerApplicationRecord | PeerApplicationOperationRecovery, "key" | "routeAddress" | "resultPartCount">): Promise<boolean> {
    if (record.resultPartCount === null) return false;
    for (let index = 0; index < record.resultPartCount; index += 1) {
      const logicalId = `result:part:${index}`;
      const messageId = peerApplicationTransportMessageId(record.routeAddress.localDeviceId, record.key, logicalId);
      const plan = await this.#options.journal.getPendingHandoff(messageId);
      const ids = plan && plan.partCount > 0
        ? Array.from({ length: plan.partCount }, (_unused, partIndex) => peerApplicationFragmentMessageId(messageId, partIndex))
        : [messageId];
      for (const id of ids) {
        const state = await this.#options.peer.getSendState(record.routeAddress, id);
        if (state === "conflict") throw peerClientError("peer_client_state", "A durable Peer result conflicts with its fixed transport identity.");
        if (state === null) return false;
      }
    }
    const endId = peerApplicationTransportMessageId(record.routeAddress.localDeviceId, record.key, "result:end");
    const endState = await this.#options.peer.getSendState(record.routeAddress, endId);
    if (endState === "conflict") throw peerClientError("peer_client_state", "A durable Peer result terminator conflicts with its fixed transport identity.");
    return endState !== null;
  }

  async #finishResultHandoff(record: PeerApplicationRecord): Promise<void> {
    await this.#withKeyLock(record.key, async () => {
      const current = await this.#options.journal.getOperation(record.key);
      if (current?.resultDigest === record.resultDigest && TERMINAL.has(current.status) && !current.terminalPrepared) {
        // Clear the recovery owner only after each fixed result ID is durable.
        await this.#options.journal.clearPartialResultChunks(record.key);
        await this.#options.journal.clearPendingOperationRecovery(record.key, current.stateRevision);
      }
    });
    await this.#clearResultHandoffPlans(record);
    this.#wakeDeferredRoutes();
  }

  async #clearResultHandoffPlans(record: Pick<PeerApplicationRecord | PeerApplicationOperationRecovery, "key" | "routeAddress" | "resultPartCount">): Promise<void> {
    if (record.resultPartCount === null) return;
    for (let index = 0; index < record.resultPartCount; index += 1) {
      const logicalId = `result:part:${index}`;
      await this.#options.journal.clearPendingHandoff(
        peerApplicationTransportMessageId(record.routeAddress.localDeviceId, record.key, logicalId)
      );
    }
    await this.#options.journal.clearPendingHandoff(
      peerApplicationTransportMessageId(record.routeAddress.localDeviceId, record.key, "result:end")
    );
  }

}
