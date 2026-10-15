import crypto from "node:crypto";
import { open, opendir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { ensurePrivateDir, writePrivateFileAtomic } from "@meshrix/foundation/storage/private-file-atomic";
import { assertPrivateStorageCapacity } from "@meshrix/foundation/storage/private-storage-capacity";
import type {
  PeerApplicationDiscoveryRecord,
  PeerApplicationDiscoveryRecovery,
  PeerApplicationFragment,
  PeerApplicationFragmentSaveResult,
  PeerApplicationHandoffPlan,
  PeerApplicationJournal,
  PeerApplicationOperationRecovery,
  PeerApplicationPage,
  PeerApplicationRecord,
  PeerApplicationResultPart
} from "@meshrix/peer-client";

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function recordObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Peer application journal ${label} is malformed.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Peer application journal ${label} is malformed.`);
  return value;
}

function requireOperation(value: unknown, label: string): PeerApplicationRecord {
  const entry = recordObject(value, label);
  if (entry.version !== 1) {
    throw new Error(`Peer application journal ${label} has an unsupported record.`);
  }
  requiredString(entry.key, `${label}.key`);
  requiredString(entry.operationId, `${label}.operationId`);
  requiredString(entry.requestDigest, `${label}.requestDigest`);
  const stateRevision = entry.stateRevision ?? (entry.status === "delivery_pending" ? 0 : 1);
  if (!Number.isSafeInteger(stateRevision) || (stateRevision as number) < 0) {
    throw new Error(`Peer application journal ${label}.stateRevision is malformed.`);
  }
  const permissionHistory = entry.permissionHistory === undefined ? [] : entry.permissionHistory;
  if (!Array.isArray(permissionHistory)) throw new Error(`Peer application journal ${label}.permissionHistory is malformed.`);
  if (entry.terminalPrepared !== undefined && typeof entry.terminalPrepared !== "boolean") {
    throw new Error(`Peer application journal ${label}.terminalPrepared is malformed.`);
  }
  const retained = { ...entry };
  for (const field of [
    "progressRevision", "partialResultChunkCount", "requestAcked", "acceptedAcked",
    "progressAckedRevision", "resultAckedParts", "resultEndAcked", "cancelAcked"
  ]) delete retained[field];
  return Object.freeze({
    ...retained,
    promptExecutionId: entry.promptExecutionId ?? null,
    terminalPrepared: entry.terminalPrepared === true,
    stateRevision: stateRevision as number,
    permissionHistory: Object.freeze([...permissionHistory])
  }) as unknown as PeerApplicationRecord;
}

function requirePart(value: unknown, label: string): PeerApplicationResultPart {
  const entry = recordObject(value, label);
  if (!Number.isSafeInteger(entry.index) || (entry.index as number) < 0 || typeof entry.text !== "string") {
    throw new Error(`Peer application journal ${label} is malformed.`);
  }
  return Object.freeze({ index: entry.index as number, text: entry.text });
}

function requireDiscovery(value: unknown, label: string): PeerApplicationDiscoveryRecord {
  const entry = recordObject(value, label);
  if (entry.version !== 1 || !Array.isArray(entry.agents)) throw new Error(`Peer application journal ${label} is malformed.`);
  requiredString(entry.key, `${label}.key`);
  requiredString(entry.requestId, `${label}.requestId`);
  return entry as unknown as PeerApplicationDiscoveryRecord;
}

interface StoredFragmentAssembly {
  readonly version: 1;
  readonly address: PeerApplicationFragment["address"];
  readonly messageId: string;
  readonly messageKind: string;
  readonly partCount: number;
  readonly totalBytes: number;
  readonly complete: boolean;
  /** Set only after the logical application handler has durably committed. */
  readonly applied: boolean;
}

interface StoredFragmentPart {
  readonly partIndex: number;
  readonly data: string;
}

interface FragmentProgress {
  receivedParts: number;
  receivedBytes: number;
}

const MAX_ACTIVE_FRAGMENT_ASSEMBLIES = 128;
const JOURNAL_INDEX_VERSION = 1;
const PAGE_LIMIT = 128;
const TERMINAL_OPERATION_STATUSES = new Set(["completed", "refused", "stopped", "cancelled", "unknown", "failed"]);

function requireOperationKeys(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((key) => typeof key === "string" && key.length > 0)) {
    throw new Error("Peer application operation index is malformed.");
  }
  return Object.freeze([...new Set(value as string[])]);
}

function requireAddress(value: unknown, label: string): PeerApplicationFragment["address"] {
  const address = recordObject(value, label);
  for (const field of ["tenantId", "routeId", "localDeviceId", "peerDeviceId"] as const) {
    requiredString(address[field], `${label}.${field}`);
  }
  return Object.freeze({
    tenantId: address.tenantId as string,
    routeId: address.routeId as string,
    localDeviceId: address.localDeviceId as string,
    peerDeviceId: address.peerDeviceId as string
  });
}

function requireOperationRecovery(value: unknown): PeerApplicationOperationRecovery {
  const entry = recordObject(value, "operation recovery");
  if (entry.version !== 1 || (entry.role !== "caller" && entry.role !== "receiver")
    || typeof entry.cancelRequested !== "boolean" || typeof entry.terminal !== "boolean"
    || typeof entry.terminalPrepared !== "boolean" || typeof entry.executionPending !== "boolean"
    || !Number.isSafeInteger(entry.stateRevision) || (entry.stateRevision as number) < 0
    || !Number.isFinite(Date.parse(requiredString(entry.createdAt, "operation recovery.createdAt")))
    || (entry.resultPartCount !== null && (!Number.isSafeInteger(entry.resultPartCount) || (entry.resultPartCount as number) < 0))) {
    throw new Error("Peer application operation recovery marker is malformed.");
  }
  requiredString(entry.key, "operation recovery.key");
  requiredString(entry.operationId, "operation recovery.operationId");
  requiredString(entry.requestDigest, "operation recovery.requestDigest");
  return Object.freeze({
    key: entry.key as string,
    role: entry.role,
    operationId: entry.operationId as string,
    originAddress: requireAddress(entry.originAddress, "operation recovery.originAddress"),
    routeAddress: requireAddress(entry.routeAddress, "operation recovery.routeAddress"),
    requestDigest: entry.requestDigest as string,
    cancelRequested: entry.cancelRequested,
    terminal: entry.terminal,
    terminalPrepared: entry.terminalPrepared,
    executionPending: entry.executionPending,
    resultPartCount: entry.resultPartCount as number | null,
    stateRevision: entry.stateRevision as number,
    createdAt: entry.createdAt as string
  });
}

function operationRecovery(record: PeerApplicationRecord): PeerApplicationOperationRecovery & { readonly version: 1 } {
  return Object.freeze({
    version: 1,
    key: record.key,
    role: record.role,
    operationId: record.operationId,
    originAddress: Object.freeze({ ...record.originAddress }),
    routeAddress: Object.freeze({ ...record.routeAddress }),
    requestDigest: record.requestDigest,
    cancelRequested: record.cancelRequested,
    terminal: TERMINAL_OPERATION_STATUSES.has(record.status),
    terminalPrepared: record.terminalPrepared,
    executionPending: record.role === "receiver" && !record.terminalPrepared && !TERMINAL_OPERATION_STATUSES.has(record.status),
    resultPartCount: record.resultPartCount,
    stateRevision: record.stateRevision,
    createdAt: record.createdAt
  });
}

function requireDiscoveryRecovery(value: unknown): PeerApplicationDiscoveryRecovery {
  const entry = recordObject(value, "discovery recovery");
  if (entry.version !== 1 || (entry.action !== "request" && entry.action !== "response")) {
    throw new Error("Peer application discovery recovery marker is malformed.");
  }
  return Object.freeze({
    key: requiredString(entry.key, "discovery recovery.key"),
    address: requireAddress(entry.address, "discovery recovery.address"),
    requestId: requiredString(entry.requestId, "discovery recovery.requestId"),
    action: entry.action
  });
}

function requireHandoffPlan(value: unknown): PeerApplicationHandoffPlan {
  const entry = recordObject(value, "pending handoff");
  const address = recordObject(entry.address, "pending handoff address");
  if (entry.version !== 1 || (entry.sourceKind !== "operation" && entry.sourceKind !== "discovery")
    || !Number.isSafeInteger(entry.partCount) || (entry.partCount as number) < 0
    || typeof address.tenantId !== "string" || typeof address.routeId !== "string"
    || typeof address.localDeviceId !== "string" || typeof address.peerDeviceId !== "string") {
    throw new Error("Peer application journal pending handoff is malformed.");
  }
  requiredString(entry.key, "pending handoff.key");
  requiredString(entry.sourceKey, "pending handoff.sourceKey");
  requiredString(entry.logicalId, "pending handoff.logicalId");
  requiredString(entry.messageKind, "pending handoff.messageKind");
  requiredString(entry.messageId, "pending handoff.messageId");
  return Object.freeze({
    key: entry.key as string,
    sourceKind: entry.sourceKind,
    sourceKey: entry.sourceKey as string,
    address: Object.freeze({
      tenantId: address.tenantId as string,
      routeId: address.routeId as string,
      localDeviceId: address.localDeviceId as string,
      peerDeviceId: address.peerDeviceId as string
    }),
    logicalId: entry.logicalId as string,
    messageKind: entry.messageKind as string,
    messageId: entry.messageId as string,
    partCount: entry.partCount as number
  });
}

function needsOperationRecovery(record: PeerApplicationRecord): boolean {
  if (record.role === "receiver") {
    return !TERMINAL_OPERATION_STATUSES.has(record.status)
      || record.terminalPrepared
      || record.resultPartCount !== null;
  }
  return record.status === "delivery_pending" || (record.cancelRequested && !TERMINAL_OPERATION_STATUSES.has(record.status));
}

function requireFragmentAssembly(value: unknown): StoredFragmentAssembly {
  const entry = recordObject(value, "application fragment assembly");
  const address = recordObject(entry.address, "application fragment assembly address");
  if (entry.version !== 1 || typeof entry.messageId !== "string" || typeof entry.messageKind !== "string"
    || !Number.isSafeInteger(entry.partCount) || (entry.partCount as number) < 1
    || !Number.isSafeInteger(entry.totalBytes) || (entry.totalBytes as number) < 1
    || typeof entry.complete !== "boolean"
    || (entry.applied !== undefined && typeof entry.applied !== "boolean")
    || (entry.applied === true && entry.complete !== true)
    || typeof address.tenantId !== "string" || typeof address.routeId !== "string"
    || typeof address.localDeviceId !== "string" || typeof address.peerDeviceId !== "string") {
    throw new Error("Peer application fragment assembly metadata is malformed.");
  }
  return Object.freeze({ ...entry, applied: entry.applied === true }) as unknown as StoredFragmentAssembly;
}

function requireFragmentPart(value: unknown, label: string): StoredFragmentPart {
  const entry = recordObject(value, label);
  if (!Number.isSafeInteger(entry.partIndex) || (entry.partIndex as number) < 0 || typeof entry.data !== "string") {
    throw new Error(`Peer application journal ${label} is malformed.`);
  }
  const bytes = Buffer.from(entry.data, "base64url");
  if (bytes.length === 0 || bytes.toString("base64url") !== entry.data) {
    throw new Error(`Peer application journal ${label} is malformed.`);
  }
  return Object.freeze({ partIndex: entry.partIndex as number, data: entry.data });
}

function sameFragmentHeader(left: StoredFragmentAssembly, right: PeerApplicationFragment): boolean {
  return left.version === 1 && left.messageId === right.messageId && left.messageKind === right.messageKind
    && left.partCount === right.partCount && left.totalBytes === right.totalBytes
    && left.address.tenantId === right.address.tenantId && left.address.routeId === right.address.routeId
    && left.address.localDeviceId === right.address.localDeviceId && left.address.peerDeviceId === right.address.peerDeviceId;
}

function sameFragmentHeaderAddress(
  left: PeerApplicationFragment["address"],
  right: PeerApplicationFragment["address"]
): boolean {
  return left.tenantId === right.tenantId && left.routeId === right.routeId
    && left.localDeviceId === right.localDeviceId && left.peerDeviceId === right.peerDeviceId;
}

function isStorageCapacityError(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && ((error as { code?: unknown }).code === "private_storage_capacity"
      || (error as { code?: unknown }).code === "ENOSPC");
}

/**
 * Private per-profile journal, separate from the removable Peer/Signal
 * transport stores. Every accepted operation and transport-independent result
 * is an owner-only atomic record; result chunks and transport deliveries have
 * separate files so ACP chunks never rewrite the full operation record.
 */
export class FilePeerApplicationJournal implements PeerApplicationJournal {
  readonly #root: string;
  readonly #partialNextIndex = new Map<string, number>();
  readonly #fragmentProgress = new Map<string, FragmentProgress>();
  readonly #fragmentTails = new Map<string, Promise<unknown>>();
  #indexMigration: Promise<void> | null = null;
  #activeFragmentCount: number | null = null;

  constructor(rootDir: string) {
    if (typeof rootDir !== "string" || rootDir.length === 0) throw new Error("A peer application journal directory is required.");
    this.#root = path.resolve(rootDir);
    for (const name of [
      "operations", "operation-id-index", "operation-recovery", "discovery-recovery", "pending-handoffs",
      "result-parts", "partial-result-chunks", "application-fragments", "discoveries"
    ]) {
      ensurePrivateDir(path.join(this.#root, name));
    }
  }

  #operationPath(key: string): string {
    return path.join(this.#root, "operations", `${encoded(key)}.json`);
  }

  #partPath(operationKey: string, index: number): string {
    return path.join(this.#root, "result-parts", encoded(operationKey), `${index.toString().padStart(12, "0")}.json`);
  }

  #partialResultLogPath(operationKey: string): string {
    return path.join(this.#root, "partial-result-chunks", `${encoded(operationKey)}.jsonl`);
  }

  #discoveryPath(key: string): string {
    return path.join(this.#root, "discoveries", `${encoded(key)}.json`);
  }

  #operationIdIndexPath(operationId: string): string {
    return path.join(this.#root, "operation-id-index", `${encoded(operationId)}.json`);
  }

  #operationRecoveryPath(key: string): string {
    return path.join(this.#root, "operation-recovery", `${encoded(key)}.json`);
  }

  #discoveryRecoveryPath(key: string): string {
    return path.join(this.#root, "discovery-recovery", `${encoded(key)}.json`);
  }

  #pendingHandoffPath(key: string): string {
    const hash = crypto.createHash("sha256").update(key, "utf8").digest("hex");
    return path.join(this.#root, "pending-handoffs", `${hash}.json`);
  }

  #journalIndexPath(): string {
    return path.join(this.#root, "journal-index.json");
  }

  async #writeIndexFile(filePath: string, value: unknown): Promise<void> {
    const contents = `${JSON.stringify(value)}\n`;
    await assertPrivateStorageCapacity(this.#root, Buffer.byteLength(contents, "utf8"));
    await writePrivateFileAtomic(filePath, contents);
  }

  async #addOperationIdIndex(record: PeerApplicationRecord): Promise<void> {
    const filePath = this.#operationIdIndexPath(record.operationId);
    const value = await this.#read(filePath);
    const keys = value === null ? [] : [...requireOperationKeys(value)];
    if (keys.includes(record.key)) return;
    keys.push(record.key);
    keys.sort();
    await this.#writeIndexFile(filePath, keys);
  }

  async #ensureJournalIndexes(): Promise<void> {
    if (!this.#indexMigration) {
      const migration = (async () => {
        const existing = await this.#read(this.#journalIndexPath());
        if (existing !== null) {
          const marker = recordObject(existing, "index version");
          if (marker.version !== JOURNAL_INDEX_VERSION) throw new Error("Peer application journal index version is unsupported.");
          return;
        }

        // One-time reindex of retained local history. The completion marker is
        // published last so interruption can safely replay every idempotent write.
        for (const record of await this.listOperations()) {
          await this.#addOperationIdIndex(record);
          if (needsOperationRecovery(record)) await this.#writeIndexFile(this.#operationRecoveryPath(record.key), operationRecovery(record));
        }
        for (const record of await this.listDiscoveries()) {
          if (record.status === "pending") {
            await this.#writeIndexFile(this.#discoveryRecoveryPath(record.key), {
              version: 1, key: record.key, address: record.address, requestId: record.requestId, action: "request"
            });
          }
        }
        await this.#writeIndexFile(this.#journalIndexPath(), { version: JOURNAL_INDEX_VERSION });
      })();
      this.#indexMigration = migration;
    }
    try {
      await this.#indexMigration;
    } catch (error: unknown) {
      this.#indexMigration = null;
      throw error;
    }
  }

  async #listRecoveryPage<T>(
    directory: string,
    afterKey: string | null | undefined,
    limit: number | undefined,
    parse: (marker: unknown) => { readonly key: string; readonly item: T }
  ): Promise<PeerApplicationPage<T>> {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit as number, PAGE_LIMIT)) : 32;
    let names: string[];
    try { names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort(); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return Object.freeze({ items: Object.freeze([]), nextAfterKey: null });
      throw error;
    }
    const afterName = afterKey ?? "";
    const remaining = names.filter((name) => name > afterName);
    const selected = remaining.slice(0, boundedLimit);
    const items: T[] = [];
    for (const name of selected) {
      const marker = await this.#read(path.join(directory, name));
      if (marker === null) continue;
      const parsed = parse(marker);
      // A writer publishes the marker before its operation/discovery record.
      // Keep missing-source markers visible here; the engine checks and retires
      // them under that item's existing serialization lock, so a concurrent
      // commit cannot be mistaken for an abandoned marker.
      items.push(parsed.item);
    }
    return Object.freeze({
      items: Object.freeze(items),
      nextAfterKey: remaining.length > selected.length ? selected[selected.length - 1] ?? afterName : null
    });
  }

  #fragmentAssemblyKey(address: PeerApplicationFragment["address"], messageId: string): string {
    return crypto.createHash("sha256")
      .update(JSON.stringify([address.tenantId, address.routeId, address.localDeviceId, address.peerDeviceId, messageId]))
      .digest("hex");
  }

  #fragmentDir(key: string): string {
    return path.join(this.#root, "application-fragments", key);
  }

  #fragmentManifestPath(key: string): string {
    return path.join(this.#fragmentDir(key), "manifest.json");
  }

  #fragmentPartPath(key: string, index: number): string {
    return path.join(this.#fragmentDir(key), "parts", `${index.toString().padStart(12, "0")}.json`);
  }

  async #withFragmentLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#fragmentTails.get(key) ?? Promise.resolve();
    let current: Promise<T>;
    current = previous.catch(() => undefined).then(action);
    this.#fragmentTails.set(key, current);
    try {
      return await current;
    } finally {
      if (this.#fragmentTails.get(key) === current) this.#fragmentTails.delete(key);
    }
  }

  async #countActiveFragmentAssemblies(): Promise<number> {
    if (this.#activeFragmentCount !== null) return this.#activeFragmentCount;
    let active = 0;
    const root = path.join(this.#root, "application-fragments");
    let assemblies;
    try { assemblies = await opendir(root); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return this.#activeFragmentCount = 0;
      throw error;
    }
    for await (const assembly of assemblies) {
      if (!assembly.isDirectory()) continue;
      const value = await this.#read(path.join(root, assembly.name, "manifest.json"));
      if (value === null) continue;
      if (!requireFragmentAssembly(value).applied) active += 1;
    }
    this.#activeFragmentCount = active;
    return active;
  }

  async #scanFragmentProgress(key: string, header: StoredFragmentAssembly): Promise<FragmentProgress> {
    const partsDir = path.join(this.#fragmentDir(key), "parts");
    let parts;
    try { parts = await opendir(partsDir); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { receivedParts: 0, receivedBytes: 0 };
      throw error;
    }
    let receivedParts = 0;
    let receivedBytes = 0;
    for await (const file of parts) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const value = await this.#read(path.join(partsDir, file.name));
      if (value === null) continue;
      const part = requireFragmentPart(value, "application fragment part");
      const fileIndex = Number(file.name.slice(0, -5));
      if (!Number.isSafeInteger(fileIndex) || fileIndex !== part.partIndex || fileIndex >= header.partCount) {
        throw new Error("Peer application fragment part index conflicts with its immutable assembly.");
      }
      const bytes = Buffer.from(part.data, "base64url");
      receivedParts += 1;
      receivedBytes += bytes.length;
      if (!Number.isSafeInteger(receivedBytes) || receivedBytes > header.totalBytes) {
        throw new Error("Peer application fragments exceed their declared complete size.");
      }
    }
    return { receivedParts, receivedBytes };
  }

  async #read(filePath: string): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as unknown;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
  }

  async #writeFragmentFile(filePath: string, value: unknown): Promise<boolean> {
    const contents = `${JSON.stringify(value)}\n`;
    try {
      await assertPrivateStorageCapacity(this.#root, Buffer.byteLength(contents, "utf8"));
      await writePrivateFileAtomic(filePath, contents);
      return true;
    } catch (error: unknown) {
      if (isStorageCapacityError(error)) return false;
      throw error;
    }
  }

  async #list(directory: string): Promise<readonly unknown[]> {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return Object.freeze([]);
      throw error;
    }
    const rows: unknown[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      rows.push(await this.#read(path.join(directory, name)));
    }
    return Object.freeze(rows.filter((row) => row !== null));
  }

  async getOperation(key: string): Promise<PeerApplicationRecord | null> {
    const value = await this.#read(this.#operationPath(key));
    if (value === null) return null;
    return requireOperation(value, "operation");
  }

  async listOperations(): Promise<readonly PeerApplicationRecord[]> {
    const rows = await this.#list(path.join(this.#root, "operations"));
    return Object.freeze(rows.map((row) => requireOperation(row, "operation"))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  }

  async findOperationKeysById(operationId: string): Promise<readonly string[]> {
    await this.#ensureJournalIndexes();
    const filePath = this.#operationIdIndexPath(operationId);
    const value = await this.#read(filePath);
    if (value === null) return Object.freeze([]);
    const keys = [...requireOperationKeys(value)];
    const existing: string[] = [];
    for (const key of keys) {
      if (await this.getOperation(key)) existing.push(key);
    }
    if (existing.length !== keys.length) {
      if (existing.length === 0) await rm(filePath, { force: true });
      else await this.#writeIndexFile(filePath, existing);
    }
    return Object.freeze(existing);
  }

  async listPendingOperationRecoveryPage(afterKey: string | null = null, limit = 32): Promise<PeerApplicationPage<PeerApplicationOperationRecovery>> {
    await this.#ensureJournalIndexes();
    return this.#listRecoveryPage(
      path.join(this.#root, "operation-recovery"), afterKey, limit,
      (marker) => {
        const item = requireOperationRecovery(marker);
        return { key: item.key, item };
      }
    );
  }

  async savePendingOperationRecovery(record: PeerApplicationRecord): Promise<void> {
    await this.#ensureJournalIndexes();
    const filePath = this.#operationRecoveryPath(record.key);
    const next = operationRecovery(record);
    const previous = await this.#read(filePath);
    if (previous !== null) {
      const parsed = requireOperationRecovery(previous);
      const same = parsed.key === next.key && parsed.role === next.role && parsed.operationId === next.operationId
        && sameFragmentHeaderAddress(parsed.originAddress, next.originAddress)
        && sameFragmentHeaderAddress(parsed.routeAddress, next.routeAddress)
        && parsed.requestDigest === next.requestDigest && parsed.cancelRequested === next.cancelRequested
        && parsed.terminal === next.terminal && parsed.terminalPrepared === next.terminalPrepared
        && parsed.executionPending === next.executionPending && parsed.resultPartCount === next.resultPartCount
        && parsed.stateRevision === next.stateRevision
        && parsed.createdAt === next.createdAt;
      if (same) return;
    }
    await this.#writeIndexFile(filePath, next);
  }

  async clearPendingOperationRecovery(key: string, expectedStateRevision?: number): Promise<boolean> {
    const filePath = this.#operationRecoveryPath(key);
    const value = await this.#read(filePath);
    if (value === null) return true;
    const marker = requireOperationRecovery(value);
    if (expectedStateRevision !== undefined && marker.stateRevision !== expectedStateRevision) return false;
    await rm(filePath, { force: true });
    return true;
  }

  async saveOperation(record: PeerApplicationRecord): Promise<void> {
    if (record.key.length === 0 || record.prompt.length === 0) throw new Error("Peer application operation cannot be empty.");
    await this.#ensureJournalIndexes();
    // The durable ID index is the source of truth, so this lookup does not
    // retain one process-lifetime cache entry for every historical operation.
    await this.#addOperationIdIndex(record);
    await writePrivateFileAtomic(this.#operationPath(record.key), `${JSON.stringify(record)}\n`);
  }

  async getResultPart(operationKey: string, index: number): Promise<PeerApplicationResultPart | null> {
    const value = await this.#read(this.#partPath(operationKey, index));
    return value === null ? null : requirePart(value, "result part");
  }

  async listResultParts(operationKey: string): Promise<readonly PeerApplicationResultPart[]> {
    const rows = await this.#list(path.join(this.#root, "result-parts", encoded(operationKey)));
    return Object.freeze(rows.map((row) => requirePart(row, "result part"))
      .sort((left, right) => left.index - right.index));
  }

  async saveResultPart(operationKey: string, part: PeerApplicationResultPart): Promise<void> {
    const previous = await this.getResultPart(operationKey, part.index);
    if (previous && previous.text !== part.text) throw new Error("Peer application result part conflicts with durable content.");
    await writePrivateFileAtomic(this.#partPath(operationKey, part.index), `${JSON.stringify(part)}\n`);
  }

  async listPartialResultChunks(operationKey: string): Promise<readonly PeerApplicationResultPart[]> {
    const legacy = await this.#list(path.join(this.#root, "partial-result-chunks", encoded(operationKey)));
    const byIndex = new Map<number, PeerApplicationResultPart>();
    for (const row of legacy) {
      const part = requirePart(row, "partial result chunk");
      byIndex.set(part.index, part);
    }
    let appended: string;
    try {
      appended = await readFile(this.#partialResultLogPath(operationKey), "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      appended = "";
    }
    const lines = appended.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (error: unknown) {
        // A process may stop during the last append; all earlier synced rows
        // remain usable partial-result evidence for the existing operation.
        if (index === lines.length - 1 && !appended.endsWith("\n")) break;
        throw error;
      }
      const part = requirePart(parsed, "partial result chunk");
      const previous = byIndex.get(part.index);
      if (previous && previous.text !== part.text) throw new Error("Peer application partial result chunk conflicts with durable content.");
      byIndex.set(part.index, part);
    }
    const result = Object.freeze([...byIndex.values()].sort((left, right) => left.index - right.index));
    this.#partialNextIndex.set(operationKey, (result[result.length - 1]?.index ?? -1) + 1);
    return result;
  }

  async savePartialResultChunk(operationKey: string, index: number, text: string): Promise<void> {
    const part = requirePart({ index, text }, "partial result chunk");
    let next = this.#partialNextIndex.get(operationKey);
    if (next === undefined) {
      await this.listPartialResultChunks(operationKey);
      next = this.#partialNextIndex.get(operationKey) ?? 0;
    }
    if (index < next) {
      const existing = (await this.listPartialResultChunks(operationKey)).find((row) => row.index === index);
      if (existing?.text === text) return;
      throw new Error("Peer application partial result chunk conflicts with durable content.");
    }
    if (index !== next) throw new Error("Peer application partial result chunks must be appended in order.");
    const filePath = this.#partialResultLogPath(operationKey);
    const line = `${JSON.stringify(part)}\n`;
    try {
      await readFile(filePath);
      const handle = await open(filePath, "a");
      try {
        await handle.writeFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      await writePrivateFileAtomic(filePath, line);
    }
    this.#partialNextIndex.set(operationKey, index + 1);
  }

  async clearPartialResultChunks(operationKey: string): Promise<void> {
    await rm(path.join(this.#root, "partial-result-chunks", encoded(operationKey)), { recursive: true, force: true });
    await rm(this.#partialResultLogPath(operationKey), { force: true });
    this.#partialNextIndex.delete(operationKey);
  }

  async saveApplicationFragment(fragment: PeerApplicationFragment): Promise<PeerApplicationFragmentSaveResult> {
    const key = this.#fragmentAssemblyKey(fragment.address, fragment.messageId);
    return this.#withFragmentLock(key, async () => {
      const manifestPath = this.#fragmentManifestPath(key);
      const incoming: StoredFragmentAssembly = Object.freeze({
        version: 1,
        address: Object.freeze({ ...fragment.address }),
        messageId: fragment.messageId,
        messageKind: fragment.messageKind,
        partCount: fragment.partCount,
        totalBytes: fragment.totalBytes,
        complete: false,
        applied: false
      });
      let header: StoredFragmentAssembly;
      const existingValue = await this.#read(manifestPath);
      if (existingValue === null) {
        const created = await this.#withFragmentLock("!new-fragment-assembly", async () => {
          const active = await this.#countActiveFragmentAssemblies();
          if (active >= MAX_ACTIVE_FRAGMENT_ASSEMBLIES) return false;
          if (!await this.#writeFragmentFile(manifestPath, incoming)) return false;
          this.#activeFragmentCount = active + 1;
          return true;
        });
        if (!created) return Object.freeze({ status: "backpressured", receivedParts: 0 });
        header = incoming;
        this.#fragmentProgress.set(key, { receivedParts: 0, receivedBytes: 0 });
      } else {
        header = requireFragmentAssembly(existingValue);
        if (!sameFragmentHeader(header, fragment)) {
          return Object.freeze({ status: "conflict", receivedParts: 0 });
        }
      }
      if (fragment.partIndex >= header.partCount) return Object.freeze({ status: "conflict", receivedParts: 0 });
      if (header.applied) {
        await rm(path.join(this.#fragmentDir(key), "parts"), { recursive: true, force: true });
        this.#fragmentProgress.delete(key);
        return Object.freeze({ status: "applied", receivedParts: header.partCount });
      }
      let progress = this.#fragmentProgress.get(key);
      if (!progress) {
        progress = await this.#scanFragmentProgress(key, header);
        this.#fragmentProgress.set(key, progress);
        if (!header.complete && progress.receivedParts === header.partCount && progress.receivedBytes === header.totalBytes) {
          header = Object.freeze({ ...header, complete: true });
          if (!await this.#writeFragmentFile(manifestPath, header)) {
            return Object.freeze({ status: "backpressured", receivedParts: progress.receivedParts });
          }
        }
      }
      const partPath = this.#fragmentPartPath(key, fragment.partIndex);
      const storedValue = await this.#read(partPath);
      if (storedValue !== null) {
        const part = requireFragmentPart(storedValue, "application fragment part");
        if (part.partIndex !== fragment.partIndex || part.data !== fragment.data) {
          return Object.freeze({ status: "conflict", receivedParts: progress.receivedParts });
        }
      } else {
        if (header.complete) throw new Error("A completed Peer application fragment assembly is missing a durable part.");
        const bytes = Buffer.from(fragment.data, "base64url");
        const nextBytes = progress.receivedBytes + bytes.byteLength;
        if (nextBytes > header.totalBytes) return Object.freeze({ status: "conflict", receivedParts: progress.receivedParts });
        const storedPart = { partIndex: fragment.partIndex, data: fragment.data } satisfies StoredFragmentPart;
        if (!await this.#writeFragmentFile(partPath, storedPart)) {
          return Object.freeze({ status: "backpressured", receivedParts: progress.receivedParts });
        }
        progress.receivedParts += 1;
        progress.receivedBytes = nextBytes;
      }
      if (!header.complete && progress.receivedParts === header.partCount) {
        if (progress.receivedBytes !== header.totalBytes) return Object.freeze({ status: "conflict", receivedParts: progress.receivedParts });
        header = Object.freeze({ ...header, complete: true });
        if (!await this.#writeFragmentFile(manifestPath, header)) {
          return Object.freeze({ status: "backpressured", receivedParts: progress.receivedParts });
        }
      }
      return Object.freeze({ status: header.complete ? "complete" : "incomplete", receivedParts: progress.receivedParts });
    });
  }

  async readApplicationFragmentMessage(address: PeerApplicationFragment["address"], messageId: string): Promise<Uint8Array | null> {
    const key = this.#fragmentAssemblyKey(address, messageId);
    const value = await this.#read(this.#fragmentManifestPath(key));
    if (value === null) return null;
    const header = requireFragmentAssembly(value);
    if (!header.complete || header.applied || header.messageId !== messageId
      || header.address.tenantId !== address.tenantId || header.address.routeId !== address.routeId
      || header.address.localDeviceId !== address.localDeviceId || header.address.peerDeviceId !== address.peerDeviceId) return null;
    const progress = this.#fragmentProgress.get(key) ?? await this.#scanFragmentProgress(key, header);
    this.#fragmentProgress.set(key, progress);
    if (progress.receivedParts !== header.partCount || progress.receivedBytes !== header.totalBytes) {
      throw new Error("Completed Peer application fragment assembly is incomplete.");
    }
    const chunks: Buffer[] = [];
    for (let index = 0; index < header.partCount; index += 1) {
      const partValue = await this.#read(this.#fragmentPartPath(key, index));
      if (partValue === null) throw new Error("Completed Peer application fragment assembly is missing a part.");
      chunks.push(Buffer.from(requireFragmentPart(partValue, "application fragment part").data, "base64url"));
    }
    return new Uint8Array(Buffer.concat(chunks, progress.receivedBytes));
  }

  async markApplicationFragmentApplied(address: PeerApplicationFragment["address"], messageId: string): Promise<void> {
    const key = this.#fragmentAssemblyKey(address, messageId);
    await this.#withFragmentLock(key, async () => {
      const manifestPath = this.#fragmentManifestPath(key);
      const value = await this.#read(manifestPath);
      if (value === null) throw new Error("Peer application fragment assembly is missing before durable application commit.");
      const header = requireFragmentAssembly(value);
      if (header.messageId !== messageId
        || header.address.tenantId !== address.tenantId || header.address.routeId !== address.routeId
        || header.address.localDeviceId !== address.localDeviceId || header.address.peerDeviceId !== address.peerDeviceId
        || !header.complete) {
        throw new Error("Peer application fragment assembly is not complete for durable application commit.");
      }
      if (!header.applied) {
        const appliedHeader = { ...header, applied: true };
        await assertPrivateStorageCapacity(this.#root, Buffer.byteLength(`${JSON.stringify(appliedHeader)}\n`, "utf8"));
        await writePrivateFileAtomic(manifestPath, `${JSON.stringify(appliedHeader)}\n`);
        if (this.#activeFragmentCount !== null) this.#activeFragmentCount = Math.max(0, this.#activeFragmentCount - 1);
      }
      // The marker is durable before cleanup. A crash before this removal is
      // recovered by the next duplicate fragment, which observes the marker.
      await rm(path.join(this.#fragmentDir(key), "parts"), { recursive: true, force: true });
      this.#fragmentProgress.delete(key);
    });
  }

  async getDiscovery(key: string): Promise<PeerApplicationDiscoveryRecord | null> {
    const value = await this.#read(this.#discoveryPath(key));
    return value === null ? null : requireDiscovery(value, "discovery");
  }

  async listDiscoveries(): Promise<readonly PeerApplicationDiscoveryRecord[]> {
    const rows = await this.#list(path.join(this.#root, "discoveries"));
    return Object.freeze(rows.map((row) => requireDiscovery(row, "discovery"))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  }

  async findLatestPendingDiscovery(address: PeerApplicationDiscoveryRecord["address"]): Promise<PeerApplicationDiscoveryRecord | null> {
    let afterKey: string | null = null;
    let latest: PeerApplicationDiscoveryRecord | null = null;
    do {
      const page = await this.listPendingDiscoveryRecoveryPage(afterKey, PAGE_LIMIT);
      for (const recovery of page.items) {
        if (recovery.action !== "request" || !sameFragmentHeaderAddress(recovery.address, address)) continue;
        const record = await this.getDiscovery(recovery.key);
        if (record === null || record.status !== "pending" || record.requestId !== recovery.requestId
          || !sameFragmentHeaderAddress(record.address, address)) continue;
        if (latest === null || record.updatedAt > latest.updatedAt) latest = record;
      }
      afterKey = page.nextAfterKey;
    } while (afterKey !== null);
    return latest;
  }

  async listPendingDiscoveryRecoveryPage(afterKey: string | null = null, limit = 32): Promise<PeerApplicationPage<PeerApplicationDiscoveryRecovery>> {
    await this.#ensureJournalIndexes();
    return this.#listRecoveryPage(
      path.join(this.#root, "discovery-recovery"), afterKey, limit,
      (marker) => {
        const item = requireDiscoveryRecovery(marker);
        return { key: item.key, item };
      }
    );
  }

  async savePendingDiscoveryRecovery(record: Pick<PeerApplicationDiscoveryRecord, "key" | "address" | "requestId">, action: "request" | "response"): Promise<void> {
    await this.#ensureJournalIndexes();
    const filePath = this.#discoveryRecoveryPath(record.key);
    const next = { version: 1, key: record.key, address: record.address, requestId: record.requestId, action };
    const previous = await this.#read(filePath);
    if (previous !== null) {
      const parsed = requireDiscoveryRecovery(previous);
      if (parsed.key === next.key && parsed.action === next.action && parsed.requestId === next.requestId
        && sameFragmentHeaderAddress(parsed.address, next.address)) return;
    }
    await this.#writeIndexFile(filePath, next);
  }

  async clearPendingDiscoveryRecovery(key: string, expectedAction?: "request" | "response"): Promise<boolean> {
    const filePath = this.#discoveryRecoveryPath(key);
    const value = await this.#read(filePath);
    if (value === null) return true;
    const marker = requireDiscoveryRecovery(value);
    if (expectedAction !== undefined && marker.action !== expectedAction) return false;
    await rm(filePath, { force: true });
    return true;
  }

  async saveDiscovery(record: PeerApplicationDiscoveryRecord): Promise<void> {
    await this.#ensureJournalIndexes();
    const contents = `${JSON.stringify(record)}\n`;
    await assertPrivateStorageCapacity(this.#root, Buffer.byteLength(contents, "utf8"));
    await writePrivateFileAtomic(this.#discoveryPath(record.key), contents);
  }

  async listPendingHandoffPage(afterKey: string | null = null, limit = 32): Promise<PeerApplicationPage<PeerApplicationHandoffPlan>> {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, PAGE_LIMIT)) : 32;
    const directory = path.join(this.#root, "pending-handoffs");
    let names: string[];
    try { names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort(); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return Object.freeze({ items: Object.freeze([]), nextAfterKey: null });
      throw error;
    }
    const afterName = afterKey ?? "";
    const remaining = names.filter((name) => name > afterName);
    const selected = remaining.slice(0, boundedLimit);
    const items: PeerApplicationHandoffPlan[] = [];
    for (const name of selected) {
      const value = await this.#read(path.join(directory, name));
      if (value !== null) items.push(requireHandoffPlan(value));
    }
    return Object.freeze({
      items: Object.freeze(items),
      nextAfterKey: remaining.length > selected.length ? selected[selected.length - 1] ?? afterName : null
    });
  }

  async savePendingHandoff(plan: PeerApplicationHandoffPlan): Promise<void> {
    const filePath = this.#pendingHandoffPath(plan.key);
    const existing = await this.#read(filePath);
    const persisted = { version: 1, ...plan };
    if (existing !== null) {
      const previous = requireHandoffPlan(existing);
      if (previous.key !== plan.key || previous.sourceKind !== plan.sourceKind || previous.sourceKey !== plan.sourceKey
        || !sameFragmentHeaderAddress(previous.address, plan.address)
        || previous.logicalId !== plan.logicalId || previous.messageKind !== plan.messageKind
        || previous.messageId !== plan.messageId || previous.partCount !== plan.partCount) {
        throw new Error("Peer application handoff plan conflicts with its immutable identity.");
      }
      return;
    }
    await this.#writeIndexFile(filePath, persisted);
  }

  async getPendingHandoff(key: string): Promise<PeerApplicationHandoffPlan | null> {
    const value = await this.#read(this.#pendingHandoffPath(key));
    return value === null ? null : requireHandoffPlan(value);
  }

  async clearPendingHandoff(key: string): Promise<void> {
    await rm(this.#pendingHandoffPath(key), { force: true });
  }

}
