import fs from "node:fs";
import path from "node:path";

import {
  ensurePrivateDir,
  writePrivateFileAtomic
} from "@meshrix/foundation/storage/private-file-atomic";

import { peerClientError } from "./errors.ts";
import type {
  PeerClientMeta,
  PeerClientStore,
  StoredGapTombstone,
  StoredInboxEntry,
  StoredOutboxEntry
} from "./store.ts";
import { emptyPeerClientMeta, PEER_INBOX_DISPATCH_STATES, PEER_OUTBOX_STATES } from "./store.ts";
import { PEER_CLIENT_STORE_RECORD_VERSION } from "./types.ts";

/**
 * File-backed durable peer client store. One JSON document per record under
 * an owner-only directory; every write goes through `writePrivateFileAtomic`
 * (temp file → fsync → rename, 0o600) so a crash can lose a record but never
 * leaves a torn outbox/inbox file. Assumes a single writer process — the
 * device owns this directory.
 *
 * Layout:
 *   meta.json                  cursor, pending reports, local bundle, peers, policy
 *   outbox/<b64 messageId>     sender-scoped send records with wire envelopes
 *   inbox/<position12>         stored inbound entries incl. decrypted payload
 *   inbox-byid/<b64 messageId> messageId → position secondary index
 *   gaps/<fromSeq12>           durable loss tombstones (surfaced, never skipped)
 */

const KIND_DIRS = Object.freeze({
  outbox: "outbox",
  inbox: "inbox",
  inboxById: "inbox-byid",
  gaps: "gaps"
} as const);

function safeName(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64url");
}

function positionName(position: number): string {
  return position.toString().padStart(12, "0");
}

function isEntry(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(what: string, detail: string): never {
  throw peerClientError("peer_client_store", `Client store record ${what} ${detail}`);
}

function asString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) fail(what, "is missing a required string field.");
  return value as string;
}

function asNullableString(value: unknown, what: string): string | null {
  if (value === null) return null;
  return asString(value, what);
}

function asNumber(value: unknown, what: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) fail(what, "is missing a required integer field.");
  return value as number;
}

function asOutboxEntry(value: Record<string, unknown>, what: string): StoredOutboxEntry {
  const state = value.state;
  if (typeof state !== "string" || !(PEER_OUTBOX_STATES as readonly string[]).includes(state)) {
    fail(what, "carries an unknown outbox state.");
  }
  return Object.freeze({
    version: PEER_CLIENT_STORE_RECORD_VERSION,
    messageId: asString(value.messageId, `${what}.messageId`),
    peerDeviceId: asString(value.peerDeviceId, `${what}.peerDeviceId`),
    peerId: asString(value.peerId, `${what}.peerId`),
    state: state as StoredOutboxEntry["state"],
    position: value.position === null ? null : asNumber(value.position, `${what}.position`, 1),
    envelope: value.envelope as StoredOutboxEntry["envelope"],
    attempts: asNumber(value.attempts, `${what}.attempts`),
    receipts: Object.freeze(Array.isArray(value.receipts) ? value.receipts as StoredOutboxEntry["receipts"] : fail(what, "carries no receipt list.")),
    lastError: asNullableString(value.lastError, `${what}.lastError`),
    createdAt: asString(value.createdAt, `${what}.createdAt`),
    updatedAt: asString(value.updatedAt, `${what}.updatedAt`)
  });
}

function asInboxEntry(value: Record<string, unknown>, what: string): StoredInboxEntry {
  const dispatch = value.dispatch;
  if (typeof dispatch !== "string" || !(PEER_INBOX_DISPATCH_STATES as readonly string[]).includes(dispatch)) {
    fail(what, "carries an unknown dispatch state.");
  }
  return Object.freeze({
    version: PEER_CLIENT_STORE_RECORD_VERSION,
    position: asNumber(value.position, `${what}.position`, 1),
    senderDeviceId: asString(value.senderDeviceId, `${what}.senderDeviceId`),
    senderPeerId: asNullableString(value.senderPeerId, `${what}.senderPeerId`),
    messageId: asString(value.messageId, `${what}.messageId`),
    envelope: value.envelope as StoredInboxEntry["envelope"],
    plaintext: asNullableString(value.plaintext, `${what}.plaintext`),
    decryptError: asNullableString(value.decryptError, `${what}.decryptError`),
    dispatch: dispatch as StoredInboxEntry["dispatch"],
    reports: Object.freeze(Array.isArray(value.reports) ? value.reports.map((entry) => asString(entry, `${what}.reports`)) : fail(what, "carries no report list.")),
    receivedAt: asString(value.receivedAt, `${what}.receivedAt`)
  });
}

function asGapTombstone(value: Record<string, unknown>, what: string): StoredGapTombstone {
  const cause = value.cause;
  if (cause !== "expired" && cause !== "capacity_truncated") {
    fail(what, "carries an unknown gap cause.");
  }
  return Object.freeze({
    version: PEER_CLIENT_STORE_RECORD_VERSION,
    fromSeq: asNumber(value.fromSeq, `${what}.fromSeq`),
    toSeq: asNumber(value.toSeq, `${what}.toSeq`),
    cause,
    messageIds: value.messageIds === null
      ? null
      : Object.freeze(Array.isArray(value.messageIds) ? value.messageIds.map((entry) => asString(entry, `${what}.messageIds`)) : fail(what, "carries a malformed messageIds list.")),
    observedAt: asString(value.observedAt, `${what}.observedAt`)
  });
}

export class FilePeerClientStore implements PeerClientStore {
  readonly #root: string;

  constructor(rootDir: string) {
    if (typeof rootDir !== "string" || rootDir.length === 0) {
      throw peerClientError("peer_client_state", "FilePeerClientStore requires a root directory path.");
    }
    this.#root = rootDir;
    ensurePrivateDir(this.#root);
    for (const dir of Object.values(KIND_DIRS)) {
      ensurePrivateDir(path.join(this.#root, dir));
    }
  }

  get rootDir(): string {
    return this.#root;
  }

  #file(kind: keyof typeof KIND_DIRS | "meta", name?: string): string {
    if (kind === "meta") return path.join(this.#root, "meta.json");
    return path.join(this.#root, KIND_DIRS[kind], `${safeName(String(name))}.json`);
  }

  async #read(file: string, what: string): Promise<Record<string, unknown> | null> {
    let text: string;
    try {
      text = await fs.promises.readFile(file, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isEntry(parsed)) throw new Error("not an object");
      return parsed;
    } catch (error: unknown) {
      throw peerClientError("peer_client_store", `Client store record ${what} cannot be parsed.`, { cause: error });
    }
  }

  async #write(file: string, value: Readonly<Record<string, unknown>>): Promise<void> {
    await writePrivateFileAtomic(file, `${JSON.stringify(value)}\n`);
  }

  async #list(kind: keyof typeof KIND_DIRS): Promise<readonly Record<string, unknown>[]> {
    const dir = path.join(this.#root, KIND_DIRS[kind]);
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return Object.freeze([]);
    }
    const out: Record<string, unknown>[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = await this.#read(path.join(dir, name), `${kind}/${name}`);
      if (record) out.push(record);
    }
    return Object.freeze(out);
  }

  async loadMeta(): Promise<PeerClientMeta | null> {
    const record = await this.#read(this.#file("meta"), "meta");
    if (!record) return null;
    const base = emptyPeerClientMeta();
    return Object.freeze({
      version: PEER_CLIENT_STORE_RECORD_VERSION,
      cursor: asNumber(record.cursor, "meta.cursor"),
      pendingReports: Object.freeze(Array.isArray(record.pendingReports) ? record.pendingReports as PeerClientMeta["pendingReports"] : fail("meta", "carries a malformed pendingReports list.")),
      localBundle: record.localBundle === null || record.localBundle === undefined
        ? null
        : Object.freeze(isEntry(record.localBundle) ? {
          version: PEER_CLIENT_STORE_RECORD_VERSION,
          bundleId: asString(record.localBundle.bundleId, "meta.localBundle.bundleId"),
          revision: asNumber(record.localBundle.revision, "meta.localBundle.revision"),
          format: asString(record.localBundle.format, "meta.localBundle.format"),
          material: asNullableString(record.localBundle.material, "meta.localBundle.material")
        } : fail("meta", "carries a malformed localBundle.")),
      peers: Object.freeze(isEntry(record.peers) ? { ...record.peers } as Record<string, string> : {}),
      bundleObservations: Object.freeze(isEntry(record.bundleObservations) ? { ...record.bundleObservations } as PeerClientMeta["bundleObservations"] : {}),
      retentionPolicy: record.retentionPolicy === null || record.retentionPolicy === undefined
        ? null
        : record.retentionPolicy as PeerClientMeta["retentionPolicy"]
    });
  }

  async saveMeta(meta: PeerClientMeta): Promise<void> {
    await this.#write(this.#file("meta"), { v: PEER_CLIENT_STORE_RECORD_VERSION, ...meta });
  }

  async loadOutboxEntry(messageId: string): Promise<StoredOutboxEntry | null> {
    const record = await this.#read(this.#file("outbox", messageId), `outbox/${messageId}`);
    return record ? asOutboxEntry(record, `outbox/${messageId}`) : null;
  }

  async saveOutboxEntry(entry: StoredOutboxEntry): Promise<void> {
    await this.#write(this.#file("outbox", entry.messageId), { v: PEER_CLIENT_STORE_RECORD_VERSION, ...entry });
  }

  async listOutboxEntries(): Promise<readonly StoredOutboxEntry[]> {
    const records = await this.#list("outbox");
    return Object.freeze(records.map((record) => asOutboxEntry(record, "outbox entry")));
  }

  async loadInboxEntry(position: number): Promise<StoredInboxEntry | null> {
    const record = await this.#read(this.#file("inbox", positionName(position)), `inbox/${position}`);
    return record ? asInboxEntry(record, `inbox/${position}`) : null;
  }

  async loadInboxEntryByMessageId(messageId: string): Promise<StoredInboxEntry | null> {
    const pointer = await this.#read(this.#file("inboxById", messageId), `inbox-byid/${messageId}`);
    if (!pointer) return null;
    const position = asNumber(pointer.position, `inbox-byid/${messageId}.position`, 1);
    return this.loadInboxEntry(position);
  }

  async saveInboxEntry(entry: StoredInboxEntry): Promise<void> {
    await this.#write(this.#file("inbox", positionName(entry.position)), { v: PEER_CLIENT_STORE_RECORD_VERSION, ...entry });
    await this.#write(this.#file("inboxById", entry.messageId), {
      v: PEER_CLIENT_STORE_RECORD_VERSION,
      messageId: entry.messageId,
      position: entry.position
    });
  }

  async listInboxEntries(): Promise<readonly StoredInboxEntry[]> {
    const records = await this.#list("inbox");
    return Object.freeze(
      records
        .map((record) => asInboxEntry(record, "inbox entry"))
        .sort((left, right) => left.position - right.position)
    );
  }

  async saveGapTombstone(gap: StoredGapTombstone): Promise<void> {
    await this.#write(this.#file("gaps", positionName(gap.fromSeq)), { v: PEER_CLIENT_STORE_RECORD_VERSION, ...gap });
  }

  async findGapTombstone(fromSeq: number, toSeq: number): Promise<StoredGapTombstone | null> {
    const record = await this.#read(this.#file("gaps", positionName(fromSeq)), `gaps/${fromSeq}`);
    if (!record) return null;
    const gap = asGapTombstone(record, `gaps/${fromSeq}`);
    return gap.toSeq === toSeq ? gap : null;
  }

  async listGapTombstones(): Promise<readonly StoredGapTombstone[]> {
    const records = await this.#list("gaps");
    return Object.freeze(
      records
        .map((record) => asGapTombstone(record, "gap tombstone"))
        .sort((left, right) => left.fromSeq - right.fromSeq)
    );
  }
}

export function createFilePeerClientStore(rootDir: string): FilePeerClientStore {
  return new FilePeerClientStore(rootDir);
}
