import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createStorageKernel } from "../../../packages/foundation/src/storage/storage-kernel.ts";
import { createStorageProvider } from "../../../packages/foundation/src/storage/storage-provider.ts";
import {
  createArtifactTransitProvider
} from "../../../packages/server-runtime/src/composition/artifact-transit-provider.ts";
import {
  createServerCompositionRoot
} from "../../../packages/server-runtime/src/composition/composition-root.ts";
import {
  createServerConsoleOperationProviders
} from "../../../packages/server-runtime/src/composition/server-runtime-providers.ts";
import {
  createLocalCustodyKeyBroker
} from "../../../packages/server-runtime/src/execution-sandbox/custody-key-broker.ts";
import {
  createUploadNoRunCustody
} from "../../../packages/server-runtime/src/jobs/upload-no-run-custody.ts";
import {
  createUploadSessionStore
} from "../../../packages/server-runtime/src/state/upload-session-store.ts";
import {
  getSessionMetaPath
} from "../../../packages/server-runtime/src/state/upload-session-support.ts";

const CHUNK_BYTES: any = 64 * 1024;
const CURRENT_GRANT_REVISION: any = "artifact-transit-grant-current";
const CURRENT_POLICY_REVISION: any = "artifact-transit-policy-current";
const READ_AUDIENCE: any = "upload-custody-read";
const OWNER: Readonly<Record<string, any>> = Object.freeze({
  subjectId: "artifact-transit-owner",
  tenantId: "artifact-transit-tenant",
  userId: "artifact-transit-user",
  username: "artifact-transit-owner"
});
const OTHER_OWNER: Readonly<Record<string, any>> = Object.freeze({
  subjectId: "artifact-transit-other",
  tenantId: "artifact-transit-tenant",
  userId: "artifact-transit-other",
  username: "artifact-transit-other"
});
const EXPECTED_METADATA_KEYS: readonly any[] = Object.freeze([
  "byteLength",
  "expiresAt",
  "kind",
  "mediaType",
  "name",
  "purpose",
  "reference",
  "sha256"
]);
const EXPECTED_SOURCE_KEYS: readonly any[] = Object.freeze(["metadata", "open"]);
const FORBIDDEN_PUBLIC_KEYS: any = /(?:absolute|content|custody|descriptor|envelope|host|key|object|source|staged|storage|wrapped).*(?:bytes|digest|id|path|ref)?/iu;

const temporaryRoots: any = new Set<any>();
const directFixtures: any = new Set<any>();
const compositionRoots: any = new Set<any>();
const consoleProviders: any = new Set<any>();
let uploadSequence: any = 0;
let receiptSequence: any = 0;

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

function resourceRef(sessionId?: any, fileIndex?: any) : any {
  return `upload-resource:${sessionId}:${fileIndex}`;
}

function authorizationReceiptFor(file?: any, {
  decisionRef = "",
  fileIndex = 0,
  owner = OWNER,
  sessionId,
  ...overrides
}: Record<string, any> = {}) : any {
  receiptSequence += 1;
  const binding: Record<string, any> = {
    audience: READ_AUDIENCE,
    byteCount: file.byteSize,
    contentDigest: file.contentDigest,
    custodyRef: file.custodyRef,
    decisionRef: decisionRef || `artifact-transit-decision:${receiptSequence}`,
    envelopeDigest: file.envelopeDigest,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    grantRevision: CURRENT_GRANT_REVISION,
    ownerBindingDigest: ownerBindingDigest(owner),
    policyRevision: CURRENT_POLICY_REVISION,
    resourceRef: resourceRef(sessionId, fileIndex),
    ...overrides
  };
  return Object.freeze({
    ...binding,
    permitDigest: Object.hasOwn(overrides, "permitDigest")
      ? overrides.permitDigest
      : sha256(canonicalJson(permitBinding(binding)))
  });
}

function createCurrentAuthorization({
  consumedDecisionRefs = new Set<any>(),
  gate = null,
  started = null
}: Record<string, any> = {}) : any {
  const reauthorizeCustodyRead: any = vi.fn(async (request: Record<string, any> = {}) : Promise<any> => {
    started?.resolve?.();
    if (gate) await gate.promise;
    const receipt: any = request.authorizationReceipt;
    const expectedReceiptKeys: any[] = [
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
    const closed: any = Boolean(
      receipt &&
      typeof receipt === "object" &&
      !Array.isArray(receipt) &&
      Object.keys(receipt).sort().join(",") === expectedReceiptKeys.sort().join(",")
    );
    const exactlyBound: any = closed &&
      receipt.audience === READ_AUDIENCE &&
      receipt.audience === request.audience &&
      receipt.byteCount === request.byteCount &&
      receipt.contentDigest === request.contentDigest &&
      receipt.custodyRef === request.custodyRef &&
      receipt.envelopeDigest === request.envelopeDigest &&
      receipt.ownerBindingDigest === request.ownerBindingDigest &&
      receipt.resourceRef === request.resourceRef;
    const canonical: any = exactlyBound &&
      receipt.permitDigest === sha256(canonicalJson(permitBinding(receipt)));
    const current: any = canonical &&
      receipt.grantRevision === CURRENT_GRANT_REVISION &&
      receipt.policyRevision === CURRENT_POLICY_REVISION &&
      Date.parse(receipt.expiresAt) > Date.now() &&
      !consumedDecisionRefs.has(receipt.decisionRef);
    if (current) consumedDecisionRefs.add(receipt.decisionRef);
    return Object.freeze({
      allowed: current,
      currentGrantRevision: CURRENT_GRANT_REVISION,
      currentPolicyRevision: CURRENT_POLICY_REVISION,
      decisionRef: current ? receipt.decisionRef : "",
      evidenceRef: current ? "artifact-transit-current-authorization" : "",
      revoked: false
    });
  });
  return { consumedDecisionRefs, reauthorizeCustodyRead };
}

function logger() : any {
  return {
    debug() : any {},
    error() : any {},
    info() : any {},
    warn() : any {}
  };
}

async function createTemporaryRoot(prefix: any = "meshrix-artifact-custody-") : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.add(root);
  return root;
}

async function openDirectFixture({
  authorization = createCurrentAuthorization(),
  crashNextEncryptedRead = false,
  root = null
}: Record<string, any> = {}) : Promise<any> {
  const userDataPath: any = root || await createTemporaryRoot();
  temporaryRoots.add(userDataPath);
  const storageKernel: any = createStorageKernel({ userDataPath });
  const baseStorageProvider: any = createStorageProvider({ userDataPath, storageKernel });
  const readFault: Record<string, any> = { crashNextEncryptedRead };
  const openPrivateNoExecObjectReadStream: any = vi.fn(async (input?: any) : Promise<any> => {
    const opened: any = await baseStorageProvider.openPrivateNoExecObjectReadStream(input);
    if (!readFault.crashNextEncryptedRead) return opened;
    readFault.crashNextEncryptedRead = false;
    const stream: any = (async function* interruptedEncryptedRead() : AsyncGenerator<any, any, any> {
      for await (const chunk of opened.stream) {
        yield Buffer.from(chunk);
        const error: any = new Error("Authenticated encrypted upload read was interrupted.");
        error.code = "upload_custody_envelope_authentication_failed";
        throw error;
      }
      const error: any = new Error("Authenticated encrypted upload read was interrupted.");
      error.code = "upload_custody_envelope_authentication_failed";
      throw error;
    })();
    return Object.freeze({ ...opened, stream });
  });
  const storageProvider: Readonly<Record<string, any>> = Object.freeze({
    ...baseStorageProvider,
    openPrivateNoExecObjectReadStream
  });
  const baseKeyBroker: any = createLocalCustodyKeyBroker({ userDataPath });
  const unwrapKey: any = vi.fn((...args: any[]) : any => baseKeyBroker.unwrapKey(...args));
  const keyBroker: Readonly<Record<string, any>> = Object.freeze({
    keyReference: baseKeyBroker.keyReference,
    wrapKey: (...args: any[]) : any => baseKeyBroker.wrapKey(...args),
    unwrapKey,
    close: () : any => baseKeyBroker.close()
  });
  const uploadNoRunCustody: any = createUploadNoRunCustody({
    userDataPath,
    storageKernel,
    storageProvider,
    keyBroker,
    reauthorizeCustodyRead: authorization.reauthorizeCustodyRead
  });
  const uploadSessionStore: any = createUploadSessionStore({
    userDataPath,
    custodyPort: uploadNoRunCustody.stagingPort,
    custodyDescribe: uploadNoRunCustody.describe
  });
  const artifactTransitPort: any = await createArtifactTransitProvider({
    userDataPath,
    uploadSessionStore,
    uploadNoRunCustodyReadPort: uploadNoRunCustody.readPort
  });
  const fixture: Record<string, any> = {
    artifactTransitPort,
    authorization,
    baseKeyBroker,
    baseStorageProvider,
    closed: false,
    keyBroker,
    openPrivateNoExecObjectReadStream,
    readFault,
    storageKernel,
    storageProvider,
    unwrapKey,
    uploadNoRunCustody,
    uploadSessionStore,
    userDataPath,
    async close() : Promise<any> {
      if (fixture.closed) return;
      fixture.closed = true;
      directFixtures.delete(fixture);
      await fixture.artifactTransitPort.close();
      await fixture.keyBroker.close();
      fixture.storageKernel.close();
    }
  };
  directFixtures.add(fixture);
  return fixture;
}

async function openCompositionRoot({
  authorization = createCurrentAuthorization(),
  root = null
}: Record<string, any> = {}) : Promise<any> {
  const userDataPath: any = root || await createTemporaryRoot("meshrix-artifact-composition-");
  temporaryRoots.add(userDataPath);
  const composition: any = await createServerCompositionRoot({
    userDataPath,
    pluginHostPorts: {
      reauthorizeCustodyRead: authorization.reauthorizeCustodyRead
    },
    runtimeLogger: logger(),
    runtimeOptions: {
      enabledPlugins: [],
      pluginConfigurations: {}
    }
  });
  compositionRoots.add(composition);
  return { authorization, composition, userDataPath };
}

async function closeCompositionRoot(composition?: any) : Promise<any> {
  if (!compositionRoots.has(composition)) return;
  compositionRoots.delete(composition);
  await composition.close();
}

async function closeConsoleProviders(providers?: any) : Promise<any> {
  if (!consoleProviders.has(providers)) return;
  consoleProviders.delete(providers);
  await providers.close();
}

async function createCompletedUpload(store?: any, payloads?: any, {
  checkpointLabel = "artifact-transit-upload",
  owner = OWNER
}: Record<string, any> = {}) : Promise<any> {
  uploadSequence += 1;
  const label: any = `${checkpointLabel}-${uploadSequence}`;
  const files: any = payloads.map((bytes?: any, index?: any) : any => ({
    byteSize: bytes.byteLength,
    mediaType: "application/octet-stream",
    relativePath: index === 0 ? "bin/installer.sh" : `bin/part-${index}.bin`,
    sha256: sha256(bytes)
  }));
  const created: any = await store.createOrResumeUploadSession({
    checkpoint: {
      archiveBatchId: `${label}-batch`,
      checkpointId: label,
      clientUid: `${label}-client`,
      sourceType: "upload"
    },
    files,
    manifest: {
      inputDigest: sha256(`${label}:input`),
      manifestDigest: sha256(`${label}:manifest`)
    },
    owner
  });
  for (const [fileIndex, bytes] of payloads.entries()) {
    let offset: any = 0;
    while (offset < bytes.byteLength) {
      const end: any = Math.min(offset + CHUNK_BYTES, bytes.byteLength);
      const result: any = await store.appendUploadSessionChunk({
        buffer: bytes.subarray(offset, end),
        fileIndex,
        offset,
        owner,
        sessionId: created.sessionId
      });
      expect(result.ok).toBe(true);
      offset = end;
    }
  }
  const descriptors: any = await store.resolveUploadSessionFiles(created.sessionId, { owner });
  return { created, descriptors, owner, payloads };
}

function referenceFor(upload?: any, fileIndex: any = 0) : any {
  return `upload:${upload.created.sessionId}:${fileIndex}`;
}

async function consumeSource(source?: any) : Promise<any> {
  const chunks: any[] = [];
  for await (const chunk of source.open()) chunks.push(Buffer.from(chunk));
  return { bytes: Buffer.concat(chunks), chunks };
}

async function captureSourceFailure(source?: any) : Promise<any> {
  const chunks: any[] = [];
  let failure: any = null;
  try {
    for await (const chunk of source.open()) chunks.push(Buffer.from(chunk));
  } catch (error: any) {
    failure = error;
  }
  return { chunks, failure };
}

async function captureOpenOrSourceFailure(createSource?: any) : Promise<any> {
  try {
    return captureSourceFailure(await createSource());
  } catch (failure: any) {
    return { chunks: [], failure };
  }
}

function deepKeys(value?: any, result: any = new Set<any>()) : any {
  if (Array.isArray(value)) {
    for (const item of value) deepKeys(item, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [key, item] of (Object.entries(value) as [string, any][])) {
    result.add(key);
    deepKeys(item, result);
  }
  return result;
}

function publicProjectionHasForbiddenKey(value?: any) : any {
  return [...deepKeys(value)].some((key?: any) : any => FORBIDDEN_PUBLIC_KEYS.test(key));
}

function expectPrivacySafeFailure(failure?: any, root?: any) : any {
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure.code || failure.reasonCode || "")).not.toBe("");
  expect(String(failure.message || "")).not.toContain(root);
  expect(failure).not.toHaveProperty("path");
  expect(failure).not.toHaveProperty("storageRelativePath");
  expect(failure).not.toHaveProperty("custodyRef");
}

async function sourceFor(port?: any, upload?: any, receipt?: any, {
  fileIndex = 0,
  owner = upload.owner,
  signal
}: Record<string, any> = {}) : Promise<any> {
  return port.openRead(
    referenceFor(upload, fileIndex),
    owner,
    "artifact-transit-acceptance",
    {
      authorizationReceipt: receipt,
      signal
    }
  );
}

afterEach(async () : Promise<any> => {
  for (const providers of [...consoleProviders].reverse()) {
    await closeConsoleProviders(providers);
  }
  for (const composition of [...compositionRoots].reverse()) {
    await closeCompositionRoot(composition);
  }
  for (const fixture of [...directFixtures].reverse()) {
    await fixture.close();
  }
  for (const root of [...temporaryRoots].reverse()) {
    await fs.rm(root, { recursive: true, force: true });
    temporaryRoots.delete(root);
  }
  vi.clearAllMocks();
});

describe("artifact transit bound upload custody", () : any => {
  it("requires the exact branded same-root store/read-port pair and wires production providers by identity", async () : Promise<any> => {
    const first: any = await openCompositionRoot();
    const second: any = await openCompositionRoot();
    const wrappedStore: Readonly<Record<string, any>> = Object.freeze({
      resolveUploadSessionFiles: (...args: any[]) : any => (
        first.composition.uploadSessionStore.resolveUploadSessionFiles(...args)
      )
    });
    const wrappedReadPort: Readonly<Record<string, any>> = Object.freeze({
      open: (...args: any[]) : any => first.composition.uploadNoRunCustody.readPort.open(...args)
    });
    const invalidBindings: any[] = [
      {
        uploadSessionStore: null,
        uploadNoRunCustodyReadPort: first.composition.uploadNoRunCustody.readPort
      },
      {
        uploadSessionStore: wrappedStore,
        uploadNoRunCustodyReadPort: first.composition.uploadNoRunCustody.readPort
      },
      {
        uploadSessionStore: first.composition.uploadSessionStore,
        uploadNoRunCustodyReadPort: wrappedReadPort
      },
      {
        uploadSessionStore: first.composition.uploadSessionStore,
        uploadNoRunCustodyReadPort: second.composition.uploadNoRunCustody.readPort
      },
      {
        uploadSessionStore: second.composition.uploadSessionStore,
        uploadNoRunCustodyReadPort: first.composition.uploadNoRunCustody.readPort
      }
    ];

    for (const binding of invalidBindings) {
      await expect(createArtifactTransitProvider({
        userDataPath: first.userDataPath,
        ...binding
      })).rejects.toMatchObject({ code: "upload_session_store_binding_invalid" });
    }
    await expect(createArtifactTransitProvider({
      userDataPath: second.userDataPath,
      uploadSessionStore: first.composition.uploadSessionStore,
      uploadNoRunCustodyReadPort: first.composition.uploadNoRunCustody.readPort
    })).rejects.toMatchObject({ code: "upload_session_store_binding_invalid" });

    const providers: any = await createServerConsoleOperationProviders({
      getAgentWorkspace: () : any => null,
      getListenUrl: () : any => "http://gateway.invalid",
      operationAuditStore: first.composition.operationAuditStore,
      operationProofSubstrate: first.composition.operationProofSubstrate,
      securityPermissions: first.composition.securityPermissions,
      storageProvider: first.composition.storageProvider,
      uploadNoRunCustodyReadPort: first.composition.uploadNoRunCustody.readPort,
      uploadSessionStore: first.composition.uploadSessionStore,
      userDataPath: first.userDataPath
    });
    consoleProviders.add(providers);
    const payload: any = Buffer.from("root-owned encrypted artifact transit", "utf8");
    const upload: any = await createCompletedUpload(
      first.composition.uploadSessionStore,
      [payload],
      { checkpointLabel: "root-owned-artifact" }
    );
    const file: any = upload.descriptors[0];
    const receipt: any = authorizationReceiptFor(file, {
      sessionId: upload.created.sessionId
    });
    const source: any = await sourceFor(providers.artifactTransitPort, upload, receipt);
    await expect(consumeSource(source)).resolves.toMatchObject({ bytes: payload });
    expect(source.metadata.reference).toBe(referenceFor(upload));
  });

  it("returns only frozen logical metadata, rejects upload ranges, and streams only through authorized custody", async () : Promise<any> => {
    const fixture: any = await openDirectFixture();
    const payload: any = Buffer.concat([
      Buffer.from("#!/bin/sh\n", "utf8"),
      Buffer.alloc(CHUNK_BYTES, 0x61),
      Buffer.alloc(37, 0x62)
    ]);
    const upload: any = await createCompletedUpload(fixture.uploadSessionStore, [payload]);
    const file: any = upload.descriptors[0];
    const reference: any = referenceFor(upload);
    const metadata: any = await fixture.artifactTransitPort.resolve(
      reference,
      OWNER,
      "artifact-transit-acceptance"
    );
    expect(Object.keys(metadata).sort()).toEqual([...EXPECTED_METADATA_KEYS].sort());
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(metadata).toEqual({
      byteLength: payload.byteLength,
      expiresAt: "",
      kind: "upload",
      mediaType: "application/octet-stream",
      name: "installer.sh",
      purpose: "artifact-transit-acceptance",
      reference,
      sha256: sha256(payload)
    });
    expect(publicProjectionHasForbiddenKey(metadata)).toBe(false);
    expect(canonicalJson(metadata)).not.toContain(fixture.userDataPath);

    const receipt: any = authorizationReceiptFor(file, {
      sessionId: upload.created.sessionId
    });
    await expect(fixture.artifactTransitPort.openRead(
      reference,
      OWNER,
      "artifact-transit-acceptance",
      { authorizationReceipt: receipt, start: 0, end: 8 }
    )).rejects.toMatchObject({ code: "artifact_upload_range_unsupported" });
    expect(fixture.authorization.reauthorizeCustodyRead).not.toHaveBeenCalled();
    expect(fixture.openPrivateNoExecObjectReadStream).not.toHaveBeenCalled();
    expect(fixture.unwrapKey).not.toHaveBeenCalled();

    const source: any = await sourceFor(fixture.artifactTransitPort, upload, receipt);
    expect(Object.keys(source).sort()).toEqual([...EXPECTED_SOURCE_KEYS].sort());
    expect(Object.isFrozen(source)).toBe(true);
    expect(source.metadata).toEqual(metadata);
    expect(publicProjectionHasForbiddenKey(source)).toBe(false);
    expect(canonicalJson(source.metadata)).not.toContain(fixture.userDataPath);
    const consumed: any = await consumeSource(source);
    expect(consumed.bytes).toEqual(payload);
    expect(Math.max(...consumed.chunks.map((chunk?: any) : any => chunk.byteLength))).toBeLessThanOrEqual(CHUNK_BYTES);
    expect(fixture.authorization.reauthorizeCustodyRead).toHaveBeenCalledOnce();
    expect(fixture.openPrivateNoExecObjectReadStream).toHaveBeenCalledOnce();
    expect(fixture.unwrapKey).toHaveBeenCalled();
  });

  it("denies missing authority and every owner, resource, content, envelope, size, or cancellation substitution before plaintext", async () : Promise<any> => {
    const fixture: any = await openDirectFixture();
    const firstPayload: any = Buffer.from("first sealed artifact payload", "utf8");
    const secondPayload: any = Buffer.from("other sealed artifact bytes", "utf8");
    const first: any = await createCompletedUpload(
      fixture.uploadSessionStore,
      [firstPayload, secondPayload],
      { checkpointLabel: "multi-file-artifact" }
    );
    const alternate: any = await createCompletedUpload(
      fixture.uploadSessionStore,
      [Buffer.from("alternate session artifact", "utf8")],
      { checkpointLabel: "alternate-artifact" }
    );
    const file: any = first.descriptors[0];
    const otherFile: any = first.descriptors[1];
    const alternateFile: any = alternate.descriptors[0];

    await expect(fixture.artifactTransitPort.openRead(
      referenceFor(first),
      OWNER,
      "artifact-transit-acceptance"
    )).rejects.toMatchObject({ code: "artifact_upload_authorization_required" });
    await expect(fixture.artifactTransitPort.openRead(
      referenceFor(first),
      OWNER,
      "artifact-transit-acceptance",
      { authorizationReceipt: { audience: READ_AUDIENCE } }
    )).rejects.toMatchObject({ code: "artifact_upload_authorization_required" });

    const exactBase: Record<string, any> = {
      fileIndex: 0,
      sessionId: first.created.sessionId
    };
    const attempts: any[] = [
      {
        label: "forged permit",
        owner: OWNER,
        receipt: authorizationReceiptFor(file, {
          ...exactBase,
          permitDigest: "f".repeat(64)
        })
      },
      {
        label: "different session resource",
        owner: OWNER,
        receipt: authorizationReceiptFor(alternateFile, {
          fileIndex: 0,
          sessionId: alternate.created.sessionId
        })
      },
      {
        label: "different file index resource",
        owner: OWNER,
        receipt: authorizationReceiptFor(otherFile, {
          fileIndex: 1,
          sessionId: first.created.sessionId
        })
      },
      {
        label: "content digest substitution",
        owner: OWNER,
        receipt: authorizationReceiptFor(file, {
          ...exactBase,
          contentDigest: alternateFile.contentDigest
        })
      },
      {
        label: "envelope digest substitution",
        owner: OWNER,
        receipt: authorizationReceiptFor(file, {
          ...exactBase,
          envelopeDigest: alternateFile.envelopeDigest
        })
      },
      {
        label: "plaintext size substitution",
        owner: OWNER,
        receipt: authorizationReceiptFor(file, {
          ...exactBase,
          byteCount: file.byteSize + 1
        })
      },
      {
        label: "owner substitution",
        owner: OTHER_OWNER,
        receipt: authorizationReceiptFor(file, {
          ...exactBase,
          owner: OTHER_OWNER
        })
      }
    ];

    for (const attempt of attempts) {
      const openCount: any = fixture.openPrivateNoExecObjectReadStream.mock.calls.length;
      const unwrapCount: any = fixture.unwrapKey.mock.calls.length;
      const denied: any = await captureOpenOrSourceFailure(() : any => sourceFor(
        fixture.artifactTransitPort,
        first,
        attempt.receipt,
        { owner: attempt.owner }
      ));
      expect(denied.chunks, attempt.label).toHaveLength(0);
      expectPrivacySafeFailure(denied.failure, fixture.userDataPath);
      expect(fixture.openPrivateNoExecObjectReadStream.mock.calls.length, attempt.label)
        .toBe(openCount);
      expect(fixture.unwrapKey.mock.calls.length, attempt.label).toBe(unwrapCount);
    }

    const controller: any = new AbortController();
    controller.abort();
    const abortedReceipt: any = authorizationReceiptFor(file, {
      ...exactBase,
      decisionRef: "artifact-transit-decision:pre-aborted"
    });
    const beforeAbortOpen: any = fixture.openPrivateNoExecObjectReadStream.mock.calls.length;
    const beforeAbortUnwrap: any = fixture.unwrapKey.mock.calls.length;
    const aborted: any = await captureOpenOrSourceFailure(() : any => sourceFor(
      fixture.artifactTransitPort,
      first,
      abortedReceipt,
      { signal: controller.signal }
    ));
    expect(aborted.chunks).toHaveLength(0);
    expect(aborted.failure).toMatchObject({ code: "upload_custody_read_aborted" });
    expect(fixture.openPrivateNoExecObjectReadStream).toHaveBeenCalledTimes(beforeAbortOpen);
    expect(fixture.unwrapKey).toHaveBeenCalledTimes(beforeAbortUnwrap);

    const controlReceipt: any = authorizationReceiptFor(file, {
      ...exactBase,
      decisionRef: "artifact-transit-decision:substitution-control"
    });
    const control: any = await sourceFor(fixture.artifactTransitPort, first, controlReceipt);
    await expect(consumeSource(control)).resolves.toMatchObject({ bytes: firstPayload });
  });

  it("re-resolves and reconciles the sealed descriptor when the lazy stream actually opens", async () : Promise<any> => {
    const fixture: any = await openDirectFixture();
    const payload: any = Buffer.from("open-time reconciliation payload", "utf8");
    const upload: any = await createCompletedUpload(fixture.uploadSessionStore, [payload]);
    const file: any = upload.descriptors[0];
    const receipt: any = authorizationReceiptFor(file, {
      decisionRef: "artifact-transit-decision:pre-drift",
      sessionId: upload.created.sessionId
    });
    const source: any = await sourceFor(fixture.artifactTransitPort, upload, receipt);
    const metaPath: any = getSessionMetaPath(fixture.userDataPath, upload.created.sessionId);
    const originalMeta: any = await fs.readFile(metaPath, "utf8");
    const substitutedMeta: any = JSON.parse(originalMeta);
    substitutedMeta.files[0].sha256 = sha256("substituted declaration");
    await fs.writeFile(metaPath, JSON.stringify(substitutedMeta, null, 2), "utf8");

    const beforeAuthorization: any = fixture.authorization.reauthorizeCustodyRead.mock.calls.length;
    const beforeOpen: any = fixture.openPrivateNoExecObjectReadStream.mock.calls.length;
    const beforeUnwrap: any = fixture.unwrapKey.mock.calls.length;
    const denied: any = await captureSourceFailure(source);
    expect(denied.chunks).toHaveLength(0);
    expect(denied.failure).toMatchObject({ code: "upload_session_custody_state_invalid" });
    expect(fixture.authorization.reauthorizeCustodyRead).toHaveBeenCalledTimes(beforeAuthorization);
    expect(fixture.openPrivateNoExecObjectReadStream).toHaveBeenCalledTimes(beforeOpen);
    expect(fixture.unwrapKey).toHaveBeenCalledTimes(beforeUnwrap);
    expectPrivacySafeFailure(denied.failure, fixture.userDataPath);

    await fs.writeFile(metaPath, originalMeta, "utf8");
    const freshReceipt: any = authorizationReceiptFor(file, {
      decisionRef: "artifact-transit-decision:post-drift-control",
      sessionId: upload.created.sessionId
    });
    const fresh: any = await sourceFor(fixture.artifactTransitPort, upload, freshReceipt);
    await expect(consumeSource(fresh)).resolves.toMatchObject({ bytes: payload });
  });

  it("releases no plaintext on encrypted-read interruption and denies receipt replay across restart", async () : Promise<any> => {
    const consumedDecisionRefs: any = new Set<any>();
    const authorization: any = createCurrentAuthorization({ consumedDecisionRefs });
    const fixture: any = await openDirectFixture({
      authorization,
      crashNextEncryptedRead: true
    });
    const payload: any = Buffer.concat([
      Buffer.alloc(CHUNK_BYTES, 0x63),
      Buffer.alloc(CHUNK_BYTES, 0x64),
      Buffer.from("interrupted-tail", "utf8")
    ]);
    const upload: any = await createCompletedUpload(
      fixture.uploadSessionStore,
      [payload],
      { checkpointLabel: "interrupted-artifact" }
    );
    const file: any = upload.descriptors[0];
    const receipt: any = authorizationReceiptFor(file, {
      decisionRef: "artifact-transit-decision:interrupted",
      sessionId: upload.created.sessionId
    });
    const interruptedSource: any = await sourceFor(fixture.artifactTransitPort, upload, receipt);
    const interrupted: any = await captureSourceFailure(interruptedSource);
    expect(interrupted.chunks).toHaveLength(0);
    expect(interrupted.failure).toMatchObject({
      code: "upload_custody_envelope_authentication_failed"
    });
    expectPrivacySafeFailure(interrupted.failure, fixture.userDataPath);
    expect(fixture.openPrivateNoExecObjectReadStream).toHaveBeenCalledOnce();
    expect(fixture.unwrapKey).toHaveBeenCalled();

    const openCountAfterCrash: any = fixture.openPrivateNoExecObjectReadStream.mock.calls.length;
    const unwrapCountAfterCrash: any = fixture.unwrapKey.mock.calls.length;
    const sameProcessReplay: any = await sourceFor(fixture.artifactTransitPort, upload, receipt);
    const sameProcessDenied: any = await captureSourceFailure(sameProcessReplay);
    expect(sameProcessDenied.chunks).toHaveLength(0);
    expect(sameProcessDenied.failure).toMatchObject({ code: "upload_custody_read_denied" });
    expect(fixture.openPrivateNoExecObjectReadStream).toHaveBeenCalledTimes(openCountAfterCrash);
    expect(fixture.unwrapKey).toHaveBeenCalledTimes(unwrapCountAfterCrash);

    const userDataPath: any = fixture.userDataPath;
    await fixture.close();
    const restartedAuthorization: any = createCurrentAuthorization({ consumedDecisionRefs });
    const restarted: any = await openDirectFixture({
      authorization: restartedAuthorization,
      root: userDataPath
    });
    const restartedReplay: any = await sourceFor(restarted.artifactTransitPort, upload, receipt);
    const restartedDenied: any = await captureSourceFailure(restartedReplay);
    expect(restartedDenied.chunks).toHaveLength(0);
    expect(restartedDenied.failure).toMatchObject({ code: "upload_custody_read_denied" });
    expect(restarted.openPrivateNoExecObjectReadStream).not.toHaveBeenCalled();
    expect(restarted.unwrapKey).not.toHaveBeenCalled();
    expectPrivacySafeFailure(restartedDenied.failure, restarted.userDataPath);

    const freshReceipt: any = authorizationReceiptFor(file, {
      decisionRef: "artifact-transit-decision:restart-fresh",
      sessionId: upload.created.sessionId
    });
    const freshSource: any = await sourceFor(restarted.artifactTransitPort, upload, freshReceipt);
    const fresh: any = await consumeSource(freshSource);
    expect(fresh.bytes).toEqual(payload);
    expect(Math.max(...fresh.chunks.map((chunk?: any) : any => chunk.byteLength))).toBeLessThanOrEqual(CHUNK_BYTES);
    expect(restarted.openPrivateNoExecObjectReadStream).toHaveBeenCalledOnce();
    expect(restarted.unwrapKey).toHaveBeenCalled();
  });
});
