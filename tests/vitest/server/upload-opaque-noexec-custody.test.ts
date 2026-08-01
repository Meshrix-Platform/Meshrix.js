import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const startCheckpointTreeMock: any = vi.hoisted(() : any => vi.fn(async () : Promise<any> => undefined));
const upsertCheckpointNodeMock: any = vi.hoisted(() : any => vi.fn(async () : Promise<any> => undefined));
const finishCheckpointTreeMock: any = vi.hoisted(() : any => vi.fn(async () : Promise<any> => undefined));
const deleteCheckpointTreeMock: any = vi.hoisted(() : any => vi.fn(async () : Promise<any> => undefined));
const checkpointTreeIdMock: any = vi.hoisted(() : any => vi.fn((kind: any, ...parts: any[]) : any => (
  `checkpoint_tree_${kind}_${parts.filter(Boolean).join("_") || "root"}`
)));

vi.mock(
  "#meshrix/foundation/checkpoint/tree/checkpoint-tree-projection",
  async (importOriginal?: any) : Promise<any> => ({
    ...(await importOriginal()),
    checkpointTreeId: checkpointTreeIdMock,
    deleteCheckpointTree: deleteCheckpointTreeMock,
    finishCheckpointTree: finishCheckpointTreeMock,
    startCheckpointTree: startCheckpointTreeMock,
    upsertCheckpointNode: upsertCheckpointNodeMock
  })
);

import { createStorageKernel } from "../../../packages/foundation/src/storage/storage-kernel.ts";
import { createStorageProvider } from "../../../packages/foundation/src/storage/storage-provider.ts";
import { createServerCompositionRoot } from "../../../packages/server-runtime/src/composition/composition-root.ts";
import { createServerConsoleDomainServices } from "../../../packages/server-runtime/src/composition/server-runtime-providers.ts";
import { createLocalCustodyKeyBroker } from "../../../packages/server-runtime/src/execution-sandbox/custody-key-broker.ts";
import { createUploadNoRunCustody } from "../../../packages/server-runtime/src/jobs/upload-no-run-custody.ts";
import { createUploadSessionStore } from "../../../packages/server-runtime/src/state/upload-session-store.ts";

const POSIX: any = process.platform !== "win32";
const itPosix: any = POSIX ? it : it.skip;
const CHUNK_BYTES: any = 64 * 1024;
const CURRENT_POLICY_REVISION: any = "policy-current";
const CURRENT_GRANT_REVISION: any = "grant-current";
const READ_AUDIENCE: any = "upload-custody-read";
const OWNER: Readonly<Record<string, any>> = Object.freeze({
  subjectId: "owner-fixture",
  userId: "owner-fixture",
  username: "fixture-user",
  tenantId: "tenant-fixture"
});
const OTHER_OWNER: Readonly<Record<string, any>> = Object.freeze({
  subjectId: "owner-other",
  userId: "owner-other",
  username: "other-user",
  tenantId: "tenant-fixture"
});
const EXPECTED_RESOLVED_FILE_KEYS: readonly any[] = Object.freeze([
  "archiveBatchId",
  "byteSize",
  "capturedAt",
  "clientUid",
  "contentDigest",
  "contentHash",
  "custodyRef",
  "custodyState",
  "envelopeDigest",
  "externalId",
  "mediaType",
  "name",
  "originalFileName",
  "providerId",
  "relativePath",
  "sha256",
  "sourceMetadata",
  "sourceNameHash",
  "sourceRelativePathHash",
  "sourceType",
  "syncBatchId"
]);
const EXPECTED_READ_RECEIPT_KEYS: readonly any[] = Object.freeze([
  "authorizationEvidenceRef",
  "byteCount",
  "contentDigest",
  "custodyRef",
  "envelopeDigest",
  "state"
]);
const CUSTODY_ROOTS: readonly any[] = Object.freeze([
  "upload-custody",
  "execution-sandbox-custody",
  "objects/execution-sandbox-custody"
]);
const roots: any[] = [];
const fixtures: any[] = [];
const resourceClosers: any[] = [];

function sha256(value?: any) : any {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value?: any) : any {
  if (Array.isArray(value)) {
    return `[${value.map((item?: any) : any => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key?: any) : any => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deferred() : any {
  let resolve: any;
  let reject: any;
  const promise: any = new Promise((resolvePromise?: any, rejectPromise?: any) : any => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function codedError(code?: any, message: any = code) : any {
  const error: any = new Error(message);
  error.code = code;
  return error;
}

function ownerBindingDigest(owner?: any) : any {
  return sha256(canonicalJson({
    subjectId: String(owner?.subjectId || ""),
    tenantId: String(owner?.tenantId || ""),
    userId: String(owner?.userId || "")
  }));
}

function permitBinding(receipt: Record<string, any> = {}) : any {
  return {
    audience: String(receipt.audience || ""),
    byteCount: Number(receipt.byteCount),
    contentDigest: String(receipt.contentDigest || ""),
    custodyRef: String(receipt.custodyRef || ""),
    decisionRef: String(receipt.decisionRef || ""),
    envelopeDigest: String(receipt.envelopeDigest || ""),
    expiresAt: String(receipt.expiresAt || ""),
    grantRevision: String(receipt.grantRevision || ""),
    ownerBindingDigest: String(receipt.ownerBindingDigest || ""),
    policyRevision: String(receipt.policyRevision || ""),
    resourceRef: String(receipt.resourceRef || "")
  };
}

function authorizationReceiptFor(sealed?: any, {
  owner = OWNER,
  resourceRef,
  ...overrides
}: Record<string, any> = {}) : any {
  const binding: Record<string, any> = {
    audience: READ_AUDIENCE,
    byteCount: sealed.byteCount,
    contentDigest: sealed.contentDigest,
    custodyRef: sealed.custodyRef,
    decisionRef: `decision:${sha256(`${sealed.custodyRef}:${resourceRef}`).slice(0, 24)}`,
    envelopeDigest: sealed.envelopeDigest,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    grantRevision: CURRENT_GRANT_REVISION,
    ownerBindingDigest: ownerBindingDigest(owner),
    policyRevision: CURRENT_POLICY_REVISION,
    resourceRef,
    ...overrides
  };
  const permitDigest: any = Object.hasOwn(overrides, "permitDigest")
    ? overrides.permitDigest
    : sha256(canonicalJson(permitBinding(binding)));
  return Object.freeze({ ...binding, permitDigest });
}

function currentAuthorizationDecision(request?: any, state?: any) : any {
  const receipt: any = request?.authorizationReceipt;
  const expectedKeys: any[] = [
    "audience",
    "byteCount",
    "contentDigest",
    "custodyRef",
    "decisionRef",
    "envelopeDigest",
    "expiresAt",
    "grantRevision",
    "ownerBindingDigest",
    "permitDigest",
    "policyRevision",
    "resourceRef"
  ];
  const shapeValid: any = Boolean(
    receipt &&
    typeof receipt === "object" &&
    !Array.isArray(receipt) &&
    Object.keys(receipt).sort().join(",") === expectedKeys.sort().join(",")
  );
  const bindingMatches: any = shapeValid &&
    receipt.audience === READ_AUDIENCE &&
    receipt.custodyRef === request.custodyRef &&
    receipt.contentDigest === request.contentDigest &&
    receipt.envelopeDigest === request.envelopeDigest &&
    receipt.byteCount === request.byteCount &&
    receipt.ownerBindingDigest === request.ownerBindingDigest &&
    receipt.resourceRef === request.resourceRef;
  const permitValid: any = bindingMatches &&
    receipt.permitDigest === sha256(canonicalJson(permitBinding(receipt)));
  const current: any = permitValid &&
    receipt.policyRevision === state.currentPolicyRevision &&
    receipt.grantRevision === state.currentGrantRevision &&
    Date.parse(receipt.expiresAt) > Date.now() &&
    state.revoked !== true;
  return Object.freeze({
    allowed: current,
    currentGrantRevision: state.currentGrantRevision,
    currentPolicyRevision: state.currentPolicyRevision,
    decisionRef: current ? receipt.decisionRef : "",
    evidenceRef: current ? "evidence:upload-custody-read:current" : "",
    revoked: state.revoked === true
  });
}

async function tempRoot() : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-upload-custody-"));
  roots.push(root);
  return root;
}

function openFixture(root?: any, {
  authorizationState = {},
  faultState = {},
  uploadSessionFaultState = {}
}: Record<string, any> = {}) : any {
  const storageKernel: any = createStorageKernel({ userDataPath: root });
  const baseStorageProvider: any = createStorageProvider({ userDataPath: root, storageKernel });
  const openPrivateNoExecObjectReadStream: any = vi.fn((input?: any) : any => (
    baseStorageProvider.openPrivateNoExecObjectReadStream(input)
  ));
  const storageProvider: Readonly<Record<string, any>> = Object.freeze({
    ...baseStorageProvider,
    openPrivateNoExecObjectReadStream
  });
  const baseKeyBroker: any = createLocalCustodyKeyBroker({ userDataPath: root });
  const unwrapKey: any = vi.fn((...args: any[]) : any => baseKeyBroker.unwrapKey(...args));
  const keyBroker: Readonly<Record<string, any>> = Object.freeze({
    keyReference: baseKeyBroker.keyReference,
    wrapKey: (...args: any[]) : any => baseKeyBroker.wrapKey(...args),
    unwrapKey,
    close: () : any => baseKeyBroker.close()
  });
  const mutableAuthorizationState: any = Object.assign({
    authorizationGate: null,
    authorizationStarted: null,
    currentGrantRevision: CURRENT_GRANT_REVISION,
    currentPolicyRevision: CURRENT_POLICY_REVISION,
    revoked: false
  }, authorizationState);
  const reauthorizeCustodyRead: any = vi.fn(async (request?: any) : Promise<any> => {
    mutableAuthorizationState.authorizationStarted?.resolve();
    if (mutableAuthorizationState.authorizationGate) {
      await mutableAuthorizationState.authorizationGate.promise;
    }
    return currentAuthorizationDecision(request, mutableAuthorizationState);
  });
  const mutableFaultState: any = Object.assign({
    crashAfterPrepared: false
  }, faultState);
  const faultInjector: Readonly<Record<string, any>> = Object.freeze({
    afterChunkPrepared: vi.fn(async () : Promise<any> => {
      if (!mutableFaultState.crashAfterPrepared) return;
      mutableFaultState.crashAfterPrepared = false;
      throw codedError(
        "upload_custody_test_crash",
        "Synthetic interruption at the prepared encrypted-chunk boundary."
      );
    })
  });
  const noRunCustody: any = createUploadNoRunCustody({
    userDataPath: root,
    storageKernel,
    storageProvider,
    keyBroker,
    reauthorizeCustodyRead,
    faultInjector
  });
  const mutableUploadSessionFaultState: any = Object.assign({
    crashAfterCustodyAppendCommitted: false
  }, uploadSessionFaultState);
  const uploadSessionFaultInjector: Readonly<Record<string, any>> = Object.freeze({
    afterCustodyAppendCommitted: vi.fn(async () : Promise<any> => {
      if (!mutableUploadSessionFaultState.crashAfterCustodyAppendCommitted) return;
      mutableUploadSessionFaultState.crashAfterCustodyAppendCommitted = false;
      throw codedError(
        "upload_session_test_crash",
        "Synthetic interruption after custody cursor commit and before upload-session metadata save."
      );
    })
  });
  const custodyDescribe: any = noRunCustody.describe;
  const uploadSessionStore: any = createUploadSessionStore({
    userDataPath: root,
    custodyPort: noRunCustody.stagingPort,
    custodyDescribe,
    faultInjector: uploadSessionFaultInjector
  });
  let closed: any = false;
  const fixture: Record<string, any> = {
    authorizationState: mutableAuthorizationState,
    baseStorageProvider,
    custodyDescribe,
    faultInjector,
    faultState: mutableFaultState,
    keyBroker,
    noRunCustody,
    openPrivateNoExecObjectReadStream,
    reauthorizeCustodyRead,
    root,
    storageKernel,
    storageProvider,
    unwrapKey,
    uploadSessionFaultInjector,
    uploadSessionFaultState: mutableUploadSessionFaultState,
    uploadSessionStore,
    async close() : Promise<any> {
      if (closed) return;
      closed = true;
      await keyBroker.close();
      storageKernel.close();
    }
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () : Promise<any> => {
  for (const close of resourceClosers.splice(0).reverse()) {
    await close().catch(() : any => {});
  }
  for (const fixture of fixtures.splice(0).reverse()) {
    await fixture.close().catch(() : any => {});
  }
  for (const root of roots.splice(0).reverse()) {
    await fs.rm(root, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

function uploadDeclaration(bytes?: any, {
  checkpointId = "checkpoint-fixture",
  relativePath = "inbox/payload.bin",
  mediaType = "application/octet-stream",
  owner = OWNER
}: Record<string, any> = {}) : any {
  return {
    checkpoint: {
      checkpointId,
      archiveBatchId: `archive-${checkpointId}`,
      clientUid: "client-fixture",
      sourceType: "upload"
    },
    manifest: {
      manifestDigest: sha256(`manifest:${checkpointId}`),
      inputDigest: sha256(`input:${checkpointId}`)
    },
    owner,
    files: [{
      relativePath,
      mediaType,
      sha256: sha256(bytes),
      byteSize: bytes.length
    }]
  };
}

async function createSession(uploadSessionStore?: any, bytes?: any, options: Record<string, any> = {}) : Promise<any> {
  return uploadSessionStore.createOrResumeUploadSession(
    uploadDeclaration(bytes, options)
  );
}

async function appendSessionChunk(
  uploadSessionStore?: any,
  sessionId?: any,
  offset?: any,
  buffer?: any,
  owner: any = OWNER
) : Promise<any> {
  return uploadSessionStore.appendUploadSessionChunk({
    sessionId,
    fileIndex: 0,
    offset,
    buffer,
    owner
  });
}

async function resolveSingleFile(uploadSessionStore?: any, sessionId?: any, owner: any = OWNER) : Promise<any> {
  const files: any = await uploadSessionStore.resolveUploadSessionFiles(sessionId, { owner });
  expect(files).toHaveLength(1);
  expect(Object.keys(files[0]).sort()).toEqual([...EXPECTED_RESOLVED_FILE_KEYS].sort());
  return files[0];
}

function directStagingInput(bytes?: any, {
  sessionId = "upload_session_direct_fixture",
  fileIndex = 0,
  owner = OWNER,
  idempotencyKey = `upload-custody:${sessionId}:${fileIndex}`
}: Record<string, any> = {}) : any {
  return {
    expectedByteSize: bytes.length,
    expectedSha256: sha256(bytes),
    fileIndex,
    idempotencyKey,
    owner,
    sessionId
  };
}

async function sealDirect(fixture?: any, bytes?: any, options: Record<string, any> = {}) : Promise<any> {
  const beginInput: any = directStagingInput(bytes, options);
  const begun: any = await fixture.noRunCustody.stagingPort.begin(beginInput);
  await fixture.noRunCustody.stagingPort.append({
    bytes,
    custodyRef: begun.custodyRef,
    offset: 0,
    owner: beginInput.owner
  });
  const sealed: any = await fixture.noRunCustody.stagingPort.seal({
    custodyRef: begun.custodyRef,
    owner: beginInput.owner
  });
  expect(sealed).toMatchObject({
    byteCount: bytes.length,
    contentDigest: sha256(bytes),
    custodyRef: begun.custodyRef,
    envelopeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    replayed: false,
    state: "sealed_no_run"
  });
  return { beginInput, begun, sealed };
}

function readInput(sealed?: any, authorizationReceipt?: any, {
  owner = OWNER,
  resourceRef,
  ...overrides
}: Record<string, any> = {}) : any {
  return {
    authorizationReceipt,
    byteCount: sealed.byteCount,
    contentDigest: sealed.contentDigest,
    custodyRef: sealed.custodyRef,
    envelopeDigest: sealed.envelopeDigest,
    maxBytes: sealed.byteCount,
    owner,
    resourceRef,
    ...overrides
  };
}

async function readBoundedStream(reader?: any) : Promise<any> {
  expect(Object.keys(reader).sort()).toEqual(["receipt", "stream"]);
  expect(Object.keys(reader.receipt).sort()).toEqual([...EXPECTED_READ_RECEIPT_KEYS].sort());
  expect(reader.stream?.[Symbol.asyncIterator]).toEqual(expect.any(Function));
  const chunks: any[] = [];
  for await (const input of reader.stream) {
    const chunk: any = Buffer.from(input);
    expect(chunk.length).toBeGreaterThan(0);
    expect(chunk.length).toBeLessThanOrEqual(CHUNK_BYTES);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function assertPrivacySafePublicValue(value?: any, forbiddenValues: any = []) : any {
  const serialized: any = JSON.stringify(value);
  expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(4096);
  expect(serialized).not.toMatch(
    /"(?:absolutePath|bytes|descriptor|filePath|hostPath|key|plaintext|stagedPath|storageRelativePath)"\s*:/u
  );
  for (const forbidden of forbiddenValues) {
    expect(serialized).not.toContain(String(forbidden));
  }
}

async function walkTree(root?: any, current: any = root, output: any = []) : Promise<any> {
  let entries: any;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return output;
    throw error;
  }
  for (const entry of entries) {
    const absolutePath: any = path.join(current, entry.name);
    const stat: any = await fs.lstat(absolutePath);
    output.push({
      absolutePath,
      relativePath: path.relative(root, absolutePath).split(path.sep).join("/"),
      stat
    });
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      await walkTree(root, absolutePath, output);
    }
  }
  return output;
}

async function custodyEntries(root?: any) : Promise<any> {
  const output: any[] = [];
  for (const relativeRoot of CUSTODY_ROOTS) {
    const absoluteRoot: any = path.join(root, relativeRoot);
    let rootStat: any;
    try {
      rootStat = await fs.lstat(absoluteRoot);
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    output.push({
      absolutePath: absoluteRoot,
      relativePath: relativeRoot,
      stat: rootStat
    });
    for (const entry of await walkTree(absoluteRoot)) {
      output.push({
        ...entry,
        relativePath: `${relativeRoot}/${entry.relativePath}`
      });
    }
  }
  return output;
}

async function assertNoPersistedPlaintext(root?: any, forbiddenPlaintexts?: any) : Promise<any> {
  const entries: any = await walkTree(root);
  const regularFiles: any = entries.filter((entry?: any) : any => entry.stat.isFile());
  expect(regularFiles.length).toBeGreaterThan(0);
  for (const entry of regularFiles) {
    const persisted: any = await fs.readFile(entry.absolutePath);
    for (const forbidden of forbiddenPlaintexts) {
      const bytes: any = Buffer.isBuffer(forbidden)
        ? forbidden
        : Buffer.from(String(forbidden), "utf8");
      if (bytes.length > 0) expect(persisted.includes(bytes)).toBe(false);
    }
  }
}

async function ciphertextSnapshot(root?: any) : Promise<any> {
  const entries: any = await custodyEntries(root);
  const snapshot: any[] = [];
  for (const entry of entries) {
    if (!entry.stat.isFile()) continue;
    const basename: any = path.basename(entry.absolutePath);
    if (
      basename === "meta.json" ||
      /\.(?:sqlite|sqlite-shm|sqlite-wal)$/u.test(basename)
    ) {
      continue;
    }
    const bytes: any = await fs.readFile(entry.absolutePath);
    snapshot.push({
      byteSize: bytes.length,
      relativePath: entry.relativePath,
      sha256: sha256(bytes)
    });
  }
  expect(snapshot.length).toBeGreaterThan(0);
  return snapshot.sort((left?: any, right?: any) : any => left.relativePath.localeCompare(right.relativePath));
}

function custodyObjectPath(fixture?: any, custodyRef?: any) : any {
  const row: any = fixture.storageKernel.db.prepare(`
    SELECT objects.storage_rel_path AS storageRelativePath
    FROM opaque_custody_artifacts AS custody
    JOIN storage_objects AS objects ON objects.object_id = custody.object_id
    WHERE custody.custody_ref = ?
    LIMIT 1
  `).get(custodyRef);
  expect(row?.storageRelativePath).toEqual(expect.any(String));
  return fixture.baseStorageProvider.resolveStoredObjectPath(row.storageRelativePath);
}

function storageCustodyRow(storageKernel?: any, custodyRef?: any) : any {
  return storageKernel.db.prepare(`
    SELECT custody.custody_ref AS custodyRef,
           custody.content_digest AS contentDigest,
           custody.envelope_digest AS envelopeDigest,
           custody.plaintext_bytes AS byteCount,
           objects.storage_rel_path AS storageRelativePath
    FROM opaque_custody_artifacts AS custody
    JOIN storage_objects AS objects ON objects.object_id = custody.object_id
    WHERE custody.custody_ref = ?
    LIMIT 1
  `).get(custodyRef);
}

function uploadCustodyEnvelopeBinding(storageKernel?: any, custodyRef?: any) : any {
  return storageKernel.db.prepare(`
    SELECT envelope_id AS envelopeId,
           expected_content_digest AS expectedContentDigest,
           expected_byte_size AS expectedByteSize,
           committed_frame_count AS committedFrameCount,
           committed_ciphertext_digest AS committedCiphertextDigest,
           sealed_envelope_digest AS sealedEnvelopeDigest
    FROM upload_no_run_custody_staging
    WHERE custody_ref = ?
    LIMIT 1
  `).get(custodyRef);
}

function expectBoundSealedEnvelope(storageKernel?: any, sealed?: any, envelopeBytes?: any) : any {
  const records: any = envelopeBytes
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line?: any) : any => JSON.parse(line));
  const header: any = records.at(0);
  const footer: any = records.at(-1);
  const binding: any = uploadCustodyEnvelopeBinding(storageKernel, sealed.custodyRef);
  expect(binding).toMatchObject({
    committedCiphertextDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    committedFrameCount: expect.any(Number),
    envelopeId: expect.any(String),
    expectedByteSize: sealed.byteCount,
    expectedContentDigest: sealed.contentDigest,
    sealedEnvelopeDigest: sealed.envelopeDigest
  });
  expect(header).toMatchObject({
    type: "header",
    envelopeId: binding.envelopeId,
    headerDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
  });
  expect(footer).toMatchObject({
    type: "footer",
    byteCount: sealed.byteCount,
    chunkCount: binding.committedFrameCount,
    contentDigest: sealed.contentDigest,
    finalFrameDigest: binding.committedCiphertextDigest,
    footerMac: expect.stringMatching(/^[a-f0-9]{64}$/u),
    mediaTypeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
  });
  expect(sha256(envelopeBytes)).toBe(sealed.envelopeDigest);
  return { binding, footer, header, records };
}

async function replaceFileBytesDurably(filePath?: any, bytes?: any) : Promise<any> {
  const handle: any = await fs.open(filePath, "r+");
  try {
    await handle.truncate(0);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function expectDeniedBeforeEffects(fixture?: any, input?: any, code?: any) : Promise<any> {
  const openCalls: any = fixture.openPrivateNoExecObjectReadStream.mock.calls.length;
  const unwrapCalls: any = fixture.unwrapKey.mock.calls.length;
  await expect(fixture.noRunCustody.readPort.open(input)).rejects.toMatchObject({ code });
  expect(fixture.openPrivateNoExecObjectReadStream).toHaveBeenCalledTimes(openCalls);
  expect(fixture.unwrapKey).toHaveBeenCalledTimes(unwrapCalls);
}

describe("upload opaque no-exec custody", () : any => {
  it("durably stages upload bytes only as opaque authenticated ciphertext", async () : Promise<any> => {
    const root: any = await tempRoot();
    const fixture: any = openFixture(root);
    const plaintext: any = Buffer.alloc(96 * 1024, 0x51);
    const sentinel: any = Buffer.from(
      "#!/bin/sh\nprintf 'uploaded-program-remains-data'\nopaque-custody-plaintext-sentinel",
      "utf8"
    );
    sentinel.copy(plaintext, 2048);
    const split: any = 37 * 1024;

    expect(Object.keys(fixture.noRunCustody).sort()).toEqual([
      "describe",
      "readPort",
      "stagingPort"
    ]);
    expect(Object.keys(fixture.noRunCustody.stagingPort).sort()).toEqual([
      "append",
      "begin",
      "seal"
    ]);
    expect(Object.keys(fixture.noRunCustody.readPort)).toEqual(["open"]);

    const created: any = await createSession(fixture.uploadSessionStore, plaintext, {
      checkpointId: "opaque-lifecycle",
      mediaType: "application/x-sh",
      relativePath: "bin/run-me.sh"
    });
    await expect(
      appendSessionChunk(
        fixture.uploadSessionStore,
        created.sessionId,
        0,
        plaintext.subarray(0, split)
      )
    ).resolves.toMatchObject({
      ok: true,
      session: { status: "uploading" }
    });
    await expect(
      appendSessionChunk(
        fixture.uploadSessionStore,
        created.sessionId,
        split,
        plaintext.subarray(split)
      )
    ).resolves.toMatchObject({
      ok: true,
      session: { status: "complete" }
    });

    const file: any = await resolveSingleFile(fixture.uploadSessionStore, created.sessionId);
    expect(file).toMatchObject({
      byteSize: plaintext.length,
      contentDigest: sha256(plaintext),
      custodyRef: expect.stringMatching(/^custody:[A-Za-z0-9._-]+$/u),
      custodyState: "sealed_no_run",
      envelopeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      relativePath: "bin/run-me.sh",
      sha256: sha256(plaintext)
    });
    expect(file).not.toHaveProperty("stagedPath");
    const row: any = storageCustodyRow(fixture.storageKernel, file.custodyRef);
    expect(row).toMatchObject({
      byteCount: plaintext.length,
      contentDigest: sha256(plaintext),
      custodyRef: file.custodyRef,
      envelopeDigest: file.envelopeDigest,
      storageRelativePath: expect.any(String)
    });
    const objectPath: any = fixture.baseStorageProvider.resolveStoredObjectPath(
      row.storageRelativePath
    );
    expect(path.basename(objectPath)).not.toContain("run-me");
    expect(path.basename(objectPath)).not.toContain(".sh");
    const envelope: any = await fs.readFile(objectPath);
    expect(envelope.includes(plaintext)).toBe(false);
    expect(envelope.includes(plaintext.subarray(0, split))).toBe(false);
    expect(envelope.includes(plaintext.subarray(split))).toBe(false);
    await assertNoPersistedPlaintext(root, [
      sentinel,
      plaintext.subarray(0, split),
      plaintext.subarray(split),
      plaintext
    ]);
    assertPrivacySafePublicValue(file, [
      root,
      OWNER.subjectId,
      OWNER.tenantId,
      sentinel.toString("utf8")
    ]);
  });

  it("rejects forged, stale, substituted, revoked, bounded, and aborted reads before object-open or key-unwrap effects", async () : Promise<any> => {
    const root: any = await tempRoot();
    const fixture: any = openFixture(root);
    const firstBytes: any = Buffer.alloc(72 * 1024, 0x31);
    Buffer.from("first-opaque-read-target", "utf8").copy(firstBytes, 1000);
    const secondBytes: any = Buffer.alloc(68 * 1024, 0x32);
    Buffer.from("second-opaque-read-target", "utf8").copy(secondBytes, 1000);
    const first: any = await sealDirect(fixture, firstBytes, {
      sessionId: "upload_session_read_first"
    });
    const second: any = await sealDirect(fixture, secondBytes, {
      sessionId: "upload_session_read_second"
    });
    const firstResource: any = "upload-resource:upload_session_read_first:0";
    const secondResource: any = "upload-resource:upload_session_read_second:0";
    const firstReceipt: any = authorizationReceiptFor(first.sealed, {
      resourceRef: firstResource
    });
    const secondReceipt: any = authorizationReceiptFor(second.sealed, {
      resourceRef: secondResource
    });

    const attempts: any[] = [
      {
        code: "upload_custody_read_denied",
        input: readInput(first.sealed, undefined, { resourceRef: firstResource }),
        name: "missing receipt"
      },
      {
        code: "upload_custody_read_denied",
        input: readInput(first.sealed, {
          ...firstReceipt,
          permitDigest: "f".repeat(64)
        }, { resourceRef: firstResource }),
        name: "forged receipt"
      },
      {
        code: "upload_custody_read_denied",
        input: readInput(first.sealed, authorizationReceiptFor(first.sealed, {
          policyRevision: "policy-stale",
          resourceRef: firstResource
        }), { resourceRef: firstResource }),
        name: "stale policy"
      },
      {
        code: "upload_custody_read_denied",
        input: readInput(first.sealed, authorizationReceiptFor(first.sealed, {
          grantRevision: "grant-stale",
          resourceRef: firstResource
        }), { resourceRef: firstResource }),
        name: "stale grant"
      },
      {
        code: "upload_custody_read_denied",
        input: readInput(first.sealed, authorizationReceiptFor(first.sealed, {
          expiresAt: "2000-01-01T00:00:00.000Z",
          resourceRef: firstResource
        }), { resourceRef: firstResource }),
        name: "expired receipt"
      },
      {
        code: "upload_custody_read_denied",
        input: readInput(second.sealed, firstReceipt, { resourceRef: secondResource }),
        name: "custody target substitution"
      },
      {
        code: "upload_custody_read_denied",
        input: readInput(first.sealed, firstReceipt, {
          resourceRef: "upload-resource:substituted:0"
        }),
        name: "resource substitution"
      },
      {
        code: "upload_custody_read_denied",
        input: readInput(first.sealed, firstReceipt, {
          owner: OTHER_OWNER,
          resourceRef: firstResource
        }),
        name: "owner substitution"
      },
      {
        code: "upload_custody_read_limit_exceeded",
        input: readInput(first.sealed, firstReceipt, {
          maxBytes: first.sealed.byteCount - 1,
          resourceRef: firstResource
        }),
        name: "undersized read budget"
      }
    ];
    for (const attempt of attempts) {
      fixture.authorizationState.revoked = false;
      await expectDeniedBeforeEffects(fixture, attempt.input, attempt.code);
    }

    fixture.authorizationState.revoked = true;
    await expectDeniedBeforeEffects(
      fixture,
      readInput(first.sealed, firstReceipt, { resourceRef: firstResource }),
      "upload_custody_read_denied"
    );
    fixture.authorizationState.revoked = false;

    const preAborted: any = new AbortController();
    preAborted.abort();
    await expectDeniedBeforeEffects(
      fixture,
      readInput(first.sealed, firstReceipt, {
        resourceRef: firstResource,
        signal: preAborted.signal
      }),
      "upload_custody_read_aborted"
    );

    fixture.authorizationState.authorizationGate = deferred();
    fixture.authorizationState.authorizationStarted = deferred();
    const inFlightAbort: any = new AbortController();
    const openCallsBeforeAbort: any = fixture.openPrivateNoExecObjectReadStream.mock.calls.length;
    const unwrapCallsBeforeAbort: any = fixture.unwrapKey.mock.calls.length;
    const pendingRead: any = fixture.noRunCustody.readPort.open(
      readInput(first.sealed, firstReceipt, {
        resourceRef: firstResource,
        signal: inFlightAbort.signal
      })
    );
    const pendingRejection: any = expect(pendingRead).rejects.toMatchObject({
      code: "upload_custody_read_aborted"
    });
    await fixture.authorizationState.authorizationStarted.promise;
    inFlightAbort.abort();
    fixture.authorizationState.authorizationGate.resolve();
    await pendingRejection;
    expect(fixture.openPrivateNoExecObjectReadStream).toHaveBeenCalledTimes(
      openCallsBeforeAbort
    );
    expect(fixture.unwrapKey).toHaveBeenCalledTimes(unwrapCallsBeforeAbort);
    fixture.authorizationState.authorizationGate = null;
    fixture.authorizationState.authorizationStarted = null;

    const openCallsBeforeControl: any = fixture.openPrivateNoExecObjectReadStream.mock.calls.length;
    const unwrapCallsBeforeControl: any = fixture.unwrapKey.mock.calls.length;
    const reader: any = await fixture.noRunCustody.readPort.open(
      readInput(second.sealed, secondReceipt, { resourceRef: secondResource })
    );
    expect(await readBoundedStream(reader)).toEqual(secondBytes);
    expect(fixture.openPrivateNoExecObjectReadStream.mock.calls.length)
      .toBeGreaterThan(openCallsBeforeControl);
    expect(fixture.unwrapKey.mock.calls.length).toBeGreaterThan(unwrapCallsBeforeControl);
    expect(reader.receipt).toMatchObject({
      byteCount: secondBytes.length,
      contentDigest: sha256(secondBytes),
      custodyRef: second.sealed.custodyRef,
      envelopeDigest: second.sealed.envelopeDigest,
      state: "authorized_custody_read"
    });
    expect(fixture.reauthorizeCustodyRead).toHaveBeenLastCalledWith(
      expect.objectContaining({
        authorizationReceipt: secondReceipt,
        byteCount: secondBytes.length,
        contentDigest: sha256(secondBytes),
        custodyRef: second.sealed.custodyRef,
        envelopeDigest: second.sealed.envelopeDigest,
        ownerBindingDigest: ownerBindingDigest(OWNER),
        resourceRef: secondResource
      })
    );
    assertPrivacySafePublicValue(reader.receipt, [
      root,
      OWNER.subjectId,
      OWNER.tenantId,
      secondBytes.toString("utf8")
    ]);
  });

  it("releases zero plaintext when a safe object is replaced by another valid sealed envelope", async () : Promise<any> => {
    const root: any = await tempRoot();
    const fixture: any = openFixture(root);
    const firstBytes: any = Buffer.alloc(72 * 1024, 0x41);
    const secondBytes: any = Buffer.alloc(firstBytes.length, 0x42);
    Buffer.from("original-envelope-plaintext", "utf8").copy(firstBytes, 2048);
    Buffer.from("substituted-envelope-plaintext", "utf8").copy(secondBytes, 2048);
    const first: any = await sealDirect(fixture, firstBytes, {
      sessionId: "upload_session_valid_envelope_original"
    });
    const second: any = await sealDirect(fixture, secondBytes, {
      sessionId: "upload_session_valid_envelope_substitute"
    });
    const firstObjectPath: any = custodyObjectPath(fixture, first.sealed.custodyRef);
    const secondObjectPath: any = custodyObjectPath(fixture, second.sealed.custodyRef);
    expect(firstObjectPath).not.toBe(secondObjectPath);
    const firstEnvelope: any = await fs.readFile(firstObjectPath);
    const secondEnvelope: any = await fs.readFile(secondObjectPath);
    expect(firstEnvelope).not.toEqual(secondEnvelope);
    const firstContract: any = expectBoundSealedEnvelope(
      fixture.storageKernel,
      first.sealed,
      firstEnvelope
    );
    const secondContract: any = expectBoundSealedEnvelope(
      fixture.storageKernel,
      second.sealed,
      secondEnvelope
    );
    expect(firstContract.header.envelopeId).not.toBe(
      secondContract.header.envelopeId
    );
    expect(firstContract.footer.contentDigest).not.toBe(
      secondContract.footer.contentDigest
    );

    await replaceFileBytesDurably(firstObjectPath, secondEnvelope);
    const substitutedStat: any = await fs.lstat(firstObjectPath);
    expect(substitutedStat.isFile()).toBe(true);
    expect(substitutedStat.nlink).toBe(1);
    if (POSIX) {
      expect(substitutedStat.mode & 0o777).toBe(0o600);
    }
    expectBoundSealedEnvelope(
      fixture.storageKernel,
      second.sealed,
      await fs.readFile(firstObjectPath)
    );

    const resourceRef: any = "upload-resource:upload_session_valid_envelope_original:0";
    const authorizationReceipt: any = authorizationReceiptFor(first.sealed, {
      resourceRef
    });
    const releasedChunks: any[] = [];
    const openCallsBeforeRead: any = fixture.openPrivateNoExecObjectReadStream.mock.calls.length;
    const unwrapCallsBeforeRead: any = fixture.unwrapKey.mock.calls.length;
    await expect((async () : Promise<any> => {
      const reader: any = await fixture.noRunCustody.readPort.open(
        readInput(first.sealed, authorizationReceipt, { resourceRef })
      );
      for await (const chunk of reader.stream) {
        releasedChunks.push(Buffer.from(chunk));
      }
    })()).rejects.toMatchObject({
      code: "upload_custody_envelope_authentication_failed"
    });
    expect(releasedChunks).toEqual([]);
    expect(fixture.openPrivateNoExecObjectReadStream.mock.calls.length)
      .toBeGreaterThan(openCallsBeforeRead);
    expect(fixture.unwrapKey.mock.calls.length).toBeGreaterThan(unwrapCallsBeforeRead);

    await replaceFileBytesDurably(firstObjectPath, firstEnvelope);
    const controlReader: any = await fixture.noRunCustody.readPort.open(
      readInput(first.sealed, authorizationReceipt, { resourceRef })
    );
    expect(await readBoundedStream(controlReader)).toEqual(firstBytes);
  });

  itPosix("enforces exact private no-exec POSIX custody files and rejects link, type, and mode substitution before key unwrap", async () : Promise<any> => {
    const root: any = await tempRoot();
    const fixture: any = openFixture(root);
    const plaintext: any = Buffer.from(
      "#!/usr/bin/env node\nthrow new Error('custody-must-never-execute')\n",
      "utf8"
    );
    const direct: any = await sealDirect(fixture, plaintext, {
      sessionId: "upload_session_posix_noexec"
    });
    const resourceRef: any = "upload-resource:upload_session_posix_noexec:0";
    const authorizationReceipt: any = authorizationReceiptFor(direct.sealed, {
      resourceRef
    });
    const input: any = readInput(direct.sealed, authorizationReceipt, { resourceRef });
    const entries: any = await custodyEntries(root);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const mode: any = entry.stat.mode & 0o777;
      if (entry.stat.isDirectory()) {
        expect(mode).toBe(0o700);
        continue;
      }
      expect(entry.stat.isFile()).toBe(true);
      expect(entry.stat.nlink).toBe(1);
      expect(mode).toBe(0o600);
      expect(mode & 0o111).toBe(0);
    }

    const objectPath: any = custodyObjectPath(fixture, direct.sealed.custodyRef);
    async function expectUnsafeObject(code?: any) : Promise<any> {
      const openCalls: any = fixture.openPrivateNoExecObjectReadStream.mock.calls.length;
      const unwrapCalls: any = fixture.unwrapKey.mock.calls.length;
      await expect(fixture.noRunCustody.readPort.open(input)).rejects.toMatchObject({ code });
      expect(fixture.openPrivateNoExecObjectReadStream).toHaveBeenCalledTimes(openCalls + 1);
      expect(fixture.unwrapKey).toHaveBeenCalledTimes(unwrapCalls);
    }

    await fs.chmod(objectPath, 0o700);
    await expectUnsafeObject("upload_custody_mode_unsafe");
    await fs.chmod(objectPath, 0o600);

    const aliasPath: any = `${objectPath}.alias`;
    await fs.link(objectPath, aliasPath);
    await expectUnsafeObject("upload_custody_file_aliased");
    await fs.unlink(aliasPath);

    const preservedPath: any = `${objectPath}.preserved`;
    await fs.rename(objectPath, preservedPath);
    await fs.symlink(path.basename(preservedPath), objectPath);
    await expectUnsafeObject("upload_custody_file_unsafe");
    await fs.unlink(objectPath);
    await fs.rename(preservedPath, objectPath);

    await fs.rename(objectPath, preservedPath);
    await fs.mkdir(objectPath, { mode: 0o700 });
    await expectUnsafeObject("upload_custody_file_unsafe");
    await fs.rmdir(objectPath);
    await fs.rename(preservedPath, objectPath);

    const reader: any = await fixture.noRunCustody.readPort.open(input);
    expect(await readBoundedStream(reader)).toEqual(plaintext);
    await assertNoPersistedPlaintext(root, [plaintext]);
  });

  it("recovers exactly the committed encrypted chunk after interruption at the prepared-before-commit boundary", async () : Promise<any> => {
    const root: any = await tempRoot();
    const plaintext: any = Buffer.alloc(80 * 1024, 0x5a);
    const sentinel: any = Buffer.from("crash-atomic-opaque-custody-sentinel", "utf8");
    sentinel.copy(plaintext, 4096);
    const split: any = 24 * 1024;
    const first: any = openFixture(root);
    const beginInput: any = directStagingInput(plaintext, {
      sessionId: "upload_session_crash_atomic"
    });
    const begun: any = await first.noRunCustody.stagingPort.begin(beginInput);
    const firstCommit: any = await first.noRunCustody.stagingPort.append({
      bytes: plaintext.subarray(0, split),
      custodyRef: begun.custodyRef,
      offset: 0,
      owner: OWNER
    });
    expect(firstCommit).toMatchObject({
      committedChunkCount: 1,
      committedEnvelopeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      custodyRef: begun.custodyRef,
      nextOffset: split,
      state: "staging_no_run"
    });
    const beforeCrash: any = await ciphertextSnapshot(root);
    first.faultState.crashAfterPrepared = true;
    await expect(first.noRunCustody.stagingPort.append({
      bytes: plaintext.subarray(split),
      custodyRef: begun.custodyRef,
      offset: split,
      owner: OWNER
    })).rejects.toMatchObject({ code: "upload_custody_test_crash" });
    expect(first.faultInjector.afterChunkPrepared).toHaveBeenLastCalledWith(
      expect.objectContaining({
        chunkByteCount: plaintext.length - split,
        custodyRef: begun.custodyRef,
        expectedOffset: split
      })
    );
    const faultProjection: any = JSON.stringify(
      first.faultInjector.afterChunkPrepared.mock.calls.at(-1)?.[0]
    );
    expect(faultProjection).not.toMatch(
      /"(?:bytes|filePath|hostPath|key|owner|path|plaintext)"\s*:/u
    );
    await first.close();

    const recovered: any = openFixture(root);
    const recoveredStatus: any = await recovered.noRunCustody.describe({
      custodyRef: begun.custodyRef,
      owner: OWNER
    });
    expect(recoveredStatus).toMatchObject({
      committedChunkCount: 1,
      committedEnvelopeDigest: firstCommit.committedEnvelopeDigest,
      custodyRef: begun.custodyRef,
      nextOffset: split,
      state: "staging_no_run"
    });
    expect(await ciphertextSnapshot(root)).toEqual(beforeCrash);

    await expect(recovered.noRunCustody.stagingPort.append({
      bytes: Buffer.from("wrong-offset", "utf8"),
      custodyRef: begun.custodyRef,
      offset: split - 1,
      owner: OWNER
    })).rejects.toMatchObject({
      code: "upload_custody_offset_mismatch",
      expectedOffset: split
    });
    expect(await ciphertextSnapshot(root)).toEqual(beforeCrash);

    const completedAppend: any = await recovered.noRunCustody.stagingPort.append({
      bytes: plaintext.subarray(split),
      custodyRef: begun.custodyRef,
      offset: split,
      owner: OWNER
    });
    expect(completedAppend).toMatchObject({
      committedChunkCount: 2,
      custodyRef: begun.custodyRef,
      nextOffset: plaintext.length,
      state: "staging_no_run"
    });
    const sealed: any = await recovered.noRunCustody.stagingPort.seal({
      custodyRef: begun.custodyRef,
      owner: OWNER
    });
    expect(sealed).toMatchObject({
      byteCount: plaintext.length,
      contentDigest: sha256(plaintext),
      custodyRef: begun.custodyRef,
      envelopeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      replayed: false,
      state: "sealed_no_run"
    });
    await assertNoPersistedPlaintext(root, [
      sentinel,
      plaintext.subarray(0, split),
      plaintext.subarray(split),
      plaintext
    ]);
    await recovered.close();

    const replay: any = openFixture(root);
    await expect(replay.noRunCustody.describe({
      custodyRef: begun.custodyRef,
      owner: OWNER
    })).resolves.toMatchObject({
      byteCount: plaintext.length,
      contentDigest: sha256(plaintext),
      custodyRef: begun.custodyRef,
      envelopeDigest: sealed.envelopeDigest,
      nextOffset: plaintext.length,
      state: "sealed_no_run"
    });
    await expect(replay.noRunCustody.stagingPort.seal({
      custodyRef: begun.custodyRef,
      owner: OWNER
    })).resolves.toMatchObject({
      byteCount: plaintext.length,
      contentDigest: sha256(plaintext),
      custodyRef: begun.custodyRef,
      envelopeDigest: sealed.envelopeDigest,
      replayed: true,
      state: "sealed_no_run"
    });
  });

  it("reconciles a custody cursor committed before upload-session metadata after restart", async () : Promise<any> => {
    const root: any = await tempRoot();
    const plaintext: any = Buffer.alloc(92 * 1024, 0x63);
    const sentinel: any = Buffer.from(
      "upload-session-post-custody-commit-crash-sentinel",
      "utf8"
    );
    sentinel.copy(plaintext, 3072);
    const firstOffset: any = 19 * 1024;
    const crashChunkBytes: any = 23 * 1024;
    const committedOffset: any = firstOffset + crashChunkBytes;
    const first: any = openFixture(root);
    expect(first.custodyDescribe).toBe(first.noRunCustody.describe);
    expect(Object.keys(first.noRunCustody.stagingPort).sort()).toEqual([
      "append",
      "begin",
      "seal"
    ]);
    expect(() : any => createUploadSessionStore({
      userDataPath: root,
      custodyPort: first.noRunCustody.stagingPort
    })).toThrow("Upload session store requires a bound custody describe function.");

    const created: any = await createSession(first.uploadSessionStore, plaintext, {
      checkpointId: "post-custody-commit-crash"
    });
    const custodyRef: any = created.files[0].custodyRef;
    await expect(appendSessionChunk(
      first.uploadSessionStore,
      created.sessionId,
      0,
      plaintext.subarray(0, firstOffset)
    )).resolves.toMatchObject({
      ok: true,
      session: {
        status: "uploading",
        files: [{ receivedBytes: firstOffset }]
      }
    });

    first.uploadSessionFaultState.crashAfterCustodyAppendCommitted = true;
    await expect(appendSessionChunk(
      first.uploadSessionStore,
      created.sessionId,
      firstOffset,
      plaintext.subarray(firstOffset, committedOffset)
    )).rejects.toMatchObject({ code: "upload_session_test_crash" });
    expect(
      first.uploadSessionFaultInjector.afterCustodyAppendCommitted
    ).toHaveBeenLastCalledWith({
      committedOffset,
      custodyRef,
      custodyState: "staging_no_run",
      fileIndex: 0,
      previousOffset: firstOffset
    });
    const sessionFaultProjection: any = JSON.stringify(
      first.uploadSessionFaultInjector.afterCustodyAppendCommitted.mock.calls.at(-1)?.[0]
    );
    expect(sessionFaultProjection).not.toMatch(
      /"(?:bytes|filePath|hostPath|key|owner|path|plaintext|sessionId)"\s*:/u
    );
    await first.close();

    const recovered: any = openFixture(root);
    expect(recovered.custodyDescribe).toBe(recovered.noRunCustody.describe);
    const reconciled: any = await recovered.uploadSessionStore.getUploadSession(
      created.sessionId,
      { owner: OWNER }
    );
    expect(reconciled).toMatchObject({
      sessionId: created.sessionId,
      status: "uploading",
      files: [{
        completed: false,
        custodyRef,
        custodyState: "staging_no_run",
        receivedBytes: committedOffset
      }]
    });
    const persistedMeta: any = JSON.parse(await fs.readFile(
      path.join(root, "upload-sessions", created.sessionId, "meta.json"),
      "utf8"
    ));
    expect(persistedMeta).toMatchObject({
      status: "uploading",
      files: [{
        custodyRef,
        custodyState: "staging_no_run",
        receivedBytes: committedOffset
      }]
    });

    const beforeWrongOffset: any = await ciphertextSnapshot(root);
    await expect(appendSessionChunk(
      recovered.uploadSessionStore,
      created.sessionId,
      firstOffset,
      Buffer.from("must-not-duplicate-committed-custody-bytes", "utf8")
    )).resolves.toMatchObject({
      code: "offset_mismatch",
      expectedOffset: committedOffset,
      ok: false
    });
    expect(await ciphertextSnapshot(root)).toEqual(beforeWrongOffset);

    await expect(appendSessionChunk(
      recovered.uploadSessionStore,
      created.sessionId,
      committedOffset,
      plaintext.subarray(committedOffset)
    )).resolves.toMatchObject({
      code: "ok",
      ok: true,
      session: {
        status: "complete",
        files: [{
          completed: true,
          custodyRef,
          custodyState: "sealed_no_run",
          receivedBytes: plaintext.length
        }]
      }
    });
    const resolved: any = await resolveSingleFile(
      recovered.uploadSessionStore,
      created.sessionId
    );
    expect(resolved).toMatchObject({
      byteSize: plaintext.length,
      contentDigest: sha256(plaintext),
      custodyRef,
      custodyState: "sealed_no_run",
      envelopeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    await expect(recovered.noRunCustody.describe({
      custodyRef,
      owner: OWNER
    })).resolves.toMatchObject({
      byteCount: plaintext.length,
      contentDigest: sha256(plaintext),
      custodyRef,
      nextOffset: plaintext.length,
      state: "sealed_no_run"
    });
    await assertNoPersistedPlaintext(root, [
      sentinel,
      plaintext.subarray(0, firstOffset),
      plaintext.subarray(firstOffset, committedOffset),
      plaintext.subarray(committedOffset),
      plaintext
    ]);
  });

  it("executes the real production composition chain from the bound upload-session store to encrypted storage", async () : Promise<any> => {
    const root: any = await tempRoot();
    const composition: any = await createServerCompositionRoot({
      userDataPath: root,
      runtimeLogger: {
        debug() : any {},
        error() : any {},
        info() : any {},
        warn() : any {}
      },
      runtimeOptions: {
        enabledPlugins: [],
        pluginConfigurations: {}
      }
    });
    resourceClosers.push(() : any => composition.close());
    expect(composition.uploadSessionStore).toEqual(expect.objectContaining({
      appendUploadSessionChunk: expect.any(Function),
      createOrResumeUploadSession: expect.any(Function),
      resolveUploadSessionFiles: expect.any(Function)
    }));
    expect(Object.keys(composition.uploadNoRunCustody).sort()).toEqual([
      "describe",
      "readPort",
      "stagingPort"
    ]);

    const domain: any = createServerConsoleDomainServices({
      userDataPath: root,
      createConsoleDomainServices: ({ uploadSessionStore }: Record<string, any>) : any => (
        Object.freeze({ uploadSessionStore })
      ),
      consoleOperationProviders: Object.freeze({}),
      settingsPort: Object.freeze({
        getSettingsPath: () : any => "settings.json",
        loadSettings: async () : Promise<any> => ({}),
        normalizeSettings: (value?: any) : any => value,
        saveSettings: async () : Promise<any> => undefined
      }),
      uploadSessionStore: composition.uploadSessionStore
    });
    expect(domain.uploadSessionStore).toBe(composition.uploadSessionStore);

    const plaintext: any = Buffer.alloc(52 * 1024, 0x70);
    Buffer.from(
      "#!/bin/sh\nprintf 'production-chain-remains-encrypted'\n",
      "utf8"
    ).copy(plaintext, 1024);
    const firstOffset: any = 11 * 1024;
    const directCustodyOffset: any = 27 * 1024;
    const created: any = await createSession(domain.uploadSessionStore, plaintext, {
      checkpointId: "production-composition-chain",
      mediaType: "application/x-sh",
      relativePath: "production/run.sh"
    });
    await expect(
      appendSessionChunk(
        domain.uploadSessionStore,
        created.sessionId,
        0,
        plaintext.subarray(0, firstOffset)
      )
    ).resolves.toMatchObject({
      ok: true,
      session: {
        status: "uploading",
        files: [{ receivedBytes: firstOffset }]
      }
    });
    const custodyRef: any = created.files[0].custodyRef;
    await expect(composition.uploadNoRunCustody.stagingPort.append({
      bytes: plaintext.subarray(firstOffset, directCustodyOffset),
      custodyRef,
      offset: firstOffset,
      owner: OWNER
    })).resolves.toMatchObject({
      custodyRef,
      nextOffset: directCustodyOffset,
      state: "staging_no_run"
    });
    await expect(domain.uploadSessionStore.getUploadSession(
      created.sessionId,
      { owner: OWNER }
    )).resolves.toMatchObject({
      status: "uploading",
      files: [{
        custodyRef,
        custodyState: "staging_no_run",
        receivedBytes: directCustodyOffset
      }]
    });
    await expect(appendSessionChunk(
      domain.uploadSessionStore,
      created.sessionId,
      directCustodyOffset,
      plaintext.subarray(directCustodyOffset)
    )).resolves.toMatchObject({
      ok: true,
      session: {
        status: "complete",
        files: [{
          custodyRef,
          custodyState: "sealed_no_run",
          receivedBytes: plaintext.length
        }]
      }
    });
    const file: any = await resolveSingleFile(domain.uploadSessionStore, created.sessionId);
    const row: any = storageCustodyRow(composition.storageKernel, file.custodyRef);
    expect(row).toMatchObject({
      byteCount: plaintext.length,
      contentDigest: sha256(plaintext),
      custodyRef: file.custodyRef,
      envelopeDigest: file.envelopeDigest,
      storageRelativePath: expect.any(String)
    });
    const envelopePath: any = composition.storageProvider.resolveStoredObjectPath(
      row.storageRelativePath
    );
    const envelope: any = await fs.readFile(envelopePath);
    expect(envelope.includes(plaintext)).toBe(false);
    await assertNoPersistedPlaintext(root, [plaintext]);
    assertPrivacySafePublicValue(file, [
      root,
      OWNER.subjectId,
      OWNER.tenantId,
      plaintext.toString("utf8")
    ]);
  });
});
