import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ACCOUNT_API_ROUTES, type AccountActionTarget, type AccountAuthorityBinding } from "@meshrix/contracts/account";
import {
  deriveRecoveryMaterial,
  deviceIdentityFromCustody,
  enrollDeviceIdentity,
  generateRecoveryKey,
  parseRecoveryText,
  type CustodyAdapter,
  type RecoveryMaterial
} from "@meshrix/entry";
import { EntryConfigStore, EntryProductService } from "@meshrix/entry-gui";

import { FakeVault } from "../entry/helpers.ts";
import { serviceConfigFixture } from "./helpers.ts";

const ACCOUNT_ORIGIN = "https://account.meshrix.invalid";
const ACCOUNT: AccountAuthorityBinding = { accountId: "account.writer.1", authEpoch: 7 };
const VAULT_ID = "vault.account.writer.1";
const ACCOUNT_SESSION_REF = "entry-gui.account.session";
const DESKTOP_KEY_PREFIX = "entry-gui.account.desktop";
const dirs: string[] = [];
const services: EntryProductService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop().catch(() => undefined);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

class MemoryOsCustody implements CustodyAdapter {
  readonly kind = "test-os-custody";
  readonly #values = new Map<string, Uint8Array>();

  async available(): Promise<boolean> { return true; }
  async storeSecret(input: { ref: string; secret: Uint8Array }): Promise<void> {
    this.#values.set(input.ref, input.secret.slice());
  }
  async loadSecret(input: { ref: string }): Promise<Uint8Array | null> {
    return this.#values.get(input.ref)?.slice() ?? null;
  }
  async deleteSecret(input: { ref: string }): Promise<void> { this.#values.delete(input.ref); }
}

function materialBytes(material: RecoveryMaterial): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    v: 1,
    signingKeyId: material.signing.keyId,
    signingPkcs8: Buffer.from(material.signing.privateKey.export({ format: "der", type: "pkcs8" })).toString("base64url"),
    writerKeyId: material.writer.keyId,
    writerPkcs8: Buffer.from(material.writer.privateKey.export({ format: "der", type: "pkcs8" })).toString("base64url"),
    backupKey: material.backupKey.toString("base64url")
  }));
}

function custodyRecoveryRef(vaultId: string, keyId: string): string {
  const suffix = keyId.replace(/[^a-z0-9._-]/giu, "-").toLowerCase();
  return `entry-gui.recovery.${vaultId}.${suffix}`.slice(0, 128);
}

function writerKey(material: RecoveryMaterial) {
  return { keyId: material.writer.keyId, algorithm: "Ed25519" as const, publicKey: material.writer.publicKey };
}

function verifierKey(material: RecoveryMaterial) {
  return { keyId: material.signing.keyId, algorithm: "Ed25519" as const, publicKey: material.signing.publicKey };
}

async function startManagedWriter(prepareTarget: (body: Record<string, unknown>, identityPublicKey: string) => Record<string, unknown>): Promise<{
  service: EntryProductService;
  store: EntryConfigStore;
  incumbent: { keyId: string; generation: number };
  prepareCount: () => number;
  stepUpCount: () => number;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "entry-account-writer-deny-"));
  dirs.push(dir);
  const custody = new MemoryOsCustody();
  const desktopIdentity = await enrollDeviceIdentity({ custody, refPrefix: DESKTOP_KEY_PREFIX });
  const entryIdentity = await enrollDeviceIdentity({ custody, deviceId: "device.entry.writer.deny" });
  const oldMaterial = deriveRecoveryMaterial(generateRecoveryKey({ vaultId: VAULT_ID }).secret);
  const oldMaterialRef = custodyRecoveryRef(VAULT_ID, oldMaterial.signing.keyId);
  await custody.storeSecret({ ref: oldMaterialRef, secret: materialBytes(oldMaterial) });
  await custody.storeSecret({ ref: ACCOUNT_SESSION_REF, secret: new TextEncoder().encode("opaque-desktop-account-session-credential-writer-deny") });
  const store = new EntryConfigStore({ dataDir: dir });
  await store.load();
  await store.update((draft) => ({
    ...draft,
    account: { desktopDeviceId: desktopIdentity.deviceId, accountId: ACCOUNT.accountId, authEpoch: ACCOUNT.authEpoch, sessionCredentialRef: ACCOUNT_SESSION_REF },
    connections: [{
      connectionId: "conn.account.writer.deny",
      displayLabel: "Managed endpoint",
      tenantId: "tenant.writer.1",
      routeId: "route.writer.1",
      mode: "personal",
      endpointPrincipalRef: "principal.writer.1",
      endpointDeviceId: "device.endpoint.writer.1",
      endpointSpkiPin: "spki.endpoint.writer.1",
      relayService: "https://relay.meshrix.invalid",
      vaultId: VAULT_ID,
      deviceId: entryIdentity.deviceId,
      deviceFingerprint: entryIdentity.fingerprint,
      capabilityGrantRef: "grant.initial.writer.deny",
      relayCredentialRef: "entry-gui.relay.conn.account.writer.deny",
      boundRecoveryKeyId: oldMaterial.signing.keyId,
      pairingService: null,
      admissionGeneration: 1,
      revocationRevision: 0,
      enrolledAt: "2026-01-01T00:00:00.000Z",
      remoteRevocation: "none",
      routeRevocation: null,
      accountBinding: ACCOUNT,
      rePairRequired: false
    }],
    recovery: {
      vaultId: VAULT_ID,
      keyId: oldMaterial.signing.keyId,
      generation: 4,
      materialRef: oldMaterialRef,
      confirmedAt: "2026-01-01T00:00:00.000Z",
      accountWriterState: "complete",
      accountSnapshotState: "ready",
      snapshotSourceMaterialRef: null,
      retainedMaterialRefs: []
    }
  }));
  let stepUps = 0;
  let prepares = 0;
  const accountFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url.pathname === ACCOUNT_API_ROUTES.desktopVaultWriterRotationPrepare) {
      prepares += 1;
      return Response.json(prepareTarget(body, entryIdentity.publicKey));
    }
    if (url.pathname === ACCOUNT_API_ROUTES.desktopTransaction) {
      stepUps += 1;
      return Response.json({ transactionId: "txn.should.not.start", browserUrl: `${ACCOUNT_ORIGIN}/account?transactionId=txn.should.not.start` });
    }
    throw new Error(`Unexpected account route ${url.pathname}`);
  };
  const service = new EntryProductService({ dataDir: dir, custody, serviceConfig: serviceConfigFixture(ACCOUNT_ORIGIN), accountFetch, vaultTransportFactory: () => new FakeVault({ vaultId: VAULT_ID, verifier: verifierKey(oldMaterial), writers: [writerKey(oldMaterial)], generation: 4 }) });
  services.push(service);
  await service.start();
  await service.beginRecoveryRotation();
  service.revealRecoveryKey();
  return {
    service,
    store,
    incumbent: { keyId: oldMaterial.signing.keyId, generation: 4 },
    prepareCount: () => prepares,
    stepUpCount: () => stepUps
  };
}

describe("durable GUI snapshot publication", () => {
  it("retains exact capacity-limited ciphertext across restart and acknowledges a lost response without another revision", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "entry-backup-capacity-"));
    dirs.push(dir);
    const custody = new MemoryOsCustody();
    const material = deriveRecoveryMaterial(generateRecoveryKey({ vaultId: VAULT_ID }).secret);
    const materialRef = custodyRecoveryRef(VAULT_ID, material.signing.keyId);
    await custody.storeSecret({ ref: materialRef, secret: materialBytes(material) });
    const store = new EntryConfigStore({ dataDir: dir });
    await store.load();
    await store.update((draft) => ({ ...draft,
      pairingServiceDefault: "https://relay.synthetic.invalid",
      recovery: { vaultId: VAULT_ID, keyId: material.signing.keyId, generation: 1,
        materialRef, confirmedAt: "2026-01-01T00:00:00.000Z", accountWriterState: "unmanaged",
        accountSnapshotState: "ready", snapshotSourceMaterialRef: null, retainedMaterialRefs: [] }
    }));
    const vault = new FakeVault({ vaultId: VAULT_ID, verifier: verifierKey(material), writers: [writerKey(material)] });
    let capacity = false;
    const writes: Record<string, unknown>[] = [];
    const options = { dataDir: dir, custody, vaultTransportFactory: () => ({ async post(input: { vaultId: string; message: Record<string, unknown> }) {
      if (input.message.kind === "vault-write") {
        writes.push(structuredClone(input.message));
        // Production journal must already be durable before the transport runs.
        const persisted = JSON.parse(await readFile(store.filePath, "utf8"));
        expect(persisted.journal.pendingWrite.snapshot).toEqual(input.message.snapshot);
        if (capacity) return { status: 429, body: { error: "rate_limited", retryable: true } };
      }
      return vault.post(input);
    } }) };
    let service = new EntryProductService(options);
    services.push(service);
    await service.start();
    const success = await service.publishSnapshot();
    expect(success.recovery.backup.lastCommittedRevision).toBe(1);
    capacity = true;
    const [pending, coalesced] = await Promise.all([service.publishSnapshot(), service.publishSnapshot()]);
    expect(coalesced).toEqual(pending);
    expect(writes).toHaveLength(2);
    expect(pending.recovery.backup.lastError).toContain("vault_write_capacity");
    expect(pending.recovery.backup.lastCommittedRevision).toBe(1);
    expect(pending.recovery.backup.lastSuccessAt).toBe(success.recovery.backup.lastSuccessAt);
    expect(vault.fetchCount).toBe(0);
    await service.stop();
    capacity = false;
    service = new EntryProductService(options);
    services.push(service);
    await service.start();
    expect((await service.publishSnapshot()).recovery.backup.lastCommittedRevision).toBe(2);
    expect(writes[2]?.snapshot).toEqual(writes[1]?.snapshot);
    expect(writes[2]?.writeAuth).not.toEqual(writes[1]?.writeAuth);
    vault.dropNextWriteResponse = true;
    const lost = await service.publishSnapshot();
    expect(lost.recovery.backup.lastError).toContain("invalid_response");
    expect(vault.current?.revision).toBe(3);
    await service.stop();
    service = new EntryProductService(options);
    services.push(service);
    await service.start();
    expect((await service.publishSnapshot()).recovery.backup.lastCommittedRevision).toBe(3);
    expect(writes[4]?.snapshot).toEqual(writes[3]?.snapshot);
    expect(vault.current?.revision).toBe(3);
    const saved = JSON.parse(await readFile(store.filePath, "utf8"));
    expect(saved.journal.pendingWrite).toBeNull();
    expect(saved.recovery.accountWriterState).toBe("unmanaged");
    capacity = true;
    await service.publishSnapshot();
    const originalPending = writes.at(-1)?.snapshot;
    await service.stop();
    const changedStore = new EntryConfigStore({ dataDir: dir });
    await changedStore.load();
    await changedStore.update((draft) => ({ ...draft, profile: { displayLabel: "Updated synthetic profile" } }));
    capacity = false;
    service = new EntryProductService(options);
    services.push(service);
    await service.start();
    expect((await service.publishSnapshot()).recovery.backup.lastCommittedRevision).toBe(5);
    expect(writes.at(-2)?.snapshot).toEqual(originalPending);
    expect(writes.at(-1)?.snapshot).not.toEqual(originalPending);
    expect(vault.current?.revision).toBe(5);
  });
});

describe("account-managed vault writer re-enrollment", () => {
  it("keeps one candidate, allows explicit pre-confirm cancellation, and coalesces confirmation through account approval", async () => {
    const prepareTarget = (body: Record<string, unknown>, devicePublicKey: string) => ({
      operationId: body.operationId,
      account: ACCOUNT,
      expiresAt: "2099-01-01T00:00:00.000Z",
      target: {
        tenantId: "tenant.writer.1",
        routeId: "route.writer.1",
        deviceId: "device.entry.writer.deny",
        devicePublicKey,
        grantRef: "grant.writer.rotation.cancel",
        scopes: ["vault:write"],
        vaultWriterRotation: {
          vaultId: VAULT_ID,
          generation: 5,
          writers: body.writers,
          recoveryVerifier: body.recoveryVerifier
        }
      }
    });
    const started = await startManagedWriter(prepareTarget);
    const candidate = started.service.snapshot().recovery;
    expect(candidate.state).toBe("awaiting_save");
    expect(candidate.generation).toBe(5);
    expect(candidate.keyId).not.toBe(started.incumbent.keyId);

    await expect(started.service.beginRecoveryRotation()).rejects.toMatchObject({ code: "recovery_state_invalid" });
    expect(started.service.snapshot().recovery.keyId).toBe(candidate.keyId);
    expect(started.service.snapshot().recovery.generation).toBe(candidate.generation);
    expect(started.prepareCount()).toBe(0);
    expect(started.stepUpCount()).toBe(0);

    const cancelled = await started.service.dispatch("recovery.abortRotation");
    expect(cancelled.ok).toBe(true);
    const incumbent = (cancelled as { value: ReturnType<EntryProductService["snapshot"]> }).value.recovery;
    expect(incumbent.state).toBe("ready");
    expect(incumbent.keyId).toBe(started.incumbent.keyId);
    expect(incumbent.generation).toBe(started.incumbent.generation);

    const restarted = await started.service.dispatch("recovery.beginRotation");
    expect(restarted.ok).toBe(true);
    const replacement = (restarted as { value: ReturnType<EntryProductService["snapshot"]> }).value.recovery;
    expect(replacement.state).toBe("awaiting_save");
    expect(replacement.generation).toBe(started.incumbent.generation + 1);
    expect(replacement.keyId).not.toBe(candidate.keyId);
    const revealed = await started.service.dispatch("recovery.revealKey");
    expect(revealed.ok).toBe(true);

    const confirmations = await Promise.all([
      started.service.dispatch("recovery.confirmSaved"),
      started.service.dispatch("recovery.confirmSaved")
    ]);
    expect(confirmations[0]).toEqual(confirmations[1]);
    expect(confirmations[0].ok).toBe(true);
    expect((confirmations[0] as { value: ReturnType<EntryProductService["snapshot"]> }).value.recovery.state)
      .toBe("account_authorization_required");
    expect(started.prepareCount()).toBe(1);
    expect(started.stepUpCount()).toBe(1);

    const blockedCancel = await started.service.dispatch("recovery.abortRotation");
    expect(blockedCancel.ok).toBe(false);
    if (!blockedCancel.ok) expect(blockedCancel.error.code).toBe("account_transaction_pending");
    const persisted = JSON.parse(await readFile(started.store.filePath, "utf8")) as {
      accountVaultWriterOperation: unknown;
    };
    expect(persisted.accountVaultWriterOperation).not.toBeNull();
    expect(started.prepareCount()).toBe(1);
    expect(started.stepUpCount()).toBe(1);
  });

  it("requires fresh exact step-up, reconciles the preserved snapshot before publishing, and keeps routine writes usable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "entry-account-writer-"));
    dirs.push(dir);
    const custody = new MemoryOsCustody();
    const desktopIdentity = await enrollDeviceIdentity({ custody, refPrefix: DESKTOP_KEY_PREFIX });
    const entryIdentity = await enrollDeviceIdentity({ custody, deviceId: "device.entry.writer.1" });
    const oldMaterial = deriveRecoveryMaterial(generateRecoveryKey({ vaultId: VAULT_ID }).secret);
    const oldMaterialRef = custodyRecoveryRef(VAULT_ID, oldMaterial.signing.keyId);
    await custody.storeSecret({ ref: oldMaterialRef, secret: materialBytes(oldMaterial) });
    await custody.storeSecret({ ref: ACCOUNT_SESSION_REF, secret: new TextEncoder().encode("opaque-desktop-account-session-credential-writer-test") });

    const connectionId = "conn.account.writer.1";
    const relayCredentialRef = "entry-gui.relay.conn.account.writer.1";
    const store = new EntryConfigStore({ dataDir: dir });
    await store.load();
    await store.update((draft) => ({
      ...draft,
      account: {
        desktopDeviceId: desktopIdentity.deviceId,
        accountId: ACCOUNT.accountId,
        authEpoch: ACCOUNT.authEpoch,
        sessionCredentialRef: ACCOUNT_SESSION_REF
      },
      connections: [{
        connectionId,
        displayLabel: "Managed endpoint",
        tenantId: "tenant.writer.1",
        routeId: "route.writer.1",
        mode: "personal",
        endpointPrincipalRef: "principal.writer.1",
        endpointDeviceId: "device.endpoint.writer.1",
        endpointSpkiPin: "spki.endpoint.writer.1",
        relayService: "https://relay.meshrix.invalid",
        vaultId: VAULT_ID,
        deviceId: entryIdentity.deviceId,
        deviceFingerprint: entryIdentity.fingerprint,
        capabilityGrantRef: "grant.initial.writer.1",
        relayCredentialRef,
        boundRecoveryKeyId: oldMaterial.signing.keyId,
        pairingService: null,
        admissionGeneration: 1,
        revocationRevision: 0,
        enrolledAt: "2026-01-01T00:00:00.000Z",
        remoteRevocation: "none",
        routeRevocation: null,
        accountBinding: ACCOUNT,
        rePairRequired: false
      }],
      recovery: {
        vaultId: VAULT_ID,
        keyId: oldMaterial.signing.keyId,
        generation: 4,
        materialRef: oldMaterialRef,
        confirmedAt: "2026-01-01T00:00:00.000Z",
        accountWriterState: "complete",
        accountSnapshotState: "ready",
        snapshotSourceMaterialRef: null,
        retainedMaterialRefs: []
      }
    }));

    const vault = new FakeVault({ vaultId: VAULT_ID, verifier: verifierKey(oldMaterial), writers: [writerKey(oldMaterial)], generation: 4 });
    const prepareBodies: Record<string, unknown>[] = [];
    const stepUpBodies: Record<string, unknown>[] = [];
    const completeBodies: Record<string, unknown>[] = [];
    let currentTarget: AccountActionTarget | null = null;
    let completeAttempts = 0;
    let transactionNumber = 0;
    let transactionId = "";
    let targetGeneration = 5;
    const accountFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
      if (url.pathname === ACCOUNT_API_ROUTES.desktopVaultWriterRotationPrepare) {
        prepareBodies.push(body);
        const writers = body.writers as typeof prepareBodies[number]["writers"];
        const recoveryVerifier = body.recoveryVerifier as Record<string, unknown>;
        const identity = await deviceIdentityFromCustody({ custody, deviceId: entryIdentity.deviceId });
        expect(identity?.publicKey).toBe(entryIdentity.publicKey);
        currentTarget = {
          tenantId: "tenant.writer.1",
          routeId: "route.writer.1",
          deviceId: entryIdentity.deviceId,
          devicePublicKey: entryIdentity.publicKey,
          grantRef: "grant.writer.rotation.1",
          scopes: ["vault:write"],
          vaultWriterRotation: {
            vaultId: VAULT_ID,
            generation: targetGeneration,
            writers: writers as never,
            recoveryVerifier: recoveryVerifier as never
          }
        };
        return Response.json({ operationId: body.operationId, account: ACCOUNT, target: currentTarget, expiresAt: "2099-01-01T00:00:00.000Z" });
      }
      if (url.pathname === ACCOUNT_API_ROUTES.desktopTransaction) {
        transactionId = `txn.writer.stepup.${++transactionNumber}`;
        stepUpBodies.push(body);
        return Response.json({
          transactionId,
          browserUrl: `${ACCOUNT_ORIGIN}/account?transactionId=${transactionId}`
        });
      }
      if (url.pathname === ACCOUNT_API_ROUTES.desktopTransactionPoll.replace("{transactionId}", encodeURIComponent(transactionId))) {
        return Response.json({
          state: "complete",
          purpose: "step_up",
          actionPurpose: "grant_access",
          account: ACCOUNT,
          deviceSessionCredential: null,
          permitId: "-" + "D".repeat(41) + "A",
          target: currentTarget
        });
      }
      if (url.pathname === ACCOUNT_API_ROUTES.desktopTransactionAcknowledge.replace("{transactionId}", encodeURIComponent(transactionId))) {
        return Response.json({ acknowledged: true });
      }
      if (url.pathname === ACCOUNT_API_ROUTES.desktopVaultWriterRotationComplete) {
        completeBodies.push(body);
        completeAttempts += 1;
        if (completeAttempts === 1) {
          return Response.json({ state: "pending", account: ACCOUNT, operationId: body.operationId, vaultId: VAULT_ID, generation: targetGeneration });
        }
        const rotation = currentTarget?.vaultWriterRotation;
        if (!rotation) throw new Error("Missing server target for writer completion");
        vault.recoveryVerifier = rotation.recoveryVerifier;
        vault.writers = [...rotation.writers];
        vault.generation = rotation.generation;
        return Response.json({ state: "complete", account: ACCOUNT, operationId: body.operationId, vaultId: VAULT_ID, generation: rotation.generation });
      }
      throw new Error(`Unexpected account route ${url.pathname}`);
    };

    const service = new EntryProductService({
      dataDir: dir,
      custody,
      serviceConfig: serviceConfigFixture(ACCOUNT_ORIGIN),
      accountFetch,
      vaultTransportFactory: () => vault
    });
    services.push(service);
    await service.start();

    const firstBackup = await service.publishSnapshot();
    expect(firstBackup.recovery.backup.lastCommittedRevision).toBe(1);
    const priorSnapshot = structuredClone(vault.current);
    expect(priorSnapshot?.publicVerifier.keyId).toBe(oldMaterial.signing.keyId);

    await service.beginRecoveryRotation();
    const recoveryKey = service.revealRecoveryKey();
    const candidate = deriveRecoveryMaterial(parseRecoveryText(recoveryKey.recoveryText).secret);
    const waiting = await service.confirmRecoverySaved();
    expect(waiting.recovery.writerRegistration.state).toBe("authorization_required");
    expect(prepareBodies).toHaveLength(1);
    expect((prepareBodies[0]?.desktopProof as Record<string, unknown>).credential).toBeTruthy();
    expect((prepareBodies[0]?.deviceProof as Record<string, unknown>).purpose).toBe("prepare_vault_writer_rotation");
    expect(stepUpBodies).toHaveLength(1);
    expect(stepUpBodies[0]?.actionPurpose).toBe("grant_access");
    expect(stepUpBodies[0]?.target).toEqual(currentTarget);
    expect((stepUpBodies[0]?.desktopProof as Record<string, unknown>).credential).toBeTruthy();

    const pending = await service.checkAccountTransaction();
    expect(pending.recovery.writerRegistration.state).toBe("service_pending");
    expect(completeBodies).toHaveLength(1);
    expect((completeBodies[0]?.deviceProof as Record<string, unknown>).purpose).toBe("complete_vault_writer_rotation");
    const committedBeforeRetry = vault.current;
    const writesBeforeRetry = vault.writeCount;
    await service.publishSnapshot();
    expect(vault.writeCount).toBe(writesBeforeRetry);
    expect(vault.current).toEqual(committedBeforeRetry);

    const complete = await service.retryVaultWriterRegistration();
    expect(complete.recovery.writerRegistration.state).toBe("complete");
    expect(completeBodies).toHaveLength(2);
    expect(completeBodies[1]).toEqual(completeBodies[0]);
    expect(vault.current).not.toEqual(priorSnapshot);
    expect(vault.current?.revision).toBe(2);
    expect(vault.current?.generation).toBe(5);
    expect(vault.current?.publicVerifier.keyId).toBe(candidate.signing.keyId);
    expect(vault.recoveryVerifier.keyId).toBe(candidate.signing.keyId);
    expect(vault.writers.map((writer) => writer.keyId)).toEqual([candidate.writer.keyId]);
    expect(service.snapshot().recovery.backup.lastCommittedRevision).toBe(2);

    const writesAfterReconcile = vault.writeCount;
    const routine = await service.publishSnapshot();
    expect(routine.recovery.backup.lastCommittedRevision).toBe(3);
    expect(vault.writeCount).toBe(writesAfterReconcile + 1);
    expect(vault.current?.revision).toBe(3);

    const config = JSON.parse(await readFile(store.filePath, "utf8")) as {
      recovery: { generation: number; materialRef: string; retainedMaterialRefs: string[]; accountWriterState: string; accountSnapshotState: string; snapshotSourceMaterialRef: string | null };
      accountVaultWriterOperation: unknown;
    };
    expect(config.recovery.accountWriterState).toBe("complete");
    expect(config.recovery.accountSnapshotState).toBe("ready");
    expect(config.recovery.snapshotSourceMaterialRef).toBeNull();
    expect(config.recovery.generation).toBe(5);
    expect(config.recovery.materialRef).not.toBe(oldMaterialRef);
    expect(config.recovery.retainedMaterialRefs).toContain(oldMaterialRef);
    expect(await custody.loadSecret({ ref: oldMaterialRef })).not.toBeNull();
    expect(config.accountVaultWriterOperation).toBeNull();
    expect(service.snapshot().recovery.backup.lastCommittedRevision).toBe(3);

    const nextMaterialRef = custodyRecoveryRef(VAULT_ID, candidate.signing.keyId);
    const preservedRevision = vault.current?.revision;
    const writesBeforeUnverifiableSnapshot = vault.writeCount;
    targetGeneration = 6;
    await service.beginRecoveryRotation();
    const nextRecoveryKey = service.revealRecoveryKey();
    const nextCandidate = deriveRecoveryMaterial(parseRecoveryText(nextRecoveryKey.recoveryText).secret);
    const nextWaiting = await service.confirmRecoverySaved();
    expect(nextWaiting.recovery.writerRegistration.state).toBe("authorization_required");
    await custody.deleteSecret({ ref: oldMaterialRef });
    await custody.deleteSecret({ ref: nextMaterialRef });
    const fenced = await service.checkAccountTransaction();
    expect(fenced.recovery.writerRegistration.state).toBe("older_snapshot_preserved");
    expect(completeAttempts).toBe(3);
    expect(vault.current?.revision).toBe(preservedRevision);
    expect(vault.current?.publicVerifier.keyId).toBe(candidate.signing.keyId);
    expect(vault.recoveryVerifier.keyId).toBe(nextCandidate.signing.keyId);
    expect(vault.writeCount).toBe(writesBeforeUnverifiableSnapshot);
    const refusedAutomaticPublish = await service.publishSnapshot();
    expect(refusedAutomaticPublish.recovery.writerRegistration.state).toBe("older_snapshot_preserved");
    expect(vault.writeCount).toBe(writesBeforeUnverifiableSnapshot);
    const fencedConfig = JSON.parse(await readFile(store.filePath, "utf8")) as {
      recovery: { accountSnapshotState: string; snapshotSourceMaterialRef: string | null; materialRef: string; retainedMaterialRefs: string[] };
      accountVaultWriterOperation: unknown;
    };
    expect(fencedConfig.recovery.accountSnapshotState).toBe("older_snapshot_preserved");
    expect(fencedConfig.recovery.snapshotSourceMaterialRef).toBe(nextMaterialRef);
    expect(fencedConfig.recovery.materialRef).not.toBe(nextMaterialRef);
    expect(fencedConfig.accountVaultWriterOperation).toBeNull();
  });

  it("rejects a substituted verifier, stale generation, or wrong account before step-up", async () => {
    const cases = [
      {
        name: "substituted verifier",
        target: (body: Record<string, unknown>, devicePublicKey: string) => ({
          operationId: body.operationId,
          account: ACCOUNT,
          expiresAt: "2099-01-01T00:00:00.000Z",
          target: {
            tenantId: "tenant.writer.1",
            routeId: "route.writer.1",
            deviceId: "device.entry.writer.deny",
            devicePublicKey,
            grantRef: "grant.writer.rotation.deny",
            scopes: ["vault:write"],
            vaultWriterRotation: {
              vaultId: VAULT_ID,
              generation: 5,
              writers: body.writers,
              recoveryVerifier: { keyId: "verifier.substituted", algorithm: "Ed25519", publicKey: "c3Vic3RpdHV0ZWQ" }
            }
          }
        })
      },
      {
        name: "stale generation",
        target: (body: Record<string, unknown>, devicePublicKey: string) => ({
          operationId: body.operationId,
          account: ACCOUNT,
          expiresAt: "2099-01-01T00:00:00.000Z",
          target: {
            tenantId: "tenant.writer.1",
            routeId: "route.writer.1",
            deviceId: "device.entry.writer.deny",
            devicePublicKey,
            grantRef: "grant.writer.rotation.deny",
            scopes: ["vault:write"],
            vaultWriterRotation: { vaultId: VAULT_ID, generation: 4, writers: body.writers, recoveryVerifier: body.recoveryVerifier }
          }
        })
      },
      {
        name: "wrong account",
        target: (body: Record<string, unknown>, devicePublicKey: string) => ({
          operationId: body.operationId,
          account: { accountId: "account.other", authEpoch: ACCOUNT.authEpoch },
          expiresAt: "2099-01-01T00:00:00.000Z",
          target: {
            tenantId: "tenant.writer.1",
            routeId: "route.writer.1",
            deviceId: "device.entry.writer.deny",
            devicePublicKey,
            grantRef: "grant.writer.rotation.deny",
            scopes: ["vault:write"],
            vaultWriterRotation: { vaultId: VAULT_ID, generation: 5, writers: body.writers, recoveryVerifier: body.recoveryVerifier }
          }
        })
      }
    ];
    for (const entry of cases) {
      const started = await startManagedWriter(entry.target);
      await expect(started.service.confirmRecoverySaved()).rejects.toMatchObject({ code: "account_vault_rotation_invalid" });
      expect(started.stepUpCount()).toBe(0);
    }
  });
});
