import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ensurePrivateDir,
  writePrivateFileAtomic
} from "@meshrix/foundation/storage/private-file-atomic";
import { assertPrivateStorageCapacity } from "@meshrix/foundation/storage/private-storage-capacity";
import { parsePeerEnvelope, type PeerMessageIdentity } from "@meshrix/contracts/private-relay";

import { peerClientError } from "./errors.ts";
import type {
  PeerClientMeta,
  PeerClientPage,
  PeerClientPageQuery,
  PeerClientRouteIdentity,
  PeerClientRouteScope,
  PeerClientStore,
  StoredInboxEntry,
  StoredOutboxEntry,
  StoredPeerHistoryEntry
} from "./store.ts";
import { emptyPeerClientMeta, PEER_INBOX_DISPATCH_STATES, PEER_OUTBOX_STATES } from "./store.ts";
import { PEER_CLIENT_STORE_RECORD_VERSION } from "./types.ts";

/**
 * File-backed device custody. The current records and indexes are separated
 * from the old mailbox layout so a one-time migration can archive every old
 * record before unlinking it. Record files are keyed by a digest of the full
 * tuple; page indexes hold only sequence and digest, not message contents.
 */
const DATA_DIR = "peer-records";
const DIRS = Object.freeze({
  meta: "meta",
  outbox: "outbox",
  inbox: "inbox",
  history: "history",
  sequence: "sequence",
  migration: "migration",
  outboxId: "outbox-by-id",
  outboxPending: "outbox-pending",
  outboxHistory: "outbox-history",
  inboxId: "inbox-by-id",
  inboxPending: "inbox-pending",
  inboxAckPending: "inbox-ack-pending",
  inboxHistory: "inbox-history",
  peerHistory: "peer-history",
  peerHistoryId: "peer-history-by-id"
} as const);

type IndexKind = "outboxPending" | "outboxHistory" | "inboxPending" | "inboxAckPending" | "inboxHistory" | "peerHistory";

interface IndexPointer {
  readonly sequence: number;
  readonly recordId: string;
  readonly identity?: Readonly<Record<string, string>>;
  readonly scope?: PeerClientRouteScope;
}

const RECORD_ID_PATTERN = /^\d{16}-[a-f0-9]{64}$/u;
const INDEX_NAME_PATTERN = /^(\d{16})-([a-f0-9]{64})\.json$/u;
const INDEX_BUCKET_SIZE = 256;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;
const PEER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u;

const LANE_INDEXES: Readonly<Record<"outbox" | "inbox" | "history", readonly IndexKind[]>> = Object.freeze({
  outbox: ["outboxPending", "outboxHistory"],
  inbox: ["inboxPending", "inboxAckPending", "inboxHistory"],
  history: ["peerHistory"]
} as const);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MISSING_SEQUENCE = Symbol("missing sequence");

function sequenceCounts(value: unknown): Record<string, unknown> {
  if (value === MISSING_SEQUENCE) return {};
  if (!record(value) || ["outbox", "inbox", "history"].some((lane) => value[lane] !== undefined
    && (!Number.isSafeInteger(value[lane]) || (value[lane] as number) < 0))) {
    throw peerClientError("peer_client_store", "The local sequence metadata is malformed; its original data was retained.");
  }
  return value;
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function scopeKey(scope: PeerClientRouteScope): string {
  return JSON.stringify([scope.tenantId, scope.routeId]);
}

function identityKey(identity: { tenantId: string; routeId: string; senderDeviceId: string; recipientDeviceId: string; messageId: string }): string {
  return JSON.stringify([identity.tenantId, identity.routeId, identity.senderDeviceId, identity.recipientDeviceId, identity.messageId]);
}

function identityDigest(identity: { tenantId: string; routeId: string; senderDeviceId: string; recipientDeviceId: string; messageId: string }): string {
  return digest(identityKey(identity));
}

function scopeDigest(scope: PeerClientRouteScope): string {
  return digest(scopeKey(scope));
}

function sequenceName(sequence: number): string {
  return String(sequence).padStart(16, "0");
}

function validRecordId(value: unknown): value is string {
  return typeof value === "string" && RECORD_ID_PATTERN.test(value);
}

function parseIndexName(value: string): { readonly sequence: number; readonly recordDigest: string } | null {
  const match = INDEX_NAME_PATTERN.exec(value);
  if (!match) return null;
  const sequence = Number(match[1]);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  return Object.freeze({ sequence, recordDigest: match[2]! });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function validPeerId(value: unknown): value is string {
  return typeof value === "string" && PEER_ID_PATTERN.test(value);
}

function sameEnvelope(left: unknown, right: unknown): boolean {
  const parsedLeft = parsePeerEnvelope(left);
  const parsedRight = parsePeerEnvelope(right);
  return parsedLeft !== null && parsedRight !== null && sameJson(parsedLeft, parsedRight);
}

function indexName(sequence: number, recordId: string): string {
  return `${sequenceName(sequence)}-${recordId}.json`;
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function isValidScope(scope: PeerClientRouteScope): boolean {
  return validOpaqueId(scope.tenantId) && validOpaqueId(scope.routeId);
}

function isValidRoute(route: { readonly tenantId: string; readonly routeId: string; readonly deviceId: string }): boolean {
  return isValidScope(route) && validOpaqueId(route.deviceId);
}

function parseIdentity(value: Record<string, unknown>, what: string) {
  const fields = ["tenantId", "routeId", "senderDeviceId", "recipientDeviceId", "messageId"] as const;
  for (const field of fields) {
    if (!validOpaqueId(value[field])) {
      throw peerClientError("peer_client_store", `${what} is missing ${field}.`);
    }
  }
  return Object.freeze({
    tenantId: value.tenantId as string,
    routeId: value.routeId as string,
    senderDeviceId: value.senderDeviceId as string,
    recipientDeviceId: value.recipientDeviceId as string,
    messageId: value.messageId as string
  });
}

function parseOutbox(value: unknown, what: string): StoredOutboxEntry {
  if (!record(value) || value.version !== PEER_CLIENT_STORE_RECORD_VERSION
    || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1
    || !PEER_OUTBOX_STATES.includes(value.state as never)
    || !validPeerId(value.peerId) || parsePeerEnvelope(value.envelope) === null
    || !Number.isSafeInteger(value.attempts) || (value.attempts as number) < 0
    || (value.lastForwarded !== null && !record(value.lastForwarded))
    || (value.deliveryAck !== null && !record(value.deliveryAck))
    || (value.lastError !== null && typeof value.lastError !== "string")
    || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw peerClientError("peer_client_store", `${what} is malformed.`);
  }
  return Object.freeze({ ...parseIdentity(value, what), ...clone(value) }) as StoredOutboxEntry;
}

function parseInbox(value: unknown, what: string): StoredInboxEntry {
  if (!record(value) || value.version !== PEER_CLIENT_STORE_RECORD_VERSION
    || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1
    || !PEER_INBOX_DISPATCH_STATES.includes(value.dispatch as never)
    || (value.senderPeerId !== null && !validPeerId(value.senderPeerId))
    || parsePeerEnvelope(value.envelope) === null
    || (value.plaintext !== null && typeof value.plaintext !== "string")
    || (value.decryptError !== null && typeof value.decryptError !== "string")
    || (value.deliveryAck !== null && !record(value.deliveryAck))
    || typeof value.receivedAt !== "string" || typeof value.updatedAt !== "string") {
    throw peerClientError("peer_client_store", `${what} is malformed.`);
  }
  return Object.freeze({ ...parseIdentity(value, what), ...clone(value) }) as StoredInboxEntry;
}

function parseHistory(value: unknown, what: string): StoredPeerHistoryEntry {
  if (!record(value) || value.version !== PEER_CLIENT_STORE_RECORD_VERSION
    || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1
    || typeof value.evidenceId !== "string"
    || typeof value.tenantId !== "string" || typeof value.routeId !== "string"
    || !["legacy_outbox", "legacy_inbox", "legacy_gap"].includes(value.source as string)
    || (value.messageId !== null && typeof value.messageId !== "string")
    || (value.deviceId !== null && typeof value.deviceId !== "string")
    || (value.formerPosition !== null && (!Number.isSafeInteger(value.formerPosition) || (value.formerPosition as number) < 1))
    || !Array.isArray(value.formerReceiptFacts)
    || (value.legacyRecord !== null && !record(value.legacyRecord))
    || typeof value.recordedAt !== "string") {
    throw peerClientError("peer_client_store", `${what} is malformed.`);
  }
  return Object.freeze(clone(value)) as unknown as StoredPeerHistoryEntry;
}

export class FilePeerClientStore implements PeerClientStore {
  readonly #root: string;
  readonly #data: string;
  readonly #migrating = new Map<string, Promise<void>>();
  readonly #routeDevices = new Map<string, string>();
  readonly #sequenceLocks = new Map<string, Promise<void>>();
  #routePreparation: Promise<void> = Promise.resolve();
  #recordPublication: Promise<void> = Promise.resolve();
  #boundRoute: PeerClientRouteIdentity | null = null;

  constructor(rootDir: string) {
    if (typeof rootDir !== "string" || rootDir.length === 0) {
      throw peerClientError("peer_client_state", "FilePeerClientStore requires a root directory path.");
    }
    this.#root = rootDir;
    this.#data = path.join(rootDir, DATA_DIR);
    ensurePrivateDir(this.#root);
    ensurePrivateDir(this.#data);
    for (const dir of Object.values(DIRS)) ensurePrivateDir(path.join(this.#data, dir));
  }

  get rootDir(): string { return this.#root; }

  #scopeDir(kind: keyof typeof DIRS, scope: PeerClientRouteScope): string {
    return path.join(this.#data, DIRS[kind], scopeDigest(scope));
  }

  #recordFile(kind: "outbox" | "inbox" | "history", scope: PeerClientRouteScope, recordId: string): string {
    if (!validRecordId(recordId)) throw peerClientError("peer_client_store", "A client store record identifier is malformed.");
    return path.join(this.#scopeDir(kind, scope), `${recordId}.json`);
  }

  #indexBucketDir(kind: IndexKind, scope: PeerClientRouteScope, sequence: number): string {
    const bucket = Math.floor((sequence - 1) / INDEX_BUCKET_SIZE).toString().padStart(10, "0");
    return path.join(this.#scopeDir(kind, scope), bucket);
  }

  #idIndexFile(kind: "outboxId" | "inboxId", identity: Parameters<typeof identityDigest>[0]): string {
    return path.join(this.#data, DIRS[kind], scopeDigest(identity), `${identityDigest(identity)}.json`);
  }

  async #read(file: string, label: string, missingValue: unknown = null): Promise<unknown | null> {
    let text: string;
    try {
      text = await fs.promises.readFile(file, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return missingValue;
      throw error;
    }
    try { return JSON.parse(text) as unknown; }
    catch (error: unknown) {
      throw peerClientError("peer_client_store", `Client store record ${label} cannot be parsed.`, { cause: error });
    }
  }

  async #write(file: string, value: unknown): Promise<void> {
    await writePrivateFileAtomic(file, `${JSON.stringify(value)}\n`);
  }

  async #assertRecordCapacity(entry: unknown): Promise<void> {
    const serialized = JSON.stringify(entry);
    if (typeof serialized !== "string") throw peerClientError("peer_client_store", "A durable client record cannot be serialized.");
    // The exact record plus a bounded allowance for its identity/state indexes
    // and sequence metadata; the capacity helper adds the free-space reserve.
    await assertPrivateStorageCapacity(this.#root, Buffer.byteLength(serialized, "utf8") + 4_096);
  }

  async #remove(file: string): Promise<void> {
    try { await fs.promises.unlink(file); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }

  async #advanceSequence(scope: PeerClientRouteScope, lane: "outbox" | "inbox" | "history", value: number): Promise<void> {
    await this.#withSequenceLock(scope, async () => {
      const file = path.join(this.#data, DIRS.sequence, `${scopeDigest(scope)}.json`);
      const counts = sequenceCounts(await this.#read(file, "sequence", MISSING_SEQUENCE));
      if (Number.isSafeInteger(counts[lane]) && (counts[lane] as number) >= value) return;
      await this.#write(file, { ...counts, [lane]: value });
    });
  }

  async #allocate(scope: PeerClientRouteScope, lane: "outbox" | "inbox" | "history"): Promise<number> {
    await this.#ensureMigrated(scope);
    return this.#withSequenceLock(scope, async () => {
      const file = path.join(this.#data, DIRS.sequence, `${scopeDigest(scope)}.json`);
      const counts = sequenceCounts(await this.#read(file, "sequence", MISSING_SEQUENCE));
      const next = Number.isSafeInteger(counts[lane]) && (counts[lane] as number) >= 0 ? (counts[lane] as number) + 1 : 1;
      if (!Number.isSafeInteger(next)) throw peerClientError("peer_client_store", "The local sequence space is exhausted.");
      await this.#write(file, { ...counts, [lane]: next });
      return next;
    });
  }

  async #withSequenceLock<T>(scope: PeerClientRouteScope, action: () => Promise<T>): Promise<T> {
    // All lanes share one sequence file and therefore one read-modify-write lock.
    const key = scopeKey(scope);
    const previous = this.#sequenceLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.then(() => gate);
    this.#sequenceLocks.set(key, current);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.#sequenceLocks.get(key) === current) this.#sequenceLocks.delete(key);
    }
  }

  #withRecordPublication<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.#recordPublication.then(action);
    this.#recordPublication = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async prepareRoute(route: { readonly tenantId: string; readonly routeId: string; readonly deviceId: string }): Promise<void> {
    if (!isValidRoute(route)) throw peerClientError("peer_client_store", "A bound route identity is malformed.");
    const pending = this.#routePreparation.then(() => this.#bindRoute(route));
    this.#routePreparation = pending.catch(() => undefined);
    await pending;
  }

  async #bindRoute(route: PeerClientRouteIdentity): Promise<void> {
    const nextRoute = Object.freeze({ tenantId: route.tenantId, routeId: route.routeId, deviceId: route.deviceId });
    if (this.#boundRoute && (this.#boundRoute.tenantId !== nextRoute.tenantId
      || this.#boundRoute.routeId !== nextRoute.routeId || this.#boundRoute.deviceId !== nextRoute.deviceId)) {
      throw peerClientError("peer_client_store", "The file store cannot be rebound to another tenant, route or device.");
    }
    const bindingFile = path.join(this.#data, DIRS.meta, "route-binding.json");
    const persisted = await this.#read(bindingFile, "route binding");
    if (persisted !== null) {
      if (!record(persisted) || persisted.version !== 1 || persisted.tenantId !== nextRoute.tenantId
        || persisted.routeId !== nextRoute.routeId || persisted.deviceId !== nextRoute.deviceId) {
        throw peerClientError("peer_client_store", "The file store belongs to a different tenant, route or device.");
      }
    } else {
      await this.#write(bindingFile, { version: 1, ...nextRoute });
    }
    this.#boundRoute = nextRoute;
    const scope = Object.freeze({ tenantId: route.tenantId, routeId: route.routeId });
    this.#routeDevices.set(scopeKey(scope), route.deviceId);
    await this.#ensureMigrated(scope);
  }

  #assertBoundIdentity(identity: PeerMessageIdentity, localField: "senderDeviceId" | "recipientDeviceId"): void {
    const route = this.#boundRoute;
    if (!route) throw peerClientError("peer_client_store", "The file store must be bound to an authenticated route before message access.");
    if (!validOpaqueId(identity.senderDeviceId) || !validOpaqueId(identity.recipientDeviceId) || !validOpaqueId(identity.messageId)) {
      throw peerClientError("peer_client_store", "A message identity contains a malformed wire identifier.");
    }
    if (identity.tenantId !== route.tenantId || identity.routeId !== route.routeId) {
      throw peerClientError("peer_client_store", "A message identity does not belong to the bound route.");
    }
    if (identity[localField] !== route.deviceId) {
      throw peerClientError("peer_client_store", `A message identity does not match the bound local device (${localField}).`);
    }
  }

  async #ensureMigrated(scope: PeerClientRouteScope): Promise<void> {
    if (!isValidScope(scope)) throw peerClientError("peer_client_store", "A route scope is malformed.");
    if (!this.#boundRoute) {
      throw peerClientError("peer_client_store", "The file store must be bound to an authenticated route before route-scoped access.");
    }
    if (scopeKey(scope) !== scopeKey(this.#boundRoute)) {
      throw peerClientError("peer_client_store", "The file store is already bound to a different route.");
    }
    const device = this.#routeDevices.get(scopeKey(scope));
    if (!device) return;
    const key = `${scopeKey(scope)}\n${device}`;
    let migration = this.#migrating.get(key);
    if (!migration) {
      migration = this.#recoverSequenceHighWater(scope).then(() => this.#migrateLegacy(scope, device)).catch((error: unknown) => {
        if (this.#migrating.get(key) === migration) this.#migrating.delete(key);
        throw error;
      });
      this.#migrating.set(key, migration);
    }
    await migration;
  }

  async #indexBuckets(kind: IndexKind, scope: PeerClientRouteScope, firstBucket = 0): Promise<number[]> {
    let names: string[];
    try { names = await fs.promises.readdir(this.#scopeDir(kind, scope)); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      return [];
    }
    return names.filter((name) => /^\d{10,}$/u.test(name)).map(Number)
      .filter((bucket) => Number.isSafeInteger(bucket) && bucket >= firstBucket)
      .sort((left, right) => left - right);
  }

  async #recoverSequenceHighWater(scope: PeerClientRouteScope): Promise<void> {
    await this.#withSequenceLock(scope, async () => {
      const file = path.join(this.#data, DIRS.sequence, `${scopeDigest(scope)}.json`);
      const counts = sequenceCounts(await this.#read(file, "sequence", MISSING_SEQUENCE));
      const recovered = { ...counts };
      let changed = false;
      // Cold-start recovery reads bucket names and the last bucket's index names,
      // never historical message bodies. Staged reservations may leave safe holes.
      for (const lane of ["outbox", "inbox", "history"] as const) {
        let highWater = (counts[lane] as number | undefined) ?? 0;
        for (const kind of LANE_INDEXES[lane]) {
          const buckets = await this.#indexBuckets(kind, scope);
          for (let index = buckets.length - 1; index >= 0; index -= 1) {
            const bucket = buckets[index]!;
            const directory = path.join(this.#scopeDir(kind, scope), bucket.toString().padStart(10, "0"));
            const names = await fs.promises.readdir(directory);
            const sequences = names.map(parseIndexName).filter((entry) => entry !== null
              && Math.floor((entry.sequence - 1) / INDEX_BUCKET_SIZE) === bucket).map((entry) => entry!.sequence);
            if (sequences.length === 0) continue;
            highWater = Math.max(highWater, ...sequences);
            break;
          }
        }
        if (highWater > ((counts[lane] as number | undefined) ?? 0)) {
          recovered[lane] = highWater;
          changed = true;
        }
      }
      if (changed) await this.#write(file, recovered);
    });
  }

  async #assertSequenceAvailable(lane: "outbox" | "inbox" | "history", scope: PeerClientRouteScope, pointer: IndexPointer): Promise<void> {
    for (const kind of LANE_INDEXES[lane]) {
      const directory = this.#indexBucketDir(kind, scope, pointer.sequence);
      let names: string[];
      try { names = await fs.promises.readdir(directory); }
      catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        throw error;
      }
      if (names.some((name) => {
        const index = parseIndexName(name);
        return index?.sequence === pointer.sequence && name !== `${pointer.recordId}.json`;
      })) {
        throw peerClientError("peer_client_conflict", "The local sequence is already reserved for another durable identity.");
      }
    }
  }

  async #migrateLegacy(scope: PeerClientRouteScope, localDeviceId: string): Promise<void> {
    const markerFile = path.join(this.#data, DIRS.migration, `${digest(`${scopeKey(scope)}\n${localDeviceId}`)}.json`);
    const marker = await this.#read(markerFile, "migration");
    if (record(marker) && marker.routeScope === scopeKey(scope) && marker.deviceId === localDeviceId && marker.complete === true) return;

    for (const legacy of [
      { dir: "outbox", source: "legacy_outbox" as const },
      { dir: "inbox", source: "legacy_inbox" as const },
      { dir: "gaps", source: "legacy_gap" as const }
    ]) {
      const folder = path.join(this.#root, legacy.dir);
      let names: string[];
      try { names = await fs.promises.readdir(folder); }
      catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        throw error;
      }
      names.sort();
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const sourceFile = path.join(folder, name);
        const original = await this.#read(sourceFile, `legacy ${legacy.dir}/${name}`);
        const raw = record(original) ? original : { legacyJsonValue: clone(original) };
        const canonical = JSON.stringify(original);
        const evidenceId = `legacy.${legacy.source}.${digest(`${name}\n${canonical}`)}`;
        const historyCurrent = await this.#findHistoryEvidence(scope, evidenceId);
        if (!historyCurrent) {
          const sequence = await this.#reservedHistorySequence(scope, evidenceId) ?? await this.#allocateWithoutMigration(scope, "history");
          const receipts = Array.isArray(raw.receipts) ? raw.receipts : Array.isArray(raw.reports) ? raw.reports : [];
          const gap = legacy.source === "legacy_gap" ? raw : null;
          const evidence: StoredPeerHistoryEntry = Object.freeze({
            version: PEER_CLIENT_STORE_RECORD_VERSION,
            sequence,
            evidenceId,
            tenantId: scope.tenantId,
            routeId: scope.routeId,
            source: legacy.source,
            messageId: typeof raw.messageId === "string" ? raw.messageId : null,
            deviceId: typeof raw.peerDeviceId === "string" ? raw.peerDeviceId : typeof raw.senderDeviceId === "string" ? raw.senderDeviceId : null,
            formerPosition: Number.isSafeInteger(raw.position) && (raw.position as number) > 0 ? raw.position as number : null,
            formerGap: gap && Number.isSafeInteger(gap.fromSeq) && Number.isSafeInteger(gap.toSeq)
              && (gap.cause === "expired" || gap.cause === "capacity_truncated")
              ? Object.freeze({
                fromSeq: gap.fromSeq as number,
                toSeq: gap.toSeq as number,
                cause: gap.cause,
                messageIds: Array.isArray(gap.messageIds) ? Object.freeze(gap.messageIds.filter((item): item is string => typeof item === "string")) : null
              }) : null,
            formerState: typeof raw.state === "string" ? raw.state : typeof raw.dispatch === "string" ? raw.dispatch : null,
            formerReceiptFacts: Object.freeze(receipts.filter(record)),
            legacyRecord: Object.freeze(clone(raw)),
            recordedAt: new Date().toISOString()
          });
          await this.#writeHistoryEntry(evidence);
        } else {
          await this.#ensureHistoryIndexes(historyCurrent);
        }
        if (legacy.source === "legacy_outbox"
          && (raw.state === "pending" || raw.state === "accepted" || raw.state === "received" || raw.state === "accepted_by_agent")
          && validOpaqueId(raw.messageId) && validOpaqueId(raw.peerDeviceId)
          && validPeerId(raw.peerId) && parsePeerEnvelope(raw.envelope) !== null) {
          const identity = {
            tenantId: scope.tenantId, routeId: scope.routeId,
            senderDeviceId: localDeviceId, recipientDeviceId: raw.peerDeviceId, messageId: raw.messageId
          };
          const existing = await this.#loadOutboxDirect(identity);
          if (existing) {
            if (existing.peerId !== raw.peerId || !sameEnvelope(existing.envelope, raw.envelope)) {
              throw peerClientError("peer_client_conflict", "A legacy outbox identity conflicts with a different durable ciphertext; its source record was retained.");
            }
            await this.#ensureOutboxIndexes(existing);
          } else {
            const sequence = await this.#reservedSequence("outboxId", identity) ?? await this.#allocateWithoutMigration(scope, "outbox");
            const now = new Date().toISOString();
            const entry: StoredOutboxEntry = Object.freeze({
              ...identity,
              version: PEER_CLIENT_STORE_RECORD_VERSION,
              sequence,
              peerId: raw.peerId,
              state: "pending",
              envelope: clone(raw.envelope) as unknown as StoredOutboxEntry["envelope"],
              attempts: Number.isSafeInteger(raw.attempts) && (raw.attempts as number) >= 0 ? raw.attempts as number : 0,
              lastForwarded: null,
              deliveryAck: null,
              lastError: typeof raw.lastError === "string" ? raw.lastError : null,
              createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
              updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now
            });
            await this.#writeOutboxEntry(entry, true);
          }
        } else if (legacy.source === "legacy_inbox" && validOpaqueId(raw.messageId)
          && validOpaqueId(raw.senderDeviceId)
          && (raw.senderPeerId === null || raw.senderPeerId === undefined || validPeerId(raw.senderPeerId))
          && parsePeerEnvelope(raw.envelope) !== null) {
          const identity = {
            tenantId: scope.tenantId, routeId: scope.routeId,
            senderDeviceId: raw.senderDeviceId, recipientDeviceId: localDeviceId, messageId: raw.messageId
          };
          const existing = await this.#loadInboxDirect(identity);
          if (existing) {
            if (!sameEnvelope(existing.envelope, raw.envelope)) {
              throw peerClientError("peer_client_conflict", "A legacy inbox identity conflicts with a different durable ciphertext; its source record was retained.");
            }
            await this.#ensureInboxIndexes(existing);
          } else {
            const sequence = await this.#reservedSequence("inboxId", identity) ?? await this.#allocateWithoutMigration(scope, "inbox");
            const now = new Date().toISOString();
            const plaintext = typeof raw.plaintext === "string" ? raw.plaintext : null;
            const dispatch = raw.dispatch === "accepted_by_agent" || raw.dispatch === "rejected" || raw.dispatch === "skipped"
              ? raw.dispatch
              : plaintext !== null && (raw.dispatch === "pending" || raw.dispatch === "failed") ? "pending" : "failed";
            const entry: StoredInboxEntry = Object.freeze({
              ...identity,
              version: PEER_CLIENT_STORE_RECORD_VERSION,
              sequence,
              senderPeerId: typeof raw.senderPeerId === "string" ? raw.senderPeerId : null,
              envelope: clone(raw.envelope) as unknown as StoredInboxEntry["envelope"],
              plaintext,
              decryptError: typeof raw.decryptError === "string" ? raw.decryptError : null,
              dispatch,
              // Legacy unsigned mailbox receipts never become delivery proof.
              deliveryAck: null,
              receivedAt: typeof raw.receivedAt === "string" ? raw.receivedAt : now,
              updatedAt: now
            });
            await this.#writeInboxEntry(entry, true);
          }
        }
        // The historical copy is durable and idempotent before source removal.
        await this.#remove(sourceFile);
      }
    }
    await this.#write(markerFile, { version: 1, routeScope: scopeKey(scope), deviceId: localDeviceId, complete: true });
  }

  async #allocateWithoutMigration(scope: PeerClientRouteScope, lane: "outbox" | "inbox" | "history"): Promise<number> {
    return this.#withSequenceLock(scope, async () => {
      const file = path.join(this.#data, DIRS.sequence, `${scopeDigest(scope)}.json`);
      const counts = sequenceCounts(await this.#read(file, "sequence", MISSING_SEQUENCE));
      const next = Number.isSafeInteger(counts[lane]) && (counts[lane] as number) >= 0 ? (counts[lane] as number) + 1 : 1;
      if (!Number.isSafeInteger(next)) throw peerClientError("peer_client_store", "The local sequence space is exhausted.");
      await this.#write(file, { ...counts, [lane]: next });
      return next;
    });
  }

  async #findHistoryEvidence(scope: PeerClientRouteScope, evidenceId: string): Promise<StoredPeerHistoryEntry | null> {
    const id = digest(evidenceId);
    const pointer = await this.#read(path.join(this.#data, DIRS.peerHistoryId, scopeDigest(scope), `${id}.json`), `history-by-id/${id}`);
    if (pointer !== null && (!record(pointer) || !validRecordId(pointer.recordId) || !Number.isSafeInteger(pointer.sequence)
      || pointer.recordId !== `${sequenceName(pointer.sequence as number)}-${id}`)) {
      throw peerClientError("peer_client_store", "A historical Peer evidence pointer is malformed; its source record was retained.");
    }
    if (!record(pointer) || !validRecordId(pointer.recordId) || !Number.isSafeInteger(pointer.sequence)
      || pointer.recordId !== `${sequenceName(pointer.sequence as number)}-${id}`) return null;
    const value = await this.#read(this.#recordFile("history", scope, pointer.recordId), `history/${pointer.recordId}`);
    if (value === null) return null;
    const entry = parseHistory(value, `history/${pointer.recordId}`);
    if (entry.sequence !== pointer.sequence || entry.evidenceId !== evidenceId
      || entry.tenantId !== scope.tenantId || entry.routeId !== scope.routeId) {
      throw peerClientError("peer_client_store", "A historical Peer evidence pointer resolves to a different immutable record.");
    }
    return entry;
  }

  async #reservedHistorySequence(scope: PeerClientRouteScope, evidenceId: string): Promise<number | null> {
    const id = digest(evidenceId);
    const pointer = await this.#read(path.join(this.#data, DIRS.peerHistoryId, scopeDigest(scope), `${id}.json`), `history-by-id/${id}`);
    if (pointer !== null && (!record(pointer) || !Number.isSafeInteger(pointer.sequence) || (pointer.sequence as number) < 1
      || pointer.recordId !== `${sequenceName(pointer.sequence as number)}-${id}`)) {
      throw peerClientError("peer_client_store", "A historical Peer evidence pointer is malformed; its source record was retained.");
    }
    if (!record(pointer) || !Number.isSafeInteger(pointer.sequence) || (pointer.sequence as number) < 1
      || pointer.recordId !== `${sequenceName(pointer.sequence as number)}-${id}`) return null;
    return pointer.sequence as number;
  }

  async #loadOutboxDirect(identity: Parameters<typeof identityDigest>[0]): Promise<StoredOutboxEntry | null> {
    const id = identityDigest(identity);
    const pointer = await this.#read(this.#idIndexFile("outboxId", identity), `outbox-by-id/${id}`);
    if (pointer === null) return null;
    if (!record(pointer) || !validRecordId(pointer.recordId) || !Number.isSafeInteger(pointer.sequence)
      || pointer.recordId !== `${sequenceName(pointer.sequence as number)}-${id}`) {
      throw peerClientError("peer_client_store", "A durable outbox identity pointer is malformed; its record was retained.");
    }
    const scope = { tenantId: identity.tenantId, routeId: identity.routeId };
    const value = await this.#read(this.#recordFile("outbox", scope, pointer.recordId), `outbox/${pointer.recordId}`);
    if (value === null) return null;
    const entry = parseOutbox(value, `outbox/${pointer.recordId}`);
    if (entry.sequence !== pointer.sequence || identityKey(entry) !== identityKey(identity)) {
      throw peerClientError("peer_client_store", "A durable outbox identity pointer resolves to a different immutable record.");
    }
    return entry;
  }

  async #loadInboxDirect(identity: Parameters<typeof identityDigest>[0]): Promise<StoredInboxEntry | null> {
    const id = identityDigest(identity);
    const pointer = await this.#read(this.#idIndexFile("inboxId", identity), `inbox-by-id/${id}`);
    if (pointer === null) return null;
    if (!record(pointer) || !validRecordId(pointer.recordId) || !Number.isSafeInteger(pointer.sequence)
      || pointer.recordId !== `${sequenceName(pointer.sequence as number)}-${id}`) {
      throw peerClientError("peer_client_store", "A durable inbox identity pointer is malformed; its record was retained.");
    }
    const scope = { tenantId: identity.tenantId, routeId: identity.routeId };
    const value = await this.#read(this.#recordFile("inbox", scope, pointer.recordId), `inbox/${pointer.recordId}`);
    if (value === null) return null;
    const entry = parseInbox(value, `inbox/${pointer.recordId}`);
    if (entry.sequence !== pointer.sequence || identityKey(entry) !== identityKey(identity)) {
      throw peerClientError("peer_client_store", "A durable inbox identity pointer resolves to a different immutable record.");
    }
    return entry;
  }

  async #reservedSequence(
    kind: "outboxId" | "inboxId",
    identity: Parameters<typeof identityDigest>[0]
  ): Promise<number | null> {
    const pointer = await this.#read(this.#idIndexFile(kind, identity), `${kind} reservation`);
    if (pointer !== null && (!record(pointer) || !Number.isSafeInteger(pointer.sequence) || (pointer.sequence as number) < 1
      || pointer.recordId !== `${sequenceName(pointer.sequence as number)}-${identityDigest(identity)}`)) {
      throw peerClientError("peer_client_store", `A durable ${kind} reservation is malformed; its record was retained.`);
    }
    if (!record(pointer) || !Number.isSafeInteger(pointer.sequence) || (pointer.sequence as number) < 1
      || pointer.recordId !== `${sequenceName(pointer.sequence as number)}-${identityDigest(identity)}`) return null;
    return pointer.sequence as number;
  }

  async loadMeta(): Promise<PeerClientMeta | null> {
    const value = await this.#read(path.join(this.#data, DIRS.meta, "meta.json"), "meta");
    if (!record(value)) {
      // Preserve the old metadata document in place until its retained
      // user-owned bundle and pins are read by the new client.
      const legacy = await this.#read(path.join(this.#root, "meta.json"), "legacy meta");
      if (!record(legacy)) return null;
      return this.#parseMeta(legacy);
    }
    return this.#parseMeta(value);
  }

  async assertAvailableCapacity(additionalBytes: number): Promise<void> {
    await assertPrivateStorageCapacity(this.#root, additionalBytes);
  }

  #parseMeta(value: Record<string, unknown>): PeerClientMeta {
    const base = emptyPeerClientMeta();
    const local = value.localBundle;
    const localBundle = record(local) && typeof local.bundleId === "string" && Number.isSafeInteger(local.revision)
      && typeof local.format === "string" && (local.material === null || typeof local.material === "string")
      ? Object.freeze({
        version: PEER_CLIENT_STORE_RECORD_VERSION,
        bundleId: local.bundleId,
        revision: local.revision as number,
        format: local.format,
        material: local.material as string | null
      }) : null;
    const peers: Record<string, string> = {};
    if (record(value.peers)) {
      for (const [deviceId, peerId] of Object.entries(value.peers)) if (typeof peerId === "string") peers[deviceId] = peerId;
    }
    const bundleObservations: PeerClientMeta["bundleObservations"] = Object.freeze(record(value.bundleObservations)
      ? Object.fromEntries(Object.entries(value.bundleObservations).filter(([, item]) => record(item)
        && typeof item.bundleId === "string" && Number.isSafeInteger(item.revision)
        && (item.oneTimePreKeyId === null || Number.isSafeInteger(item.oneTimePreKeyId))
        && (item.signedPrekeyId === null || Number.isSafeInteger(item.signedPrekeyId)))) as PeerClientMeta["bundleObservations"]
      : {});
    return Object.freeze({
      version: PEER_CLIENT_STORE_RECORD_VERSION,
      localBundle,
      peers: Object.freeze(peers),
      bundleObservations: bundleObservations ?? base.bundleObservations
    });
  }

  async saveMeta(meta: PeerClientMeta): Promise<void> {
    const target = path.join(this.#data, DIRS.meta, "meta.json");
    const existing = await this.#read(target, "meta");
    const legacy = record(existing) ? existing : await this.#read(path.join(this.#root, "meta.json"), "legacy meta");
    const archived = record(legacy)
      ? Object.fromEntries(Object.entries(legacy).filter(([key]) => !["version", "v", "localBundle", "peers", "bundleObservations"].includes(key)))
      : {};
    const next = { ...archived, ...meta };
    if (record(existing) && sameJson(existing, next)) return;
    await this.#write(target, next);
  }

  async allocateOutboxSequence(scope: PeerClientRouteScope): Promise<number> { return this.#allocate(scope, "outbox"); }
  async allocateInboxSequence(scope: PeerClientRouteScope): Promise<number> { return this.#allocate(scope, "inbox"); }
  async allocateHistorySequence(scope: PeerClientRouteScope): Promise<number> { return this.#allocate(scope, "history"); }

  async loadOutboxEntry(identity: PeerMessageIdentity): Promise<StoredOutboxEntry | null> {
    this.#assertBoundIdentity(identity, "senderDeviceId");
    await this.#ensureMigrated(identity);
    return this.#withRecordPublication(() => this.#loadOutboxDirect(identity));
  }

  async saveOutboxEntry(entry: StoredOutboxEntry): Promise<void> {
    const checked = parseOutbox(entry, "outbox entry");
    const scope = { tenantId: checked.tenantId, routeId: checked.routeId };
    this.#assertBoundIdentity(checked, "senderDeviceId");
    await this.#ensureMigrated(scope);
    return this.#withRecordPublication(async () => {
      const existing = await this.#loadOutboxDirect(checked);
      if (existing) {
        if (existing.sequence !== checked.sequence || existing.peerId !== checked.peerId
          || !sameJson(existing.envelope, checked.envelope)) {
          throw peerClientError("peer_client_conflict", "A durable outbox identity cannot change its sequence, peer or ciphertext.");
        }
        if (existing.state !== "pending" && checked.state === "pending") {
          throw peerClientError("peer_client_conflict", "A durable outbox state cannot return to pending after settlement.");
        }
        if (existing.state !== "pending" && checked.state !== existing.state) {
          throw peerClientError("peer_client_conflict", "A settled outbox state cannot be replaced.");
        }
        if (existing.deliveryAck !== null && !sameJson(existing.deliveryAck, checked.deliveryAck)) {
          throw peerClientError("peer_client_conflict", "A durable outbox receipt cannot be replaced.");
        }
        if (sameJson(existing, checked)) {
          await this.#ensureOutboxIndexes(existing);
          return;
        }
      } else {
        const reserved = await this.#reservedSequence("outboxId", checked);
        if (reserved !== null && reserved !== checked.sequence) {
          throw peerClientError("peer_client_conflict", "A durable outbox identity already reserves a different local sequence.");
        }
      }
      await this.#writeOutboxEntry(checked, false, existing === null);
    });
  }

  listPendingOutboxPage(scope: PeerClientRouteScope, query: PeerClientPageQuery): Promise<PeerClientPage<StoredOutboxEntry>> {
    return this.#listIndexed("outboxPending", "outbox", scope, query,
      (entry) => entry.state === "pending", parseOutbox);
  }

  listOutboxHistoryPage(scope: PeerClientRouteScope, query: PeerClientPageQuery): Promise<PeerClientPage<StoredOutboxEntry>> {
    return this.#listIndexed("outboxHistory", "outbox", scope, query,
      (entry) => entry.state !== "pending", parseOutbox);
  }

  async #writeOutboxEntry(entry: StoredOutboxEntry, checkCapacity = false, checkSequence = true): Promise<void> {
    parseOutbox(entry, "outbox entry");
    if (checkCapacity) await this.#assertRecordCapacity(entry);
    const scope = { tenantId: entry.tenantId, routeId: entry.routeId };
    const id = identityDigest(entry);
    const recordId = `${sequenceName(entry.sequence)}-${id}`;
    const pointer: IndexPointer = Object.freeze({ sequence: entry.sequence, recordId, identity: {
      tenantId: entry.tenantId, routeId: entry.routeId, senderDeviceId: entry.senderDeviceId,
      recipientDeviceId: entry.recipientDeviceId, messageId: entry.messageId
    } });
    if (checkSequence) await this.#assertSequenceAvailable("outbox", scope, pointer);
    await this.#ensureOutboxIndexes(entry, pointer, true);
    await this.#write(this.#recordFile("outbox", scope, recordId), entry);
    await this.#syncIndex(entry.state === "pending" ? "outboxHistory" : "outboxPending", scope, pointer, false);
  }

  async #ensureOutboxIndexes(entry: StoredOutboxEntry, supplied?: IndexPointer, publishing = false): Promise<void> {
    const scope = { tenantId: entry.tenantId, routeId: entry.routeId };
    const id = identityDigest(entry);
    const recordId = `${sequenceName(entry.sequence)}-${id}`;
    const pointer = supplied ?? Object.freeze({ sequence: entry.sequence, recordId, identity: {
      tenantId: entry.tenantId, routeId: entry.routeId, senderDeviceId: entry.senderDeviceId,
      recipientDeviceId: entry.recipientDeviceId, messageId: entry.messageId
    } });
    await this.#writePointer(this.#idIndexFile("outboxId", entry), "outbox-by-id", pointer);
    if (!publishing || entry.state === "pending") await this.#syncIndex("outboxPending", scope, pointer, entry.state === "pending");
    if (!publishing || entry.state !== "pending") await this.#syncIndex("outboxHistory", scope, pointer, entry.state !== "pending");
    await this.#advanceSequence(scope, "outbox", entry.sequence);
  }

  async loadInboxEntry(identity: PeerMessageIdentity): Promise<StoredInboxEntry | null> {
    this.#assertBoundIdentity(identity, "recipientDeviceId");
    await this.#ensureMigrated(identity);
    return this.#withRecordPublication(() => this.#loadInboxDirect(identity));
  }

  async saveInboxEntry(entry: StoredInboxEntry): Promise<void> {
    const checked = parseInbox(entry, "inbox entry");
    const scope = { tenantId: checked.tenantId, routeId: checked.routeId };
    this.#assertBoundIdentity(checked, "recipientDeviceId");
    await this.#ensureMigrated(scope);
    return this.#withRecordPublication(async () => {
      const existing = await this.#loadInboxDirect(checked);
      if (existing) {
        if (existing.sequence !== checked.sequence || existing.senderPeerId !== checked.senderPeerId
          || !sameJson(existing.envelope, checked.envelope)
          || existing.plaintext !== checked.plaintext || existing.receivedAt !== checked.receivedAt) {
          throw peerClientError("peer_client_conflict", "A durable inbox identity cannot change its committed message.");
        }
        if (existing.dispatch !== "pending" && checked.dispatch === "pending") {
          throw peerClientError("peer_client_conflict", "A durable inbox dispatch state cannot return to pending after settlement.");
        }
        if (existing.dispatch !== "pending" && checked.dispatch !== existing.dispatch) {
          throw peerClientError("peer_client_conflict", "A settled inbox dispatch state cannot be replaced.");
        }
        if (existing.deliveryAck !== null && !sameJson(existing.deliveryAck, checked.deliveryAck)) {
          throw peerClientError("peer_client_conflict", "A durable inbox receipt cannot be replaced.");
        }
        if (sameJson(existing, checked)) {
          await this.#ensureInboxIndexes(existing);
          return;
        }
      } else {
        const reserved = await this.#reservedSequence("inboxId", checked);
        if (reserved !== null && reserved !== checked.sequence) {
          throw peerClientError("peer_client_conflict", "A durable inbox identity already reserves a different local sequence.");
        }
      }
      await this.#writeInboxEntry(checked, false, existing === null);
    });
  }

  listPendingInboxPage(scope: PeerClientRouteScope, query: PeerClientPageQuery): Promise<PeerClientPage<StoredInboxEntry>> {
    return this.#listIndexed("inboxPending", "inbox", scope, query,
      (entry) => entry.dispatch === "pending" && entry.plaintext !== null, parseInbox);
  }

  listPendingDeliveryAckPage(scope: PeerClientRouteScope, query: PeerClientPageQuery): Promise<PeerClientPage<StoredInboxEntry>> {
    return this.#listIndexed("inboxAckPending", "inbox", scope, query,
      (entry) => entry.deliveryAck === null, parseInbox);
  }

  listInboxHistoryPage(scope: PeerClientRouteScope, query: PeerClientPageQuery): Promise<PeerClientPage<StoredInboxEntry>> {
    return this.#listIndexed("inboxHistory", "inbox", scope, query,
      (entry) => entry.dispatch !== "pending", parseInbox);
  }

  async savePeerHistoryEntry(entry: StoredPeerHistoryEntry): Promise<void> {
    const checked = parseHistory(entry, "history entry");
    const scope = { tenantId: checked.tenantId, routeId: checked.routeId };
    await this.#ensureMigrated(scope);
    return this.#withRecordPublication(async () => {
      const existing = await this.#findHistoryEvidence(scope, checked.evidenceId);
      if (existing) {
        if (!sameJson(existing, checked)) {
          throw peerClientError("peer_client_conflict", "A historical Peer evidence identity already contains different data.");
        }
        await this.#ensureHistoryIndexes(existing);
        return;
      }
      const reserved = await this.#reservedHistorySequence(scope, checked.evidenceId);
      if (reserved !== null && reserved !== checked.sequence) {
        throw peerClientError("peer_client_conflict", "A historical Peer evidence identity already reserves a different local sequence.");
      }
      await this.#writeHistoryEntry(checked);
    });
  }

  listPeerHistoryPage(scope: PeerClientRouteScope, query: PeerClientPageQuery): Promise<PeerClientPage<StoredPeerHistoryEntry>> {
    return this.#listIndexed("peerHistory", "history", scope, query, () => true, parseHistory);
  }

  async #writeHistoryEntry(entry: StoredPeerHistoryEntry): Promise<void> {
    parseHistory(entry, "history entry");
    await this.#assertRecordCapacity(entry);
    const scope = { tenantId: entry.tenantId, routeId: entry.routeId };
    const recordId = `${sequenceName(entry.sequence)}-${digest(entry.evidenceId)}`;
    const pointer: IndexPointer = Object.freeze({ sequence: entry.sequence, recordId });
    await this.#assertSequenceAvailable("history", scope, pointer);
    await this.#ensureHistoryIndexes(entry, pointer);
    await this.#write(this.#recordFile("history", scope, recordId), entry);
  }

  async #ensureHistoryIndexes(entry: StoredPeerHistoryEntry, supplied?: IndexPointer): Promise<void> {
    const scope = { tenantId: entry.tenantId, routeId: entry.routeId };
    const pointer = supplied ?? Object.freeze({ sequence: entry.sequence, recordId: `${sequenceName(entry.sequence)}-${digest(entry.evidenceId)}` });
    await this.#writeHistoryId(scope, entry.evidenceId, pointer);
    await this.#syncIndex("peerHistory", scope, pointer, true);
    await this.#advanceSequence(scope, "history", entry.sequence);
  }

  async #writeHistoryId(scope: PeerClientRouteScope, evidenceId: string, pointer: IndexPointer): Promise<void> {
    const id = digest(evidenceId);
    const file = path.join(this.#data, DIRS.peerHistoryId, scopeDigest(scope), `${id}.json`);
    const current = await this.#read(file, `history-by-id/${id}`);
    if (sameJson(current, pointer)) return;
    await this.#write(file, pointer);
  }

  async #writeInboxEntry(entry: StoredInboxEntry, checkCapacity = false, checkSequence = true): Promise<void> {
    parseInbox(entry, "inbox entry");
    if (checkCapacity) await this.#assertRecordCapacity(entry);
    const scope = { tenantId: entry.tenantId, routeId: entry.routeId };
    const id = identityDigest(entry);
    const recordId = `${sequenceName(entry.sequence)}-${id}`;
    const pointer: IndexPointer = Object.freeze({ sequence: entry.sequence, recordId, identity: {
      tenantId: entry.tenantId, routeId: entry.routeId, senderDeviceId: entry.senderDeviceId,
      recipientDeviceId: entry.recipientDeviceId, messageId: entry.messageId
    } });
    if (checkSequence) await this.#assertSequenceAvailable("inbox", scope, pointer);
    await this.#ensureInboxIndexes(entry, pointer, true);
    await this.#write(this.#recordFile("inbox", scope, recordId), entry);
    if (entry.dispatch !== "pending" || entry.plaintext === null) await this.#syncIndex("inboxPending", scope, pointer, false);
    if (entry.deliveryAck !== null) await this.#syncIndex("inboxAckPending", scope, pointer, false);
    if (entry.dispatch === "pending") await this.#syncIndex("inboxHistory", scope, pointer, false);
  }

  async #ensureInboxIndexes(entry: StoredInboxEntry, supplied?: IndexPointer, publishing = false): Promise<void> {
    const scope = { tenantId: entry.tenantId, routeId: entry.routeId };
    const id = identityDigest(entry);
    const recordId = `${sequenceName(entry.sequence)}-${id}`;
    const pointer = supplied ?? Object.freeze({ sequence: entry.sequence, recordId, identity: {
      tenantId: entry.tenantId, routeId: entry.routeId, senderDeviceId: entry.senderDeviceId,
      recipientDeviceId: entry.recipientDeviceId, messageId: entry.messageId
    } });
    await this.#writePointer(this.#idIndexFile("inboxId", entry), "inbox-by-id", pointer);
    const pending = entry.dispatch === "pending" && entry.plaintext !== null;
    if (!publishing || pending) await this.#syncIndex("inboxPending", scope, pointer, pending);
    if (!publishing || entry.deliveryAck === null) await this.#syncIndex("inboxAckPending", scope, pointer, entry.deliveryAck === null);
    if (!publishing || entry.dispatch !== "pending") await this.#syncIndex("inboxHistory", scope, pointer, entry.dispatch !== "pending");
    await this.#advanceSequence(scope, "inbox", entry.sequence);
  }

  async #writePointer(file: string, label: string, pointer: IndexPointer): Promise<void> {
    const current = await this.#read(file, label);
    if (sameJson(current, pointer)) return;
    await this.#write(file, pointer);
  }

  async #syncIndex(kind: IndexKind, scope: PeerClientRouteScope, pointer: IndexPointer, present: boolean): Promise<void> {
    const parsedRecordId = validRecordId(pointer.recordId) ? parseIndexName(`${pointer.recordId}.json`) : null;
    if (!parsedRecordId || parsedRecordId.sequence !== pointer.sequence) {
      throw peerClientError("peer_client_store", "A client store index pointer is malformed.");
    }
    const dir = this.#indexBucketDir(kind, scope, pointer.sequence);
    const file = path.join(dir, indexName(pointer.sequence, pointer.recordId.slice(pointer.recordId.indexOf("-") + 1)));
    if (!present) {
      await this.#remove(file);
      await this.#removeEmptyIndexBucket(dir);
      return;
    }
    await this.#writePointer(file, `${kind} index`, pointer);
  }

  async #removeEmptyIndexBucket(directory: string): Promise<void> {
    try { await fs.promises.rmdir(directory); }
    catch (error: unknown) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException)?.code ?? "")) throw error;
    }
  }

  async #listIndexed<T extends { readonly sequence: number }>(
    kind: IndexKind,
    recordKind: "outbox" | "inbox" | "history",
    scope: PeerClientRouteScope,
    query: PeerClientPageQuery,
    predicate: (entry: T) => boolean,
    parse: (value: unknown, what: string) => T
  ): Promise<PeerClientPage<T>> {
    await this.#ensureMigrated(scope);
    return this.#withRecordPublication(async () => {
      if (!Number.isSafeInteger(query.afterSequence) || query.afterSequence < 0
        || !Number.isSafeInteger(query.limit) || query.limit < 1) {
        throw peerClientError("peer_client_store", "A page query is malformed.");
      }
      const limit = Math.min(query.limit, 256);
      const firstBucket = Math.floor(query.afterSequence / INDEX_BUCKET_SIZE);
      const items: T[] = [];
      const buckets = await this.#indexBuckets(kind, scope, firstBucket);
      for (const bucket of buckets) {
        if (items.length >= limit) break;
        const bucketName = bucket.toString().padStart(10, "0");
        const dir = path.join(this.#scopeDir(kind, scope), bucketName);
        let names: string[];
        try { names = await fs.promises.readdir(dir); }
        catch (error: unknown) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
          throw error;
        }
        names.sort();
        if (names.length === 0) await this.#removeEmptyIndexBucket(dir);
        for (const name of names) {
          if (!name.endsWith(".json")) continue;
          const filename = parseIndexName(name);
          if (!filename) {
            await this.#remove(path.join(dir, name));
            continue;
          }
          if (filename.sequence <= query.afterSequence) continue;
          const indexFile = path.join(dir, name);
          const expectedRecordId = `${sequenceName(filename.sequence)}-${filename.recordDigest}`;
          const value = await this.#read(this.#recordFile(recordKind, scope, expectedRecordId), `${recordKind}/${expectedRecordId}`);
          if (value === null) {
            await this.#remove(indexFile);
            continue;
          }
          const parsed = parse(value, `${recordKind}/${expectedRecordId}`);
          if (parsed.sequence !== filename.sequence
            || (recordKind === "history"
              ? !record(parsed) || (parsed as unknown as StoredPeerHistoryEntry).tenantId !== scope.tenantId
                || (parsed as unknown as StoredPeerHistoryEntry).routeId !== scope.routeId
                || expectedRecordId !== `${sequenceName(parsed.sequence)}-${digest((parsed as unknown as StoredPeerHistoryEntry).evidenceId)}`
              : !record(parsed) || (parsed as unknown as PeerMessageIdentity).tenantId !== scope.tenantId
                || (parsed as unknown as PeerMessageIdentity).routeId !== scope.routeId
                || expectedRecordId !== `${sequenceName(parsed.sequence)}-${identityDigest(parsed as unknown as PeerMessageIdentity)}`)) {
            await this.#remove(indexFile);
            continue;
          }
          const pointer: IndexPointer = recordKind === "history"
            ? Object.freeze({ sequence: filename.sequence, recordId: expectedRecordId })
            : Object.freeze({
              sequence: filename.sequence,
              recordId: expectedRecordId,
              identity: {
                tenantId: (parsed as unknown as PeerMessageIdentity).tenantId,
                routeId: (parsed as unknown as PeerMessageIdentity).routeId,
                senderDeviceId: (parsed as unknown as PeerMessageIdentity).senderDeviceId,
                recipientDeviceId: (parsed as unknown as PeerMessageIdentity).recipientDeviceId,
                messageId: (parsed as unknown as PeerMessageIdentity).messageId
              }
            });
          const pointerValue = await this.#read(indexFile, `${kind}/${name}`);
          if (!sameJson(pointerValue, pointer)) await this.#writePointer(indexFile, `${kind}/${name}`, pointer);
          if (!predicate(parsed)) {
            await this.#remove(indexFile);
            await this.#repairIndexes(recordKind, scope, pointer, parsed);
            continue;
          }
          items.push(parsed);
          if (items.length >= limit) break;
        }
      }
      return Object.freeze({
        items: Object.freeze(items),
        nextAfterSequence: items.length === 0 ? null : items[items.length - 1]!.sequence
      });
    });
  }

  async #repairIndexes(
    recordKind: "outbox" | "inbox" | "history",
    scope: PeerClientRouteScope,
    pointer: IndexPointer,
    value: unknown
  ): Promise<void> {
    if (recordKind === "outbox") {
      const entry = parseOutbox(value, `outbox/${pointer.recordId}`);
      await this.#ensureOutboxIndexes(entry, pointer);
      return;
    }
    if (recordKind === "inbox") {
      const entry = parseInbox(value, `inbox/${pointer.recordId}`);
      await this.#ensureInboxIndexes(entry, pointer);
      return;
    }
    await this.#ensureHistoryIndexes(parseHistory(value, `history/${pointer.recordId}`), pointer);
  }
}

export function createFilePeerClientStore(rootDir: string): FilePeerClientStore {
  return new FilePeerClientStore(rootDir);
}
