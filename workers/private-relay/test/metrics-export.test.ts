/**
 * /admin/metrics Prometheus exposition tests on real local Workerd:
 * exposition format, fan-out aggregation across object kinds, durable vs
 * ephemeral scope honesty, admin auth, bounded tenant-scoped enumeration
 * and the counters-and-opaque-ids-only privacy invariant. All synthetic.
 */

import { afterEach, describe, expect, it } from "vitest";
import { SELF, env, reset } from "cloudflare:test";

import { RELAY_RUNTIME_LIMITS } from "../src/env.ts";
import { directoryObjectName } from "../src/ids.ts";
import { RELAY_COUNTER_KEYS, counterMetricName, counterScope } from "../src/metrics.ts";
import {
  type Enrolled,
  ADMIN_TOKEN,
  RELAY_ORIGIN,
  ROUTE_1,
  ROUTE_2,
  TENANT_A,
  TENANT_B,
  VAULT_1,
  WsClient,
  adminGet,
  enroll,
  frameMessage,
  freshPeerId,
  generateVaultKeys,
  makeSnapshot,
  peerEnvelopeObject,
  peerSendMessage,
  provisionVault,
  randomCiphertext,
  sessionOpenMessage,
  sha256Hex,
  vaultFetchMessage,
  vaultPost,
  vaultWriteMessage,
} from "./helpers.ts";

afterEach(async () => {
  await reset();
});

function admissionFor(enrolled: Enrolled): Record<string, unknown> {
  return {
    tenantId: TENANT_A,
    deviceId: enrolled.deviceId,
    routeId: enrolled.routeId,
    role: enrolled.role,
    mode: "personal",
    admissionGeneration: enrolled.admissionGeneration,
    revocationRevision: enrolled.revocationRevision,
  };
}

// ---------------------------------------------------------------------------
// Exposition parsing: strict-enough reader for `text/plain; version=0.0.4`.
// ---------------------------------------------------------------------------

interface ParsedSample {
  metric: string;
  labels: Record<string, string>;
  value: number;
}

const KNOWN_METRICS = new Set(RELAY_COUNTER_KEYS.map(counterMetricName));
const KEY_BY_METRIC = new Map(RELAY_COUNTER_KEYS.map((key) => [counterMetricName(key), key]));

function parseExposition(text: string): { samples: ParsedSample[] } {
  const help = new Set<string>();
  const type = new Map<string, string>();
  const samples: ParsedSample[] = [];
  const lines = text.split("\n");
  // The exposition must end with exactly one trailing newline.
  expect(lines[lines.length - 1]).toBe("");
  for (const [index, line] of lines.slice(0, -1).entries()) {
    const helpMatch = line.match(/^# HELP ([a-zA-Z_:][a-zA-Z0-9_:]*) .+$/u);
    if (helpMatch) {
      help.add(helpMatch[1]);
      continue;
    }
    const typeMatch = line.match(/^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) (\w+)$/u);
    if (typeMatch) {
      type.set(typeMatch[1], typeMatch[2]);
      continue;
    }
    const sampleMatch = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\{([^}]*)\} (\d+)$/u);
    expect(sampleMatch, `unparseable exposition line ${index}: ${line}`).not.toBeNull();
    const labels: Record<string, string> = {};
    for (const part of sampleMatch![2].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
      labels[part[1]] = part[2];
    }
    // The parsed pairs must reconstruct the whole {...} block: no duplicate
    // keys, no unquoted values, no trailing junk inside the braces.
    expect(sampleMatch![2]).toBe(Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(","));
    samples.push({ metric: sampleMatch![1], labels, value: Number(sampleMatch![3]) });
  }
  // Every declared counter metric carries both HELP and TYPE= counter lines.
  expect(help).toEqual(KNOWN_METRICS);
  expect(new Set(type.keys())).toEqual(KNOWN_METRICS);
  for (const metricType of type.values()) expect(metricType).toBe("counter");
  return { samples };
}

/** Distinct label-set count for one object class across all metrics. */
function labelSetsFor(samples: ParsedSample[], object: string): Set<string> {
  return new Set(
    samples
      .filter((sample) => sample.labels.object === object)
      .map((sample) => `${sample.labels.route}/${sample.labels.device}`),
  );
}

function sampleValue(samples: ParsedSample[], metric: string, labels: Record<string, string>): number {
  const match = samples.find(
    (sample) => sample.metric === metric
      && Object.entries(labels).every(([key, value]) => sample.labels[key] === value),
  );
  return match?.value ?? -1;
}

async function connectAdmittedPair(routeId: string): Promise<{ entry: { enrolled: Enrolled; ws: WsClient; admitted: Record<string, unknown> }; endpoint: { enrolled: Enrolled; ws: WsClient; admitted: Record<string, unknown> } }> {
  const entry = await enroll(TENANT_A, `dev.test.mx.entry.${Math.random().toString(36).slice(2, 8)}`, routeId, "entry");
  const endpoint = await enroll(TENANT_A, `dev.test.mx.endpoint.${Math.random().toString(36).slice(2, 8)}`, routeId, "endpoint");
  const [entryWs, endpointWs] = await Promise.all([
    WsClient.connect(TENANT_A, routeId, entry.credential),
    WsClient.connect(TENANT_A, routeId, endpoint.credential),
  ]);
  entryWs.send(sessionOpenMessage({ purpose: "forward", admission: admissionFor(entry) }));
  endpointWs.send(sessionOpenMessage({ purpose: "forward", admission: admissionFor(endpoint) }));
  const [entryAdmitted, endpointAdmitted] = await Promise.all([
    entryWs.waitForKind("session-admitted"),
    endpointWs.waitForKind("session-admitted"),
  ]);
  return {
    entry: { enrolled: entry, ws: entryWs, admitted: entryAdmitted },
    endpoint: { enrolled: endpoint, ws: endpointWs, admitted: endpointAdmitted },
  };
}

describe("admin metrics exposition", () => {
  it("rejects unauthenticated requests and malformed parameters", async () => {
    const unauthenticated = await SELF.fetch(`${RELAY_ORIGIN}/admin/metrics?tenant=${TENANT_A}`);
    expect(unauthenticated.status).toBe(401);
    const wrongToken = await SELF.fetch(`${RELAY_ORIGIN}/admin/metrics?tenant=${TENANT_A}`, {
      headers: { authorization: "Bearer wrong-synthetic-admin-token" },
    });
    expect(wrongToken.status).toBe(401);

    expect((await adminGet("/admin/metrics")).status).toBe(400);
    expect((await adminGet(`/admin/metrics?tenant=${encodeURIComponent("bad tenant!!")}`)).status).toBe(400);
    expect((await adminGet(`/admin/metrics?tenant=${TENANT_A}&vault=${encodeURIComponent("bad vault!!")}`)).status).toBe(400);
    // The token is honored — the route is not accidentally public.
    expect((await adminGet(`/admin/metrics?tenant=${TENANT_A}`)).status).toBe(200);
  });

  it("emits a parseable exposition aggregating all object kinds with honest scopes", async () => {
    const { entry, endpoint } = await connectAdmittedPair(ROUTE_1);
    // A second route with one enrolled device widens fan-out coverage.
    const solo = await enroll(TENANT_A, "dev.test.mx.solo", ROUTE_2, "entry");

    // Real session traffic and a peer-send into the endpoint's partition.
    entry.ws.send(frameMessage(String(entry.admitted.sessionId), ROUTE_1, 1, randomCiphertext(32)));
    await endpoint.ws.waitForKind("frame");
    entry.ws.send(peerSendMessage(
      TENANT_A, ROUTE_1, entry.enrolled.deviceId, endpoint.enrolled.deviceId,
      freshPeerId(), peerEnvelopeObject(),
    ));
    await entry.ws.waitForKind("peer-accepted");

    // Vault object: provision + commit + one recovery-proof fetch.
    const writer = await generateVaultKeys("wkey.test.mx");
    const recovery = await generateVaultKeys("rckey.test.mx");
    const provisioned = await provisionVault(VAULT_1, [writer], {
      keyId: recovery.keyId, algorithm: recovery.algorithm, publicKey: recovery.publicKey,
    }, 3);
    expect(provisioned.ok).toBe(true);
    const snapshot = makeSnapshot(VAULT_1, 3, 1, randomCiphertext(48), {
      keyId: recovery.keyId, algorithm: recovery.algorithm, publicKey: recovery.publicKey,
    });
    const committed = await vaultPost(VAULT_1, await vaultWriteMessage(VAULT_1, writer, 0, snapshot));
    expect(committed.body.outcome).toBe("committed");
    const fetched = await vaultPost(VAULT_1, await vaultFetchMessage(VAULT_1, recovery));
    expect(fetched.status).toBe(200);

    // The same vault id twice exercises deduplication of the vault fan-out.
    const response = await adminGet(`/admin/metrics?tenant=${TENANT_A}&vault=${VAULT_1}&vault=${VAULT_1}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("content-type")).toContain("version=0.0.4");
    const { samples } = parseExposition(await response.text());

    for (const sample of samples) {
      // Fixed label set, fixed enumerations, tenant pinned to the query.
      expect(Object.keys(sample.labels).sort()).toEqual(["device", "object", "route", "scope", "tenant"]);
      expect(sample.labels.tenant).toBe(TENANT_A);
      expect(sample.labels.object).toMatch(/^(session|mailbox|directory|vault)$/u);
      // The scope label is the counter's real tier — never both for one key.
      const key = KEY_BY_METRIC.get(sample.metric);
      expect(key).toBeDefined();
      expect(sample.labels.scope).toBe(counterScope(key!));
      if (sample.labels.object === "mailbox") {
        expect(sample.labels.device).not.toBe("");
      } else {
        expect(sample.labels.device).toBe("");
      }
      if (sample.labels.object === "session" || sample.labels.object === "mailbox") {
        expect(sample.labels.route).not.toBe("");
      } else {
        expect(sample.labels.route).toBe("");
      }
    }

    // Bounded fan-out: exactly the enumerated objects appear — one directory,
    // two session routes, three mailbox partitions, one summed vault series.
    expect(labelSetsFor(samples, "directory")).toEqual(new Set(["/"]));
    expect(labelSetsFor(samples, "session")).toEqual(new Set([`${ROUTE_1}/`, `${ROUTE_2}/`]));
    expect(labelSetsFor(samples, "mailbox")).toEqual(new Set([
      `${ROUTE_1}/${entry.enrolled.deviceId}`,
      `${ROUTE_1}/${endpoint.enrolled.deviceId}`,
      `${ROUTE_2}/${solo.deviceId}`,
    ]));
    expect(labelSetsFor(samples, "vault")).toEqual(new Set(["/"]));

    // Real counts, correct tier: session admission is durable, per-frame
    // forwarding is ephemeral, mailbox acceptance is durable.
    expect(sampleValue(samples, "meshrix_relay_sessions_admitted", {
      object: "session", route: ROUTE_1, device: "", scope: "durable",
    })).toBe(2);
    expect(sampleValue(samples, "meshrix_relay_frames_forwarded", {
      object: "session", route: ROUTE_1, device: "", scope: "ephemeral",
    })).toBeGreaterThanOrEqual(1);
    expect(sampleValue(samples, "meshrix_relay_mailbox_accepted", {
      object: "mailbox", route: ROUTE_1, device: endpoint.enrolled.deviceId, scope: "durable",
    })).toBe(1);
    expect(sampleValue(samples, "meshrix_relay_vault_writes_committed", {
      object: "vault", route: "", device: "", scope: "durable",
    })).toBe(1);
    expect(sampleValue(samples, "meshrix_relay_vault_fetches", {
      object: "vault", route: "", device: "", scope: "durable",
    })).toBeGreaterThanOrEqual(1);
    // The scrape itself counts on the directory: reads served (ephemeral
    // httpRequests) and the flushed counter write (durable storageWrites).
    expect(sampleValue(samples, "meshrix_relay_http_requests", {
      object: "directory", route: "", device: "", scope: "ephemeral",
    })).toBeGreaterThanOrEqual(1);
    expect(sampleValue(samples, "meshrix_relay_storage_writes", {
      object: "directory", route: "", device: "", scope: "durable",
    })).toBeGreaterThanOrEqual(1);

    entry.ws.close();
    endpoint.ws.close();
  });

  it("scopes fan-out to the queried tenant only", async () => {
    await enroll(TENANT_A, "dev.test.mx.tenA", ROUTE_1, "entry");
    await enroll(TENANT_B, "dev.test.mx.tenB", ROUTE_1, "entry");

    const { samples } = parseExposition(await (await adminGet(`/admin/metrics?tenant=${TENANT_A}`)).text());
    for (const sample of samples) expect(sample.labels.tenant).toBe(TENANT_A);
    expect(labelSetsFor(samples, "session")).toEqual(new Set([`${ROUTE_1}/`]));
    expect(labelSetsFor(samples, "mailbox")).toEqual(new Set([`${ROUTE_1}/dev.test.mx.tenA`]));
    // Tenant B's enrollment never leaks into tenant A's exposition.
    const otherTenant = await (await adminGet(`/admin/metrics?tenant=${TENANT_B}`)).text();
    expect(otherTenant).toContain(`tenant="${TENANT_B}"`);
    expect(otherTenant).not.toContain(TENANT_A);
  });

  it("bounds the vault fan-out and sums explicit vaults into one series", async () => {
    // 300 distinct explicit ids exceed the fan-out slice bound; the
    // exposition must stay inside it and still emit one merged vault series.
    const params = new URLSearchParams({ tenant: TENANT_A });
    for (let i = 0; i < 300; i += 1) params.append("vault", `v.test.mx.${i}`);
    const response = await adminGet(`/admin/metrics?${params.toString()}`);
    expect(response.status).toBe(200);
    const { samples } = parseExposition(await response.text());
    // Vault label sets are unique per metric (summed, never duplicated).
    expect(labelSetsFor(samples, "vault")).toEqual(new Set(["/"]));
    const vaultFetches = samples.filter(
      (sample) => sample.metric === "meshrix_relay_vault_fetches" && sample.labels.object === "vault",
    );
    expect(vaultFetches).toHaveLength(1);
    expect(vaultFetches[0].labels.scope).toBe("durable");
    // Bounded fan-out: each scraped object counts its own /internal/counters
    // request (ephemeral httpRequests=1 at snapshot time), so the summed
    // series is exactly the number of objects scraped — the slice bound,
    // not the 300 requested ids.
    expect(sampleValue(samples, "meshrix_relay_http_requests", {
      object: "vault", route: "", device: "", scope: "ephemeral",
    })).toBe(RELAY_RUNTIME_LIMITS.maxRoutesPerTenant);
  });

  it("exposes counters and opaque ids only — no secrets, proofs or payload material", async () => {
    const { entry, endpoint } = await connectAdmittedPair(ROUTE_1);
    const payload = randomCiphertext(64);
    const envelope = peerEnvelopeObject();
    entry.ws.send(frameMessage(String(entry.admitted.sessionId), ROUTE_1, 1, payload));
    await endpoint.ws.waitForKind("frame");
    entry.ws.send(peerSendMessage(
      TENANT_A, ROUTE_1, entry.enrolled.deviceId, endpoint.enrolled.deviceId,
      freshPeerId(), envelope,
    ));
    await entry.ws.waitForKind("peer-accepted");

    const writer = await generateVaultKeys("wkey.test.pv");
    const recovery = await generateVaultKeys("rckey.test.pv");
    await provisionVault(VAULT_1, [writer], {
      keyId: recovery.keyId, algorithm: recovery.algorithm, publicKey: recovery.publicKey,
    }, 3);
    const snapshot = makeSnapshot(VAULT_1, 3, 1, randomCiphertext(48), {
      keyId: recovery.keyId, algorithm: recovery.algorithm, publicKey: recovery.publicKey,
    });
    await vaultPost(VAULT_1, await vaultWriteMessage(VAULT_1, writer, 0, snapshot));

    const text = await (await adminGet(`/admin/metrics?tenant=${TENANT_A}&vault=${VAULT_1}`)).text();

    // Literal secret/material values used in this run must never appear.
    const forbiddenValues = [
      entry.enrolled.credential,
      endpoint.enrolled.credential,
      await sha256Hex(entry.enrolled.credential),
      payload,
      envelope.ciphertext as string,
      writer.publicKey,
      recovery.publicKey,
      ADMIN_TOKEN,
    ];
    for (const value of forbiddenValues) {
      expect(text.includes(value), `exposition leaked material: ${value.slice(0, 12)}…`).toBe(false);
    }
    // No forbidden string class anywhere in names, labels or help text.
    expect(/signature|credential|privatekey|secret|token|nonce|plaintext|apikey|authorization|bearer|digest|ciphertext/iu.test(text)).toBe(false);
    entry.ws.close();
    endpoint.ws.close();
  });

  it("exposes the bounded directory inventory used for fan-out", async () => {
    const entry = await enroll(TENANT_A, "dev.test.mx.inv1", ROUTE_1, "entry");
    const endpoint = await enroll(TENANT_A, "dev.test.mx.inv2", ROUTE_1, "endpoint");
    const solo = await enroll(TENANT_A, "dev.test.mx.inv3", ROUTE_2, "entry");

    const stub = env.RELAY_DIRECTORY.get(env.RELAY_DIRECTORY.idFromName(directoryObjectName(TENANT_A)));
    const response = await stub.fetch("http://directory.internal/internal/inventory");
    expect(response.ok).toBe(true);
    const inventory = await response.json() as { routes: string[]; devices: { routeId: string; deviceId: string }[] };
    expect([...inventory.routes].sort()).toEqual([ROUTE_1, ROUTE_2].sort());
    expect(new Set(inventory.devices.map((device) => device.deviceId))).toEqual(
      new Set([entry.deviceId, endpoint.deviceId, solo.deviceId]),
    );
    for (const device of inventory.devices) expect(inventory.routes).toContain(device.routeId);
  });
});
