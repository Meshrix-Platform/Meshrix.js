import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createOperationProofSubstrate } from "../../../../packages/foundation/src/proof/proof-substrate/index.ts";

type FixtureEvent = Record<string, any> & { kind: string };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function candidate(dataRoot: string, peerUrl: string, mode: string, risk = "safe_write") {
  const script = fileURLToPath(new URL("./platform-durable-intent-child.mjs", import.meta.url));
  const child = spawn(globalThis.process.execPath, ["--conditions=source", script, dataRoot, peerUrl, mode, risk], {
    cwd: path.resolve(fileURLToPath(new URL("../../../../", import.meta.url))),
    stdio: ["pipe", "pipe", "pipe"]
  });
  const events: FixtureEvent[] = [];
  const waiters: Array<{ kind: string; resolve: (event: FixtureEvent) => void; reject: (error: Error) => void }> = [];
  const stdout = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  stdout.on("line", (line) => {
    let event: FixtureEvent;
    try { event = JSON.parse(line) as FixtureEvent; } catch { return; }
    const index = waiters.findIndex((waiter) => waiter.kind === event.kind);
    if (index >= 0) waiters.splice(index, 1)[0].resolve(event);
    else events.push(event);
  });
  child.once("exit", (code, signal) => {
    for (const waiter of waiters.splice(0)) {
      waiter.reject(new Error(`Synthetic platform candidate exited before ${waiter.kind} (code=${String(code)}, signal=${String(signal)}).`));
    }
  });
  const waitFor = (kind: string): Promise<FixtureEvent> => {
    const index = events.findIndex((event) => event.kind === kind);
    if (index >= 0) return Promise.resolve(events.splice(index, 1)[0]);
    return new Promise((resolve, reject) => waiters.push({ kind, resolve, reject }));
  };
  const send = (message: Record<string, unknown>) => child.stdin!.write(`${JSON.stringify(message)}\n`);
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    waitFor,
    send,
    exit,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      send({ type: "close" });
      await waitFor("closed");
      await exit;
    },
    async crash() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit;
    }
  };
}

async function controlledPeer(counterPath: string) {
  let nextCallGate: ReturnType<typeof deferred> | null = null;
  let nextDiscoveryGate: ReturnType<typeof deferred> | null = null;
  const callGates = new Set<ReturnType<typeof deferred>>();
  let observedCalls = 0;
  let observedDiscoveries = 0;
  const calledNames: string[] = [];
  let nextCallResult: Record<string, any> | null = null;
  const callWaiters: Array<{ count: number; resolve: (count: number) => void }> = [];
  const discoveryWaiters: Array<{ count: number; resolve: (count: number) => void }> = [];
  const server = http.createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const wire = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (wire.method === "server/discover") {
        observedDiscoveries += 1;
        for (const waiter of discoveryWaiters.splice(0)) {
          if (observedDiscoveries >= waiter.count) waiter.resolve(observedDiscoveries);
          else discoveryWaiters.push(waiter);
        }
        const gate = nextDiscoveryGate;
        nextDiscoveryGate = null;
        if (gate) await gate.promise;
        if (response.destroyed) return;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: wire.id, result: { resultType: "complete", supportedVersions: ["2026-07-28"] } }));
        return;
      }
      if (wire.method === "tools/list") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: wire.id, result: { resultType: "complete", tools: [{
          name: "echo",
          inputSchema: {
            type: "object",
            properties: { label: { type: "string" }, url: { type: "string" }, path: { type: "string" }, headers: { type: "object" } },
            required: ["label"],
            additionalProperties: false
          }
        }] } }));
        return;
      }
      if (wire.method !== "tools/call") {
        response.writeHead(404).end();
        return;
      }
      calledNames.push(String(wire.params?.name || ""));
      let prior = 0;
      try { prior = Number(await fs.readFile(counterPath, "utf8")) || 0; } catch {}
      const next = prior + 1;
      const tempPath = `${counterPath}.next`;
      await fs.writeFile(tempPath, String(next), { mode: 0o600 });
      await fs.rename(tempPath, counterPath);
      observedCalls = next;
      for (const waiter of callWaiters.splice(0)) {
        if (observedCalls >= waiter.count) waiter.resolve(observedCalls);
        else callWaiters.push(waiter);
      }
      const gate = nextCallGate;
      nextCallGate = null;
      if (gate) await gate.promise;
      if (response.destroyed) return;
      const result = nextCallResult || {
        resultType: "complete",
        content: [{ type: "text", text: "synthetic-complete" }],
        structuredContent: { accepted: true }
      };
      nextCallResult = null;
      response.writeHead(200, { "content-type": "application/json" });
      if (result.__jsonRpcError === true) {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: wire.id, error: result.error }));
        return;
      }
      response.end(JSON.stringify({ jsonrpc: "2.0", id: wire.id, result }));
    } catch {
      if (!response.destroyed) response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic controlled peer did not bind.");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    holdNextCall() {
      const gate = deferred();
      callGates.add(gate);
      nextCallGate = gate;
      return gate;
    },
    holdNextDiscovery() {
      const gate = deferred();
      callGates.add(gate);
      nextDiscoveryGate = gate;
      return gate;
    },
    setNextCallResult(result: Record<string, any>) {
      nextCallResult = result;
    },
    async calledNames() {
      return [...calledNames];
    },
    async waitForCall(count: number) {
      if (observedCalls >= count) return observedCalls;
      return new Promise<number>((resolve) => callWaiters.push({ count, resolve }));
    },
    async waitForDiscovery(count: number) {
      if (observedDiscoveries >= count) return observedDiscoveries;
      return new Promise<number>((resolve) => discoveryWaiters.push({ count, resolve }));
    },
    async count() {
      try { return Number(await fs.readFile(counterPath, "utf8")) || 0; } catch { return 0; }
    },
    async close() {
      for (const gate of callGates) gate.resolve();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

const tempRoots: string[] = [];
const candidates: Array<ReturnType<typeof candidate>> = [];
const peers: Array<Awaited<ReturnType<typeof controlledPeer>>> = [];
afterEach(async () => {
  while (candidates.length) await candidates.pop()!.crash();
  while (peers.length) await peers.pop()!.close();
  while (tempRoots.length) await fs.rm(tempRoots.pop()!, { recursive: true, force: true });
});

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-platform-durable-intent-"));
  tempRoots.push(root);
  return root;
}

async function startCandidate(root: string, peerUrl: string, mode: string, risk = "safe_write") {
  const process = candidate(root, peerUrl, mode, risk);
  candidates.push(process);
  return { process, ready: await process.waitFor("ready") };
}

describe("platform discovered-tool durable dispatch intent", () => {
  it("fails closed on intent-owner failure and leaves read-only calls without proof writes", async () => {
    const root = await makeRoot();
    const peer = await controlledPeer(path.join(root, "peer-effect-count"));
    peers.push(peer);
    const failing = await startCandidate(path.join(root, "failing-candidate"), peer.url, "fail-intent");
    failing.process.send({ type: "call", arguments: { label: "must-not-send" } });
    const failedResponse = await failing.process.waitFor("response");
    // The injected proof-owner diagnostic is projected to the bounded public failure;
    // the synthetic internal code never crosses the protocol boundary.
    expect(failedResponse).toMatchObject({ status: 200, errorCode: "transport_failed" });
    expect(JSON.stringify(failedResponse)).not.toContain("synthetic_proof_persistence_failure");
    expect(await peer.count()).toBe(0);
    await failing.process.stop();

    const readOnly = await startCandidate(path.join(root, "read-candidate"), peer.url, "normal", "read_only");
    readOnly.process.send({ type: "proof-head" });
    const before = await readOnly.process.waitFor("proof-head");
    readOnly.process.send({ type: "call", arguments: { label: "read-only" } });
    const response = await readOnly.process.waitFor("response");
    readOnly.process.send({ type: "proof-head" });
    const after = await readOnly.process.waitFor("proof-head");
    expect(response).toMatchObject({ status: 200, resultType: "complete" });
    expect(after.size).toBe(before.size);
    expect(await peer.count()).toBe(1);
    await readOnly.process.stop();
  }, 20_000);

  it("rechecks platform authority after held modern discovery before tools/call", async () => {
    const root = await makeRoot();
    const peer = await controlledPeer(path.join(root, "peer-effect-count"));
    peers.push(peer);
    const started = await startCandidate(path.join(root, "discovery-revoked-candidate"), peer.url, "normal");
    const discovery = peer.holdNextDiscovery();
    started.process.send({ type: "call", arguments: { label: "revoke-during-discovery" } });
    const intent = await started.process.waitFor("intent");
    expect(intent.ledgerEventId).toBeTruthy();
    await peer.waitForDiscovery(2);
    expect(await peer.count()).toBe(0);

    started.process.send({ type: "revoke-authority" });
    await started.process.waitFor("authority-revoked");
    discovery.resolve();

    const marker = await started.process.waitFor("dispatch-marker");
    const terminal = await started.process.waitFor("terminal");
    const response = await started.process.waitFor("response");
    expect(marker.status).toBe("in_doubt");
    expect(terminal).toMatchObject({ ledgerEventId: intent.ledgerEventId, status: "denied" });
    expect(response.errorCode).toBe("final_protected_sink_permit_revoked");
    expect(await peer.count()).toBe(0);
    expect(await peer.calledNames()).toEqual([]);
    await started.process.stop();
  }, 20_000);

  it("retains an open prepared parent when interrupted at the known pre-marker checkpoint", async () => {
    const root = await makeRoot();
    const peer = await controlledPeer(path.join(root, "peer-effect-count"));
    peers.push(peer);
    const started = await startCandidate(path.join(root, "pre-dispatch-candidate"), peer.url, "pause-after-intent");
    started.process.send({ type: "call", arguments: { label: "pre-dispatch" } });
    const intent = await started.process.waitFor("intent");
    expect(intent.ledgerEventId).toBeTruthy();
    expect(await peer.count()).toBe(0);
    await started.process.crash();

    const proof = createOperationProofSubstrate({ dataDir: path.join(root, "pre-dispatch-candidate", "proof") });
    try {
      const reopened = await proof.getReceipt(intent.ledgerEventId);
      expect(reopened).toMatchObject({ status: "started" });
      // OPEN alone is intentionally not interpreted as proof that a dispatch marker is absent.
      expect(reopened).not.toHaveProperty("dispatchProjection");
      expect(await peer.count()).toBe(0);
    } finally {
      await proof.close();
    }
  }, 20_000);

  it("projects an in-doubt dispatch after a peer effect and candidate crash without startup resend", async () => {
    const root = await makeRoot();
    const peer = await controlledPeer(path.join(root, "peer-effect-count"));
    peers.push(peer);
    const gate = peer.holdNextCall();
    const started = await startCandidate(path.join(root, "ambiguous-candidate"), peer.url, "normal");
    started.process.send({ type: "call", arguments: { label: "ambiguous" } });
    const intent = await started.process.waitFor("intent");
    const marker = await started.process.waitFor("dispatch-marker");
    await peer.waitForCall(1);
    expect(marker.status).toBe("in_doubt");
    expect(await peer.count()).toBe(1);
    await started.process.crash();
    gate.resolve();

    const proof = createOperationProofSubstrate({ dataDir: path.join(root, "ambiguous-candidate", "proof") });
    try {
      const reopenedMarker = await proof.getReceipt(marker.ledgerEventId);
      expect(reopenedMarker).toMatchObject({
        status: "in_doubt",
        dispatchProjection: { state: "in_doubt", status: "in_doubt", parentLedgerEventId: intent.ledgerEventId }
      });
      const reopenedParent = await proof.getReceipt(intent.ledgerEventId);
      expect(reopenedParent).toMatchObject({ status: "started" });
    } finally {
      await proof.close();
    }

    const restarted = await startCandidate(path.join(root, "ambiguous-candidate"), peer.url, "normal");
    restarted.process.send({ type: "proof-head" });
    await restarted.process.waitFor("proof-head");
    expect(await peer.count()).toBe(1);
    await restarted.process.stop();
  }, 20_000);

  it("keeps the historical dispatch receipt uncertain while projecting a durable successful parent outcome", async () => {
    const root = await makeRoot();
    const peer = await controlledPeer(path.join(root, "peer-effect-count"));
    peers.push(peer);
    const started = await startCandidate(path.join(root, "successful-candidate"), peer.url, "normal");
    started.process.send({ type: "call", arguments: { label: "successful" } });
    const intent = await started.process.waitFor("intent");
    const marker = await started.process.waitFor("dispatch-marker");
    const terminal = await started.process.waitFor("terminal");
    const response = await started.process.waitFor("response");
    expect(terminal).toMatchObject({ ledgerEventId: intent.ledgerEventId, status: "succeeded" });
    expect(response).toMatchObject({ status: 200, resultType: "complete" });
    expect(await peer.count()).toBe(1);
    await started.process.stop();

    const proof = createOperationProofSubstrate({ dataDir: path.join(root, "successful-candidate", "proof") });
    try {
      const reopenedMarker = await proof.getReceipt(marker.ledgerEventId);
      expect(reopenedMarker).toMatchObject({ status: "in_doubt", dispatchProjection: { state: "settled", status: "succeeded" } });
      const reopenedParent = await proof.getReceipt(intent.ledgerEventId);
      expect(reopenedParent).toMatchObject({ status: "succeeded", receiptRefs: [marker.ledgerEventId] });
      const listed = await proof.listReceipts({ limit: 100 });
      expect(listed.find((entry: Record<string, any>) => entry.ledgerEventId === marker.ledgerEventId))
        .toMatchObject({ status: "in_doubt", dispatchProjection: { state: "settled", status: "succeeded" } });
    } finally {
      await proof.close();
    }
  }, 20_000);

  it("records and settles a discovered MCP stdio effect around the real process write", async () => {
    const root = await makeRoot();
    const dataRoot = path.join(root, "stdio-candidate");
    const started = await startCandidate(dataRoot, "", "stdio");
    started.process.send({ type: "call", arguments: { label: "stdio-effect" } });
    const intent = await started.process.waitFor("intent");
    const marker = await started.process.waitFor("dispatch-marker");
    const terminal = await started.process.waitFor("terminal");
    const response = await started.process.waitFor("response");
    expect(marker).toMatchObject({ status: "in_doubt" });
    expect(terminal).toMatchObject({ ledgerEventId: intent.ledgerEventId, status: "succeeded" });
    expect(response).toMatchObject({ status: 200, resultType: "complete" });
    expect(Number(await fs.readFile(path.join(dataRoot, "stdio-peer-effect-count"), "utf8"))).toBe(1);
    await started.process.stop();

    const proof = createOperationProofSubstrate({ dataDir: path.join(dataRoot, "proof") });
    try {
      const reopenedParent = await proof.getReceipt(intent.ledgerEventId);
      expect(reopenedParent).toMatchObject({ status: "succeeded", receiptRefs: [marker.ledgerEventId] });
      const reopenedMarker = await proof.getReceipt(marker.ledgerEventId);
      expect(reopenedMarker).toMatchObject({ status: "in_doubt", dispatchProjection: { state: "settled", status: "succeeded" } });
    } finally {
      await proof.close();
    }
  }, 20_000);

  it("keeps MCP tool arguments out of destination routing while binding the actual tool name", async () => {
    const root = await makeRoot();
    const peer = await controlledPeer(path.join(root, "peer-effect-count"));
    peers.push(peer);
    const started = await startCandidate(path.join(root, "target-input-candidate"), peer.url, "normal");
    started.process.send({ type: "call", arguments: {
      label: "tool-input",
      url: "https://arguments-are-not-a-destination.invalid/",
      path: "/arguments-are-not-a-route",
      headers: { authorization: "tool-data" }
    } });
    const intent = await started.process.waitFor("intent");
    const marker = await started.process.waitFor("dispatch-marker");
    const terminal = await started.process.waitFor("terminal");
    const response = await started.process.waitFor("response");
    expect(marker).toMatchObject({ status: "in_doubt" });
    expect(terminal).toMatchObject({ ledgerEventId: intent.ledgerEventId, status: "succeeded" });
    expect(response).toMatchObject({ status: 200, resultType: "complete" });
    expect(await peer.count()).toBe(1);
    expect(await peer.calledNames()).toEqual(["echo"]);
    await started.process.stop();
  }, 20_000);

  it("preserves malformed modern results as uncertain instead of normalizing them to complete", async () => {
    const root = await makeRoot();
    const peer = await controlledPeer(path.join(root, "peer-effect-count"));
    peers.push(peer);
    peer.setNextCallResult({ structuredContent: { accepted: true } });
    const started = await startCandidate(path.join(root, "malformed-modern-candidate"), peer.url, "normal");
    started.process.send({ type: "call", arguments: { label: "malformed-modern" } });
    const intent = await started.process.waitFor("intent");
    const marker = await started.process.waitFor("dispatch-marker");
    const terminal = await started.process.waitFor("terminal");
    const response = await started.process.waitFor("response");
    expect(marker).toMatchObject({ status: "in_doubt" });
    expect(terminal).toMatchObject({ ledgerEventId: intent.ledgerEventId, status: "in_doubt" });
    expect(response).toMatchObject({ status: 200 });
    expect(response.resultType).toBe("");
    expect(response.errorCode).toBeTruthy();
    expect(await peer.count()).toBe(1);
    await started.process.stop();
  }, 20_000);

  it("preserves an unvalidated upstream JSON-RPC error envelope as an uncertain effect", async () => {
    const root = await makeRoot();
    const peer = await controlledPeer(path.join(root, "peer-effect-count"));
    peers.push(peer);
    peer.setNextCallResult({ __jsonRpcError: true, error: { code: -32000, message: "fixture failure" } });
    const started = await startCandidate(path.join(root, "jsonrpc-error-candidate"), peer.url, "normal");
    started.process.send({ type: "call", arguments: { label: "jsonrpc-error" } });
    const intent = await started.process.waitFor("intent");
    const marker = await started.process.waitFor("dispatch-marker");
    const terminal = await started.process.waitFor("terminal");
    const response = await started.process.waitFor("response");
    expect(marker).toMatchObject({ status: "in_doubt" });
    expect(terminal).toMatchObject({ ledgerEventId: intent.ledgerEventId, status: "in_doubt" });
    expect(response.errorCode).toBeTruthy();
    expect(response.resultType).toBe("");
    expect(await peer.count()).toBe(1);
    await started.process.stop();
  }, 20_000);

  it("settles a complete validated tool error as a known failed effect", async () => {
    const root = await makeRoot();
    const peer = await controlledPeer(path.join(root, "peer-effect-count"));
    peers.push(peer);
    peer.setNextCallResult({
      resultType: "complete",
      isError: true,
      content: [{ type: "text", text: "synthetic tool failure" }],
      structuredContent: { accepted: false }
    });
    const started = await startCandidate(path.join(root, "validated-tool-error-candidate"), peer.url, "normal");
    started.process.send({ type: "call", arguments: { label: "validated-tool-error" } });
    const intent = await started.process.waitFor("intent");
    const marker = await started.process.waitFor("dispatch-marker");
    const terminal = await started.process.waitFor("terminal");
    const response = await started.process.waitFor("response");
    expect(marker).toMatchObject({ status: "in_doubt" });
    expect(terminal).toMatchObject({ ledgerEventId: intent.ledgerEventId, status: "failed" });
    expect(response).toMatchObject({ status: 200, resultType: "complete", isError: true });
    expect(await peer.count()).toBe(1);
    await started.process.stop();
  }, 20_000);

  it("keeps an explicit unknown terminal outcome projected as in doubt after reopen", async () => {
    const root = await makeRoot();
    const peer = await controlledPeer(path.join(root, "peer-effect-count"));
    peers.push(peer);
    peer.setNextCallResult({ resultType: "not-negotiated", value: { accepted: true } });
    const started = await startCandidate(path.join(root, "unknown-candidate"), peer.url, "normal");
    started.process.send({ type: "call", arguments: { label: "unknown-terminal" } });
    const intent = await started.process.waitFor("intent");
    const marker = await started.process.waitFor("dispatch-marker");
    await started.process.waitFor("terminal");
    await started.process.waitFor("response");
    expect(await peer.count()).toBe(1);
    await started.process.stop();

    const proof = createOperationProofSubstrate({ dataDir: path.join(root, "unknown-candidate", "proof") });
    try {
      const reopenedMarker = await proof.getReceipt(marker.ledgerEventId);
      expect(reopenedMarker).toMatchObject({
        status: "in_doubt",
        dispatchProjection: { state: "in_doubt", status: "in_doubt", parentLedgerEventId: intent.ledgerEventId }
      });
      expect(reopenedMarker.dispatchProjection.outcomeLedgerEventId).toBeTruthy();
      const reopenedParent = await proof.getReceipt(intent.ledgerEventId);
      expect(reopenedParent).toMatchObject({ status: "in_doubt", receiptRefs: [marker.ledgerEventId] });
    } finally {
      await proof.close();
    }
  }, 20_000);
});
