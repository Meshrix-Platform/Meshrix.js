import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SANDBOX_CUSTODY_PROMOTION_SCHEMA
} from "../../../packages/foundation/src/execution-sandbox/custody-contracts.mjs";
import {
  SANDBOX_PROVIDER_CONFORMANCE_SCHEMA
} from "../../../packages/foundation/src/execution-sandbox/contracts.mjs";
import { createLocalCustodyKeyBroker } from "../../../packages/server-runtime/src/execution-sandbox/custody-key-broker.mjs";
import {
  createOpaqueSandboxCustodyRuntime
} from "../../../packages/server-runtime/src/execution-sandbox/opaque-custody.mjs";
import { createStorageKernel } from "../../../packages/foundation/src/storage/storage-kernel.mjs";
import { createStorageProvider } from "../../../packages/foundation/src/storage/storage-provider.mjs";

const roots = [];
const kernels = [];

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lico-custody-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const kernel of kernels.splice(0)) kernel.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function storageFixture(root) {
  const storageKernel = createStorageKernel({ userDataPath: root });
  kernels.push(storageKernel);
  return {
    storageKernel,
    storageProvider: createStorageProvider({ userDataPath: root, storageKernel })
  };
}

async function *source(bytes) {
  yield bytes.subarray(0, 3);
  yield bytes.subarray(3);
}

function promotion(stored, overrides = {}) {
  const policyRevision = "policy-current";
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

describe("opaque sandbox custody", () => {
  it("binds seal idempotency replay to the exact owner and request contract", async () => {
    const root = await tempRoot();
    const { storageKernel, storageProvider } = storageFixture(root);
    const keyBroker = createLocalCustodyKeyBroker({ userDataPath: root });
    const { custody } = createOpaqueSandboxCustodyRuntime({ userDataPath: root, storageKernel, storageProvider, keyBroker });
    const ownerBinding = {
      subjectRef: "subject:fixture",
      tenantRef: "tenant:fixture",
      workspaceRef: "workspace:fixture"
    };
    const bytes = Buffer.from("idempotent-custody-payload", "utf8");
    const stored = await custody.store({
      source: source(bytes),
      mediaType: "application/octet-stream",
      maxBytes: 4096,
      idempotencyKey: "seal:idempotency-binding",
      ownerBinding
    });
    let replaySourceConsumed = false;
    const replayed = await custody.store({
      source: (async function *replaySource() {
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

    const row = storageKernel.db.prepare(`
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

  it("persists only authenticated ciphertext and releases plaintext only through explicit promotion", async () => {
    const root = await tempRoot();
    const { storageKernel, storageProvider } = storageFixture(root);
    const keyBroker = createLocalCustodyKeyBroker({ userDataPath: root });
    const { custody, promotionAuthority } = createOpaqueSandboxCustodyRuntime({
      userDataPath: root, storageKernel, storageProvider, keyBroker
    });
    expect(custody).not.toHaveProperty("promote");
    const plaintext = Buffer.from("executable-custody-payload", "utf8");

    const stored = await custody.store({
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
    const object = storageProvider.getObject(stored.handle.slice("custody:".length));
    const persisted = await fs.readFile(storageProvider.resolveStoredObjectPath(object.storageRelativePath));
    expect(persisted.includes(plaintext)).toBe(false);

    const promotionRequest = promotion(stored, { approvalRef: "" });
    await expect(promotionAuthority.promote(promotionRequest, async () => {
      throw new Error("initial sandbox input staging failed");
    })).rejects.toMatchObject({ code: "custody_envelope_authentication_failed" });
    expect(storageKernel.db.prepare(`
      SELECT state FROM opaque_custody_promotions WHERE idempotency_key = ?
    `).get("promotion:fixture")).toEqual({ state: "failed" });
    const released = [];
    const receipt = await promotionAuthority.promote(promotionRequest, async (chunk) => {
      released.push(Buffer.from(chunk));
    });
    expect(Buffer.concat(released)).toEqual(plaintext);
    expect(receipt).toMatchObject({
      promotionState: "released_to_sandbox_input",
      contentDigest: sha256(plaintext)
    });
    await expect(promotionAuthority.promote(promotionRequest, async () => {
      throw new Error("sandbox input staging failed");
    })).rejects.toMatchObject({ code: "custody_envelope_authentication_failed" });
    const replayed = [];
    const replayReceipt = await promotionAuthority.promote(promotionRequest, async (chunk) => {
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
    const encryptedDownload = [];
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
    expect(await fs.stat(storageProvider.resolveStoredObjectPath(object.storageRelativePath)).catch(() => null)).toBeNull();
    await keyBroker.close();
  });

  it("denies stale governance, digest mismatch, and tampering before releasing plaintext", async () => {
    const root = await tempRoot();
    const { storageKernel, storageProvider } = storageFixture(root);
    const keyBroker = createLocalCustodyKeyBroker({ userDataPath: root });
    const { custody, promotionAuthority } = createOpaqueSandboxCustodyRuntime({
      userDataPath: root, storageKernel, storageProvider, keyBroker
    });
    const stored = await custody.store({
      source: source(Buffer.from("opaque", "utf8")),
      idempotencyKey: "seal:tamper",
      ownerBinding: {
        subjectRef: "subject:fixture",
        tenantRef: "tenant:fixture",
        workspaceRef: "workspace:fixture"
      }
    });
    let released = 0;

    await expect(promotionAuthority.promote(promotion(stored, {
      sandboxAvailable: false
    }), async () => { released += 1; })).rejects.toThrow("ready sandbox");
    await expect(promotionAuthority.promote(promotion(stored, {
      contentDigest: "b".repeat(64)
    }), async () => { released += 1; })).rejects.toMatchObject({ code: "custody_promotion_digest_mismatch" });

    const object = storageProvider.getObject(stored.handle.slice("custody:".length));
    const objectPath = storageProvider.resolveStoredObjectPath(object.storageRelativePath);
    const envelope = await fs.readFile(objectPath, "utf8");
    await fs.writeFile(objectPath, envelope.replace(
      /"ciphertext":"(.)/u,
      (_match, first) => `"ciphertext":"${first === "A" ? "B" : "A"}`
    ), "utf8");
    await expect(promotionAuthority.promote(promotion(stored), async () => { released += 1; }))
      .rejects.toMatchObject({ code: "custody_envelope_authentication_failed" });
    expect(released).toBe(0);
    await keyBroker.close();
  });

  it("keeps wrapped data keys recoverable across broker restart without exposing the master key", async () => {
    const root = await tempRoot();
    const first = createLocalCustodyKeyBroker({ userDataPath: root });
    const dataKey = crypto.randomBytes(32);
    const wrapped = await first.wrapKey(dataKey, "env_fixture");
    await first.close();
    const second = createLocalCustodyKeyBroker({ userDataPath: root });
    const recovered = await second.unwrapKey(wrapped, "env_fixture");
    expect(recovered).toEqual(dataKey);
    expect(wrapped).not.toHaveProperty("plaintextKey");
    recovered.fill(0);
    dataKey.fill(0);
    await second.close();
  });

  it("rejects truncation, frame reordering, duplicate footer, and authenticated-header mutation", async () => {
    const root = await tempRoot();
    const { storageKernel, storageProvider } = storageFixture(root);
    const keyBroker = createLocalCustodyKeyBroker({ userDataPath: root });
    const { custody, promotionAuthority } = createOpaqueSandboxCustodyRuntime({
      userDataPath: root, storageKernel, storageProvider, keyBroker
    });
    const plaintext = Buffer.alloc(96 * 1024, 7);
    const stored = await custody.store({
      source: source(plaintext),
      idempotencyKey: "seal:framing",
      ownerBinding: {
        subjectRef: "subject:fixture",
        tenantRef: "tenant:fixture",
        workspaceRef: "workspace:fixture"
      }
    });
    const object = storageProvider.getObject(stored.handle.slice("custody:".length));
    const objectPath = storageProvider.resolveStoredObjectPath(object.storageRelativePath);
    const original = await fs.readFile(objectPath, "utf8");
    const lines = original.trimEnd().split("\n");
    const mutations = [
      lines.slice(0, -1).join("\n") + "\n",
      [lines[0], lines[2], lines[1], lines[3]].join("\n") + "\n",
      [...lines, lines.at(-1)].join("\n") + "\n",
      original.replace("application/octet-stream", "application/x-mutated")
    ];
    let released = 0;
    for (const [index, mutation] of mutations.entries()) {
      await fs.writeFile(objectPath, mutation, "utf8");
      await expect(promotionAuthority.promote(promotion(stored, {
        idempotencyKey: `promotion:framing:${index}`
      }), async () => { released += 1; })).rejects.toMatchObject({
        code: "custody_envelope_authentication_failed"
      });
    }
    expect(released).toBe(0);
    await keyBroker.close();
  });
});
