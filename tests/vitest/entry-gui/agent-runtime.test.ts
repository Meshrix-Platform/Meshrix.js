import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@meshrix/foundation/storage/private-storage-capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meshrix/foundation/storage/private-storage-capacity")>();
  return {
    ...actual,
    assertPrivateStorageCapacity: vi.fn(actual.assertPrivateStorageCapacity)
  };
});

import { assertPrivateStorageCapacity } from "@meshrix/foundation/storage/private-storage-capacity";

import { AcpSubprocessExecutor } from "../../../apps/entry-gui/src/main/agent/acp-executor.ts";
import { FilePeerApplicationJournal } from "../../../apps/entry-gui/src/main/agent/journal.ts";
import {
  PeerApplicationEngine,
  reversePeerApplicationAddress
} from "@meshrix/peer-client";
import type {
  PeerApplicationAddress,
  PeerApplicationAgentDirectory,
  PeerApplicationInbound,
  PeerApplicationPeerPort,
  PeerApplicationFragment,
  PeerInboundOutcome,
  StoredOutboxEntry
} from "@meshrix/peer-client";

const ADDRESS_AB: PeerApplicationAddress = Object.freeze({
  tenantId: "tenant.synthetic",
  routeId: "route.synthetic",
  localDeviceId: "device.alice",
  peerDeviceId: "device.bob"
});

const SYNTHETIC_AGENT = String.raw`
const fs = require("node:fs");
const mode = process.argv[2];
const marker = process.argv[3];
let input = "";
let promptRequestId = null;
const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const update = (text) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "synthetic-session",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }
  }
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const newline = input.indexOf("\n");
    if (newline < 0) break;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      write({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (request.method === "session/new") {
      write({ jsonrpc: "2.0", id: request.id, result: { sessionId: "synthetic-session" } });
    } else if (request.method === "session/prompt") {
      promptRequestId = request.id;
      fs.appendFileSync(marker, "prompt\npid:" + process.pid + "\n");
      if (mode === "tail") {
        process.stdout.write([
          update("first chunk "),
          update("second chunk"),
          { jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } }
        ].map(JSON.stringify).join("\n") + "\n");
      } else if (mode === "permission") {
        write({
          jsonrpc: "2.0",
          id: "synthetic-permission",
          method: "session/request_permission",
          params: {
            sessionId: "synthetic-session",
            toolCall: {
              toolCallId: "tool.synthetic",
              title: "Run command",
              name: "execute",
              kind: "execute",
              status: "pending",
              content: [{ type: "content", content: { type: "text", text: "Run a controlled command" } }],
              rawInput: { command: "synthetic command" },
              locations: [{ path: "/tmp/synthetic-target", line: 7 }]
            },
            options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }]
          }
        });
      } else {
        const bytes = JSON.stringify(update("durable partial chunk")) + "\n";
        process.stdout.write(bytes);
      }
    } else if (request.id === "synthetic-permission" && request.result?.outcome?.outcome === "selected") {
      process.stdout.write([
        update("permission granted"),
        { jsonrpc: "2.0", id: promptRequestId, result: { stopReason: "end_turn" } }
      ].map(JSON.stringify).join("\n") + "\n");
    }
  }
});
`;

class LinkedPeerPort implements PeerApplicationPeerPort {
  handler: ((delivery: PeerApplicationInbound) => Promise<PeerInboundOutcome>) | null = null;
  remote: LinkedPeerPort | null = null;
  position = 0;
  readonly states = new Map<string, StoredOutboxEntry["state"]>();

  async resolvePeerAuthority(): Promise<"current"> {
    return "current";
  }

  async isPeerReachable(): Promise<boolean> {
    return this.remote !== null;
  }

  async sendMessage(address: PeerApplicationAddress, plaintext: Uint8Array, options: { readonly messageId: string }) {
    const now = new Date().toISOString();
    const remote = this.remote;
    let state: StoredOutboxEntry["state"] = "pending";
    if (remote?.handler) {
      await remote.handler({
        address: reversePeerApplicationAddress(address),
        message: {
          messageId: options.messageId,
          position: ++this.position,
          senderPeerId: `peer:${address.localDeviceId}`,
          senderDeviceId: address.localDeviceId,
          plaintext: Uint8Array.from(plaintext),
          receivedAt: now
        }
      });
      state = "delivered";
    }
    this.states.set(options.messageId, state);
    return Object.freeze({
      version: 1,
      messageId: options.messageId,
      tenantId: address.tenantId,
      routeId: address.routeId,
      senderDeviceId: address.localDeviceId,
      recipientDeviceId: address.peerDeviceId,
      peerId: `peer:${address.peerDeviceId}`,
      state,
      sequence: this.position || 1,
      envelope: {} as StoredOutboxEntry["envelope"],
      attempts: 1,
      lastForwarded: null,
      deliveryAck: null,
      lastError: null,
      createdAt: now,
      updatedAt: now
    }) as unknown as StoredOutboxEntry;
  }

  async getSendState(_address: PeerApplicationAddress, messageId: string): Promise<StoredOutboxEntry["state"] | null> {
    return this.states.get(messageId) ?? null;
  }

  onInboundMessage(handler: (delivery: PeerApplicationInbound) => Promise<PeerInboundOutcome>): () => void {
    this.handler = handler;
    return () => { this.handler = null; };
  }

  async retryPendingInbound(): Promise<void> {}
}

const directories: string[] = [];
const engines: PeerApplicationEngine[] = [];

afterEach(async () => {
  while (engines.length > 0) engines.pop()?.dispose();
  await new Promise((resolve) => setTimeout(resolve, 25));
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

async function waitFor(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(mode: "tail" | "interrupt" | "permission") {
  const root = await mkdtemp(path.join(tmpdir(), "meshrix-acp-runtime-"));
  directories.push(root);
  const scriptPath = path.join(root, "synthetic-acp-agent.cjs");
  const markerPath = path.join(root, "prompt-count.txt");
  await writeFile(scriptPath, SYNTHETIC_AGENT, { mode: 0o600 });
  await writeFile(markerPath, "", { mode: 0o600 });
  const definition = Object.freeze({
    id: "agent.synthetic",
    displayName: "Synthetic ACP agent",
    description: null,
    command: process.execPath,
    args: Object.freeze([scriptPath, mode, markerPath]),
    cwd: root,
    environment: Object.freeze({}),
    permissionPolicy: "ask" as const,
    enabled: true
  });
  const executor = new AcpSubprocessExecutor(definition, { async resolve() { return null; } });
  const agents: PeerApplicationAgentDirectory = Object.freeze({
    async list() { return Object.freeze([executor.summary]); },
    get(id) { return id === executor.summary.id ? executor : null; }
  });
  const peerA = new LinkedPeerPort();
  const peerB = new LinkedPeerPort();
  peerA.remote = peerB;
  peerB.remote = peerA;
  const journalA = new FilePeerApplicationJournal(path.join(root, "caller-journal"));
  const journalB = new FilePeerApplicationJournal(path.join(root, "receiver-journal"));
  const engineA = new PeerApplicationEngine({ peer: peerA, journal: journalA, agents: { async list() { return Object.freeze([]); }, get() { return null; } } });
  const engineB = new PeerApplicationEngine({ peer: peerB, journal: journalB, agents });
  engines.push(engineA, engineB);
  return { root, markerPath, peerA, peerB, journalB, engineA, engineB, agents, executor };
}

describe("production ACP subprocess execution", () => {
  it("recovers application-fragment bytes after restart and keeps duplicate/conflicting parts deterministic", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meshrix-peer-fragments-"));
    directories.push(root);
    const journalDir = path.join(root, "journal");
    const first = new FilePeerApplicationJournal(journalDir);
    const bytes = Buffer.from('{"kind":"operation_request","prompt":"quotes \\\" and 界"}', "utf8");
    const midpoint = Math.floor(bytes.byteLength / 2);
    const makeFragment = (partIndex: number, data: Buffer): PeerApplicationFragment => Object.freeze({
      address: ADDRESS_AB,
      messageId: "logical.request.1",
      messageKind: "operation_request",
      partIndex,
      partCount: 2,
      totalBytes: bytes.byteLength,
      data: data.toString("base64url")
    });
    const left = makeFragment(0, bytes.subarray(0, midpoint));
    const right = makeFragment(1, bytes.subarray(midpoint));

    expect(await first.saveApplicationFragment(left)).toMatchObject({ status: "incomplete", receivedParts: 1 });
    expect(await first.saveApplicationFragment(left)).toMatchObject({ status: "incomplete", receivedParts: 1 });

    const resumed = new FilePeerApplicationJournal(journalDir);
    expect(await resumed.readApplicationFragmentMessage(ADDRESS_AB, "logical.request.1")).toBeNull();
    expect(await resumed.saveApplicationFragment(right)).toMatchObject({ status: "complete", receivedParts: 2 });
    expect(await resumed.saveApplicationFragment(right)).toMatchObject({ status: "complete", receivedParts: 2 });
    expect(Buffer.from((await resumed.readApplicationFragmentMessage(ADDRESS_AB, "logical.request.1")) ?? []).equals(bytes)).toBe(true);
    expect(await resumed.saveApplicationFragment(makeFragment(1, Buffer.from("conflict")))).toMatchObject({ status: "conflict" });
    expect(await resumed.saveApplicationFragment(Object.freeze({ ...right, messageKind: "catalog_response" }))).toMatchObject({ status: "conflict" });
    await resumed.markApplicationFragmentApplied(ADDRESS_AB, "logical.request.1");
    expect(await resumed.readApplicationFragmentMessage(ADDRESS_AB, "logical.request.1")).toBeNull();
    const [assemblyDir] = await readdir(path.join(journalDir, "application-fragments"));
    await expect(readdir(path.join(journalDir, "application-fragments", assemblyDir!, "parts"))).rejects.toMatchObject({ code: "ENOENT" });
    const afterAppliedRestart = new FilePeerApplicationJournal(journalDir);
    expect(await afterAppliedRestart.saveApplicationFragment(right)).toMatchObject({ status: "applied", receivedParts: 2 });
    expect(await afterAppliedRestart.readApplicationFragmentMessage(ADDRESS_AB, "logical.request.1")).toBeNull();
  });

  it("finds the latest exact-route pending discovery without reading retained discovery history", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meshrix-pending-discovery-"));
    directories.push(root);
    const journal = new FilePeerApplicationJournal(path.join(root, "journal"));
    const otherAddress: PeerApplicationAddress = Object.freeze({ ...ADDRESS_AB, peerDeviceId: "device.other" });
    const makeRecord = (
      key: string,
      address: PeerApplicationAddress,
      requestId: string,
      status: "pending" | "completed",
      updatedAt: string
    ) => Object.freeze({
      version: 1 as const,
      key,
      address,
      requestId,
      status,
      agents: Object.freeze([]),
      lastError: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt
    });
    const older = makeRecord("discovery.older", ADDRESS_AB, "request.older", "pending", "2026-01-01T00:00:01.000Z");
    const latest = makeRecord("discovery.latest", ADDRESS_AB, "request.latest", "pending", "2026-01-01T00:00:02.000Z");
    const completed = makeRecord("discovery.completed", ADDRESS_AB, "request.completed", "completed", "2026-01-01T00:00:03.000Z");
    const otherRoute = makeRecord("discovery.other-route", otherAddress, "request.other", "pending", "2026-01-01T00:00:04.000Z");
    for (const record of [older, latest, completed, otherRoute]) {
      await journal.saveDiscovery(record);
      await journal.savePendingDiscoveryRecovery(record, record.status === "pending" ? "request" : "response");
    }
    const listHistory = vi.spyOn(journal, "listDiscoveries");

    expect((await journal.findLatestPendingDiscovery(ADDRESS_AB))?.requestId).toBe("request.latest");
    expect(listHistory).not.toHaveBeenCalled();
  });

  it("backpressures a fragment write before it consumes the reserve and preserves prior parts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meshrix-peer-fragment-capacity-"));
    directories.push(root);
    const journal = new FilePeerApplicationJournal(path.join(root, "journal"));
    const bytes = Buffer.from("ab");
    const makeFragment = (partIndex: number, data: Buffer): PeerApplicationFragment => Object.freeze({
      address: ADDRESS_AB,
      messageId: "logical.capacity.1",
      messageKind: "catalog_response",
      partIndex,
      partCount: 2,
      totalBytes: bytes.byteLength,
      data: data.toString("base64url")
    });
    const first = makeFragment(0, bytes.subarray(0, 1));
    const second = makeFragment(1, bytes.subarray(1));
    expect(await journal.saveApplicationFragment(first)).toMatchObject({ status: "incomplete", receivedParts: 1 });

    vi.mocked(assertPrivateStorageCapacity).mockRejectedValueOnce(
      Object.assign(new Error("synthetic private storage is full"), { code: "private_storage_capacity" })
    );
    expect(await journal.saveApplicationFragment(second)).toMatchObject({ status: "backpressured", receivedParts: 1 });
    expect(await journal.saveApplicationFragment(first)).toMatchObject({ status: "incomplete", receivedParts: 1 });

    expect(await journal.saveApplicationFragment(second)).toMatchObject({ status: "complete", receivedParts: 2 });
    expect(Buffer.from((await journal.readApplicationFragmentMessage(ADDRESS_AB, "logical.capacity.1")) ?? []).equals(bytes)).toBe(true);
  });

  it("retains every queued update before the prompt stop response", async () => {
    const state = await fixture("tail");
    const operationId = "op.synthetic.tail";
    await state.engineA.submit({
      address: ADDRESS_AB,
      operationId,
      targetAgentId: "agent.synthetic",
      prompt: "complete the synthetic request"
    });
    await waitFor(async () => (await state.engineB.getOperation(operationId))?.status === "completed", "ACP subprocess did not complete");

    const record = await state.engineB.getOperation(operationId);
    expect(record?.resultText).toBe("first chunk second chunk");
    expect((await readFile(state.markerPath, "utf8")).trim().split("\n").filter((line) => line === "prompt")).toHaveLength(1);
  });

  it("persists ACP permission input and file locations for the explicit local decision", async () => {
    const state = await fixture("permission");
    const operationId = "op.synthetic.permission";
    await state.engineA.submit({
      address: ADDRESS_AB,
      operationId,
      targetAgentId: "agent.synthetic",
      prompt: "request one controlled permission"
    });
    await waitFor(async () => (await state.engineB.getOperation(operationId))?.permission?.status === "pending",
      "ACP subprocess did not persist its permission request");

    const pending = await state.engineB.getOperation(operationId);
    expect(pending?.permission?.request.toolCall.rawInput).toEqual({ command: "synthetic command" });
    expect(pending?.permission?.request.toolCall.locations).toEqual([{ path: "/tmp/synthetic-target", line: 7 }]);
    if (!pending?.permission) throw new Error("The expected ACP permission record is missing.");
    await state.engineB.resolvePermission({
      operationId,
      permissionId: pending.permission.id,
      resolution: { outcome: "selected", optionId: "allow-once" }
    });
    await waitFor(async () => (await state.engineB.getOperation(operationId))?.status === "completed",
      "ACP subprocess did not resume after permission resolution");
    expect((await state.engineB.getOperation(operationId))?.resultText).toBe("permission granted");
  });

  it("preserves partial text after process interruption and never replays the reserved prompt", async () => {
    const state = await fixture("interrupt");
    const operationId = "op.synthetic.interrupt";
    await state.engineA.submit({
      address: ADDRESS_AB,
      operationId,
      targetAgentId: "agent.synthetic",
      prompt: "interrupt after the first synthetic chunk"
    });
    await waitFor(async () => {
      const record = (await state.journalB.listOperations()).find((item) => item.operationId === operationId);
      return record !== undefined && (await state.journalB.listPartialResultChunks(record.key)).length === 1;
    }, "ACP progress chunk was not durably recorded before interruption");
    const marker = await readFile(state.markerPath, "utf8");
    const pid = Number(marker.split("\n").find((line) => line.startsWith("pid:"))?.slice(4));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(pid).not.toBe(process.pid);
    process.kill(pid);
    await waitFor(async () => (await state.engineB.getOperation(operationId))?.status === "unknown", "interrupted ACP result was not classified as unknown");

    const record = await state.engineB.getOperation(operationId);
    expect(record?.resultText).toBe("durable partial chunk");
    expect(record?.promptReserved).toBe(true);
    expect((await readFile(state.markerPath, "utf8")).trim().split("\n").filter((line) => line === "prompt")).toHaveLength(1);

    state.engineB.dispose();
    const replacementPeer = new LinkedPeerPort();
    replacementPeer.remote = state.peerA;
    state.peerA.remote = replacementPeer;
    const replacementEngine = new PeerApplicationEngine({
      peer: replacementPeer,
      journal: state.journalB,
      agents: state.agents
    });
    engines.push(replacementEngine);
    await replacementEngine.resume();

    expect((await replacementEngine.getOperation(operationId))?.resultText).toBe("durable partial chunk");
    expect((await readFile(state.markerPath, "utf8")).trim().split("\n").filter((line) => line === "prompt")).toHaveLength(1);
    const callerRecord = await state.engineA.getOperation(operationId);
    expect(callerRecord?.resultText).toBe("durable partial chunk");
  });
});
