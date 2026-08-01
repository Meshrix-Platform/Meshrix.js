import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SANDBOX_CUSTODY_PROMOTION_SCHEMA
} from "../../../packages/foundation/src/execution-sandbox/custody-contracts.ts";
import {
  SANDBOX_PROVIDER_CONFORMANCE_SCHEMA
} from "../../../packages/foundation/src/execution-sandbox/contracts.ts";
import { createLocalCustodyKeyBroker } from "../../../packages/server-runtime/src/execution-sandbox/custody-key-broker.ts";
import {
  createOpaqueSandboxCustodyRuntime
} from "../../../packages/server-runtime/src/execution-sandbox/opaque-custody.ts";
import { createStorageKernel } from "../../../packages/foundation/src/storage/storage-kernel.ts";
import { createStorageProvider } from "../../../packages/foundation/src/storage/storage-provider.ts";

const roots: any[] = [];
const kernels: any[] = [];

async function tempRoot() : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-custody-test-"));
  roots.push(root);
  return root;
}

afterEach(async () : Promise<any> => {
  for (const kernel of kernels.splice(0)) kernel.close();
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

function sha256(value?: any) : any {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function storageFixture(root?: any) : any {
  const storageKernel: any = createStorageKernel({ userDataPath: root });
  kernels.push(storageKernel);
  return {
    storageKernel,
    storageProvider: createStorageProvider({ userDataPath: root, storageKernel })
  };
}

async function *source(bytes?: any) : AsyncGenerator<any, any, any> {
  yield bytes.subarray(0, 3);
  yield bytes.subarray(3);
}

function promotion(stored?: any, overrides: Record<string, any> = {}) : any {
  const policyRevision: any = "policy-current";
  return {
    schemaVersion: SANDBOX_CUSTODY_PROMOTION_SCHEMA,
    handle: stored.handle,
    contentDigest: stored.contentDigest,
    envelopeDigest: stored.envelopeDigest,
    authorizationRef: "grant:current",
    approvalRef: "approval:current",
    policyRevision,
    sandboxAvailable: true,
    providerReceipt: {
      schemaVersion: SANDBOX_PROVIDER_CONFORMANCE_SCHEMA,
      providerId: "docker-fixed",
      policyRevision,
      status: "passed",
      digest: "a".repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    },
    idempotencyKey: "promotion:fixture",
    subjectRef: "subject:fixture",
    tenantRef: "tenant:fixture",
    workspaceRef: "workspace:fixture",
    ...overrides
  };
}

describe("opaque sandbox custody", () : any => {
  it("binds seal idempotency replay to the exact owner and request contract", async () : Promise<any> => {
    const root: any = await tempRoot();
    const { storageKernel, storageProvider } = storageFixture(root);
    const keyBroker: any = createLocalCustodyKeyBroker({ userDataPath: root });
    const { custody } = createOpaqueSandboxCustodyRuntime({ userDataPath: root, storageKernel, storageProvider, keyBroker });
    const ownerBinding: Record<string, any> = {
      subjectRef: "subject:fixture",
      tenantRef: "tenant:fixture",
      workspaceRef: "workspace:fixture"
    };
    const bytes: any = Buffer.from("idempotent-custody-payload", "utf8");
    const stored: any = await custody.store({
      source: source(bytes),
      mediaType: "application/octet-stream",
      maxBytes: 4096,
      idempotencyKey: "seal:idempotency-binding",
      ownerBinding
    });
    let replaySourceConsumed: any = false;
    const replayed: any = await custody.store({
      source: (async function *replaySource() : AsyncGenerator<any, any, any> {
        replaySourceConsumed = true;
        yield Buffer.from("different-content-that-must-not-be-consumed", "utf8");
      })(),
      mediaType: "application/octet-stream",
      maxBytes: 4096,
      idempotencyKey: "seal:idempotency-binding",
      ownerBinding
    });

    expect(replayed).toMatchObject({
      handle: stored.handle,
      contentDigest: stored.contentDigest,
      envelopeDigest: stored.envelopeDigest,
      state: "stored_no_run",
      replayed: true
    });
    expect(replaySourceConsumed).toBe(false);

    await expect(custody.store({
      source: source(bytes),
      mediaType: "application/octet-stream",
      maxBytes: 4096,
      idempotencyKey: "seal:idempotency-binding",
      ownerBinding: { ...ownerBinding, subjectRef: "subject:other" }
    })).rejects.toMatchObject({ code: "custody_seal_idempotency_conflict" });

    await expect(custody.store({
      source: source(bytes),
      mediaType: "application/json",
      maxBytes: 4096,
      idempotencyKey: "seal:idempotency-binding",
      ownerBinding
    })).rejects.toMatchObject({ code: "custody_seal_idempotency_conflict" });

    await expect(custody.store({
      source: source(bytes),
      mediaType: "application/octet-stream",
      maxBytes: 8192,
      idempotencyKey: "seal:idempotency-binding",
      ownerBinding
    })).rejects.toMatchObject({ code: "custody_seal_idempotency_conflict" });

    const row: any = storageKernel.db.prepare(`
      SELECT seal_request_digest, owner_subject_ref, tenant_ref, workspace_ref
      FROM opaque_custody_artifacts WHERE custody_ref = ?
    `).get(stored.handle);
    expect(row).toMatchObject({
      owner_subject_ref: ownerBinding.subjectRef,
      tenant_ref: ownerBinding.tenantRef,
      workspace_ref: ownerBinding.workspaceRef
    });
    expect(row.seal_request_digest).toMatch(/^[a-f0-9]{64}$/u);
    await keyBroker.close();
  });

  it("persists only authenticated ciphertext and releases plaintext only through explicit promotion", async () : Promise<any> => {
    const root: any = await tempRoot();
    const { storageKernel, storageProvider } = storageFixture(root);
    const keyBroker: any = createLocalCustodyKeyBroker({ userDataPath: root });
    const { custody, promotionAuthority } = createOpaqueSandboxCustodyRuntime({
      userDataPath: root, storageKernel, storageProvider, keyBroker
    });
    expect(custody).not.toHaveProperty("promote");
    const plaintext: any = Buffer.from("executable-custody-payload", "utf8");

    const stored: any = await custody.store({
      source: source(plaintext),
      mediaType: "application/octet-stream",
      idempotencyKey: "seal:fixture",
      ownerBinding: {
        subjectRef: "subject:fixture",
        tenantRef: "tenant:fixture",
        workspaceRef: "workspace:fixture"
      }
    });
    expect(custody.status(stored.handle)).toMatchObject({
      state: "stored_no_run",
      contentDigest: sha256(plaintext)
    });
    const object: any = storageProvider.getObject(stored.handle.slice("custody:".length));
    const persisted: any = await fs.readFile(storageProvider.resolveStoredObjectPath(object.storageRelativePath));
    expect(persisted.includes(plaintext)).toBe(false);

    const promotionRequest: any = promotion(stored, { approvalRef: "" });
    await expect(promotionAuthority.promote(promotionRequest, async () : Promise<any> => {
      throw new Error("initial sandbox input staging failed");
    })).rejects.toMatchObject({ code: "custody_envelope_authentication_failed" });
    expect(storageKernel.db.prepare(`
      SELECT state FROM opaque_custody_promotions WHERE idempotency_key = ?
    `).get("promotion:fixture")).toEqual({ state: "failed" });
    const released: any[] = [];
    const receipt: any = await promotionAuthority.promote(promotionRequest, async (chunk?: any) : Promise<any> => {
      released.push(Buffer.from(chunk));
    });
    expect(Buffer.concat(released)).toEqual(plaintext);
    expect(receipt).toMatchObject({
      promotionState: "released_to_sandbox_input",
      contentDigest: sha256(plaintext)
    });
    await expect(promotionAuthority.promote(promotionRequest, async () : Promise<any> => {
      throw new Error("sandbox input staging failed");
    })).rejects.toMatchObject({ code: "custody_envelope_authentication_failed" });
    const replayed: any[] = [];
    const replayReceipt: any = await promotionAuthority.promote(promotionRequest, async (chunk?: any) : Promise<any> => {
      replayed.push(Buffer.from(chunk));
    });
    expect(Buffer.concat(replayed)).toEqual(plaintext);
    expect(replayReceipt).toMatchObject({
      promotionState: "replayed_release_to_sandbox_input",
      contentDigest: sha256(plaintext)
    });
    expect(storageKernel.db.prepare(`
      SELECT state, reason_code
      FROM opaque_custody_promotions
      WHERE idempotency_key = ?
    `).get("promotion:fixture")).toEqual({ state: "released", reason_code: "" });
    const encryptedDownload: any[] = [];
    for await (const chunk of custody.downloadEnvelope(stored.handle, {
      subjectRef: "subject:fixture",
      tenantRef: "tenant:fixture",
      workspaceRef: "workspace:fixture"
    })) encryptedDownload.push(chunk);
    expect(Buffer.concat(encryptedDownload).includes(plaintext)).toBe(false);
    await expect(custody.delete({
      handle: stored.handle,
      authorizationRef: "grant:delete",
      ownerBinding: {
        subjectRef: "subject:fixture",
        tenantRef: "tenant:fixture",
        workspaceRef: "workspace:fixture"
      }
    })).resolves.toEqual({ handle: stored.handle, state: "deleted" });
    expect(custody.status(stored.handle).state).toBe("deleted");
    expect(await fs.stat(storageProvider.resolveStoredObjectPath(object.storageRelativePath)).catch(() : any => null)).toBeNull();
    await keyBroker.close();
  });

  it("denies stale governance, digest mismatch, and tampering before releasing plaintext", async () : Promise<any> => {
    const root: any = await tempRoot();
    const { storageKernel, storageProvider } = storageFixture(root);
    const keyBroker: any = createLocalCustodyKeyBroker({ userDataPath: root });
    const { custody, promotionAuthority } = createOpaqueSandboxCustodyRuntime({
      userDataPath: root, storageKernel, storageProvider, keyBroker
    });
    const stored: any = await custody.store({
      source: source(Buffer.from("opaque", "utf8")),
      idempotencyKey: "seal:tamper",
      ownerBinding: {
        subjectRef: "subject:fixture",
        tenantRef: "tenant:fixture",
        workspaceRef: "workspace:fixture"
      }
    });
    let released: any = 0;

    await expect(promotionAuthority.promote(promotion(stored, {
      sandboxAvailable: false
    }), async () : Promise<any> => { released += 1; })).rejects.toThrow("ready sandbox");
    await expect(promotionAuthority.promote(promotion(stored, {
      contentDigest: "b".repeat(64)
    }), async () : Promise<any> => { released += 1; })).rejects.toMatchObject({ code: "custody_promotion_digest_mismatch" });

    const object: any = storageProvider.getObject(stored.handle.slice("custody:".length));
    const objectPath: any = storageProvider.resolveStoredObjectPath(object.storageRelativePath);
    const envelope: any = await fs.readFile(objectPath, "utf8");
    await fs.writeFile(objectPath, envelope.replace(
      /"ciphertext":"(.)/u,
      (_match?: any, first?: any) : any => `"ciphertext":"${first === "A" ? "B" : "A"}`
    ), "utf8");
    await expect(promotionAuthority.promote(promotion(stored), async () : Promise<any> => { released += 1; }))
      .rejects.toMatchObject({ code: "custody_envelope_authentication_failed" });
    expect(released).toBe(0);
    await keyBroker.close();
  });

  it("keeps wrapped data keys recoverable across broker restart without exposing the master key", async () : Promise<any> => {
    const root: any = await tempRoot();
    const first: any = createLocalCustodyKeyBroker({ userDataPath: root });
    const dataKey: any = crypto.randomBytes(32);
    const wrapped: any = await first.wrapKey(dataKey, "env_fixture");
    await first.close();
    const second: any = createLocalCustodyKeyBroker({ userDataPath: root });
    const recovered: any = await second.unwrapKey(wrapped, "env_fixture");
    expect(recovered).toEqual(dataKey);
    expect(wrapped).not.toHaveProperty("plaintextKey");
    recovered.fill(0);
    dataKey.fill(0);
    await second.close();
  });

  it("rejects truncation, frame reordering, duplicate footer, and authenticated-header mutation", async () : Promise<any> => {
    const root: any = await tempRoot();
    const { storageKernel, storageProvider } = storageFixture(root);
    const keyBroker: any = createLocalCustodyKeyBroker({ userDataPath: root });
    const { custody, promotionAuthority } = createOpaqueSandboxCustodyRuntime({
      userDataPath: root, storageKernel, storageProvider, keyBroker
    });
    const plaintext: any = Buffer.alloc(96 * 1024, 7);
    const stored: any = await custody.store({
      source: source(plaintext),
      idempotencyKey: "seal:framing",
      ownerBinding: {
        subjectRef: "subject:fixture",
        tenantRef: "tenant:fixture",
        workspaceRef: "workspace:fixture"
      }
    });
    const object: any = storageProvider.getObject(stored.handle.slice("custody:".length));
    const objectPath: any = storageProvider.resolveStoredObjectPath(object.storageRelativePath);
    const original: any = await fs.readFile(objectPath, "utf8");
    const lines: any = original.trimEnd().split("\n");
    const mutations: any[] = [
      lines.slice(0, -1).join("\n") + "\n",
      [lines[0], lines[2], lines[1], lines[3]].join("\n") + "\n",
      [...lines, lines.at(-1)].join("\n") + "\n",
      original.replace("application/octet-stream", "application/x-mutated")
    ];
    let released: any = 0;
    for (const [index, mutation] of mutations.entries()) {
      await fs.writeFile(objectPath, mutation, "utf8");
      await expect(promotionAuthority.promote(promotion(stored, {
        idempotencyKey: `promotion:framing:${index}`
      }), async () : Promise<any> => { released += 1; })).rejects.toMatchObject({
        code: "custody_envelope_authentication_failed"
      });
    }
    expect(released).toBe(0);
    await keyBroker.close();
  });
});
