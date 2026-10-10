/**
 * Peer messaging end-to-end on a REAL local Workerd private relay:
 * `wrangler dev --local` serves the actual `RelaySessionDO` + `MailboxDO`
 * graph; the two "devices" are the shipped product runtimes —
 * `EndpointPeerRuntime` (private endpoint) and `EntryPeerRuntime` (entry
 * product) — each riding a REAL `PrivateRelaySession` over a REAL
 * `RelayWebSocketTransport` socket, with real Signal (PQXDH + Double
 * Ratchet) envelopes stored only as ciphertext by the mailbox.
 *
 * Evidence: bundle exchange, encrypted request/progress/result in both
 * directions, receipt honesty (mailbox accepted/received vs agent
 * completed are distinct rows), session drop → `session-reconnect`
 * resume with durable outbox replay, replayed-page dedup, revoked-device
 * refusal at the session boundary, capacity-gap tombstone visibility on
 * the operator surface, and out-of-band safety-number parity.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";

import { isPeerSchemaMessage } from "@meshrix/entry-transport";
import { PrivateRelaySession, type RelayAdmissionInput } from "@meshrix/gateway/private-endpoint";

import { EndpointPeerRuntime } from "../../../apps/mcp-gateway-installer/src/private-endpoint/peer.ts";
import { EntryPeerRuntime } from "../../../apps/entry-gui/src/main/peer.ts";
import { RelayWebSocketTransport } from "../../../apps/mcp-gateway-installer/src/private-endpoint/transport.ts";

const ADMIN_TOKEN = "local-only-synthetic-admin-token";
const TENANT = "tenant.e2e.1";
const WRANGLER_CLI = path.resolve("node_modules/wrangler/wrangler-dist/cli.js");
const WORKER_DIR = path.resolve("workers/private-relay");

const tmpDirs: string[] = [];
const workers: { child: ChildProcess; port: number; origin: string; persistDir: string; log: string[] }[] = [];

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out on ${label}${lastError ? ` (last: ${String(lastError)})` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/* ------------------------------------------------------------------ */
/* wrangler dev lifecycle                                              */
/* ------------------------------------------------------------------ */

async function startWorkerd(vars: Record<string, string> = {}): Promise<{ port: number; origin: string }> {
  const port = await freePort();
  const persistDir = await mkdtemp(path.join(tmpdir(), "peer-e2e-worker-state-"));
  tmpDirs.push(persistDir);
  const varArgs = Object.entries(vars).flatMap(([key, value]) => ["--var", `${key}:${value}`]);
  const log: string[] = [];
  const child = spawn(process.execPath, [
    WRANGLER_CLI, "dev", "--local",
    "--ip", "127.0.0.1",
    "--port", String(port),
    "--config", "wrangler.toml",
    "--persist-to", persistDir,
    ...varArgs
  ], {
    cwd: WORKER_DIR,
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_DISABLE_VERSION_CHECK: "1",
      CI: "true",
      NO_COLOR: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const keep = (chunk: Buffer) => {
    log.push(chunk.toString("utf8"));
    if (log.join("").length > 32_768) log.splice(0, log.length - 8);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const origin = `http://127.0.0.1:${port}`;
  workers.push({ child, port, origin, persistDir, log });
  // /healthz is answered by the worker itself; polling it proves the full
  // worknerd→router path is serving, not just a banner line.
  try {
    await waitFor(async () => {
      try {
        const response = await fetch(`${origin}/healthz`);
        return response.status === 200;
      } catch {
        return false;
      }
    }, 90_000, "workerd /healthz");
  } catch (error) {
    throw new Error(`wrangler dev did not become ready: ${String(error)}\n${log.join("").slice(-4096)}`);
  }
  return { port, origin };
}

async function stopWorkerd(instance: { child: ChildProcess; log: string[] }): Promise<void> {
  if (instance.child.exitCode !== null || instance.child.signalCode !== null) return;
  instance.child.kill("SIGTERM");
  await waitFor(() => instance.child.exitCode !== null || instance.child.signalCode !== null, 10_000, "wrangler dev exit")
    .catch(() => instance.child.kill("SIGKILL"));
}

/* ------------------------------------------------------------------ */
/* Device harness: real session driver + transport + product runtime   */
/* ------------------------------------------------------------------ */

interface Enrolled {
  deviceId: string;
  routeId: string;
  role: string;
  mode: string;
  credential: string;
  admissionGeneration: number;
  revocationRevision: number;
}

async function enrollDevice(origin: string, routeId: string, deviceId: string, role: "entry" | "endpoint"): Promise<Enrolled> {
  const response = await fetch(`${origin}/admin/tenants/${TENANT}/enroll`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ deviceId, routeId, role, mode: "personal" })
  });
  if (!response.ok) throw new Error(`enroll ${deviceId} failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<Enrolled>;
}

async function revokeDevice(origin: string, deviceId: string): Promise<void> {
  const response = await fetch(`${origin}/admin/tenants/${TENANT}/revoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ deviceId })
  });
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`revoke ${deviceId} failed: ${response.status}`);
}

/**
 * One product peer runtime bound to a real forward session on the live
 * Workerd relay. `kind` selects the shipped runtime — "endpoint" wires
 * `EndpointPeerRuntime`, "entry" wires `EntryPeerRuntime` — and the demux
 * in front of `session.handleMessage` is the same shape both product
 * profiles run (peer-schema kinds → runtime, everything else → session).
 */
class DeviceSide {
  readonly transport: RelayWebSocketTransport;
  session!: PrivateRelaySession;
  readonly runtime: EndpointPeerRuntime | EntryPeerRuntime;
  readonly enrolled: Enrolled;
  readonly role: "entry" | "endpoint";
  #admitResolve: (() => void) | null = null;
  #admitReject: ((error: Error) => void) | null = null;
  #closedReason: string | null = null;
  #rejectedReason: string | null = null;
  #socketDown = false;

  private constructor(input: {
    enrolled: Enrolled;
    role: "entry" | "endpoint";
    transport: RelayWebSocketTransport;
    runtime: EndpointPeerRuntime | EntryPeerRuntime;
  }) {
    this.enrolled = input.enrolled;
    this.role = input.role;
    this.transport = input.transport;
    this.runtime = input.runtime;
  }

  static async connect(origin: string, input: {
    enrolled: Enrolled;
    role: "entry" | "endpoint";
    storeDir: string;
    requestTimeoutMs?: number;
    maxSendAttempts?: number;
    admitTimeoutMs?: number;
  }): Promise<DeviceSide> {
    const route = { tenantId: TENANT, routeId: input.enrolled.routeId, deviceId: input.enrolled.deviceId };
    const url = `${origin.replace(/^http/u, "ws")}/session/${TENANT}/${input.enrolled.routeId}`;
    const transport = new RelayWebSocketTransport({
      url,
      headers: { authorization: `Bearer ${input.enrolled.credential}` }
    });
    const sideRef: { side?: DeviceSide } = {};
    const sessionLive = () => {
      const state = sideRef.side?.session.state;
      return state === "admitted" || state === "streaming";
    };
    const common = {
      ...(input.requestTimeoutMs !== undefined ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
      ...(input.maxSendAttempts !== undefined ? { maxSendAttempts: input.maxSendAttempts } : {})
    };
    const runtime = input.role === "endpoint"
      ? await EndpointPeerRuntime.create({
          peer: { storageDir: input.storeDir },
          route,
          send: (message) => transport.send(message),
          sessionLive,
          ...common
        })
      : await EntryPeerRuntime.create({
          storeDir: input.storeDir,
          route,
          ...common
        });
    const side = new DeviceSide({ enrolled: input.enrolled, role: input.role, transport, runtime });
    sideRef.side = side;
    const admission: RelayAdmissionInput = {
      tenantId: TENANT,
      deviceId: input.enrolled.deviceId,
      routeId: input.enrolled.routeId,
      role: input.role,
      mode: "personal",
      admissionGeneration: input.enrolled.admissionGeneration,
      revocationRevision: input.enrolled.revocationRevision
    };
    side.session = new PrivateRelaySession({
      transport,
      admission,
      purpose: "forward",
      handlers: {
        onAdmitted: () => side.#onAdmitted(),
        onRejected: (reason) => {
          side.#rejectedReason = reason;
          side.#admitReject?.(new Error(`session-rejected: ${reason}`));
          side.#admitResolve = null;
          side.#admitReject = null;
        },
        onClosed: (reason) => { side.#closedReason = reason; side.#onSessionDown(); }
      }
    });
    transport.setHandlers({
      onMessage: (message) => {
        if (isPeerSchemaMessage(message)) {
          side.runtime.handleInbound(message);
          return;
        }
        side.session.handleMessage(message);
      },
      onDown: (detail) => {
        side.#socketDown = true;
        side.#onSessionDown();
        if (detail.hadOpened === false) {
          side.#admitReject?.(new Error(`socket closed before admission (code ${detail.code ?? "?"})`));
          side.#admitResolve = null;
          side.#admitReject = null;
        }
      }
    });
    if (runtime instanceof EntryPeerRuntime) {
      runtime.attachChannel((message) => transport.send(message));
    }
    transport.connect();
    const admitTimeoutMs = input.admitTimeoutMs ?? 20_000;
    await new Promise<void>((resolve, reject) => {
      side.#admitResolve = resolve;
      side.#admitReject = reject;
      setTimeout(() => reject(new Error("admission timeout")), admitTimeoutMs);
      side.session.open();
    });
    return side;
  }

  #onAdmitted(): void {
    if (this.runtime instanceof EndpointPeerRuntime) this.runtime.onSessionLive();
    else this.runtime.onSessionAdmitted();
    this.#admitResolve?.();
    this.#admitResolve = null;
    this.#admitReject = null;
  }

  #onSessionDown(): void {
    if (this.runtime instanceof EndpointPeerRuntime) this.runtime.onSessionDown();
    else this.runtime.onSessionClosed();
  }

  get rejected(): string | null { return this.#rejectedReason; }
  get closedReason(): string | null { return this.#closedReason; }

  /**
   * Re-establish the wire session on a fresh socket.
   *
   * `graceful` sends `session-close("reconnect")` on the live socket first
   * — the relay answers session-close and terminates the socket itself, so
   * the close handshake does not depend on a client-initiated close racing
   * a hibernated DO. `unclean` kills the socket first (drop semantics) and
   * only then runs the driver's close transition. Either way the driver
   * ends `closed`, then `session-reconnect` rides the fresh socket and the
   * relay restores the session — cursors and durable peer state carry over.
   */
  async reconnect(mode: "unclean" | "graceful" = "unclean"): Promise<void> {
    if (mode === "graceful") {
      try { this.session.close("reconnect"); } catch { /* already dead */ }
    }
    this.transport.close();
    await waitFor(() => this.transport.state === "closed", 20_000, "socket down");
    if (mode === "unclean") {
      try { this.session.close("reconnect"); } catch { /* transport already dead — the send is counted, not sent */ }
    }
    const admittedWait = new Promise<void>((resolve, reject) => {
      this.#admitResolve = resolve;
      this.#admitReject = reject;
      setTimeout(() => reject(new Error("re-admission timeout")), 20_000);
    });
    this.transport.connect();
    this.session.reconnect();
    await admittedWait;
  }

  async close(): Promise<void> {
    try { this.session.close("normal"); } catch { /* dead */ }
    this.transport.terminate();
    await this.runtime.close();
  }
}

/* ------------------------------------------------------------------ */
/* The exchange                                                        */
/* ------------------------------------------------------------------ */

function outboxReceiptKinds(status: { outbox: readonly { receipts: readonly unknown[] }[] }): string[] {
  return status.outbox.flatMap((row) => row.receipts).map((receipt) => String((receipt as { kind?: unknown }).kind));
}

describe("peer mailbox E2E on real Workerd (wrangler dev)", () => {
  it("two device identities exchange Signal-encrypted request/progress/result with honest receipts, resume, dedup and revocation evidence", async () => {
    const worker = await startWorkerd();
    const origin = worker.origin;
    try {
      const routeId = `route.e2e.${Date.now().toString(36)}a`;
      const entryEnrolled = await enrollDevice(origin, routeId, "dev.e2e.entry.1", "entry");
      const endpointEnrolled = await enrollDevice(origin, routeId, "dev.e2e.endpoint.1", "endpoint");
      const dir = await mkdtemp(path.join(tmpdir(), "peer-e2e-"));
      tmpDirs.push(dir);

      const entry = await DeviceSide.connect(origin, {
        enrolled: entryEnrolled, role: "entry", storeDir: path.join(dir, "entry"), requestTimeoutMs: 4_000
      });
      const endpoint = await DeviceSide.connect(origin, {
        enrolled: endpointEnrolled, role: "endpoint", storeDir: path.join(dir, "endpoint"), requestTimeoutMs: 4_000
      });
      try {
        // Bundles publish through the runtime lifecycle on admission.
        await waitFor(async () => (await entry.runtime.status()).localBundle !== null, 20_000, "entry bundle publish");
        await waitFor(async () => (await endpoint.runtime.status()).localBundle !== null, 20_000, "endpoint bundle publish");
        const entryStatus = await entry.runtime.status();
        const endpointStatus = await endpoint.runtime.status();
        expect(entryStatus.peerId).toBe(`peer:${TENANT}:${routeId}:${entryEnrolled.deviceId}`);
        expect(endpointStatus.peerId).toBe(`peer:${TENANT}:${routeId}:${endpointEnrolled.deviceId}`);
        // Retention advertisement rode the same admitted session.
        await waitFor(async () => (await entry.runtime.status()).retentionPolicy !== null, 10_000, "entry retention policy");
        await waitFor(async () => (await endpoint.runtime.status()).retentionPolicy !== null, 10_000, "endpoint retention policy");
        expect((await entry.runtime.status()).retentionPolicy?.mailboxMaxItems).toBe(4096);
        expect((await endpoint.runtime.status()).retentionPolicy?.mailboxCapacityBytes).toBe(16_777_216);

        // request → progress → result with real Signal envelopes both ways.
        const request = await entry.runtime.sendMessage({ peerDeviceId: endpointEnrolled.deviceId, text: "request:diagnose" });
        expect(request.state).toBe("accepted");
        await waitFor(async () => (await endpoint.runtime.inbox()).some((row) => row.text === "request:diagnose"), 15_000, "endpoint inbox");
        const requestRow = (await endpoint.runtime.inbox()).find((row) => row.text === "request:diagnose");
        expect(requestRow?.senderDeviceId).toBe(entryEnrolled.deviceId);
        expect(requestRow?.senderPeerId).toBe(entryStatus.peerId);

        await endpoint.runtime.sendMessage({ peerDeviceId: entryEnrolled.deviceId, text: "progress:started" });
        await endpoint.runtime.sendMessage({ peerDeviceId: entryEnrolled.deviceId, text: "result:ok" });
        await waitFor(async () => (await entry.runtime.inbox()).length >= 2, 15_000, "entry inbox fill");
        const entryTexts = (await entry.runtime.inbox()).map((row) => row.text).sort();
        expect(entryTexts).toEqual(["progress:started", "result:ok"]);

        // Receipt honesty: the application receipt is explicit evidence
        // next to mailbox accepted/received — never derived from them.
        const resultRow = (await entry.runtime.inbox()).find((row) => row.text === "result:ok");
        await entry.runtime.reportOutcome({ messageId: resultRow!.messageId, outcome: "completed" });
        await endpoint.runtime.client.reconcile();
        await waitFor(async () => outboxReceiptKinds(await endpoint.runtime.status()).includes("completed"), 15_000, "completed receipt reconciled");
        const kinds = outboxReceiptKinds(await endpoint.runtime.status());
        expect(kinds).toContain("accepted");
        expect(kinds).toContain("received");
        expect(kinds).toContain("completed");

        // Out-of-band safety parity — both sides derive the same number.
        const [safetyEntry, safetyEndpoint] = await Promise.all([
          entry.runtime.pairSafety(endpointEnrolled.deviceId),
          endpoint.runtime.pairSafety(entryEnrolled.deviceId)
        ]);
        expect(safetyEntry.safetyNumber).toBeTruthy();
        expect(safetyEntry.safetyNumber).toBe(safetyEndpoint.safetyNumber);

        // Unclean drop: the entry send offered while the socket is dead is
        // refused fast by the admission gate — it lands durably in the
        // outbox and is replayed with identical envelope bytes on resume.
        entry.transport.close();
        await waitFor(() => entry.transport.state === "closed", 10_000, "entry socket down");
        await expect(entry.runtime.sendMessage({ peerDeviceId: endpointEnrolled.deviceId, text: "while-offline" }))
          .rejects.toMatchObject({ code: expect.stringMatching(/peer/u) });
        await entry.reconnect();
        await waitFor(async () => (await endpoint.runtime.inbox()).some((row) => row.text === "while-offline"), 20_000, "durable replay after reconnect");
        const replayed = (await entry.runtime.status()).outbox.find((row) => row.peerDeviceId === endpointEnrolled.deviceId && row.state === "accepted");
        expect(replayed).toBeTruthy();

        // Dedup on resume: a graceful session-close → session-reconnect
        // must not grow either inbox — cursor fetch + replayed pages are
        // idempotent by position.
        const endpointInboxBefore = (await endpoint.runtime.inbox()).length;
        await endpoint.reconnect("graceful");
        await endpoint.runtime.client.sync();
        expect((await endpoint.runtime.inbox()).length).toBe(endpointInboxBefore);

        // Revoked-device refusal: revoke the endpoint; its live session is
        // closed by the relay and a fresh upgrade is denied. The revoked
        // side's own runtime refuses new sends honestly.
        await revokeDevice(origin, endpointEnrolled.deviceId);
        await waitFor(() => endpoint.transport.state === "closed" || endpoint.session.state === "closed", 15_000, "revoked session close");
        await expect(DeviceSide.connect(origin, {
          enrolled: endpointEnrolled, role: "endpoint", storeDir: path.join(dir, "endpoint2"), admitTimeoutMs: 10_000
        })).rejects.toThrow();
        await expect(endpoint.runtime.sendMessage({ peerDeviceId: entryEnrolled.deviceId, text: "x" }))
          .rejects.toMatchObject({ code: expect.stringMatching(/peer/u) });
      } finally {
        await entry.close().catch(() => undefined);
        await endpoint.close().catch(() => undefined);
      }
    } finally {
      await stopWorkerd(workers.at(-1)!);
      workers.pop();
    }
  }, 180_000);

  it("a capacity-truncated mailbox range surfaces as an explicit gap tombstone on the operator surface", async () => {
    // A second workerd instance with maxItems=1: each new durable envelope
    // evicts the previous one. The recipient is OFFLINE during the sends —
    // positions are evicted before they could ever be delivered, which is
    // the honest precondition for a gap tombstone (already-delivered
    // positions are not "lost"). No alarm timing involved.
    const worker = await startWorkerd({ RELAY_MAILBOX_MAX_ITEMS: "1" });
    const origin = worker.origin;
    try {
      const routeId = `route.e2e.${Date.now().toString(36)}g`;
      const entryEnrolled = await enrollDevice(origin, routeId, "dev.e2e.entry.g1", "entry");
      const endpointEnrolled = await enrollDevice(origin, routeId, "dev.e2e.endpoint.g1", "endpoint");
      const dir = await mkdtemp(path.join(tmpdir(), "peer-e2e-gap-"));
      tmpDirs.push(dir);
      const entry = await DeviceSide.connect(origin, {
        enrolled: entryEnrolled, role: "entry", storeDir: path.join(dir, "entry"), requestTimeoutMs: 4_000
      });
      const endpoint = await DeviceSide.connect(origin, {
        enrolled: endpointEnrolled, role: "endpoint", storeDir: path.join(dir, "endpoint"), requestTimeoutMs: 4_000
      });
      try {
        // The endpoint's bundle must exist before the entry can initiate —
        // wait for an actual PUBLISHED revision (revision 0 is the allocated
        // record before the wire call completes), then take it offline.
        await waitFor(async () => ((await endpoint.runtime.status()).localBundle?.revision ?? 0) >= 1, 20_000, "endpoint bundle publish");
        await waitFor(async () => ((await entry.runtime.status()).localBundle?.revision ?? 0) >= 1, 20_000, "entry bundle publish");
        // The deployment env var actually applied: the advertisement the
        // endpoint pulls reports the bounded capacity verbatim.
        await waitFor(async () => (await endpoint.runtime.status()).retentionPolicy !== null, 10_000, "endpoint policy");
        expect((await endpoint.runtime.status()).retentionPolicy?.mailboxMaxItems).toBe(1);

        // Endpoint goes offline — sends still land durably in its mailbox
        // partition, and each new envelope truncates the previous one.
        endpoint.transport.close();
        await waitFor(() => endpoint.transport.state === "closed", 20_000, "endpoint offline");
        await entry.runtime.sendMessage({ peerDeviceId: endpointEnrolled.deviceId, text: "first" });
        await entry.runtime.sendMessage({ peerDeviceId: endpointEnrolled.deviceId, text: "second" });
        await entry.runtime.sendMessage({ peerDeviceId: endpointEnrolled.deviceId, text: "third" });

        // Endpoint reconnects: session-restored → resume → an explicit
        // sync() awaits the full fetch → process → ack → cursor chain, so
        // the tombstone page is fully committed before we observe it.
        await endpoint.reconnect();
        await endpoint.runtime.sync();
        const status = await endpoint.runtime.status();
        expect(status.gaps.length).toBeGreaterThan(0);
        expect(status.gaps[0].cause).toBe("capacity_truncated");
        expect(status.gaps[0].fromSeq).toBe(1);
        expect(status.gaps[0].toSeq).toBe(2);
        const rows = await endpoint.runtime.inbox();
        const survivor = rows.find((row) => row.position === 3);
        // Position 3 is durably present. Its decrypt may be honest-failed
        // (its session bootstrap rode evicted positions) or clean — either
        // way the entry and the gap are evidence, never silently skipped.
        expect(survivor).toBeTruthy();
        expect(survivor!.text === "third" || survivor!.decryptError !== null).toBe(true);
        expect(rows.some((row) => row.text === "first" || row.text === "second")).toBe(false);
        // The runtime event log records the lost range honestly.
        expect(status.events.some((event) => event.kind === "lostRange")).toBe(true);
      } finally {
        await entry.close().catch(() => undefined);
        await endpoint.close().catch(() => undefined);
      }
    } finally {
      await stopWorkerd(workers.at(-1)!);
      workers.pop();
    }
  }, 180_000);
});

process.on("beforeExit", () => {
  for (const worker of workers.splice(0)) {
    try { worker.child.kill("SIGKILL"); } catch { /* already gone */ }
  }
});
