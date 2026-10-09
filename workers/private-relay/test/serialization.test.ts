/**
 * Secret-free serialization checks: after real traffic, every persisted
 * record and every hibernation attachment is scanned for contract-forbidden
 * keys, proof secrets, credentials and frame payload bytes.
 */

import { afterEach, describe, expect, it } from "vitest";
import { env, listDurableObjectIds, reset, runInDurableObject } from "cloudflare:test";

import {
  containsForbiddenRelayKeys,
  containsForbiddenSnapshotKeys,
} from "../../../packages/contracts/src/private-relay/index.ts";
import { sessionObjectName } from "../src/ids.ts";
import {
  ROUTE_1,
  TENANT_A,
  VAULT_1,
  WsClient,
  enroll,
  frameMessage,
  generateVaultKeys,
  makeSnapshot,
  provisionVault,
  randomCiphertext,
  sessionOpenMessage,
  vaultFetchMessage,
  vaultPost,
  vaultWriteMessage,
} from "./helpers.ts";

afterEach(async () => {
  await reset();
});

const SECRET_FIELD_NAMES = /signature|credential|privateKey|secret|token|nonce|plaintext|apiKey|authorization/iu;
// One-way digests are hash outputs used as lookup/compare values, never the
// secret itself (credentialDigest, snapshotDigest, nonce digests).
const DIGEST_FIELD_ALLOWLIST = /digest$/iu;

function scanRecord(value: unknown, label: string, problems: string[]): void {
  if (!value || typeof value !== "object") return;
  if (containsForbiddenRelayKeys(value)) problems.push(`${label}: relay-forbidden key present`);
  if (containsForbiddenSnapshotKeys(value)) problems.push(`${label}: snapshot-forbidden key present`);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (SECRET_FIELD_NAMES.test(key) && !DIGEST_FIELD_ALLOWLIST.test(key)) {
      problems.push(`${label}: suspicious field "${key}"`);
    }
  }
}

async function dumpStorage(ns: DurableObjectNamespace): Promise<Map<string, unknown>> {
  const ids = await listDurableObjectIds(ns);
  const result = new Map<string, unknown>();
  for (const id of ids) {
    const target = ns.get(id);
    await runInDurableObject(target, async (_instance: unknown, state: DurableObjectState) => {
      const entries = await state.storage.list();
      for (const [key, value] of entries) result.set(key, value);
    });
  }
  return result;
}

describe("secret-free serialization", () => {
  it("keeps frames, credentials, nonces and signatures out of durable state and attachments", async () => {
    // Real traffic first: enroll, admit, forward a recognizable payload.
    const entry = await enroll(TENANT_A, "dev.test.entry.scan", ROUTE_1, "entry");
    const endpoint = await enroll(TENANT_A, "dev.test.endpoint.scan", ROUTE_1, "endpoint");
    const entryWs = await WsClient.connect(TENANT_A, ROUTE_1, entry.credential);
    const endpointWs = await WsClient.connect(TENANT_A, ROUTE_1, endpoint.credential);
    const admission = (e: { deviceId: string; routeId: string; role: string; admissionGeneration: number; revocationRevision: number }) => ({
      tenantId: TENANT_A,
      deviceId: e.deviceId,
      routeId: e.routeId,
      role: e.role,
      mode: "personal",
      admissionGeneration: e.admissionGeneration,
      revocationRevision: e.revocationRevision,
    });
    entryWs.send(sessionOpenMessage({ purpose: "forward", admission: admission(entry) }));
    endpointWs.send(sessionOpenMessage({ purpose: "forward", admission: admission(endpoint) }));
    const entryAdmitted = await entryWs.waitForKind("session-admitted");
    await endpointWs.waitForKind("session-admitted");

    const markerPayload = "U0VDUkVUTUFSS0VSLUZPUi1TQ0FO";
    entryWs.send(frameMessage(String(entryAdmitted.sessionId), ROUTE_1, 1, markerPayload));
    await endpointWs.waitForKind("frame");

    // Vault traffic: provision, write, fetch (nonces and signatures flow).
    const writer = await generateVaultKeys("wkey.scan.1");
    const recovery = await generateVaultKeys("rckey.scan.1");
    await provisionVault(VAULT_1, [writer], {
      keyId: recovery.keyId, algorithm: recovery.algorithm, publicKey: recovery.publicKey,
    }, 3);
    const snapshot = makeSnapshot(VAULT_1, 3, 1, randomCiphertext(64), {
      keyId: recovery.keyId, algorithm: recovery.algorithm, publicKey: recovery.publicKey,
    });
    const write = await vaultWriteMessage(VAULT_1, writer, 0, snapshot);
    await vaultPost(VAULT_1, write);
    const fetch = await vaultFetchMessage(VAULT_1, recovery);
    await vaultPost(VAULT_1, fetch);

    const problems: string[] = [];

    // Session DO: all persisted records + live hibernation attachments.
    const sessionStub = env.RELAY_SESSION.get(env.RELAY_SESSION.idFromName(sessionObjectName(TENANT_A, ROUTE_1)));
    await runInDurableObject(sessionStub, async (_instance: unknown, state: DurableObjectState) => {
      const records = await state.storage.list();
      for (const [key, value] of records) scanRecord(value, `session:${key}`, problems);
      for (const ws of state.getWebSockets()) {
        const attachment = ws.deserializeAttachment();
        scanRecord(attachment, "session:attachment", problems);
        const serialized = JSON.stringify(attachment);
        if (serialized.includes(entry.credential) || serialized.includes(endpoint.credential)) {
          problems.push("session:attachment: credential leaked into attachment");
        }
      }
    });

    // Directory + vault DO: all persisted records.
    for (const [key, value] of await dumpStorage(env.RELAY_DIRECTORY)) {
      scanRecord(value, `directory:${key}`, problems);
    }
    for (const [key, value] of await dumpStorage(env.RECOVERY_VAULT)) {
      scanRecord(value, `vault:${key}`, problems);
    }

    // Frame payload bytes must not be persisted anywhere.
    const sessionDump = await runInDurableObject(sessionStub, async (_instance: unknown, state: DurableObjectState) => {
      const records = await state.storage.list();
      return JSON.stringify([...records.entries()]);
    });
    expect(sessionDump.includes(markerPayload)).toBe(false);

    // Nonce digests exist but the raw proof nonce never does.
    const vaultDump = await dumpStorage(env.RECOVERY_VAULT);
    const vaultJson = JSON.stringify([...vaultDump.entries()]);
    expect(vaultJson.includes((fetch.fetchProof as { nonce: string }).nonce)).toBe(false);
    expect(vaultJson.includes((fetch.fetchProof as { signature: string }).signature)).toBe(false);

    expect(problems).toEqual([]);
    entryWs.close();
    endpointWs.close();
  });
});
