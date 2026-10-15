import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const storageHooks = vi.hoisted(() => ({
  writeAttempts: 0,
  failWhen: null as ((file: string) => boolean) | null,
  beforeWrite: null as ((file: string) => Promise<void>) | null,
  afterWrite: null as ((file: string) => void) | null,
  capacityCalls: [] as Array<readonly [string, number]>,
  capacityFailure: null as Error | null
}));

vi.mock("@meshrix/foundation/storage/private-file-atomic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meshrix/foundation/storage/private-file-atomic")>();
  return {
    ...actual,
    writePrivateFileAtomic: async (file: string, contents: string | Uint8Array) => {
      storageHooks.writeAttempts += 1;
      if (storageHooks.failWhen?.(file)) {
        storageHooks.failWhen = null;
        throw new Error("simulated atomic-store interruption");
      }
      await storageHooks.beforeWrite?.(file);
      const result = await actual.writePrivateFileAtomic(file, contents);
      storageHooks.afterWrite?.(file);
      return result;
    }
  };
});

vi.mock("@meshrix/foundation/storage/private-storage-capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meshrix/foundation/storage/private-storage-capacity")>();
  return {
    ...actual,
    assertPrivateStorageCapacity: async (rootPath: string, additionalBytes: number) => {
      storageHooks.capacityCalls.push(Object.freeze([rootPath, additionalBytes]));
      if (storageHooks.capacityFailure !== null) throw storageHooks.capacityFailure;
    }
  };
});

import { createFilePeerClientStore } from "@meshrix/peer-client";
import type {
  PeerClientRouteIdentity,
  PeerClientRouteScope,
  StoredPeerHistoryEntry,
  StoredInboxEntry,
  StoredOutboxEntry
} from "@meshrix/peer-client";
import type { PeerEnvelope } from "@meshrix/contracts/private-relay";
import { PEER_CLIENT_STORE_RECORD_VERSION } from "../../../packages/peer-client/src/types.ts";

const scope: PeerClientRouteScope = Object.freeze({ tenantId: "tenant.personal", routeId: "route.primary" });
const route: PeerClientRouteIdentity = Object.freeze({ ...scope, deviceId: "device.local" });
const timestamp = "2026-10-12T00:00:00.000Z";
const roots: string[] = [];

function opaqueEnvelope(value: string): PeerEnvelope {
  return Object.freeze({
    format: "signal-x3dh",
    headers: Object.freeze({
      messageType: "session",
      senderBundleId: "bundle.sender",
      recipientBundleId: "bundle.recipient",
      prekeyId: null,
      signedPrekeyId: null,
      baseKeyId: null
    }),
    ciphertext: Buffer.from(value, "utf8").toString("base64url")
  }) as PeerEnvelope;
}

function legacyOutbox(messageId: string, state: string, ciphertext: string): Record<string, unknown> {
  return {
    messageId,
    peerDeviceId: "device.remote",
    peerId: "peer.remote",
    state,
    position: 17,
    envelope: opaqueEnvelope(ciphertext),
    attempts: 3,
    receipts: [{ type: "unsigned-legacy-receipt", position: 17 }],
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function legacyInbox(messageId: string, dispatch: string, plaintext: string | null): Record<string, unknown> {
  return {
    position: 31,
    senderDeviceId: "device.remote",
    senderPeerId: "peer.remote",
    messageId,
    envelope: opaqueEnvelope(`cipher.${messageId}`),
    plaintext,
    decryptError: null,
    dispatch,
    reports: ["legacy-report"],
    receivedAt: timestamp
  };
}

function outboxEntry(messageId: string, sequence: number, state: StoredOutboxEntry["state"] = "pending"): StoredOutboxEntry {
  return Object.freeze({
    tenantId: scope.tenantId,
    routeId: scope.routeId,
    senderDeviceId: route.deviceId,
    recipientDeviceId: "device.remote",
    messageId,
    version: PEER_CLIENT_STORE_RECORD_VERSION,
    sequence,
    peerId: "peer.remote",
    state,
    envelope: opaqueEnvelope(`cipher.${messageId}`),
    attempts: 0,
    lastForwarded: null,
    deliveryAck: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

async function newRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "meshrix-peer-file-store-"));
  roots.push(root);
  return root;
}

async function writeLegacy(root: string, kind: "outbox" | "inbox" | "gaps", name: string, value: unknown): Promise<string> {
  const directory = path.join(root, kind);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${name}.json`);
  await writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return file;
}

async function findIndexFile(root: string, directoryName: string): Promise<string> {
  const rootPath = path.join(root, "peer-records", directoryName);
  const scopes = await readdir(rootPath);
  for (const scopeName of scopes) {
    const scopePath = path.join(rootPath, scopeName);
    for (const bucketName of await readdir(scopePath)) {
      const bucketPath = path.join(scopePath, bucketName);
      const names = await readdir(bucketPath);
      if (names.length > 0) return path.join(bucketPath, names[0]!);
    }
  }
  throw new Error(`No index file found in ${directoryName}.`);
}

afterEach(async () => {
  storageHooks.writeAttempts = 0;
  storageHooks.failWhen = null;
  storageHooks.beforeWrite = null;
  storageHooks.afterWrite = null;
  storageHooks.capacityCalls = [];
  storageHooks.capacityFailure = null;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FilePeerClientStore legacy recovery", () => {
  it("rebuilds recoverable outbox work and preserves terminal, receipt, inbox and gap evidence", async () => {
    const root = await newRoot();
    const pendingStates = ["pending", "accepted", "received", "accepted_by_agent"] as const;
    const outboxSources = await Promise.all(pendingStates.map((state, index) => {
      const raw = legacyOutbox(`legacy.out.${index}`, state, `cipher.out.${index}`);
      return writeLegacy(root, "outbox", `record-${index}`, raw).then((file) => ({ file, raw }));
    }));
    const terminalRaw = legacyOutbox("legacy.out.completed", "completed", "cipher.completed");
    const terminalFile = await writeLegacy(root, "outbox", "terminal", terminalRaw);
    const malformedRaw = { ...legacyOutbox("", "accepted", "cipher.unbound"), peerDeviceId: null, envelope: null };
    const malformedFile = await writeLegacy(root, "outbox", "malformed", malformedRaw);
    const primitiveRaw = 42;
    const primitiveFile = await writeLegacy(root, "outbox", "primitive", primitiveRaw);
    const inboxAccepted = legacyInbox("legacy.in.accepted", "accepted_by_agent", "AQ==");
    const originalOperation = { operationId: "operation.already-reserved", text: "retained request" };
    const inboxFailed = legacyInbox("legacy.in.failed", "failed", Buffer.from(JSON.stringify(originalOperation)).toString("base64"));
    const inboxAcceptedFile = await writeLegacy(root, "inbox", "accepted", inboxAccepted);
    const inboxFailedFile = await writeLegacy(root, "inbox", "failed", inboxFailed);
    const gap = { fromSeq: 8, toSeq: 9, cause: "expired", messageIds: ["old.8", "old.9"], observedAt: timestamp };
    const gapFile = await writeLegacy(root, "gaps", "gap-8", gap);

    const store = createFilePeerClientStore(root);
    await store.prepareRoute(route);

    const pendingOutbox = await store.listPendingOutboxPage(scope, { afterSequence: 0, limit: 20 });
    expect(pendingOutbox.items.map((entry) => entry.messageId)).toEqual(pendingStates.map((_, index) => `legacy.out.${index}`));
    for (const entry of pendingOutbox.items) {
      const original = outboxSources.find(({ raw }) => raw.messageId === entry.messageId)?.raw;
      expect(entry.state).toBe("pending");
      expect(entry.senderDeviceId).toBe(route.deviceId);
      expect(entry.recipientDeviceId).toBe("device.remote");
      expect(entry.envelope).toEqual(original?.envelope);
      expect(entry.deliveryAck).toBeNull();
      expect(entry.lastForwarded).toBeNull();
      expect(entry).not.toHaveProperty("position");
    }
    expect((await store.listOutboxHistoryPage(scope, { afterSequence: 0, limit: 20 })).items).toEqual([]);

    const recoveredInbox = await store.loadInboxEntry({
      ...scope,
      senderDeviceId: "device.remote",
      recipientDeviceId: route.deviceId,
      messageId: "legacy.in.accepted"
    });
    expect(recoveredInbox?.dispatch).toBe("accepted_by_agent");
    expect(recoveredInbox?.deliveryAck).toBeNull();
    const recoveredPending = (await store.listPendingInboxPage(scope, { afterSequence: 0, limit: 20 })).items;
    expect(recoveredPending.map((entry) => entry.messageId)).toEqual(["legacy.in.failed"]);
    expect(recoveredPending[0]?.plaintext).toBe(inboxFailed.plaintext);
    expect(JSON.parse(Buffer.from(recoveredPending[0]!.plaintext!, "base64").toString("utf8"))).toEqual(originalOperation);
    const pendingAck = await store.listPendingDeliveryAckPage(scope, { afterSequence: 0, limit: 20 });
    expect(pendingAck.items.map((entry) => entry.messageId)).toEqual(["legacy.in.accepted", "legacy.in.failed"]);
    expect((await store.listInboxHistoryPage(scope, { afterSequence: 0, limit: 20 })).items.map((entry) => entry.messageId))
      .toEqual(["legacy.in.accepted"]);

    const histories = await store.listPeerHistoryPage(scope, { afterSequence: 0, limit: 20 });
    const historyByMessage = new Map(histories.items.map((entry) => [entry.messageId, entry]));
    for (const { raw } of outboxSources) {
      const history = historyByMessage.get(raw.messageId as string);
      expect(history?.legacyRecord).toEqual(raw);
      expect(history?.formerReceiptFacts).toEqual(raw.receipts);
      expect(history?.formerPosition).toBe(17);
    }
    expect(historyByMessage.get("legacy.out.completed")?.legacyRecord).toEqual(terminalRaw);
    expect(historyByMessage.get("")?.legacyRecord).toEqual(malformedRaw);
    expect(histories.items.find((entry) => entry.source === "legacy_outbox" && entry.legacyRecord?.legacyJsonValue === primitiveRaw)?.legacyRecord)
      .toEqual({ legacyJsonValue: primitiveRaw });
    expect(historyByMessage.get("legacy.in.accepted")?.legacyRecord).toEqual(inboxAccepted);
    expect(historyByMessage.get("legacy.in.failed")?.legacyRecord).toEqual(inboxFailed);
    expect(histories.items.find((entry) => entry.source === "legacy_gap")?.legacyRecord).toEqual(gap);
    expect(histories.items.find((entry) => entry.source === "legacy_gap")?.formerGap).toEqual({
      fromSeq: 8,
      toSeq: 9,
      cause: "expired",
      messageIds: ["old.8", "old.9"]
    });
    expect(await Promise.all([...outboxSources.map(({ file }) => file), terminalFile, malformedFile, primitiveFile, inboxAcceptedFile, inboxFailedFile, gapFile]
      .map(async (file) => readFile(file).then(() => true, () => false)))).toEqual(Array(10).fill(false));
  });

  it("retries an interrupted migration using the reserved identity and sequence before unlinking source data", async () => {
    const root = await newRoot();
    const raw = legacyOutbox("legacy.crash", "accepted", "cipher.recoverable");
    const source = await writeLegacy(root, "outbox", "crash", raw);
    const store = createFilePeerClientStore(root);
    storageHooks.failWhen = (file) => file.includes(`${path.sep}peer-records${path.sep}outbox${path.sep}`);

    await expect(store.prepareRoute(route)).rejects.toThrow("simulated atomic-store interruption");
    await expect(readFile(source, "utf8")).resolves.toContain("legacy.crash");
    await store.prepareRoute(route);

    const active = await store.loadOutboxEntry({
      ...scope,
      senderDeviceId: route.deviceId,
      recipientDeviceId: "device.remote",
      messageId: "legacy.crash"
    });
    expect(active?.state).toBe("pending");
    expect(active?.sequence).toBe(1);
    expect(active?.envelope).toEqual(raw.envelope);
    expect((await store.listPendingOutboxPage(scope, { afterSequence: 0, limit: 10 })).items).toHaveLength(1);
    expect(await store.allocateOutboxSequence(scope)).toBe(2);
    await expect(readFile(source, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs a stale page pointer and does not rewrite an identical durable entry", async () => {
    const root = await newRoot();
    const store = createFilePeerClientStore(root);
    await store.prepareRoute(route);
    const sequence = await store.allocateOutboxSequence(scope);
    const entry = outboxEntry("current.message", sequence);
    await store.saveOutboxEntry(entry);
    const indexFile = await findIndexFile(root, "outbox-pending");
    await writeFile(indexFile, JSON.stringify({ sequence: 9, recordId: "stale-pointer" }));

    const repaired = await store.listPendingOutboxPage(scope, { afterSequence: 0, limit: 10 });
    expect(repaired.items).toEqual([entry]);
    const writeCount = storageHooks.writeAttempts;
    await store.saveOutboxEntry(entry);
    expect(storageHooks.writeAttempts).toBe(writeCount);
    await expect(readFile(indexFile, "utf8")).resolves.toContain(entry.messageId);
  });

  it("keeps paging ordered, binds the route to one local device, and forwards capacity failures unchanged", async () => {
    const root = await newRoot();
    const store = createFilePeerClientStore(root);
    await store.prepareRoute(route);
    const firstSequence = await store.allocateOutboxSequence(scope);
    const secondSequence = await store.allocateOutboxSequence(scope);
    await store.saveOutboxEntry(outboxEntry("first.message", firstSequence));
    await store.saveOutboxEntry(outboxEntry("second.message", secondSequence));

    const first = await store.listPendingOutboxPage(scope, { afterSequence: 0, limit: 1 });
    expect(first.items.map((entry) => entry.messageId)).toEqual(["first.message"]);
    expect(first.nextAfterSequence).toBe(firstSequence);
    const second = await store.listPendingOutboxPage(scope, { afterSequence: first.nextAfterSequence!, limit: 1 });
    expect(second.items.map((entry) => entry.messageId)).toEqual(["second.message"]);

    await expect(store.prepareRoute({ ...route, deviceId: "device.other" })).rejects.toThrow(/rebound|different tenant/u);
    await expect(store.saveOutboxEntry({ ...outboxEntry("wrong.sender", 3), senderDeviceId: "device.other" }))
      .rejects.toThrow(/bound local device/u);

    const failure = Object.assign(new Error("capacity guard refused the write"), { code: "private_storage_capacity" });
    storageHooks.capacityFailure = failure;
    await expect(store.assertAvailableCapacity(4_096)).rejects.toBe(failure);
    expect(storageHooks.capacityCalls).toEqual([[root, 4_096]]);
  });

  it("requires authenticated route preparation before route-scoped access and refuses persisted route rebinding", async () => {
    const root = await newRoot();
    const store = createFilePeerClientStore(root);
    await expect(store.allocateOutboxSequence(scope)).rejects.toThrow(/bound to an authenticated route/u);
    await store.prepareRoute(route);
    const reopened = createFilePeerClientStore(root);
    await expect(reopened.prepareRoute({ ...route, routeId: "route.other" })).rejects.toThrow(/different tenant, route or device/u);
  });

  it("uses tuple identity for lookups and rejects mismatched local-device identities", async () => {
    const root = await newRoot();
    const store = createFilePeerClientStore(root);
    await store.prepareRoute(route);
    const sequence = await store.allocateOutboxSequence(scope);
    const entry = outboxEntry("tuple.message", sequence);
    await store.saveOutboxEntry(entry);
    await expect(store.loadOutboxEntry({ ...entry, recipientDeviceId: "device.other" })).resolves.toBeNull();
    await expect(store.loadOutboxEntry({ ...entry, senderDeviceId: "device.other" })).rejects.toThrow(/bound local device/u);

    const inbox: StoredInboxEntry = Object.freeze({
      ...scope,
      senderDeviceId: "device.remote",
      recipientDeviceId: route.deviceId,
      messageId: "tuple.inbox",
      version: PEER_CLIENT_STORE_RECORD_VERSION,
      sequence: await store.allocateInboxSequence(scope),
      senderPeerId: "peer.remote",
      envelope: opaqueEnvelope("cipher.inbox"),
      plaintext: "AQ==",
      decryptError: null,
      dispatch: "pending",
      deliveryAck: null,
      receivedAt: timestamp,
      updatedAt: timestamp
    });
    await store.saveInboxEntry(inbox);
    await expect(store.loadInboxEntry({ ...inbox, recipientDeviceId: "device.other" })).rejects.toThrow(/bound local device/u);
  });

  it("does not run capacity checks for read-only history queries", async () => {
    const root = await newRoot();
    const store = createFilePeerClientStore(root);
    await store.prepareRoute(route);
    expect(await store.listPeerHistoryPage(scope, { afterSequence: 0, limit: 20 })).toEqual({ items: [], nextAfterSequence: null });
    expect(storageHooks.capacityCalls).toEqual([]);
  });

  it("serializes all sequence lanes sharing one metadata document and preserves their high-water marks after restart", async () => {
    const root = await newRoot();
    const store = createFilePeerClientStore(root);
    await store.prepareRoute(route);
    let entered!: () => void;
    const firstWrite = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    storageHooks.beforeWrite = async (file) => {
      if (file.includes(`${path.sep}sequence${path.sep}`)) { storageHooks.beforeWrite = null; entered(); await held; }
    };
    const read = vi.spyOn(fs.promises, "readFile");
    const outbox = store.allocateOutboxSequence(scope);
    await firstWrite;
    const inbox = store.allocateInboxSequence(scope);
    const history = store.allocateHistorySequence(scope);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(read.mock.calls.filter(([file]) => String(file).includes(`${path.sep}sequence${path.sep}`))).toHaveLength(1);
    } finally {
      release();
    }
    expect(await Promise.all([outbox, inbox, history])).toEqual([1, 1, 1]);
    const reopened = createFilePeerClientStore(root);
    await reopened.prepareRoute(route);
    expect(await Promise.all([reopened.allocateOutboxSequence(scope), reopened.allocateInboxSequence(scope),
      reopened.allocateHistorySequence(scope)])).toEqual([2, 2, 2]);
  });

  it("refuses malformed or exhausted sequence metadata without overwriting or reusing a sequence", async () => {
    const root = await newRoot();
    const store = createFilePeerClientStore(root);
    await store.prepareRoute(route);
    expect(await store.allocateOutboxSequence(scope)).toBe(1);
    const directory = path.join(root, "peer-records", "sequence");
    const [name] = await readdir(directory);
    const file = path.join(directory, name!);
    for (const invalid of ["null", JSON.stringify({ outbox: -1 }), JSON.stringify({ inbox: "damaged" })]) {
      await writeFile(file, invalid);
      const count = storageHooks.writeAttempts;
      await expect(store.allocateOutboxSequence(scope)).rejects.toThrow(/sequence metadata is malformed/u);
      expect((await store.listPendingOutboxPage(scope, { afterSequence: 0, limit: 10 })).items).toEqual([]);
      expect(await readFile(file, "utf8")).toBe(invalid);
      expect(storageHooks.writeAttempts).toBe(count);
    }
    const exhausted = JSON.stringify({ outbox: Number.MAX_SAFE_INTEGER });
    await writeFile(file, exhausted);
    await expect(store.allocateOutboxSequence(scope)).rejects.toThrow(/sequence space is exhausted/u);
    expect(await readFile(file, "utf8")).toBe(exhausted);
  });

  it("recovers a regressed high-water mark from projections without reading historical bodies or reusing an occupied slot", async () => {
    const root = await newRoot();
    const store = createFilePeerClientStore(root);
    await store.prepareRoute(route);
    const entry = outboxEntry("retained.high-water", 513);
    await store.saveOutboxEntry(entry);
    const sequenceDirectory = path.join(root, "peer-records", "sequence");
    const [name] = await readdir(sequenceDirectory);
    const file = path.join(sequenceDirectory, name!);
    await writeFile(file, JSON.stringify({ outbox: 1 }));
    // Pages use existing projections even before the next startup repairs counts.
    expect((await store.listPendingOutboxPage(scope, { afterSequence: 0, limit: 10 })).items).toEqual([entry]);
    const reopened = createFilePeerClientStore(root);
    const read = fs.promises.readFile.bind(fs.promises);
    const readSpy = vi.spyOn(fs.promises, "readFile").mockImplementation((async (...args: Parameters<typeof fs.promises.readFile>) => {
      if (["outbox", "inbox", "history"].some((kind) => String(args[0]).includes(`${path.sep}peer-records${path.sep}${kind}${path.sep}`))) {
        throw new Error("Cold-start high-water recovery read a historical message body.");
      }
      return read(...args);
    }) as typeof fs.promises.readFile);
    await reopened.prepareRoute(route);
    readSpy.mockRestore();
    expect(await reopened.allocateOutboxSequence(scope)).toBe(514);
    const count = storageHooks.writeAttempts;
    await expect(reopened.saveOutboxEntry(outboxEntry("different.identity", 513))).rejects.toThrow(/already reserved for another/u);
    expect(storageHooks.writeAttempts).toBe(count);
    expect((await reopened.listPendingOutboxPage(scope, { afterSequence: 0, limit: 10 })).items).toEqual([entry]);
  });

  it("keeps a newly published record discoverable after interruption before save returns", async () => {
    const root = await newRoot();
    const store = createFilePeerClientStore(root);
    await store.prepareRoute(route);
    const entry = outboxEntry("published.before-interruption", 27);
    storageHooks.afterWrite = (file) => {
      if (file.includes(`${path.sep}peer-records${path.sep}outbox${path.sep}`)) {
        storageHooks.afterWrite = null;
        throw new Error("simulated interruption after durable record publication");
      }
    };
    await expect(store.saveOutboxEntry(entry)).rejects.toThrow(/after durable record/u);
    const reopened = createFilePeerClientStore(root);
    await reopened.prepareRoute(route);
    expect((await reopened.listPendingOutboxPage(scope, { afterSequence: 0, limit: 10 })).items).toEqual([entry]);
    expect(await reopened.allocateOutboxSequence(scope)).toBe(28);
    const terminal = Object.freeze({ ...entry, state: "conflict" as const });
    storageHooks.afterWrite = (file) => {
      if (file.includes(`${path.sep}peer-records${path.sep}outbox${path.sep}`)) {
        storageHooks.afterWrite = null;
        throw new Error("simulated interruption after terminal publication");
      }
    };
    await expect(reopened.saveOutboxEntry(terminal)).rejects.toThrow(/after terminal/u);
    const recovered = createFilePeerClientStore(root);
    await recovered.prepareRoute(route);
    expect((await recovered.listOutboxHistoryPage(scope, { afterSequence: 0, limit: 10 })).items).toEqual([terminal]);
    expect((await recovered.listPendingOutboxPage(scope, { afterSequence: 0, limit: 10 })).items).toEqual([]);
  });

  it("retains settled inbox deduplication when interrupted before pending-index cleanup", async () => {
    const root = await newRoot();
    const store = createFilePeerClientStore(root);
    await store.prepareRoute(route);
    const entry: StoredInboxEntry = Object.freeze({
      ...scope,
      senderDeviceId: "device.remote",
      recipientDeviceId: route.deviceId,
      messageId: "settled.inbox",
      version: PEER_CLIENT_STORE_RECORD_VERSION,
      sequence: await store.allocateInboxSequence(scope),
      senderPeerId: "peer.remote",
      envelope: opaqueEnvelope("cipher.settled.inbox"),
      plaintext: Buffer.from(JSON.stringify({ operationId: "operation.already-accepted" })).toString("base64"),
      decryptError: null,
      dispatch: "pending",
      deliveryAck: null,
      receivedAt: timestamp,
      updatedAt: timestamp
    });
    await store.saveInboxEntry(entry);
    const settled = Object.freeze({ ...entry, dispatch: "accepted_by_agent" as const });
    storageHooks.afterWrite = (file) => {
      if (file.includes(`${path.sep}peer-records${path.sep}inbox${path.sep}`)) {
        storageHooks.afterWrite = null;
        throw new Error("simulated interruption after inbox settlement");
      }
    };
    await expect(store.saveInboxEntry(settled)).rejects.toThrow(/after inbox settlement/u);
    const recovered = createFilePeerClientStore(root);
    await recovered.prepareRoute(route);
    expect(await recovered.loadInboxEntry(entry)).toEqual(settled);
    expect((await recovered.listInboxHistoryPage(scope, { afterSequence: 0, limit: 10 })).items).toEqual([settled]);
    expect((await recovered.listPendingInboxPage(scope, { afterSequence: 0, limit: 10 })).items).toEqual([]);
    expect((await recovered.listPendingDeliveryAckPage(scope, { afterSequence: 0, limit: 10 })).items).toEqual([settled]);
    await expect(recovered.saveInboxEntry(entry)).rejects.toThrow(/cannot return to pending/u);
  });

  it("keeps committed immutable history discoverable and does not duplicate it after interruption", async () => {
    const root = await newRoot();
    const store = createFilePeerClientStore(root);
    await store.prepareRoute(route);
    const evidence: StoredPeerHistoryEntry = Object.freeze({
      version: PEER_CLIENT_STORE_RECORD_VERSION,
      sequence: 23,
      evidenceId: "evidence.interrupted",
      ...scope,
      source: "legacy_gap",
      messageId: null,
      deviceId: null,
      formerPosition: null,
      formerGap: null,
      formerState: null,
      formerReceiptFacts: Object.freeze([]),
      legacyRecord: Object.freeze({ retained: true }),
      recordedAt: timestamp
    });
    storageHooks.afterWrite = (file) => {
      if (file.includes(`${path.sep}peer-records${path.sep}history${path.sep}`)) {
        storageHooks.afterWrite = null;
        throw new Error("simulated interruption after history publication");
      }
    };
    await expect(store.savePeerHistoryEntry(evidence)).rejects.toThrow(/after history publication/u);
    const recovered = createFilePeerClientStore(root);
    await recovered.prepareRoute(route);
    expect((await recovered.listPeerHistoryPage(scope, { afterSequence: 0, limit: 10 })).items).toEqual([evidence]);
    expect(await recovered.allocateHistorySequence(scope)).toBe(24);
    const count = storageHooks.writeAttempts;
    await recovered.savePeerHistoryEntry(evidence);
    expect(storageHooks.writeAttempts).toBe(count);
  });

  it("does not let a concurrent page remove a staged index before its record is published", async () => {
    const root = await newRoot();
    const store = createFilePeerClientStore(root);
    await store.prepareRoute(route);
    const entry = outboxEntry("staged.concurrent-page", 1);
    let entered!: () => void;
    const writingRecord = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    storageHooks.beforeWrite = async (file) => {
      if (file.includes(`${path.sep}peer-records${path.sep}outbox${path.sep}`)) {
        storageHooks.beforeWrite = null;
        entered();
        await held;
      }
    };
    const saving = store.saveOutboxEntry(entry);
    await writingRecord;
    let readCompleted = false;
    const reading = store.listPendingOutboxPage(scope, { afterSequence: 0, limit: 10 })
      .then((page) => { readCompleted = true; return page; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(readCompleted).toBe(false);
    } finally {
      release();
    }
    await saving;
    expect((await reading).items).toEqual([entry]);
  });

  it("enumerates only active pending buckets even when the sequence has large historical holes", async () => {
    const root = await newRoot();
    const store = createFilePeerClientStore(root);
    await store.prepareRoute(route);
    const entry = outboxEntry("sparse.pending", 256 * 10_000 + 1);
    await store.saveOutboxEntry(entry);
    const readDirectory = fs.promises.readdir.bind(fs.promises);
    const pageReads: string[] = [];
    vi.spyOn(fs.promises, "readdir").mockImplementation((async (...args: Parameters<typeof fs.promises.readdir>) => {
      const directory = String(args[0]);
      if (directory.includes(`${path.sep}outbox-pending${path.sep}`)) {
        pageReads.push(directory);
        const name = path.basename(directory);
        if (/^\d{10}$/u.test(name) && name !== "0000010000") throw new Error("Page visited a historical hole.");
      }
      return readDirectory(...args);
    }) as typeof fs.promises.readdir);
    expect((await store.listPendingOutboxPage(scope, { afterSequence: 0, limit: 1 })).items).toEqual([entry]);
    expect(pageReads).toHaveLength(2);
    await store.saveOutboxEntry({ ...entry, state: "conflict" });
    pageReads.length = 0;
    expect((await store.listPendingOutboxPage(scope, { afterSequence: 0, limit: 10 })).items).toEqual([]);
    expect(pageReads).toHaveLength(1);
  });

  it("retains malformed JSON byte for byte and retries capacity-refused legacy work with the original ciphertext", async () => {
    const brokenRoot = await newRoot();
    const brokenFile = await writeLegacy(brokenRoot, "outbox", "broken", {});
    const broken = " { invalid, unclosed source bytes";
    await writeFile(brokenFile, broken);
    const brokenStore = createFilePeerClientStore(brokenRoot);
    await expect(brokenStore.prepareRoute(route)).rejects.toThrow(/cannot be parsed/u);
    expect(await readFile(brokenFile, "utf8")).toBe(broken);
    const root = await newRoot();
    const raw = legacyOutbox("capacity.retained", "received", "cipher.capacity");
    const source = await writeLegacy(root, "outbox", "retained", raw);
    const original = await readFile(source, "utf8");
    const store = createFilePeerClientStore(root);
    const failure = Object.assign(new Error("synthetic free-space refusal"), { code: "private_storage_capacity" });
    storageHooks.capacityFailure = failure;
    await expect(store.prepareRoute(route)).rejects.toBe(failure);
    expect(await readFile(source, "utf8")).toBe(original);
    storageHooks.capacityFailure = null;
    await store.prepareRoute(route);
    const pending = (await store.listPendingOutboxPage(scope, { afterSequence: 0, limit: 10 })).items;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ messageId: raw.messageId, envelope: raw.envelope, state: "pending" });
  });

  it("does not rewrite identical outbox, metadata, or immutable history records", async () => {
    const root = await newRoot();
    const store = createFilePeerClientStore(root);
    await store.prepareRoute(route);
    const outSequence = await store.allocateOutboxSequence(scope);
    const entry = outboxEntry("no-op.entry", outSequence);
    await store.saveOutboxEntry(entry);
    const meta = Object.freeze({
      version: PEER_CLIENT_STORE_RECORD_VERSION,
      localBundle: null,
      peers: Object.freeze({}),
      bundleObservations: Object.freeze({})
    });
    await store.saveMeta(meta);
    const history: StoredPeerHistoryEntry = Object.freeze({
      version: PEER_CLIENT_STORE_RECORD_VERSION,
      sequence: await store.allocateHistorySequence(scope),
      evidenceId: "evidence.no-op",
      tenantId: scope.tenantId,
      routeId: scope.routeId,
      source: "legacy_gap",
      messageId: null,
      deviceId: null,
      formerPosition: null,
      formerGap: null,
      formerState: null,
      formerReceiptFacts: Object.freeze([]),
      legacyRecord: Object.freeze({ retained: true }),
      recordedAt: timestamp
    });
    await store.savePeerHistoryEntry(history);
    const count = storageHooks.writeAttempts;
    await store.saveOutboxEntry(entry);
    await store.saveMeta(meta);
    await store.savePeerHistoryEntry(history);
    expect(storageHooks.writeAttempts).toBe(count);
  });
});
