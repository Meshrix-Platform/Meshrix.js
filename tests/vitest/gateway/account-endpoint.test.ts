import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { isAccountStepUpPermitId } from "@meshrix/contracts/account";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { EndpointAccountPairingApplication, accountDeviceAuthorizationMatches, createEndpointIdentityStore, createFileEndpointIdentityDurablePort, createPrivateGatewayEndpoint, type EndpointAccountPairingAuthority, type EndpointIdentityDurablePort, type EndpointDeviceRecord, type EndpointGrantOperationRecord, type EndpointInvitationRecord, type EndpointPairingOperationRecord, type EndpointPairingProofPort, type RecoveryAuthorityRecord } from "@meshrix/gateway/private-endpoint";

function accountDeviceKey(): string {
  return generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
}

const account = Object.freeze({ accountId: "acct.account-endpoint.test", authEpoch: 3 });

function target(overrides: Partial<{
  tenantId: string;
  routeId: string;
  deviceId: string;
  devicePublicKey: string;
  grantRef: string;
  scopes: readonly string[];
}> = {}) {
  return Object.freeze({
    tenantId: "tenant.account-endpoint.test",
    routeId: "route.account-endpoint.test",
    deviceId: "device.account-endpoint.test",
    devicePublicKey: accountDeviceKey(),
    grantRef: "grant.account-endpoint.test",
    scopes: Object.freeze(["svc:tool:read"]),
    ...overrides
  });
}

class SnapshotStore implements EndpointIdentityDurablePort {
  devices: readonly EndpointDeviceRecord[] = [];
  recoveries: readonly RecoveryAuthorityRecord[] = [];
  invitations: readonly EndpointInvitationRecord[] = [];
  operations: readonly EndpointPairingOperationRecord[] = [];
  grantOperations: readonly EndpointGrantOperationRecord[] = [];
  revisions: Readonly<Record<string, number>> = {};

  loadDevices() { return this.devices; }
  loadRecoveryAuthorities() { return this.recoveries; }
  loadInvitations() { return this.invitations; }
  loadPairingOperations() { return this.operations; }
  loadGrantOperations() { return this.grantOperations; }
  loadRevocationRevision(tenantId: string) { return this.revisions[tenantId]; }
  loadRevocationRevisions() { return this.revisions; }
  saveState(state: { devices: readonly EndpointDeviceRecord[]; recoveryAuthorities: readonly RecoveryAuthorityRecord[]; invitations: readonly EndpointInvitationRecord[]; pairingOperations: readonly EndpointPairingOperationRecord[]; grantOperations: readonly EndpointGrantOperationRecord[]; revocationRevisions: Readonly<Record<string, number>> }) {
    this.devices = structuredClone(state.devices);
    this.recoveries = structuredClone(state.recoveryAuthorities);
    this.invitations = structuredClone(state.invitations);
    this.operations = structuredClone(state.pairingOperations);
    this.grantOperations = structuredClone(state.grantOperations);
    this.revisions = structuredClone(state.revocationRevisions);
  }
}

describe("account-managed endpoint authority", () => {
  it("persists exact account grants and refuses route or scope substitution", () => {
    const durable = new SnapshotStore();
    const identity = createEndpointIdentityStore(durable);
    const action = target();
    const entry = identity.enrollAccountDevice({ account, target: action, mode: "personal" });

    expect(entry.accountBinding).toEqual(account);
    expect(identity.accountGrantAllows({
      deviceId: action.deviceId,
      account,
      tenantId: action.tenantId,
      routeId: action.routeId,
      scope: "svc:tool:read"
    })).toBe(true);
    expect(identity.accountGrantAllows({
      deviceId: action.deviceId,
      account,
      tenantId: action.tenantId,
      routeId: "route.other",
      scope: "svc:tool:read"
    })).toBe(false);
    expect(identity.accountGrantAllows({
      deviceId: action.deviceId,
      account,
      tenantId: action.tenantId,
      routeId: action.routeId,
      scope: "svc:admin:write"
    })).toBe(false);

    expect(() => identity.enrollAccountDevice({ account, target: { ...action, devicePublicKey: accountDeviceKey() }, mode: "personal" }))
      .toThrow(/already bound/);
    expect(() => identity.enrollAccountDevice({ account, target: { ...action, routeId: "route.substituted" }, mode: "personal" }))
      .toThrow(/already bound/);

    const restored = createEndpointIdentityStore(durable);
    expect(restored.accountGrantAllows({
      deviceId: action.deviceId,
      account,
      tenantId: action.tenantId,
      routeId: action.routeId,
      scope: "svc:tool:read"
    })).toBe(true);
  });

  it("checks current device authorization against the exact active grant and additive scope set", () => {
    const identity = createEndpointIdentityStore(new SnapshotStore());
    const first = target();
    const entry = identity.enrollAccountDevice({ account, target: first, mode: "personal" });
    const second = target({
      deviceId: first.deviceId,
      devicePublicKey: first.devicePublicKey,
      grantRef: "grant.account-endpoint.second",
      scopes: ["svc:tool:write"]
    });
    const updated = identity.enrollAccountDevice({ account, target: second, mode: "personal" });
    const current = {
      account,
      target: second,
      authorizedScopes: ["svc:tool:read", "svc:tool:write"]
    };

    expect(accountDeviceAuthorizationMatches({ response: current, binding: account, device: updated, scope: "svc:tool:read" })).toBe(true);
    expect(accountDeviceAuthorizationMatches({ response: current, binding: account, device: updated, scope: "svc:admin:write" })).toBe(false);
    expect(accountDeviceAuthorizationMatches({
      response: { ...current, target: { ...second, grantRef: "grant.unknown" } }, binding: account, device: updated
    })).toBe(false);
    expect(accountDeviceAuthorizationMatches({
      response: { ...current, authorizedScopes: [...current.authorizedScopes, "svc:admin:write"] }, binding: account, device: updated
    })).toBe(false);
    expect(accountDeviceAuthorizationMatches({
      response: { ...current, account: { ...account, authEpoch: account.authEpoch + 1 } }, binding: account, device: updated
    })).toBe(false);
    expect(entry.deviceId).toBe(updated.deviceId);
  });

  it("fences earlier device grants and recovery authorities at a higher account epoch", () => {
    const durable = new SnapshotStore();
    const identity = createEndpointIdentityStore(durable);
    const action = target();
    identity.enrollAccountDevice({ account, target: action, mode: "personal" });
    identity.enrollRecoveryAuthority({
      recoveryKeyId: "recovery.account-endpoint.test",
      principalRef: "principal.account-endpoint.test",
      publicKey: "recovery-public-key",
      generation: 1,
      accountBinding: account
    });
    identity.revoke(action.deviceId);
    expect(identity.device(action.deviceId)?.accountGrants).toHaveLength(1);

    const revoked = identity.revokeAccountEpoch(account.accountId, account.authEpoch + 1);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.revoked).toBe(true);
    expect(revoked[0]?.accountScopes).toEqual([]);
    expect(revoked[0]?.accountGrants).toEqual([]);
    expect(identity.accountGrantAllows({
      deviceId: action.deviceId,
      account,
      tenantId: action.tenantId,
      routeId: action.routeId,
      scope: "svc:tool:read"
    })).toBe(false);
    expect(identity.recoveryAuthority("recovery.account-endpoint.test")?.state).toBe("revoked");

    const restored = createEndpointIdentityStore(durable);
    expect(restored.admit({
      tenantId: action.tenantId,
      routeId: action.routeId,
      deviceId: action.deviceId,
      role: "entry",
      mode: "personal",
      admissionGeneration: revoked[0]!.admissionGeneration,
      revocationRevision: restored.revocationRevision(action.tenantId)
    }).admitted).toBe(false);
    expect(restored.recoveryAuthority("recovery.account-endpoint.test")?.state).toBe("revoked");
  });

  it("does not let an older epoch revocation invalidate a newer account binding", () => {
    const identity = createEndpointIdentityStore();
    const action = target();
    identity.enrollAccountDevice({ account: { ...account, authEpoch: 5 }, target: action, mode: "personal" });

    expect(identity.revokeAccountEpoch(account.accountId, 4)).toEqual([]);
    expect(identity.accountGrantAllows({
      deviceId: action.deviceId,
      account: { ...account, authEpoch: 5 },
      tenantId: action.tenantId,
      routeId: action.routeId,
      scope: "svc:tool:read"
    })).toBe(true);
  });

  it("reactivates only the endpoint after a fresh account claim and keeps prior Entry grants revoked", () => {
    const durable = new SnapshotStore();
    const identity = createEndpointIdentityStore(durable);
    const endpointPublicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    identity.enroll({
      deviceId: "endpoint.account-endpoint.test",
      tenantId: "tenant.account-endpoint.test",
      routeId: "route.account-endpoint.test",
      trustBinding: {
        schemaVersion: "v0.0.1:private-relay:recovery-1",
        kind: "endpoint-trust-binding",
        pairedIdentityKey: endpointPublicKey,
        pairedIdentityFingerprint: "fingerprint.account-endpoint.test",
        mode: "personal",
        role: "endpoint",
        trustGeneration: 1,
        endpointPrincipalRef: "principal.account-endpoint.test",
        capabilityGrantRef: "grant.endpoint.account-endpoint.test",
        boundRecoveryKeyId: null
      }
    });
    identity.bindAccountEndpoint({ deviceId: "endpoint.account-endpoint.test", account });
    const entryTarget = target({ deviceId: "entry.account-endpoint.test" });
    identity.enrollAccountDevice({ account, target: entryTarget, mode: "personal" });

    const endpoint = identity.activateAccountEndpointClaim({
      deviceId: "endpoint.account-endpoint.test",
      account: { ...account, authEpoch: account.authEpoch + 1 },
      admissionGeneration: 2,
      revocationRevision: 4
    });
    expect(endpoint.revoked).toBe(false);
    expect(endpoint.accountBinding?.authEpoch).toBe(account.authEpoch + 1);
    expect(endpoint.accountGrants).toEqual([]);
    expect(identity.device(entryTarget.deviceId)?.revoked).toBe(true);
    expect(identity.accountGrantAllows({
      deviceId: entryTarget.deviceId,
      account: { ...account, authEpoch: account.authEpoch + 1 },
      tenantId: entryTarget.tenantId,
      routeId: entryTarget.routeId,
      scope: "svc:tool:read"
    })).toBe(false);
    expect(identity.revocationRevision(endpoint.tenantId)).toBe(4);
  });

  it.each(["_" + "B".repeat(41) + "A", "-" + "B".repeat(41) + "A"])("pairs only the inspected Entry key with canonical permit %s", async (permitId) => {
    expect(isAccountStepUpPermitId(permitId)).toBe(true);
    const directory = await mkdtemp(join(tmpdir(), "meshrix-account-pairing-permit-"));
    try {
    const durable = createFileEndpointIdentityDurablePort(join(directory, "identity.json"));
    const identity = createEndpointIdentityStore(durable);
    const entryKeys = generateKeyPairSync("ed25519");
    const entryPublicKey = entryKeys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
    const pending = {
      bootstrapId: "bootstrap.account-endpoint.test",
      account,
      tenantId: "tenant.account-endpoint.test",
      routeId: "route.account-endpoint.test",
      entryDeviceId: "device.account-endpoint.test",
      entryDevicePublicKey: entryPublicKey,
      endpointDeviceId: "endpoint.account-endpoint.test",
      endpointPinRef: "endpoint-pin.account-endpoint.test",
      target: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
    let publishedTarget: ReturnType<typeof target> | undefined;
    const consumed = new Set<string>();
    let relayCompletionCount = 0;
    const authority: EndpointAccountPairingAuthority = {
      async currentBinding(accountId) { return accountId === account.accountId ? account : null; },
      async inspectPendingPairing() { return pending; },
      async publishPairingTarget(input) {
        publishedTarget = input.target as ReturnType<typeof target>;
        return { ...pending, target: input.target };
      },
      async inspectStepUpPermit(input) {
        return input.purpose === "pair_device" && input.bootstrapId === pending.bootstrapId
          && input.target.devicePublicKey === entryPublicKey
          ? { valid: true, permit: { permitId: input.permitId, account, purpose: input.purpose, target: input.target, bootstrapId: input.bootstrapId ?? null, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } }
          : { valid: false, reason: "target_mismatch" };
      },
      async consumeStepUpPermit(input) {
        const key = `${input.permitId}:${input.operationId}`;
        consumed.add(key);
        return { consumed: true, replayed: consumed.has(key) };
      },
      async completePairing() { relayCompletionCount += 1; return { completed: true, relayAdmissionActive: true }; }
    };
    const proof: EndpointPairingProofPort = {
      async inspect() { return pending; },
      async publishTarget(input) { return authority.publishPairingTarget({ bootstrapId: pending.bootstrapId, target: input.target }); },
      inspectPermit: (input) => authority.inspectStepUpPermit(input),
      consumePermit: (input) => authority.consumeStepUpPermit(input),
      complete: (input) => authority.completePairing({ account: input.account, bootstrapId: input.bootstrapId, operationId: input.operationId, target: input.target })
    };
    const app = new EndpointAccountPairingApplication({
      identity,
      authority,
      proof,
      invite: {
        tenantId: pending.tenantId,
        routeId: pending.routeId,
        endpointDeviceId: pending.endpointDeviceId,
        endpointPinRef: pending.endpointPinRef,
        endpointSpkiPin: "endpoint-spki.account-endpoint.test",
        endpointPrincipalRef: "principal.endpoint.account-endpoint.test",
        relayService: "wss://relay.example.test",
        vaultId: "vault.account-endpoint.test",
        mode: "personal",
        recoveryAuthority: null
      },
      availableScopes: ["route.account-endpoint.test:tools/read"],
      tokenFactory: () => "A".repeat(43),
      idFactory: (prefix) => `${prefix}.stable`
    });

    const issued = await app.issueInvite();
    await expect(app.issueInvite({ vaultId: "vault.pre-account.test" })).rejects.toMatchObject({ code: "pairing_vault_mismatch" });
    expect(identity.invitation(String(issued.invite.inviteId))?.tokenDigest).not.toContain(issued.pairingToken);
    expect(await app.inspectBootstrap({ bootstrapId: pending.bootstrapId, entrySessionId: "entry.session.account-endpoint" })).toMatchObject({
      entryDeviceId: pending.entryDeviceId,
      peerSpki: expect.any(String)
    });
    const challenge = await app.beginPairing({
      bootstrapId: pending.bootstrapId,
      entrySessionId: "entry.session.account-endpoint",
      inviteId: String(issued.invite.inviteId),
      pairingToken: issued.pairingToken,
      deviceId: pending.entryDeviceId,
      devicePublicKey: entryPublicKey
    });
    expect(challenge.outcome).toBe("challenge");
    if (challenge.outcome !== "challenge") return;
    expect(publishedTarget).toEqual(challenge.target);
    const signature = cryptoSign(null, Buffer.from(canonicalJson({
      challengeId: challenge.challengeId,
      inviteId: issued.invite.inviteId,
      endpointRouteId: pending.routeId,
      deviceId: pending.entryDeviceId,
      devicePublicKey: entryPublicKey,
      entryPeerIdentity: null,
      purpose: "pair_device"
    })), entryKeys.privateKey).toString("base64url");
    const completed = await app.completePairing({
      bootstrapId: pending.bootstrapId,
      entrySessionId: "entry.session.account-endpoint",
      inviteId: String(issued.invite.inviteId),
      pairingToken: issued.pairingToken,
      challengeId: challenge.challengeId,
      deviceId: pending.entryDeviceId,
      devicePublicKey: entryPublicKey,
      entryPeerIdentity: null,
      signature,
      account,
      permitId,
      purpose: "pair_device",
      target: challenge.target,
      operationId: "operation.account-endpoint.test"
    });
    expect(completed).toEqual({
      outcome: "enrolled",
      capabilityGrantRef: challenge.target.grantRef,
      admissionGeneration: 1,
      revocationRevision: 0,
      endpointPeerIdentity: null
    });
    expect(identity.device(pending.entryDeviceId)?.accountBinding).toEqual(account);
    expect(identity.accountGrantAllows({
      deviceId: pending.entryDeviceId,
      account,
      tenantId: pending.tenantId,
      routeId: pending.routeId,
      scope: "route.account-endpoint.test:tools/read"
    })).toBe(true);
    const replayed = await app.completePairing({
      bootstrapId: pending.bootstrapId,
      entrySessionId: "entry.session.account-endpoint",
      inviteId: String(issued.invite.inviteId),
      pairingToken: issued.pairingToken,
      challengeId: challenge.challengeId,
      deviceId: pending.entryDeviceId,
      devicePublicKey: entryPublicKey,
      entryPeerIdentity: null,
      signature,
      account,
      permitId,
      purpose: "pair_device",
      target: challenge.target,
      operationId: "operation.account-endpoint.test"
    });
    expect(replayed).toEqual(completed);
    const restoredIdentity = createEndpointIdentityStore(createFileEndpointIdentityDurablePort(join(directory, "identity.json")));
    expect(restoredIdentity.pairingOperation(pending.bootstrapId)).toMatchObject({ permitId, state: "enrolled" });

    const createEndpoint = (endpointIdentity = identity) => createPrivateGatewayEndpoint({
      gateway: { invoke: async () => ({ kind: "complete", value: null }) } as never,
      authority: { contextFor: () => null },
      recoverySigner: { sign: () => "signature", verify: () => true },
      transport: { send() {}, close() {} },
      admission: {
        tenantId: pending.tenantId,
        routeId: pending.routeId,
        deviceId: pending.endpointDeviceId,
        role: "endpoint",
        mode: "personal",
        admissionGeneration: 1,
        revocationRevision: 0
      },
      identity: endpointIdentity,
      innerTls: { key: Buffer.from("unused-test-key"), cert: Buffer.from("unused-test-cert") },
      accountPairing: app
    });
    const forwardEndpoint = createEndpoint();
    const authenticatedEntry = identity.device(pending.entryDeviceId)!;
    const completeParams = {
      bootstrapId: pending.bootstrapId,
      inviteId: issued.invite.inviteId,
      pairingToken: issued.pairingToken,
      challengeId: challenge.challengeId,
      deviceId: pending.entryDeviceId,
      devicePublicKey: entryPublicKey,
      signature,
      account,
      permitId,
      purpose: "pair_device",
      target: challenge.target,
      operationId: "operation.account-endpoint.test"
    };
    const forwardRequest = (params: Record<string, unknown>) => forwardEndpoint.dispatchAccountMessage({
      peerSessionId: "entry.forward.account-endpoint.test",
      pairingOnly: false,
      device: authenticatedEntry,
      message: { jsonrpc: "2.0", id: "pairing-replay", method: "meshrix/pairing/complete", params }
    });

    expect(await forwardRequest(completeParams)).toEqual(completed);
    expect(relayCompletionCount).toBe(3);
    expect(await forwardRequest({ ...completeParams, operationId: "operation.substituted.test" })).toEqual({
      outcome: "refused", refusal: "pairing_operation_not_replayable"
    });
    expect(await forwardRequest({ ...completeParams, target: { ...challenge.target, grantRef: "grant.substituted.test" } })).toEqual({
      outcome: "refused", refusal: "pairing_operation_not_replayable"
    });
    expect(await forwardEndpoint.dispatchAccountMessage({
      peerSessionId: "entry.session.account-endpoint",
      pairingOnly: false,
      device: authenticatedEntry,
      message: { method: "meshrix/pairing/complete", params: completeParams }
    })).toEqual({ outcome: "refused", refusal: "pairing_operation_not_replayable" });
    expect(await forwardEndpoint.dispatchAccountMessage({
      peerSessionId: "entry.forward.account-endpoint.test",
      pairingOnly: false,
      device: authenticatedEntry,
      message: { method: "meshrix/pairing/begin", params: completeParams }
    })).toEqual({ outcome: "refused", refusal: "pairing_method_refused" });

    const pendingIdentity = createEndpointIdentityStore();
    pendingIdentity.enrollAccountDevice({ account, target: challenge.target, mode: "personal" });
    pendingIdentity.savePairingOperation({
      bootstrapId: "bootstrap.pending.account-endpoint.test",
      entrySessionId: "entry.pair.account-endpoint.test",
      inviteId: "invite.pending.account-endpoint.test",
      challengeId: "challenge.pending.account-endpoint.test",
      nonce: "nonce.pending.account-endpoint.test",
      account,
      target: challenge.target,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: "challenged"
    });
    const pendingEndpoint = createEndpoint(pendingIdentity);
    const pendingEntry = pendingIdentity.device(pending.entryDeviceId)!;
    expect(await pendingEndpoint.dispatchAccountMessage({
      peerSessionId: "entry.forward.account-endpoint.test",
      pairingOnly: false,
      device: pendingEntry,
      message: {
        method: "meshrix/pairing/complete",
        params: { ...completeParams, bootstrapId: "bootstrap.pending.account-endpoint.test", inviteId: "invite.pending.account-endpoint.test", challengeId: "challenge.pending.account-endpoint.test" }
      }
    })).toEqual({ outcome: "refused", refusal: "pairing_operation_not_replayable" });
    expect(relayCompletionCount).toBe(3);

    identity.revoke(pending.entryDeviceId);
    expect(await forwardRequest(completeParams)).toEqual({
      outcome: "refused", refusal: "pairing_operation_not_replayable"
    });
    expect(relayCompletionCount).toBe(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses altered grant scopes and a missing Entry key signature", async () => {
    const identity = createEndpointIdentityStore();
    const keys = generateKeyPairSync("ed25519");
    const raw = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
    const action = target({ devicePublicKey: raw });
    const device = identity.enrollAccountDevice({ account, target: action, mode: "personal" });
    let consumes = 0;
    const authority: EndpointAccountPairingAuthority = {
      async currentBinding() { return account; },
      async inspectPendingPairing() { return null; },
      async publishPairingTarget() { return null; },
      async inspectStepUpPermit(input) { return { valid: true, permit: { permitId: input.permitId, account, purpose: input.purpose, target: input.target, bootstrapId: null, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } }; },
      async consumeStepUpPermit() { consumes += 1; return { consumed: true }; },
      async completePairing() { return { completed: false, relayAdmissionActive: false }; }
    };
    const proof: EndpointPairingProofPort = {
      async inspect() { return null; }, async publishTarget() { return null; },
      inspectPermit: (input) => authority.inspectStepUpPermit(input),
      consumePermit: (input) => authority.consumeStepUpPermit(input),
      complete: (input) => authority.completePairing({ account: input.account, bootstrapId: input.bootstrapId, operationId: input.operationId, target: input.target })
    };
    const app = new EndpointAccountPairingApplication({
      identity, authority, proof,
      invite: { tenantId: action.tenantId, routeId: action.routeId, endpointDeviceId: "endpoint.test", endpointPinRef: "pin.test", endpointSpkiPin: "pin.test", endpointPrincipalRef: "principal.test", relayService: "wss://relay.example.test", vaultId: "vault.test", mode: "personal", recoveryAuthority: null },
      availableScopes: ["svc:tool:read"]
    });
    const request = {
      device,
      account,
      operationId: "operation.test",
      permitId: "_" + "C".repeat(41) + "A",
      purpose: "grant_access" as const,
      target: action,
      signature: "not-a-valid-signature"
    };
    expect(await app.grantAccess(request)).toMatchObject({ outcome: "refused" });
    expect(consumes).toBe(0);
    expect(await app.grantAccess({ ...request, target: { ...action, scopes: ["svc:admin:write"] } })).toMatchObject({ outcome: "refused" });
    expect(await app.grantAccess({
      ...request,
      target: {
        ...action,
        vaultWriterRotation: {
          vaultId: "vault.substituted",
          generation: 2,
          writers: [{ keyId: "writer.substituted", algorithm: "Ed25519", publicKey: "substituted-writer" }],
          recoveryVerifier: { keyId: "verifier.substituted", algorithm: "Ed25519", publicKey: "substituted-verifier" }
        }
      }
    })).toMatchObject({ outcome: "refused", refusal: "grant_target_mismatch" });
    expect(consumes).toBe(0);
  });

  it("replays a consumed exact-target grant operation after local state was not saved", async () => {
    const identity = createEndpointIdentityStore();
    const keys = generateKeyPairSync("ed25519");
    const raw = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
    const initial = target({ devicePublicKey: raw, scopes: ["svc:tool:read"] });
    const device = identity.enrollAccountDevice({ account, target: initial, mode: "personal" });
    let consumes = 0;
    let inspects = 0;
    let liveEpoch = account.authEpoch;
    const authority: EndpointAccountPairingAuthority = {
      async currentBinding() { return { ...account, authEpoch: liveEpoch }; },
      async inspectPendingPairing() { return null; },
      async publishPairingTarget() { return null; },
      async inspectStepUpPermit() { inspects += 1; return { valid: false, reason: "permit_consumed" }; },
      async consumeStepUpPermit(input) {
        consumes += 1;
        expect(input.operationId).toBe("grant.op.stable");
        return { consumed: true, replayed: true };
      },
      async completePairing() { return { completed: false, relayAdmissionActive: false }; }
    };
    const proof: EndpointPairingProofPort = {
      async inspect() { return null; }, async publishTarget() { return null; },
      inspectPermit: (input) => authority.inspectStepUpPermit(input),
      consumePermit: (input) => authority.consumeStepUpPermit(input),
      complete: (input) => authority.completePairing({ account: input.account, bootstrapId: input.bootstrapId, operationId: input.operationId, target: input.target })
    };
    const app = new EndpointAccountPairingApplication({
      identity, authority, proof,
      invite: { tenantId: initial.tenantId, routeId: initial.routeId, endpointDeviceId: "endpoint.test", endpointPinRef: "pin.test", endpointSpkiPin: "pin.test", endpointPrincipalRef: "principal.test", relayService: "wss://relay.example.test", vaultId: "vault.test", mode: "personal", recoveryAuthority: null },
      availableScopes: ["svc:tool:read", "svc:tool:write"],
      idFactory: () => "grant.op.stable"
    });
    const requested = await app.grantTarget({ device, scopes: ["svc:tool:write"] });
    expect(requested.outcome).toBe("grant_target");
    if (requested.outcome !== "grant_target") return;
    const signature = cryptoSign(null, Buffer.from(canonicalJson({
      account,
      operationId: requested.operationId,
      purpose: "grant_access",
      target: requested.target
    })), keys.privateKey).toString("base64url");
    const request = {
      device, account, operationId: requested.operationId, permitId: "-" + "D".repeat(41) + "A",
      purpose: "grant_access" as const, target: requested.target, signature
    };

    // This models the server having consumed the permit before a process
    // crash prevented the local durable operation-state write.
    expect(await app.grantAccess(request)).toEqual({
      outcome: "granted",
      capabilityGrantRef: requested.target.grantRef,
      authorizedScopes: ["svc:tool:read", "svc:tool:write"]
    });
    expect(await app.grantAccess(request)).toEqual({
      outcome: "granted",
      capabilityGrantRef: requested.target.grantRef,
      authorizedScopes: ["svc:tool:read", "svc:tool:write"]
    });
    expect(consumes).toBe(2);
    expect(inspects).toBe(0);
    liveEpoch = account.authEpoch + 1;
    expect(await app.grantAccess(request)).toMatchObject({ outcome: "refused", refusal: "account_stale" });
    expect(consumes).toBe(2);
  });

  it("denies a protected effect when the account epoch or grant is stale", async () => {
    const identity = createEndpointIdentityStore();
    const action = target();
    const device = identity.enrollAccountDevice({ account, target: action, mode: "personal" });
    let live = account;
    let authorityReads = 0;
    const authority: EndpointAccountPairingAuthority = {
      async currentBinding() { return live; },
      async inspectPendingPairing() { return null; },
      async publishPairingTarget() { return null; },
      async inspectStepUpPermit() { return { valid: false, reason: "permit_missing" }; },
      async consumeStepUpPermit() { return { consumed: false }; },
      async completePairing() { return { completed: false, relayAdmissionActive: false }; },
      async currentDeviceAuthorization() {
        authorityReads += 1;
        return {
          account: live,
          target: live.authEpoch === account.authEpoch ? action : null,
          authorizedScopes: live.authEpoch === account.authEpoch ? action.scopes : []
        };
      }
    };
    const proof: EndpointPairingProofPort = {
      async inspect() { return null; }, async publishTarget() { return null; },
      inspectPermit: (input) => authority.inspectStepUpPermit(input),
      consumePermit: (input) => authority.consumeStepUpPermit(input),
      complete: (input) => authority.completePairing({ account: input.account, bootstrapId: input.bootstrapId, operationId: input.operationId, target: input.target })
    };
    const app = new EndpointAccountPairingApplication({
      identity, authority, proof,
      invite: { tenantId: action.tenantId, routeId: action.routeId, endpointDeviceId: "endpoint.test", endpointPinRef: "pin.test", endpointSpkiPin: "pin.test", endpointPrincipalRef: "principal.test", relayService: "wss://relay.example.test", vaultId: "vault.test", mode: "personal", recoveryAuthority: null },
      availableScopes: action.scopes
    });
    let invocations = 0;
    const endpoint = createPrivateGatewayEndpoint({
      gateway: { invoke: async () => { invocations += 1; return { kind: "complete", value: { ok: true } }; } } as never,
      authority: { contextFor: () => null },
      recoverySigner: { sign: () => "signature", verify: () => true },
      transport: { send() {}, close() {} },
      admission: { tenantId: action.tenantId, routeId: action.routeId, deviceId: "endpoint.test", role: "endpoint", mode: "personal", admissionGeneration: 1, revocationRevision: 0 },
      identity,
      innerTls: { key: Buffer.from("unused-test-key"), cert: Buffer.from("unused-test-cert") },
      accountPairing: app
    });
    const context = Object.freeze({
      tenant: action.tenantId,
      principal: device.principalRef,
      authGeneration: "1",
      grant: Object.freeze({ revision: "1", routes: action.scopes }),
      metadata: Object.freeze({ accountId: account.accountId, authEpoch: account.authEpoch, deviceId: device.deviceId })
    });
    const message = { jsonrpc: "2.0", id: "effect.1", method: "tools/call", params: { name: "svc/tool", arguments: {} } };
    expect(await endpoint.dispatchInnerMessage(context, message)).toMatchObject({ kind: "complete" });
    expect(invocations).toBe(1);
    expect(authorityReads).toBe(1);

    live = { ...account, authEpoch: account.authEpoch + 1 };
    expect(await endpoint.dispatchInnerMessage(context, message)).toMatchObject({
      kind: "failure", code: "account_stale", effectOutcome: "not_started"
    });
    expect(invocations).toBe(1);

    live = account;
    identity.revokeAccountEpoch(account.accountId, account.authEpoch + 1);
    expect(await endpoint.dispatchInnerMessage(context, message)).toMatchObject({
      kind: "failure", code: "account_stale", effectOutcome: "not_started"
    });
    expect(invocations).toBe(1);
  });
});
