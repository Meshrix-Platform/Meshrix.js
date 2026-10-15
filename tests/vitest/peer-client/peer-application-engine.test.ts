import { afterEach, describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";

import type { StoredOutboxEntry } from "@meshrix/peer-client";
import {
  PEER_APPLICATION_PROTOCOL_VERSION,
  PEER_CLIENT_MAX_PLAINTEXT_BYTES,
  PeerApplicationEngine,
  peerApplicationOperationKey,
  peerApplicationRequestDigest,
  peerApplicationTransportMessageId,
  reversePeerApplicationAddress,
  samePeerApplicationAddress
} from "@meshrix/peer-client";
import type {
  AcpPermissionPrompt,
  AcpStopReason,
  PeerApplicationAddress,
  PeerApplicationAgentDirectory,
  PeerApplicationAgentExecutor,
  PeerApplicationDiscoveryRecord,
  PeerApplicationDiscoveryRecovery,
  PeerApplicationFragment,
  PeerApplicationFragmentSaveResult,
  PeerApplicationInbound,
  PeerApplicationJournal,
  PeerApplicationHandoffPlan,
  PeerApplicationOperationRecovery,
  PeerApplicationPeerPort,
  PeerApplicationRecord,
  PeerApplicationResultPart,
  PeerInboundOutcome
} from "@meshrix/peer-client";

const ADDRESS_AB: PeerApplicationAddress = Object.freeze({
  tenantId: "tenant.personal.1",
  routeId: "route.personal.1",
  localDeviceId: "device.alice",
  peerDeviceId: "device.bob"
});

function sleepTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await sleepTurn();
  }
}

class MemoryJournal implements PeerApplicationJournal {
  readonly operations = new Map<string, PeerApplicationRecord>();
  readonly resultParts = new Map<string, PeerApplicationResultPart>();
  readonly partialChunks = new Map<string, PeerApplicationResultPart>();
  readonly discoveries = new Map<string, PeerApplicationDiscoveryRecord>();
  readonly operationRecoveries = new Map<string, PeerApplicationOperationRecovery>();
  readonly discoveryRecoveries = new Map<string, PeerApplicationDiscoveryRecovery>();
  readonly handoffs = new Map<string, PeerApplicationHandoffPlan>();
  readonly fragments = new Map<string, { readonly header: PeerApplicationFragment; readonly parts: Map<number, string>; complete: boolean; applied: boolean }>();
  failResultPartIndex: number | null = null;
  failOperationWrites = 0;
  operationWriteCount = 0;
  listOperationsCalls = 0;
  getOperationCalls = 0;
  listResultPartsCalls = 0;
  getDiscoveryCalls = 0;
  listDiscoveriesCalls = 0;

  async getOperation(key: string) { this.getOperationCalls += 1; return this.operations.get(key) ?? null; }
  async listOperations() { this.listOperationsCalls += 1; return Object.freeze([...this.operations.values()]); }
  async findOperationKeysById(operationId: string) {
    return Object.freeze([...this.operations.values()].filter((record) => record.operationId === operationId).map((record) => record.key));
  }
  async listPendingOperationRecoveryPage(afterKey: string | null = null, limit = 32) {
    const keys = [...this.operationRecoveries.keys()].sort().filter((key) => key > (afterKey ?? ""));
    const selected = keys.slice(0, limit);
    const items = selected.flatMap((key) => {
      const item = this.operationRecoveries.get(key);
      return item ? [item] : [];
    });
    return Object.freeze({ items: Object.freeze(items), nextAfterKey: keys.length > selected.length ? selected[selected.length - 1] ?? null : null });
  }
  async savePendingOperationRecovery(record: PeerApplicationRecord) {
    const terminal = new Set(["completed", "refused", "stopped", "cancelled", "unknown", "failed"]).has(record.status);
    this.operationRecoveries.set(record.key, Object.freeze({
      key: record.key,
      role: record.role,
      operationId: record.operationId,
      originAddress: record.originAddress,
      routeAddress: record.routeAddress,
      requestDigest: record.requestDigest,
      cancelRequested: record.cancelRequested,
      terminal,
      terminalPrepared: record.terminalPrepared,
      executionPending: record.role === "receiver" && !record.terminalPrepared && !terminal,
      resultPartCount: record.resultPartCount,
      stateRevision: record.stateRevision,
      createdAt: record.createdAt
    }));
  }
  async clearPendingOperationRecovery(key: string, expectedStateRevision?: number) {
    const current = this.operationRecoveries.get(key);
    if (current && expectedStateRevision !== undefined && current.stateRevision !== expectedStateRevision) return false;
    this.operationRecoveries.delete(key);
    return true;
  }
  async saveOperation(record: PeerApplicationRecord) {
    if (this.failOperationWrites > 0) {
      this.failOperationWrites -= 1;
      throw new Error("injected operation write interruption");
    }
    this.operationWriteCount += 1;
    this.operations.set(record.key, record);
  }
  async getResultPart(operationKey: string, index: number) { return this.resultParts.get(`${operationKey}/${index}`) ?? null; }
  async listResultParts(operationKey: string) {
    this.listResultPartsCalls += 1;
    return Object.freeze([...this.resultParts.entries()]
      .filter(([key]) => key.startsWith(`${operationKey}/`))
      .map(([, part]) => part)
      .sort((left, right) => left.index - right.index));
  }
  async saveResultPart(operationKey: string, part: PeerApplicationResultPart) {
    if (this.failResultPartIndex === part.index) {
      this.failResultPartIndex = null;
      throw new Error("injected result-part write interruption");
    }
    const key = `${operationKey}/${part.index}`;
    const previous = this.resultParts.get(key);
    if (previous && previous.text !== part.text) throw new Error("result part conflict");
    this.resultParts.set(key, part);
  }
  async savePartialResultChunk(operationKey: string, index: number, text: string) {
    const key = `${operationKey}/${index}`;
    const previous = this.partialChunks.get(key);
    if (previous && previous.text !== text) throw new Error("partial result chunk conflict");
    this.partialChunks.set(key, Object.freeze({ index, text }));
  }
  async listPartialResultChunks(operationKey: string) {
    return Object.freeze([...this.partialChunks.entries()]
      .filter(([key]) => key.startsWith(`${operationKey}/`))
      .map(([, part]) => part)
      .sort((left, right) => left.index - right.index));
  }
  async clearPartialResultChunks(operationKey: string) {
    for (const key of this.partialChunks.keys()) if (key.startsWith(`${operationKey}/`)) this.partialChunks.delete(key);
  }
  async saveApplicationFragment(fragment: PeerApplicationFragment): Promise<PeerApplicationFragmentSaveResult> {
    const key = JSON.stringify([fragment.address.tenantId, fragment.address.routeId, fragment.address.localDeviceId,
      fragment.address.peerDeviceId, fragment.messageId]);
    let assembly = this.fragments.get(key);
    if (!assembly) {
      assembly = { header: fragment, parts: new Map(), complete: false, applied: false };
      this.fragments.set(key, assembly);
    } else if (assembly.header.messageKind !== fragment.messageKind || assembly.header.partCount !== fragment.partCount
      || assembly.header.totalBytes !== fragment.totalBytes) {
      return { status: "conflict", receivedParts: assembly.parts.size };
    }
    if (assembly.applied) return { status: "applied", receivedParts: fragment.partCount };
    const previous = assembly.parts.get(fragment.partIndex);
    if (previous !== undefined && previous !== fragment.data) return { status: "conflict", receivedParts: assembly.parts.size };
    assembly.parts.set(fragment.partIndex, fragment.data);
    const receivedBytes = [...assembly.parts.values()].reduce((sum, value) => sum + Buffer.from(value, "base64url").byteLength, 0);
    if (assembly.parts.size === fragment.partCount) {
      if (receivedBytes !== fragment.totalBytes) return { status: "conflict", receivedParts: assembly.parts.size };
      assembly.complete = true;
    }
    return { status: assembly.complete ? "complete" : "incomplete", receivedParts: assembly.parts.size };
  }
  async readApplicationFragmentMessage(address: PeerApplicationAddress, messageId: string): Promise<Uint8Array | null> {
    const key = JSON.stringify([address.tenantId, address.routeId, address.localDeviceId, address.peerDeviceId, messageId]);
    const assembly = this.fragments.get(key);
    if (!assembly?.complete || assembly.applied) return null;
    const chunks: Buffer[] = [];
    for (let index = 0; index < assembly.header.partCount; index += 1) {
      const part = assembly.parts.get(index);
      if (part === undefined) return null;
      chunks.push(Buffer.from(part, "base64url"));
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
  async markApplicationFragmentApplied(address: PeerApplicationAddress, messageId: string) {
    const key = JSON.stringify([address.tenantId, address.routeId, address.localDeviceId, address.peerDeviceId, messageId]);
    const assembly = this.fragments.get(key);
    if (!assembly?.complete) throw new Error("fragment assembly is incomplete");
    assembly.applied = true;
    assembly.parts.clear();
  }
  async getDiscovery(key: string) { this.getDiscoveryCalls += 1; return this.discoveries.get(key) ?? null; }
  async listDiscoveries() { this.listDiscoveriesCalls += 1; return Object.freeze([...this.discoveries.values()]); }
  async findLatestPendingDiscovery(address: PeerApplicationAddress) {
    const candidates = [...this.discoveryRecoveries.values()]
      .filter((recovery) => recovery.action === "request" && samePeerApplicationAddress(recovery.address, address))
      .flatMap((recovery) => {
        const record = this.discoveries.get(recovery.key);
        return record?.status === "pending" && record.requestId === recovery.requestId
          && samePeerApplicationAddress(record.address, address) ? [record] : [];
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return candidates[0] ?? null;
  }
  async listPendingDiscoveryRecoveryPage(afterKey: string | null = null, limit = 32) {
    const keys = [...this.discoveryRecoveries.keys()].sort().filter((key) => key > (afterKey ?? ""));
    const selected = keys.slice(0, limit);
    const items = selected.flatMap((key) => {
      const item = this.discoveryRecoveries.get(key);
      return item ? [item] : [];
    });
    return Object.freeze({ items: Object.freeze(items), nextAfterKey: keys.length > selected.length ? selected[selected.length - 1] ?? null : null });
  }
  async savePendingDiscoveryRecovery(record: Pick<PeerApplicationDiscoveryRecord, "key" | "address" | "requestId">, action: "request" | "response") {
    this.discoveryRecoveries.set(record.key, Object.freeze({ key: record.key, address: record.address, requestId: record.requestId, action }));
  }
  async clearPendingDiscoveryRecovery(key: string, expectedAction?: "request" | "response") {
    const current = this.discoveryRecoveries.get(key);
    if (current && expectedAction !== undefined && current.action !== expectedAction) return false;
    this.discoveryRecoveries.delete(key);
    return true;
  }
  async saveDiscovery(record: PeerApplicationDiscoveryRecord) { this.discoveries.set(record.key, record); }
  async listPendingHandoffPage(afterKey: string | null = null, limit = 32) {
    const keys = [...this.handoffs.keys()].sort().filter((key) => key > (afterKey ?? ""));
    const selected = keys.slice(0, limit);
    const items = selected.flatMap((key) => {
      const item = this.handoffs.get(key);
      return item ? [item] : [];
    });
    return Object.freeze({ items: Object.freeze(items), nextAfterKey: keys.length > selected.length ? selected[selected.length - 1] ?? null : null });
  }
  async getPendingHandoff(key: string) { return this.handoffs.get(key) ?? null; }
  async savePendingHandoff(plan: PeerApplicationHandoffPlan) {
    const previous = this.handoffs.get(plan.key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(plan)) throw new Error("handoff plan conflict");
    this.handoffs.set(plan.key, plan);
  }
  async clearPendingHandoff(key: string) { this.handoffs.delete(key); }
}

class LinkedPeerPort implements PeerApplicationPeerPort {
  handler: ((delivery: PeerApplicationInbound) => Promise<PeerInboundOutcome>) | null = null;
  remote: LinkedPeerPort | null = null;
  reachable = true;
  authority: "current" | "unavailable" | "revoked" = "current";
  readonly pendingInbound: PeerApplicationInbound[] = [];
  readonly dropKinds = new Set<string>();
  readonly sendStates = new Map<string, StoredOutboxEntry["state"]>();
  readonly pendingMessages = new Map<string, { readonly address: PeerApplicationAddress; readonly bytes: Uint8Array; readonly kind: string }>();
  readonly sent: { readonly address: PeerApplicationAddress; readonly bytes: Uint8Array; readonly messageId: string }[] = [];
  failNextSends = 0;
  sendFailures = 0;
  #position = 0;

  async resolvePeerAuthority(_address: PeerApplicationAddress) { return this.authority; }
  async isPeerReachable(_address: PeerApplicationAddress) { return this.reachable; }

  async sendMessage(address: PeerApplicationAddress, plaintext: Uint8Array, options: { readonly messageId: string }) {
    const bytes = Uint8Array.from(plaintext);
    this.sent.push(Object.freeze({ address, bytes, messageId: options.messageId }));
    if (this.failNextSends > 0) {
      this.failNextSends -= 1;
      this.sendFailures += 1;
      throw new Error("injected transient Peer enqueue failure");
    }
    this.sendStates.set(options.messageId, "pending");
    let received = false;
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { kind?: string };
    if (!this.dropKinds.has(parsed.kind ?? "") && this.remote) {
      const delivery: PeerApplicationInbound = {
        address: reversePeerApplicationAddress(address),
        message: {
          messageId: options.messageId,
          position: ++this.#position,
          senderPeerId: "peer.test.sender",
          senderDeviceId: address.localDeviceId,
          plaintext: bytes,
          receivedAt: new Date().toISOString()
        }
      };
      if (!this.remote.handler) {
        this.remote.pendingInbound.push(delivery);
        received = true;
      } else {
        const outcome = await this.remote.handler(delivery);
        if (typeof outcome === "object" && outcome.kind === "deferred") this.remote.pendingInbound.push(delivery);
        received = true;
      }
    }
    const state: StoredOutboxEntry["state"] = received ? "delivered" : "pending";
    this.sendStates.set(options.messageId, state);
    if (received) this.pendingMessages.delete(options.messageId);
    else this.pendingMessages.set(options.messageId, { address, bytes, kind: parsed.kind ?? "" });
    const now = new Date().toISOString();
    return Object.freeze({
      version: 1,
      messageId: options.messageId,
      tenantId: address.tenantId,
      routeId: address.routeId,
      senderDeviceId: address.localDeviceId,
      recipientDeviceId: address.peerDeviceId,
      peerId: "peer.test.receiver",
      state,
      sequence: this.#position || 1,
      envelope: {} as StoredOutboxEntry["envelope"],
      attempts: 1,
      lastForwarded: null,
      deliveryAck: null,
      lastError: null,
      createdAt: now,
      updatedAt: now
    }) as unknown as StoredOutboxEntry;
  }

  async getSendState(_address: PeerApplicationAddress, messageId: string) {
    return this.sendStates.get(messageId) ?? null;
  }

  onInboundMessage(handler: (delivery: PeerApplicationInbound) => Promise<PeerInboundOutcome>) {
    this.handler = handler;
    return () => { this.handler = null; };
  }

  async retryPendingInbound(address: PeerApplicationAddress) {
    if (!this.handler) return;
    const pending = this.pendingInbound.splice(0);
    for (const delivery of pending) {
      if (!samePeerApplicationAddress(delivery.address, address)) {
        this.pendingInbound.push(delivery);
        continue;
      }
      const outcome = await this.handler(delivery);
      if (typeof outcome === "object" && outcome.kind === "deferred") this.pendingInbound.push(delivery);
    }
  }

  /** Simulates PeerClient's exact-ciphertext retry before host journal resume. */
  async retryPendingMessages() {
    if (!this.remote?.handler) return;
    for (const [messageId, pending] of this.pendingMessages) {
      if (this.dropKinds.has(pending.kind)) continue;
      const delivery: PeerApplicationInbound = {
        address: reversePeerApplicationAddress(pending.address),
        message: {
          messageId,
          position: ++this.#position,
          senderPeerId: "peer.test.sender",
          senderDeviceId: pending.address.localDeviceId,
          plaintext: pending.bytes,
          receivedAt: new Date().toISOString()
        }
      };
      const outcome = await this.remote.handler(delivery);
      if (typeof outcome === "object" && outcome.kind === "deferred") {
        this.remote.pendingInbound.push(delivery);
        continue;
      }
      this.sendStates.set(messageId, "delivered");
      this.pendingMessages.delete(messageId);
    }
  }

}

class DeferredAgent implements PeerApplicationAgentExecutor {
  readonly summary = Object.freeze({ id: "agent.local", displayName: "Local Agent", description: null, enabled: true });
  handlers: Parameters<PeerApplicationAgentExecutor["start"]>[1] | null = null;
  starts = 0;
  resolve: ((result: { readonly stopReason: AcpStopReason; readonly text: string }) => void) | null = null;

  start(_input: { readonly operationId: string; readonly prompt: string }, handlers: Parameters<PeerApplicationAgentExecutor["start"]>[1]) {
    this.starts += 1;
    this.handlers = handlers;
    const result = new Promise<{ readonly stopReason: AcpStopReason; readonly text: string }>((resolve) => { this.resolve = resolve; });
    void handlers.beforePrompt();
    return Object.freeze({ result, cancel: async () => {} });
  }
}

class CompletingAgent implements PeerApplicationAgentExecutor {
  readonly summary = Object.freeze({ id: "agent.local", displayName: "Local Agent", description: null, enabled: true });
  starts = 0;
  readonly prompts: string[] = [];
  readonly text: string;
  readonly progress: string | null;

  constructor(text: string, progress: string | null = null) {
    this.text = text;
    this.progress = progress;
  }

  start(input: { readonly operationId: string; readonly prompt: string }, handlers: Parameters<PeerApplicationAgentExecutor["start"]>[1]) {
    this.starts += 1;
    this.prompts.push(input.prompt);
    const result = (async () => {
      await handlers.beforePrompt();
      if (this.progress !== null) await handlers.onProgress({ kind: "message", text: this.progress });
      return { stopReason: "end_turn" as const, text: this.text };
    })();
    return Object.freeze({ result, cancel: async () => {} });
  }
}

class QueueAgent implements PeerApplicationAgentExecutor {
  readonly summary = Object.freeze({ id: "agent.local", displayName: "Local Agent", description: null, enabled: true });
  readonly executions: { readonly operationId: string; readonly handlers: Parameters<PeerApplicationAgentExecutor["start"]>[1]; readonly resolve: (result: { readonly stopReason: AcpStopReason; readonly text: string }) => void }[] = [];

  start(input: { readonly operationId: string; readonly prompt: string }, handlers: Parameters<PeerApplicationAgentExecutor["start"]>[1]) {
    let resolve: (result: { readonly stopReason: AcpStopReason; readonly text: string }) => void = () => {};
    const beforePrompt = handlers.beforePrompt();
    const result = beforePrompt.then(() => new Promise<{ readonly stopReason: AcpStopReason; readonly text: string }>((complete) => { resolve = complete; }));
    this.executions.push({ operationId: input.operationId, handlers, resolve: (value) => { void beforePrompt.then(() => resolve(value)); } });
    return Object.freeze({ result, cancel: async () => {} });
  }
}

function agentDirectory(agent: PeerApplicationAgentExecutor | null): PeerApplicationAgentDirectory {
  return Object.freeze({
    async list() { return Object.freeze(agent ? [agent.summary] : []); },
    get(id: string) { return id === agent?.summary.id ? agent : null; }
  });
}

const engines: PeerApplicationEngine[] = [];
afterEach(() => {
  while (engines.length > 0) engines.pop()?.dispose();
});

function linkedEngines(options: {
  readonly agentA?: PeerApplicationAgentExecutor | null;
  readonly agentB?: PeerApplicationAgentExecutor | null;
  readonly journalA?: MemoryJournal;
  readonly journalB?: MemoryJournal;
} = {}) {
  const peerA = new LinkedPeerPort();
  const peerB = new LinkedPeerPort();
  peerA.remote = peerB;
  peerB.remote = peerA;
  const journalA = options.journalA ?? new MemoryJournal();
  const journalB = options.journalB ?? new MemoryJournal();
  const engineA = new PeerApplicationEngine({ peer: peerA, journal: journalA, agents: agentDirectory(options.agentA ?? null) });
  const engineB = new PeerApplicationEngine({ peer: peerB, journal: journalB, agents: agentDirectory(options.agentB ?? null) });
  engines.push(engineA, engineB);
  return { peerA, peerB, journalA, journalB, engineA, engineB };
}

describe("Peer application execution journal", () => {
  it("fragments the full 32,000-byte escaped and multibyte prompt without changing its paid dispatch", async () => {
    const agent = new CompletingAgent("fragmented prompt completed");
    const { engineA, engineB, peerA, peerB } = linkedEngines({ agentB: agent });
    const prompt = ('"\\\n'.repeat(5_000) + "界".repeat(5_666) + "ab");
    expect(Buffer.byteLength(prompt, "utf8")).toBe(32_000);

    await engineA.submit({
      address: ADDRESS_AB,
      operationId: "op.fragmented.prompt",
      targetAgentId: "agent.local",
      prompt
    });
    await waitFor(async () => (await engineB.getOperation("op.fragmented.prompt"))?.status === "completed",
      "the complete fragmented request did not finish");

    const fragments = peerA.sent.filter((entry) => {
      const envelope = JSON.parse(new TextDecoder().decode(entry.bytes)) as { kind?: string };
      return envelope.kind === "application_fragment";
    });
    expect(fragments.length).toBeGreaterThan(1);
    for (const fragment of fragments) {
      expect(fragment.bytes.byteLength).toBeLessThanOrEqual(PEER_CLIENT_MAX_PLAINTEXT_BYTES);
      expect(JSON.parse(new TextDecoder().decode(fragment.bytes))).toMatchObject({ kind: "application_fragment" });
    }
    expect(new Set(fragments.map((entry) => entry.messageId)).size).toBe(fragments.length);
    expect(agent.starts).toBe(1);
    expect(agent.prompts).toEqual([prompt]);
    await waitFor(async () => (await engineA.getOperation("op.fragmented.prompt"))?.resultText === "fragmented prompt completed",
      "the full result did not return to the caller");
    expect((await engineA.getOperation("op.fragmented.prompt"))?.resultText).toBe("fragmented prompt completed");
    for (const [index, fragment] of fragments.entries()) {
      const outcome = await peerB.handler?.({
        address: reversePeerApplicationAddress(ADDRESS_AB),
        message: {
          messageId: fragment.messageId,
          position: index + 1,
          senderPeerId: "peer.test.sender",
          senderDeviceId: ADDRESS_AB.localDeviceId,
          plaintext: fragment.bytes,
          receivedAt: new Date().toISOString()
        }
      });
      expect(outcome).toBe("accepted_by_agent");
    }
    expect(agent.starts).toBe(1);
  });

  it("fragments a complete catalog without imposing a new catalog-size limit", async () => {
    const summaries = Object.freeze(Array.from({ length: 128 }, (_, index) => Object.freeze({
      id: `agent.catalog.${index.toString().padStart(3, "0")}`,
      displayName: `Catalog agent ${index}`,
      description: `可检索的完整 Agent 说明 ${index} `.repeat(64),
      enabled: index % 2 === 0
    })));
    const peerA = new LinkedPeerPort();
    const peerB = new LinkedPeerPort();
    peerA.remote = peerB;
    peerB.remote = peerA;
    const journalA = new MemoryJournal();
    const journalB = new MemoryJournal();
    const emptyDirectory = agentDirectory(null);
    const catalogDirectory: PeerApplicationAgentDirectory = Object.freeze({
      async list() { return summaries; },
      get() { return null; }
    });
    const engineA = new PeerApplicationEngine({ peer: peerA, journal: journalA, agents: emptyDirectory });
    const engineB = new PeerApplicationEngine({ peer: peerB, journal: journalB, agents: catalogDirectory });
    engines.push(engineA, engineB);

    await engineA.discoverAgents(ADDRESS_AB, { requestId: "discovery.catalog.large" });
    await waitFor(async () => (await engineA.getDiscovery(ADDRESS_AB, "discovery.catalog.large"))?.status === "completed",
      "the full catalog response was not reassembled");

    const responseFragments = peerB.sent.filter((entry) => {
      const envelope = JSON.parse(new TextDecoder().decode(entry.bytes)) as { kind?: string; messageKind?: string };
      return envelope.kind === "application_fragment" && envelope.messageKind === "catalog_response";
    });
    expect(responseFragments.length).toBeGreaterThan(1);
    expect(responseFragments.every((entry) => entry.bytes.byteLength <= PEER_CLIENT_MAX_PLAINTEXT_BYTES)).toBe(true);
    expect((await engineA.getDiscovery(ADDRESS_AB, "discovery.catalog.large"))?.agents).toEqual(summaries);
  });

  it("bounds admission, keeps the 35th request pending, and admits it after capacity frees", async () => {
    const agent = new QueueAgent();
    const { engineA, engineB, journalB, peerB } = linkedEngines({ agentB: agent });
    const submissions = Array.from({ length: 35 }, (_, index) => engineA.submit({
      address: ADDRESS_AB,
      operationId: `op.capacity.${index.toString().padStart(2, "0")}`,
      targetAgentId: "agent.local",
      prompt: `controlled request ${index}`
    }));
    await Promise.all(submissions);
    await waitFor(async () => {
      const operations = await journalB.listOperations();
      return operations.length === 34 && operations.filter((record) => record.promptReserved).length === 2 && agent.executions.length === 2;
    },
      "receiver did not apply the 2 active + 32 waiting capacity");
    expect(peerB.pendingInbound).toHaveLength(1);
    expect(await engineB.getOperation("op.capacity.34")).toBeNull();

    agent.executions[0].resolve({ stopReason: "end_turn", text: "first done" });
    await waitFor(async () => (await engineB.getOperation("op.capacity.34")) !== null,
      "pending request was not admitted when an execution completed");
    await waitFor(() => agent.executions.length === 3, "freed execution slot was not scheduled");
    expect(peerB.pendingInbound).toHaveLength(0);
    expect(agent.executions.length).toBe(3);
    expect((await journalB.listOperations()).filter((row) => row.role === "receiver")).toHaveLength(35);
  });

  it("refuses a queued operation if its exact paired route is revoked before ACP starts", async () => {
    const agent = new QueueAgent();
    const { engineA, engineB, journalB, peerB } = linkedEngines({ agentB: agent });
    await Promise.all(Array.from({ length: 3 }, (_, index) => engineA.submit({
      address: ADDRESS_AB,
      operationId: `op.revoke-queued.${index}`,
      targetAgentId: "agent.local",
      prompt: `controlled request ${index}`
    })));
    await waitFor(async () => {
      const operations = await journalB.listOperations();
      return operations.length === 3 && operations.filter((record) => record.promptReserved).length === 2 && agent.executions.length === 2;
    }, "the first two executions did not occupy the bounded slots while the third queued");
    const queued = (await journalB.listOperations()).find((record) => !record.promptReserved);
    if (!queued) throw new Error("the queued operation is missing");

    peerB.authority = "revoked";
    agent.executions[0].resolve({ stopReason: "end_turn", text: "first done" });
    await waitFor(async () => (await engineB.getOperation(queued.operationId))?.status === "refused",
      "revoked queued request did not reach its retained refusal result");
    expect(agent.executions.map((execution) => execution.operationId)).not.toContain(queued.operationId);
    const revoked = await engineB.getOperation(queued.operationId);
    expect(revoked?.promptReserved).toBe(false);
    expect(revoked?.lastError).toBe("peer_route_revoked");
    agent.executions[1].resolve({ stopReason: "end_turn", text: "second done" });
  });

  it("defers before acceptance during authority uncertainty and accepts the same request when authority returns", async () => {
    const agent = new QueueAgent();
    const { engineA, engineB, journalB, peerA, peerB } = linkedEngines({ agentB: agent });
    peerB.authority = "unavailable";
    await engineA.submit({
      address: ADDRESS_AB,
      operationId: "op.authority-restored",
      targetAgentId: "agent.local",
      prompt: "resume after authority returns"
    });
    await waitFor(() => peerB.pendingInbound.length === 1, "authority outage did not retain the original inbound envelope");
    expect(await engineB.getOperation("op.authority-restored")).toBeNull();
    expect(await journalB.listOperations()).toHaveLength(0);
    expect(agent.executions).toHaveLength(0);
    expect(peerB.sent).toHaveLength(0);
    const originalRequestIds = peerA.sent.filter((item) => {
      const envelope = JSON.parse(new TextDecoder().decode(item.bytes)) as { kind?: string; operationId?: string };
      return envelope.kind === "operation_request" && envelope.operationId === "op.authority-restored";
    }).map((item) => item.messageId);
    expect(originalRequestIds).toHaveLength(1);

    peerB.authority = "current";
    await engineB.resume();
    await waitFor(() => agent.executions.length === 1, "authority restoration did not admit and run the same request");
    await waitFor(async () => (await engineB.getOperation("op.authority-restored"))?.promptReserved === true,
      "the restored request was not durably admitted before its prompt");
    expect(agent.executions[0].operationId).toBe("op.authority-restored");
    expect(peerA.sent.filter((item) => {
      const envelope = JSON.parse(new TextDecoder().decode(item.bytes)) as { kind?: string; operationId?: string };
      return envelope.kind === "operation_request" && envelope.operationId === "op.authority-restored";
    }).map((item) => item.messageId)).toEqual(originalRequestIds);
    agent.executions[0].resolve({ stopReason: "end_turn", text: "done" });
    await waitFor(async () => (await engineB.getOperation("op.authority-restored"))?.status === "completed",
      "the restored request did not complete");
  });

  it("rejects a revoked route before creating a receiver operation or starting ACP", async () => {
    const agent = new QueueAgent();
    const { engineA, engineB, journalB, peerA, peerB } = linkedEngines({ agentB: agent });
    peerB.authority = "revoked";
    await engineA.submit({
      address: ADDRESS_AB,
      operationId: "op.authority-revoked",
      targetAgentId: "agent.local",
      prompt: "must not be admitted"
    });

    await waitFor(() => peerA.sent.some((item) => {
      const envelope = JSON.parse(new TextDecoder().decode(item.bytes)) as { kind?: string; operationId?: string };
      return envelope.kind === "operation_request" && envelope.operationId === "op.authority-revoked";
    }), "caller did not send the request for the revoked-route check");
    await sleepTurn();
    expect(await engineB.getOperation("op.authority-revoked")).toBeNull();
    expect(await journalB.listOperations()).toHaveLength(0);
    expect(agent.executions).toHaveLength(0);
    expect(peerB.pendingInbound).toHaveLength(0);
    expect(peerB.sent).toHaveLength(0);
  });

  it("serializes concurrent ACP permission prompts without losing either local decision", async () => {
    const agent = new DeferredAgent();
    const { engineA, engineB } = linkedEngines({ agentB: agent });
    const operationId = "op.permission.concurrent";
    await engineA.submit({ address: ADDRESS_AB, operationId, targetAgentId: "agent.local", prompt: "do two guarded actions" });
    await waitFor(() => agent.handlers !== null, "ACP execution did not start");
    await waitFor(async () => (await engineB.getOperation(operationId))?.promptReserved === true, "ACP prompt was not durably reserved");
    const handlers = agent.handlers;
    if (!handlers) throw new Error("missing ACP execution handlers");

    const permission = (toolCallId: string): AcpPermissionPrompt => Object.freeze({
      sessionId: "session.local",
      toolCall: Object.freeze({
        toolCallId,
        title: "Run command",
        name: "run_command",
        kind: "execute",
        status: "pending",
        content: Object.freeze([]),
        rawInput: Object.freeze({ command: "controlled command" }),
        locations: Object.freeze([])
      }),
      options: Object.freeze([{ optionId: "allow-once", name: "Allow once", kind: "allow_once" as const }])
    });
    const firstDecision = handlers.requestPermission(permission("tool.first"));
    const secondDecision = handlers.requestPermission(permission("tool.second"));
    await waitFor(async () => (await engineB.getOperation(operationId))?.permissionHistory.length === 1, "first permission was not persisted");
    const first = await engineB.getOperation(operationId);
    if (!first?.permission) throw new Error("first permission is missing");
    const resolvedFirst = await engineB.resolvePermission({
      operationId,
      permissionId: first.permission.id,
      resolution: { outcome: "selected", optionId: "allow-once" }
    });
    expect(await firstDecision).toEqual({ outcome: "selected", optionId: "allow-once" });
    await waitFor(async () => (await engineB.getOperation(operationId))?.permissionHistory.length === 2, "second permission was not persisted");
    const second = await engineB.getOperation(operationId);
    expect(second?.permission?.request.toolCall.toolCallId).toBe("tool.second");
    if (!second?.permission) throw new Error("second permission is missing");
    const resolvedSecond = await engineB.resolvePermission({
      operationId,
      permissionId: second.permission.id,
      resolution: { outcome: "selected", optionId: "allow-once" }
    });
    expect(await secondDecision).toEqual({ outcome: "selected", optionId: "allow-once" });
    agent.resolve?.({ stopReason: "end_turn", text: "done" });
    await waitFor(async () => (await engineB.getOperation(operationId))?.status === "completed", "operation did not complete after permissions");
    const finished = await engineB.getOperation(operationId);
    expect(resolvedFirst.permissionHistory).toHaveLength(1);
    expect(resolvedSecond.permissionHistory).toHaveLength(2);
    expect(finished?.permissionHistory.map((row) => [row.request.toolCall.toolCallId, row.status, row.selectedOptionId]))
      .toEqual([["tool.first", "resolved", "allow-once"], ["tool.second", "resolved", "allow-once"]]);
    expect(agent.starts).toBe(1);
  });

  it("recovers the exact prepared final result after an interrupted result-part write", async () => {
    const journalB = new MemoryJournal();
    journalB.failResultPartIndex = 1;
    const finalText = "x".repeat(40_000);
    const agent = new CompletingAgent(finalText, "partial text");
    const { engineA, engineB, journalB: savedJournal } = linkedEngines({ agentB: agent, journalB });
    const operationId = "op.result.write-window";
    await engineA.submit({ address: ADDRESS_AB, operationId, targetAgentId: "agent.local", prompt: "return controlled result" });
    await waitFor(async () => (await engineB.getOperation(operationId))?.status === "completed", "prepared result was not recovered");
    const record = await engineB.getOperation(operationId);
    expect(record?.terminalPrepared).toBe(false);
    expect(record?.resultText).toBe(finalText);
    expect(record?.resultPartCount).toBe(2);
    expect((await savedJournal.listResultParts(record?.key ?? "")).map((part) => part.text).join(" ")).toContain(finalText.slice(0, 32));
    expect((await savedJournal.listResultParts(record?.key ?? "")).map((part) => part.text).join("")).toBe(finalText);
    expect(agent.starts).toBe(1);
  });

  it("keeps an uncertain prior-generation prompt unknown and never starts it again", async () => {
    const agent = new DeferredAgent();
    const sharedJournal = new MemoryJournal();
    const initial = linkedEngines({ agentB: agent, journalB: sharedJournal });
    const operationId = "op.restart.unknown";
    await initial.engineA.submit({ address: ADDRESS_AB, operationId, targetAgentId: "agent.local", prompt: "may already have run" });
    await waitFor(async () => (await initial.engineB.getOperation(operationId))?.promptReserved === true, "prompt reservation was not persisted");
    await agent.handlers?.onProgress({ kind: "message", text: "saved progress" });
    initial.engineB.dispose();

    const resumedPort = new LinkedPeerPort();
    resumedPort.remote = initial.peerA;
    initial.peerA.remote = resumedPort;
    const resumed = new PeerApplicationEngine({ peer: resumedPort, journal: sharedJournal, agents: agentDirectory(agent) });
    engines.push(resumed);
    await resumed.resume();
    const record = await resumed.getOperation(operationId);
    expect(record?.status).toBe("unknown");
    expect(record?.lastError).toBe("execution_outcome_unknown");
    expect(record?.resultText).toBe("saved progress");
    expect(agent.starts).toBe(1);
  });

  it("keeps a healthy same-process prompt running across resume without starting it again", async () => {
    const agent = new QueueAgent();
    const { engineA, engineB } = linkedEngines({ agentB: agent });
    const operationId = "op.resume.same-process-running";
    const originalResult = "the complete result from the original pending prompt";
    await engineA.submit({ address: ADDRESS_AB, operationId, targetAgentId: "agent.local", prompt: "remain pending across resume" });
    await waitFor(() => agent.executions.length === 1, "the controlled ACP prompt did not start");
    await waitFor(async () => (await engineB.getOperation(operationId))?.promptReserved === true,
      "the original prompt was not durably reserved");

    await engineB.resume();

    const duringResume = await engineB.getOperation(operationId);
    expect(duringResume?.status).toBe("running");
    expect(duringResume?.promptReserved).toBe(true);
    expect(agent.executions).toHaveLength(1);
    agent.executions[0].resolve({ stopReason: "end_turn", text: originalResult });

    await waitFor(async () => (await engineB.getOperation(operationId))?.status === "completed",
      "the original prompt did not complete after resume");
    const completed = await engineB.getOperation(operationId);
    expect(completed?.resultText).toBe(originalResult);
    expect(agent.executions).toHaveLength(1);
  });

  it("wraps recovery pages after an early transient failure while the last page succeeds", async () => {
    class RecoveryFaultJournal extends MemoryJournal {
      targetKey: string | null = null;
      targetReadFailures = 0;
      successfulTargetReads = 0;

      override async getOperation(key: string) {
        if (key === this.targetKey) {
          if (this.targetReadFailures > 0) {
            this.targetReadFailures -= 1;
            throw new Error("injected transient recovery source read failure");
          }
          this.successfulTargetReads += 1;
        }
        return super.getOperation(key);
      }
    }

    const agent = new QueueAgent();
    const journal = new RecoveryFaultJournal();
    const { engineA, engineB, peerB } = linkedEngines({ agentB: agent, journalB: journal });
    const operationId = "op.000.recovery.page-wrap";
    await engineA.submit({ address: ADDRESS_AB, operationId, targetAgentId: "agent.local", prompt: "keep the paid prompt running" });
    await waitFor(() => agent.executions.length === 1, "the controlled ACP prompt did not start");
    const targetRecord = await engineB.getOperation(operationId);
    expect(targetRecord?.promptReserved).toBe(true);
    const targetKey = targetRecord?.key;
    expect(targetKey).toBeTruthy();

    const routeAddress = reversePeerApplicationAddress(ADDRESS_AB);
    const syntheticKeys: string[] = [];
    const createdAt = new Date().toISOString();
    for (let index = 0; index < 32; index += 1) {
      const key = `z.recovery.page.${index.toString().padStart(2, "0")}`;
      syntheticKeys.push(key);
      journal.operationRecoveries.set(key, Object.freeze({
        key,
        role: "caller",
        operationId: `op.synthetic.recovery.${index}`,
        originAddress: ADDRESS_AB,
        routeAddress,
        requestDigest: `digest.${index}`,
        cancelRequested: false,
        terminal: false,
        terminalPrepared: false,
        executionPending: false,
        resultPartCount: null,
        stateRevision: 1,
        createdAt
      }));
    }
    expect(journal.operationRecoveries.size).toBeGreaterThan(32);

    journal.targetKey = targetKey as string;
    journal.targetReadFailures = 2;
    for (const key of syntheticKeys) {
      const messageId = peerApplicationTransportMessageId(routeAddress.localDeviceId, key, "request");
      // Keep these valid recovery responsibilities alive through the initial
      // eager resume. The timer's bounded page pass will see them as pending.
      peerB.sendStates.set(messageId, "conflict");
    }

    // The initial recovery attempt fails on the first page. The timer pass
    // fails there again, but must still finish later pages before wrapping.
    await engineB.resume();
    for (const key of syntheticKeys) {
      const messageId = peerApplicationTransportMessageId(routeAddress.localDeviceId, key, "request");
      peerB.sendStates.set(messageId, "pending");
    }

    await waitFor(() => journal.successfulTargetReads > 0,
      "the early failed recovery page was not retried after wrapping", 8_000);
    expect(syntheticKeys.every((key) => !journal.operationRecoveries.has(key))).toBe(true);
    expect(agent.executions).toHaveLength(1);

    agent.executions[0].resolve({ stopReason: "end_turn", text: "one original execution" });
    await waitFor(async () => (await engineB.getOperation(operationId))?.status === "completed",
      "the original prompt did not complete after page recovery");
    expect(agent.executions).toHaveLength(1);
  }, 12_000);

  it("retains a new durable failure raised while a recovery page is running", async () => {
    let releasePage: () => void = () => {};
    let signalPageStarted: () => void = () => {};
    const pageGate = new Promise<void>((resolve) => { releasePage = resolve; });
    const pageStarted = new Promise<void>((resolve) => { signalPageStarted = resolve; });
    class PausingRecoveryJournal extends MemoryJournal {
      pauseNextOperationRecoveryPage = false;
      operationRecoveryPageCalls = 0;

      override async listPendingOperationRecoveryPage(afterKey: string | null = null, limit = 32) {
        const page = await super.listPendingOperationRecoveryPage(afterKey, limit);
        this.operationRecoveryPageCalls += 1;
        if (this.pauseNextOperationRecoveryPage) {
          this.pauseNextOperationRecoveryPage = false;
          signalPageStarted();
          await pageGate;
        }
        return page;
      }
    }

    const agent = new QueueAgent();
    const journal = new PausingRecoveryJournal();
    const { engineA, engineB, peerB } = linkedEngines({ agentB: agent, journalB: journal });
    const operationId = "op.recovery.new-failure-during-page";
    await engineA.submit({ address: ADDRESS_AB, operationId, targetAgentId: "agent.local", prompt: "keep one paid prompt running" });
    await waitFor(() => agent.executions.length === 1, "the controlled ACP prompt did not start");

    peerB.failNextSends = 1;
    await engineB.cancel(operationId);
    await waitFor(() => peerB.sendFailures === 1, "the initial durable state handoff did not fail");

    journal.pauseNextOperationRecoveryPage = true;
    await pageStarted;
    peerB.failNextSends = 1;
    // A repeated cancellation is a no-op. Complete the original execution to
    // create a real new durable result handoff while recovery is paused.
    agent.executions[0].resolve({ stopReason: "end_turn", text: "one original execution" });
    await waitFor(() => peerB.sendFailures === 2, "the concurrent durable result handoff did not fail");
    await sleepTurn();
    releasePage();

    await waitFor(() => journal.operationRecoveryPageCalls >= 2,
      "the failure raised during the first recovery pass did not cause a later pass", 5_000);
    expect(agent.executions).toHaveLength(1);

    await waitFor(async () => (await engineA.getOperation(operationId))?.status === "completed",
      "the original result did not reach the caller after retry recovery");
    expect(agent.executions).toHaveLength(1);
  }, 10_000);

  it("recovers a completed result after the caller missed the first response", async () => {
    const agent = new CompletingAgent("one execution, one durable result");
    const { engineA, engineB, peerB } = linkedEngines({ agentB: agent });
    peerB.dropKinds.add("operation_result_part");
    peerB.dropKinds.add("operation_result_end");
    const operationId = "op.result.reconnect";
    await engineA.submit({ address: ADDRESS_AB, operationId, targetAgentId: "agent.local", prompt: "complete exactly once" });
    await waitFor(async () => (await engineB.getOperation(operationId))?.status === "completed", "receiver did not finish");
    expect((await engineA.getOperation(operationId))?.status).not.toBe("completed");

    peerB.dropKinds.clear();
    await peerB.retryPendingMessages();
    await engineB.resume();
    await waitFor(async () => (await engineA.getOperation(operationId))?.status === "completed", "caller did not recover stored result");
    expect((await engineA.getOperation(operationId))?.resultText).toBe("one execution, one durable result");
    expect(agent.starts).toBe(1);
  });

  it("uses durable transport state to retire completed recovery without reading settled operation or catalog bodies", async () => {
    const agent = new CompletingAgent("a result whose body is already in the durable outbox");
    const { engineA, engineB, peerB, journalB } = linkedEngines({ agentB: agent });
    await engineA.submit({
      address: ADDRESS_AB,
      operationId: "op.resume.pending-only",
      targetAgentId: "agent.local",
      prompt: "complete once"
    });
    await waitFor(async () => (await engineA.getOperation("op.resume.pending-only"))?.status === "completed",
      "caller did not durably receive the original result");
    await engineA.discoverAgents(ADDRESS_AB, { requestId: "discovery.resume.pending-only" });
    await waitFor(async () => (await engineA.getDiscovery(ADDRESS_AB, "discovery.resume.pending-only"))?.status === "completed",
      "caller did not durably receive the original catalog");
    expect(agent.starts).toBe(1);

    const terminal = await engineB.getOperation("op.resume.pending-only");
    const catalog = await engineB.getDiscovery(ADDRESS_AB, "discovery.resume.pending-only");
    if (!terminal || !catalog || terminal.resultPartCount === null) throw new Error("completed recovery sources are missing");
    // Recreate the two precise crash windows: all fixed outbox IDs were
    // committed, but the application recovery markers were not yet removed.
    journalB.operationRecoveries.set(terminal.key, Object.freeze({
      key: terminal.key,
      role: terminal.role,
      operationId: terminal.operationId,
      originAddress: terminal.originAddress,
      routeAddress: terminal.routeAddress,
      requestDigest: terminal.requestDigest,
      cancelRequested: terminal.cancelRequested,
      terminal: true,
      terminalPrepared: false,
      executionPending: false,
      resultPartCount: terminal.resultPartCount,
      stateRevision: terminal.stateRevision,
      createdAt: terminal.createdAt
    }));
    journalB.discoveryRecoveries.set(catalog.key, Object.freeze({
      key: catalog.key,
      address: catalog.address,
      requestId: catalog.requestId,
      action: "response"
    }));

    journalB.getOperationCalls = 0;
    journalB.listOperationsCalls = 0;
    journalB.listResultPartsCalls = 0;
    journalB.getDiscoveryCalls = 0;
    journalB.listDiscoveriesCalls = 0;
    await engineB.resume();

    expect(journalB.getOperationCalls).toBe(0);
    expect(journalB.listOperationsCalls).toBe(0);
    expect(journalB.listResultPartsCalls).toBe(0);
    expect(journalB.getDiscoveryCalls).toBe(0);
    expect(journalB.listDiscoveriesCalls).toBe(0);
    expect(journalB.operationRecoveries.has(terminal.key)).toBe(false);
    expect(journalB.discoveryRecoveries.has(catalog.key)).toBe(false);
    expect(agent.starts).toBe(1);
    expect((await journalB.listOperations()).some((row) => row.key === terminal.key)).toBe(true);
    expect((await journalB.listDiscoveries()).some((row) => row.key === catalog.key)).toBe(true);
  });

  it("reconstructs an interrupted old state handoff from its fixed ID after the operation advances", async () => {
    const agent = new QueueAgent();
    const { engineA, engineB, peerB, journalB } = linkedEngines({ agentB: agent });
    peerB.dropKinds.add("operation_state");
    await engineA.submit({
      address: ADDRESS_AB,
      operationId: "op.resume.state-plan",
      targetAgentId: "agent.local",
      prompt: "keep one prompt running"
    });
    await waitFor(() => agent.executions.length === 1, "receiver ACP execution did not start");
    await waitFor(async () => (await engineB.getOperation("op.resume.state-plan"))?.promptReserved === true,
      "receiver prompt reservation was not durable");
    await engineA.cancel("op.resume.state-plan");
    await waitFor(async () => (await engineB.getOperation("op.resume.state-plan"))?.status === "cancel_requested",
      "the receiver did not persist the newer cancellation state");

    const current = await engineB.getOperation("op.resume.state-plan");
    if (!current || current.stateRevision < 2) throw new Error("the operation did not advance beyond its accepted state");
    const logicalId = "state:1:accepted";
    const messageId = peerApplicationTransportMessageId(current.routeAddress.localDeviceId, current.key, logicalId);
    peerB.sendStates.delete(messageId);
    journalB.handoffs.set(messageId, Object.freeze({
      key: messageId,
      sourceKind: "operation",
      sourceKey: current.key,
      address: current.routeAddress,
      logicalId,
      messageKind: "operation_state",
      messageId,
      partCount: 0
    }));
    peerB.sent.splice(0);

    await engineB.resume();

    const replay = peerB.sent.find((item) => item.messageId === messageId);
    if (!replay) throw new Error("the missing old state handoff was not retried");
    expect(JSON.parse(new TextDecoder().decode(replay.bytes))).toMatchObject({
      kind: "operation_state",
      operationId: "op.resume.state-plan",
      status: "accepted",
      stateRevision: 1,
      deliveryId: logicalId
    });
    expect(journalB.handoffs.has(messageId)).toBe(false);
    expect((await engineB.getOperation("op.resume.state-plan"))?.status).toBe("cancel_requested");
    expect(agent.executions).toHaveLength(1);
  });

  it("binds a caller operation id to one immutable route and request across serial retries", async () => {
    const { engineA, peerA, journalA } = linkedEngines();
    peerA.dropKinds.add("operation_request");
    const input = {
      address: ADDRESS_AB,
      operationId: "op.caller.binding.serial",
      callerAgentId: "agent.requester",
      targetAgentId: "agent.remote",
      prompt: "original prompt"
    };
    const first = await engineA.submit(input);

    await expect(engineA.submit({ ...input, prompt: "changed prompt" }))
      .rejects.toMatchObject({ code: "peer_client_state" });
    await expect(engineA.submit({ ...input, targetAgentId: "agent.other" }))
      .rejects.toMatchObject({ code: "peer_client_state" });
    await expect(engineA.submit({ ...input, callerAgentId: "agent.other" }))
      .rejects.toMatchObject({ code: "peer_client_state" });
    await expect(engineA.submit({
      ...input,
      address: Object.freeze({ ...ADDRESS_AB, peerDeviceId: "device.carol" })
    })).rejects.toMatchObject({ code: "peer_client_state" });

    const retry = await engineA.submit(input);
    expect(retry.key).toBe(first.key);
    expect(retry.requestDigest).toBe(first.requestDigest);
    expect((await journalA.listOperations()).filter((record) => record.role === "caller")).toHaveLength(1);
    await waitFor(() => peerA.sent.filter((row) => {
      const envelope = JSON.parse(new TextDecoder().decode(row.bytes)) as { kind?: string; operationId?: string };
      return envelope.kind === "operation_request" && envelope.operationId === input.operationId;
    }).length === 1, "the immutable operation request was not sent once");
    expect(peerA.sent.filter((row) => {
      const envelope = JSON.parse(new TextDecoder().decode(row.bytes)) as { kind?: string; operationId?: string };
      return envelope.kind === "operation_request" && envelope.operationId === input.operationId;
    })).toHaveLength(1);
  });

  it("serializes concurrent caller submissions across destinations and keeps inbound IDs route-scoped", async () => {
    const peer = new LinkedPeerPort();
    const journal = new MemoryJournal();
    const agent = new CompletingAgent("remote result");
    const engine = new PeerApplicationEngine({ peer, journal, agents: agentDirectory(agent) });
    engines.push(engine);
    const operationId = "op.caller.binding.concurrent";
    const [first, second] = await Promise.allSettled([
      engine.submit({ address: ADDRESS_AB, operationId, targetAgentId: "agent.remote", prompt: "to first device" }),
      engine.submit({
        address: Object.freeze({ ...ADDRESS_AB, peerDeviceId: "device.carol" }),
        operationId,
        targetAgentId: "agent.remote",
        prompt: "to second device"
      })
    ]);
    expect([first.status, second.status].filter((status) => status === "fulfilled")).toHaveLength(1);
    const rejected = first.status === "rejected" ? first : second;
    expect(rejected.reason).toMatchObject({ code: "peer_client_state" });
    expect((await journal.listOperations()).filter((record) => record.role === "caller" && record.operationId === operationId)).toHaveLength(1);

    const sharedRemoteId = "op.same.remote.id";
    const receive = async (routeId: string, senderDeviceId: string, prompt: string, messageId: string): Promise<void> => {
      const inboundAddress: PeerApplicationAddress = Object.freeze({
        tenantId: "tenant.remote",
        routeId,
        localDeviceId: "device.receiver",
        peerDeviceId: senderDeviceId
      });
      const originAddress = reversePeerApplicationAddress(inboundAddress);
      const digest = peerApplicationRequestDigest({
        address: originAddress,
        callerAgentId: null,
        targetAgentId: "agent.local",
        prompt
      });
      const envelope = {
        version: PEER_APPLICATION_PROTOCOL_VERSION,
        kind: "operation_request",
        operationId: sharedRemoteId,
        originAddress,
        callerAgentId: null,
        targetAgentId: "agent.local",
        prompt,
        requestDigest: digest,
        deliveryId: "request"
      };
      const outcome = await peer.handler?.({
        address: inboundAddress,
        message: {
          messageId,
          position: 1,
          senderPeerId: `peer.${senderDeviceId}`,
          senderDeviceId,
          plaintext: new TextEncoder().encode(JSON.stringify(envelope)),
          receivedAt: new Date().toISOString()
        }
      });
      expect(outcome).toBe("accepted_by_agent");
    };
    await receive("route.remote.one", "device.remote.one", "remote one", "msg.remote.one");
    await receive("route.remote.two", "device.remote.two", "remote two", "msg.remote.two");

    const receivers = (await journal.listOperations()).filter((record) => record.role === "receiver" && record.operationId === sharedRemoteId);
    expect(receivers).toHaveLength(2);
    expect(new Set(receivers.map((record) => record.key)).size).toBe(2);
    expect(new Set(receivers.map((record) => record.originAddress.routeId))).toEqual(new Set(["route.remote.one", "route.remote.two"]));

    const localCaller = await engine.submit({ address: ADDRESS_AB, operationId: sharedRemoteId, targetAgentId: "agent.remote", prompt: "the local caller binding" });
    expect(localCaller.role).toBe("caller");
    expect((await engine.getOperation(sharedRemoteId))?.key).toBe(localCaller.key);
    expect((await journal.listOperations()).filter((record) => record.operationId === sharedRemoteId)).toHaveLength(3);
  });

  it("refuses known-offline new work before creating a journal record", async () => {
    const peer = new LinkedPeerPort();
    peer.reachable = false;
    const journal = new MemoryJournal();
    const engine = new PeerApplicationEngine({ peer, journal, agents: agentDirectory(null) });
    engines.push(engine);
    await expect(engine.submit({ address: ADDRESS_AB, operationId: "op.offline.refused", targetAgentId: "agent.local", prompt: "not accepted" }))
      .rejects.toThrow("was not accepted");
    expect(await journal.listOperations()).toHaveLength(0);

    peer.reachable = true;
    const accepted = await engine.submit({
      address: ADDRESS_AB,
      operationId: "op.offline.refused",
      targetAgentId: "agent.local",
      prompt: "submit after peer presence returns"
    });
    expect(accepted.status).toBe("delivery_pending");
    await waitFor(() => peer.sent.length === 1, "the explicit post-reconnect submission was not sent");
    expect(await journal.listOperations()).toHaveLength(1);
    expect(peer.sent.map((entry) => entry.messageId)).toHaveLength(1);
  });

  it("retries a durable caller handoff after transient enqueue failure without changing identity or paid dispatch", async () => {
    const agent = new CompletingAgent("one durable dispatch");
    const { engineA, engineB, peerA } = linkedEngines({ agentB: agent });
    peerA.failNextSends = 1;
    const operationId = "op.recovery.retry-after-enqueue-failure";
    const accepted = await engineA.submit({
      address: ADDRESS_AB,
      operationId,
      targetAgentId: "agent.local",
      prompt: "dispatch after the local relay enqueue recovers"
    });
    expect(accepted.status).toBe("delivery_pending");
    await waitFor(async () => (await engineA.getOperation(operationId))?.status === "completed",
      "the failed durable caller handoff was not retried");

    const requestId = peerApplicationTransportMessageId(ADDRESS_AB.localDeviceId, accepted.key, "request");
    const attempts = peerA.sent.filter((entry) => entry.messageId === requestId);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(attempts.map((entry) => entry.messageId)).size).toBe(1);
    expect(agent.starts).toBe(1);
    expect((await engineB.getOperation(operationId))?.resultText).toBe("one durable dispatch");
  });

  it("keeps a prepublished recovery marker until its operation record commits", async () => {
    let markerPublishedResolve: () => void = () => {};
    let releaseOperationWrite: () => void = () => {};
    let recoveryPageReadResolve: () => void = () => {};
    const markerPublished = new Promise<void>((resolve) => { markerPublishedResolve = resolve; });
    const operationWriteAllowed = new Promise<void>((resolve) => { releaseOperationWrite = resolve; });
    const recoveryPageRead = new Promise<void>((resolve) => { recoveryPageReadResolve = resolve; });
    class CommitGatedJournal extends MemoryJournal {
      holdOperationWrite = true;

      override async savePendingOperationRecovery(record: PeerApplicationRecord) {
        await super.savePendingOperationRecovery(record);
        markerPublishedResolve();
      }

      override async saveOperation(record: PeerApplicationRecord) {
        if (this.holdOperationWrite) await operationWriteAllowed;
        await super.saveOperation(record);
      }

      override async listPendingOperationRecoveryPage(afterKey: string | null = null, limit = 32) {
        const page = await super.listPendingOperationRecoveryPage(afterKey, limit);
        if (page.items.length > 0) recoveryPageReadResolve();
        return page;
      }
    }
    const peer = new LinkedPeerPort();
    const journal = new CommitGatedJournal();
    const engine = new PeerApplicationEngine({ peer, journal, agents: agentDirectory(null) });
    engines.push(engine);

    const submission = engine.submit({
      address: ADDRESS_AB,
      operationId: "op.marker-before-record",
      targetAgentId: "agent.local",
      prompt: "commit the source before recovering it"
    });
    await markerPublished;
    const recovery = engine.resume();
    await recoveryPageRead;
    await sleepTurn();
    expect(journal.getOperationCalls).toBe(0);

    journal.holdOperationWrite = false;
    releaseOperationWrite();
    await submission;
    await recovery;
    await waitFor(() => peer.sent.length > 0, "committed caller operation was not handed to Peer");
    expect(await engine.getOperation("op.marker-before-record")).not.toBeNull();
  });
});
