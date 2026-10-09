/**
 * RelaySessionDO tests on real local Workerd: hibernating sockets, admission
 * authority, bounded forwarding, reconnect, revocation and backpressure.
 * All identities, credentials and payloads are synthetic.
 */

import { afterEach, describe, expect, it } from "vitest";
import { env, evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";

import { sessionObjectName } from "../src/ids.ts";
import {
  type Enrolled,
  ROUTE_1,
  ROUTE_2,
  TENANT_A,
  TENANT_B,
  WsClient,
  adminGet,
  adminPost,
  enroll,
  frameAckMessage,
  frameMessage,
  randomCiphertext,
  recoveryRequestMessage,
  sessionOpenMessage,
  sessionReconnectMessage,
} from "./helpers.ts";

function admissionFor(enrolled: Enrolled, revocationRevision?: number): Record<string, unknown> {
  return {
    tenantId: TENANT_A,
    deviceId: enrolled.deviceId,
    routeId: enrolled.routeId,
    role: enrolled.role,
    mode: "personal",
    admissionGeneration: enrolled.admissionGeneration,
    revocationRevision: revocationRevision ?? enrolled.revocationRevision,
  };
}

async function openSession(
  ws: WsClient,
  enrolled: Enrolled,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  ws.send(sessionOpenMessage({
    purpose: "forward",
    admission: admissionFor(enrolled),
    ...overrides,
  }));
  return ws.waitForKind("session-admitted");
}

async function connectPair(routeId: string, tenantId: string = TENANT_A): Promise<{ entry: { enrolled: Enrolled; ws: WsClient; admitted: Record<string, unknown> }; endpoint: { enrolled: Enrolled; ws: WsClient; admitted: Record<string, unknown> } }> {
  const entry = await enroll(tenantId, `dev.test.entry.${routeId.slice(-1)}${Math.random().toString(36).slice(2, 8)}`, routeId, "entry");
  const endpoint = await enroll(tenantId, `dev.test.endpoint.${routeId.slice(-1)}${Math.random().toString(36).slice(2, 8)}`, routeId, "endpoint");
  const [entryWs, endpointWs] = await Promise.all([
    WsClient.connect(tenantId, routeId, entry.credential),
    WsClient.connect(tenantId, routeId, endpoint.credential),
  ]);
  const entryAdmitted = await openSession(entryWs, entry);
  const endpointAdmitted = await openSession(endpointWs, endpoint);
  return {
    entry: { enrolled: entry, ws: entryWs, admitted: entryAdmitted },
    endpoint: { enrolled: endpoint, ws: endpointWs, admitted: endpointAdmitted },
  };
}

afterEach(async () => {
  await reset();
});

describe("relay session admission and forwarding", () => {
  it("admits both roles, forwards opaque frames and reconciles acks with flow-credit", async () => {
    const { entry, endpoint } = await connectPair(ROUTE_1);
    expect(entry.admitted.routeState).toBe("unreachable");
    expect(endpoint.admitted.routeState).toBe("reachable");
    const reachableNotice = await entry.ws.waitForKind("route-status");
    expect(reachableNotice.state).toBe("reachable");

    entry.ws.send(frameMessage(String(entry.admitted.sessionId), ROUTE_1, 1, randomCiphertext(64)));
    const forwarded = await endpoint.ws.waitForKind("frame");
    expect(forwarded.seq).toBe(1);
    expect(forwarded.sessionId).toBe(entry.admitted.sessionId);

    endpoint.ws.send(frameAckMessage(ROUTE_1, 1));
    const credit = await entry.ws.waitForKind("flow-credit");
    expect(credit.routeId).toBe(ROUTE_1);
    expect(credit.grantBytes).toBe(64);
    expect(credit.grantFrames).toBe(1);

    // Reverse direction works too.
    endpoint.ws.send(frameMessage(String(endpoint.admitted.sessionId), ROUTE_1, 1, randomCiphertext(32)));
    const back = await entry.ws.waitForKind("frame");
    expect(back.seq).toBe(1);

    const counters = await (await adminGet(`/admin/counters/session/${TENANT_A}/${ROUTE_1}`)).json() as { counters: Record<string, number> };
    expect(counters.counters.framesForwarded).toBeGreaterThanOrEqual(2);
    expect(counters.counters.sessionsAdmitted).toBe(2);
    entry.ws.close();
    endpoint.ws.close();
  });

  it("rejects session-open with stale or ahead revocation revision", async () => {
    const other = await enroll(TENANT_A, "dev.test.other.1", ROUTE_2, "entry");
    // Bump the tenant revision by revoking a different device.
    const revoke = await adminPost(`/admin/tenants/${TENANT_A}/revoke`, { deviceId: other.deviceId });
    await revoke.arrayBuffer();
    expect(revoke.ok).toBe(true);

    const entry = await enroll(TENANT_A, "dev.test.entry.stale", ROUTE_1, "entry");
    const ws = await WsClient.connect(TENANT_A, ROUTE_1, entry.credential);
    ws.send(sessionOpenMessage({
      purpose: "forward",
      admission: admissionFor(entry, 0),
    }));
    const rejected = await ws.waitForKind("session-rejected");
    expect(rejected.reason).toBe("stale_revocation_revision");
    expect(rejected.retryable).toBe(true);
    expect(rejected.expectedRevocationRevision).toBe(1);

    const ws2 = await WsClient.connect(TENANT_A, ROUTE_1, entry.credential);
    ws2.send(sessionOpenMessage({
      purpose: "forward",
      admission: admissionFor(entry, 99),
    }));
    const rejected2 = await ws2.waitForKind("session-rejected");
    expect(rejected2.reason).toBe("authority_stale");
    ws.close();
    ws2.close();
  });

  it("rejects cross-tenant credentials and mismatched admission identities", async () => {
    const entry = await enroll(TENANT_A, "dev.test.entry.xtenant", ROUTE_1, "entry");
    // Credential valid in tenant A cannot open a socket under tenant B.
    const denied = await WsClient.tryConnect(TENANT_B, ROUTE_1, entry.credential);
    expect(denied.status).toBe(403);
    // A credential bound to ROUTE_2 cannot be replayed on ROUTE_1.
    const other = await enroll(TENANT_A, "dev.test.entry.otherRoute", ROUTE_2, "entry");
    const deniedRoute = await WsClient.tryConnect(TENANT_A, ROUTE_1, other.credential);
    expect(deniedRoute.status).toBe(403);
    // Presented admission differing from credentialed identity is rejected.
    const ws = await WsClient.connect(TENANT_A, ROUTE_1, entry.credential);
    ws.send(sessionOpenMessage({
      purpose: "forward",
      admission: { ...admissionFor(entry), tenantId: TENANT_B },
    }));
    const rejected = await ws.waitForKind("session-rejected");
    expect(rejected.reason).toBe("tenant_mismatch");
    ws.close();
  });

  it("closes live sockets on revocation and refuses re-admission", async () => {
    const entry = await enroll(TENANT_A, "dev.test.entry.revoke", ROUTE_1, "entry");
    const ws = await WsClient.connect(TENANT_A, ROUTE_1, entry.credential);
    const admitted = await openSession(ws, entry);
    expect(admitted.kind).toBe("session-admitted");

    const revoke = await adminPost(`/admin/tenants/${TENANT_A}/revoke`, { deviceId: entry.deviceId });
    await revoke.arrayBuffer();
    expect(revoke.ok).toBe(true);
    const closed = await ws.closed;
    expect(closed.code).toBe(4003);

    const denied = await WsClient.tryConnect(TENANT_A, ROUTE_1, entry.credential);
    expect(denied.status).toBe(403);
  });

  it("restores hibernated sockets after eviction and completes reconnect", async () => {
    const { entry, endpoint } = await connectPair(ROUTE_1);
    const stub = env.RELAY_SESSION.get(env.RELAY_SESSION.idFromName(sessionObjectName(TENANT_A, ROUTE_1)));
    await evictDurableObject(stub); // hibernates sockets, resets in-memory state

    // A frame on the restored socket still forwards (attachment restore path).
    entry.ws.send(frameMessage(String(entry.admitted.sessionId), ROUTE_1, 5, randomCiphertext(24)));
    const forwarded = await endpoint.ws.waitForKind("frame");
    expect(forwarded.seq).toBe(5);

    // Reconnect on a fresh socket with current authority.
    const ws2 = await WsClient.connect(TENANT_A, ROUTE_1, entry.enrolled.credential);
    ws2.send(sessionReconnectMessage({
      previousSessionId: entry.admitted.sessionId,
      admission: admissionFor(entry.enrolled),
      lastAcknowledged: { toEndpoint: 5, toEntry: 0 },
      reconnectGeneration: 2,
    }));
    const restored = await ws2.waitForKind("session-restored");
    expect(restored.reconnectGeneration).toBe(2);
    expect(restored.sessionId).not.toBe(entry.admitted.sessionId);
    expect(Array.isArray(restored.gaps)).toBe(true);
    ws2.close();
    endpoint.ws.close();
  });

  it("rejects a stale reconnect generation", async () => {
    const { entry, endpoint } = await connectPair(ROUTE_1);
    const ws2 = await WsClient.connect(TENANT_A, ROUTE_1, entry.enrolled.credential);
    ws2.send(sessionReconnectMessage({
      previousSessionId: entry.admitted.sessionId,
      admission: admissionFor(entry.enrolled),
      lastAcknowledged: { toEndpoint: 0, toEntry: 0 },
      // The live session is already at generation 1; replaying it is stale.
      // (Generation 0 is malformed at the wire layer and closed outright.)
      reconnectGeneration: 1,
    }));
    const rejected = await ws2.waitForKind("session-rejected");
    expect(rejected.reason).toBe("authority_stale");
    ws2.close();
    endpoint.ws.close();
  });

  it("drops frames that would exhaust the peer queue before acceptance", async () => {
    const { entry, endpoint } = await connectPair(ROUTE_1);
    // Endpoint never acknowledges: its outstanding budget (4 MiB) fills after
    // sixteen ~256 KiB payloads; the next frame must be refused pre-acceptance.
    const payload = randomCiphertext(262000);
    for (let seq = 1; seq <= 16; seq += 1) {
      entry.ws.send(frameMessage(String(entry.admitted.sessionId), ROUTE_1, seq, payload));
    }
    for (let seq = 1; seq <= 16; seq += 1) {
      const received = await endpoint.ws.waitForKind("frame", 15_000);
      expect(received.seq).toBe(seq);
    }
    const before = await (await adminGet(`/admin/counters/session/${TENANT_A}/${ROUTE_1}`)).json() as { counters: Record<string, number> };
    entry.ws.send(frameMessage(String(entry.admitted.sessionId), ROUTE_1, 17, payload));
    const after = await (await adminGet(`/admin/counters/session/${TENANT_A}/${ROUTE_1}`)).json() as { counters: Record<string, number> };
    expect(after.counters.framesDropped).toBeGreaterThan(before.counters.framesDropped);
    entry.ws.close();
    endpoint.ws.close();
  });

  it("admits recovery routing only on a recover_device session", async () => {
    const entry = await enroll(TENANT_A, "dev.test.fresh.recov", ROUTE_1, "entry");
    const endpoint = await enroll(TENANT_A, "dev.test.endpoint.recov", ROUTE_1, "endpoint");
    const entryWs = await WsClient.connect(TENANT_A, ROUTE_1, entry.credential);
    const endpointWs = await WsClient.connect(TENANT_A, ROUTE_1, endpoint.credential);
    entryWs.send(sessionOpenMessage({ purpose: "recover_device", admission: admissionFor(entry) }));
    endpointWs.send(sessionOpenMessage({ purpose: "recover_device", admission: admissionFor(endpoint) }));
    const admitted = await entryWs.waitForKind("session-admitted");
    const endpointAdmitted = await endpointWs.waitForKind("session-admitted");
    expect((admitted.limits as Record<string, number>).maxBufferedFrames).toBe(32);
    expect((endpointAdmitted.limits as Record<string, number>).maxMessageRatePerSecond).toBe(16);

    // A recovery-kind message is forwarded opaquely to the endpoint.
    entryWs.send(recoveryRequestMessage({
      endpointRouteId: ROUTE_1,
      freshDeviceId: "dev.test.fresh.recov",
      freshDevicePublicKey: "pk_test_fresh_device_0001",
    }));
    const forwarded = await endpointWs.waitForKind("recovery-request");
    expect(forwarded.endpointRouteId).toBe(ROUTE_1);

    // A normal frame on the recovery channel is refused.
    const entryWs2 = await WsClient.connect(TENANT_A, ROUTE_1, entry.credential);
    const closePromise = entryWs2.closed;
    entryWs2.send(sessionOpenMessage({ purpose: "recover_device", admission: admissionFor(entry) }));
    await entryWs2.waitForKind("session-admitted");
    entryWs2.send(frameMessage(String(admitted.sessionId), ROUTE_1, 1, randomCiphertext(16)));
    const closed = await closePromise;
    expect([4000]).toContain(closed.code);
    entryWs.close();
    endpointWs.close();
  });

  it("expires idle pending sockets on the alarm while admitted sockets hibernate", async () => {
    const entry = await enroll(TENANT_A, "dev.test.entry.idle", ROUTE_1, "entry");
    const ws = await WsClient.connect(TENANT_A, ROUTE_1, entry.credential);
    await openSession(ws, entry);
    // A second socket that upgrades but never opens a session stays pending
    // and is the only kind an idle close applies to — admitted sockets
    // hibernate at zero duration cost, so silence must not kill them.
    const pending = await WsClient.connect(TENANT_A, ROUTE_1, entry.credential);
    const stub = env.RELAY_SESSION.get(env.RELAY_SESSION.idFromName(sessionObjectName(TENANT_A, ROUTE_1)));
    await runInDurableObject(stub, (instance: unknown) => {
      (instance as unknown as { __testForceIdleAll(): void }).__testForceIdleAll();
    });
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);
    const closed = await pending.closed;
    expect(closed.code).toBe(4004);
    // The admitted socket survived the same alarm and still answers queries.
    ws.send({
      schemaVersion: "v0.0.1:private-relay:wire-1",
      wireProtocol: "meshrix-private-relay/0",
      kind: "route-query",
      routeId: ROUTE_1,
    });
    const status = await ws.waitForKind("route-status");
    expect(status.routeId).toBe(ROUTE_1);
    ws.close();
  });
});
