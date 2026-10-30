import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { parseEndpointTrustBinding } from "@meshrix/contracts/private-relay";

import {
  FileCustodyAdapter,
  PairingSession,
  entryError,
  encodePairingInvite,
  inviteToTrustBinding,
  pairingProofTranscript,
  parsePairingInvite,
  parsePairingInviteText,
  verifyEd25519,
  type PairingEndpointPort,
  type PairingInvite,
  type PairingPeerIdentity,
  enrollDeviceIdentity
} from "@meshrix/entry";
const canned1 = "spki.test.pin";
const canned2 = "rckey.test.1";
const canned3 = "pt.one-time.token";
const canned4 = "pn.test.1";
const canned5 = "";
const canned6 = "pt.wrong";
const canned7 = "k";
const canned8 = "fp.test";




let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function custody(): Promise<FileCustodyAdapter> {
  dir = await mkdtemp(path.join(tmpdir(), "entry-pairing-"));
  return new FileCustodyAdapter({ dataDir: dir, wrapSecret: randomBytes(32) });
}

function inviteFixture(overrides: Partial<PairingInvite> = {}): PairingInvite {
  const invite = {
    schemaVersion: "v0.0.1:entry:pairing-invite-2",
    kind: "entry-pairing-invite",
    inviteId: "inv.test.1",
    endpointRouteId: "route.pr.1",
    tenantId: "tenant.pr.1",
    mode: "personal",
    endpointDeviceId: "dev.endpoint.1",
    endpointPrincipalRef: "prin.pr.1",
    endpointSpkiPin: canned1,
    endpointPinRef: canned1,
    relayService: "https://relay.example.invalid",
    vaultId: "vault.pr.1",
    recoveryAuthority: { keyId: canned2, generation: 3 },
    issuedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2027-01-01T00:00:00Z",
    pairingToken: canned3,
    ...overrides
  };
  const parsed = parsePairingInvite(invite);
  if (!parsed) throw new Error("fixture does not satisfy the invite schema");
  return parsed;
}

/** Endpoint double: issues a challenge for a known pairing token. */
function fakeEndpoint(options: {
  acceptToken?: string;
  refuse?: string;
  failBegin?: "unreachable";
  failComplete?: "unreachable";
  grantRef?: string;
  endpointPeerIdentity?: PairingPeerIdentity | null;
} = {}): PairingEndpointPort & { seenSignature?: string; seenChallenge?: string } {
  const state: { seenSignature?: string; seenChallenge?: string } = {};
  const cannedFallback = "pt.one-time.token";
  const token = options.acceptToken ?? cannedFallback;
  return Object.assign(state, {
    async beginPairing(input) {
      if (options.failBegin === "unreachable") {
        throw entryError("endpoint_unreachable", "offline");
      }
      if (options.refuse || input.invite.pairingToken !== token) {
        return { outcome: "refused", refusal: options.refuse ?? "invite_token_invalid" };
      }
      state.seenChallenge = `pch.${input.deviceId}`;
      return {
        outcome: "challenge",
        challengeId: state.seenChallenge,
        nonce: canned4,
        expiresAt: "2099-01-01T00:00:00Z",
        account: { accountId: "acct.test.1", authEpoch: 1 },
        target: {
          tenantId: input.invite.tenantId,
          routeId: input.invite.endpointRouteId,
          deviceId: input.deviceId,
          devicePublicKey: input.devicePublicKey,
          grantRef: options.grantRef ?? "grant.staged.1",
          scopes: ["mcp.invoke"]
        }
      };
    },
    async completePairing(input) {
      if (options.failComplete === "unreachable") {
        throw entryError("endpoint_unreachable", "offline mid-proof");
      }
      const transcript = pairingProofTranscript({
        challengeId: input.challengeId,
        inviteId: input.invite.inviteId,
        endpointRouteId: input.invite.endpointRouteId,
        deviceId: input.deviceId,
        devicePublicKey: input.devicePublicKey,
        entryPeerIdentity: input.entryPeerIdentity
      });
      state.seenSignature = input.signature;
      if (!verifyEd25519({ publicKey: input.devicePublicKey, signature: input.signature, transcript })) {
        return { outcome: "refused", refusal: "proof_invalid" };
      }
      if (input.challengeId !== state.seenChallenge) {
        return { outcome: "refused", refusal: "challenge_mismatch" };
      }
      if (input.permitId !== "_" + "A".repeat(42)
        || input.purpose !== "pair_device"
        || input.account.accountId !== "acct.test.1"
        || input.target.deviceId !== input.deviceId) {
        return { outcome: "refused", refusal: "authorization_mismatch" };
      }
      return {
        outcome: "enrolled",
        capabilityGrantRef: input.target.grantRef,
        admissionGeneration: 4,
        revocationRevision: 7,
        endpointPeerIdentity: options.endpointPeerIdentity ?? null
      };
    }
  }) as never;
}

describe("pairing invite payload", () => {
  it("round-trips through the deep-link encoding", () => {
    const invite = inviteFixture();
    const text = encodePairingInvite(invite);
    expect(text.startsWith("meshrix-entry://pair#")).toBe(true);
    const parsed = parsePairingInviteText(text);
    expect(parsed).toEqual(invite);
  });

  it("accepts the raw JSON form", () => {
    const invite = inviteFixture();
    expect(parsePairingInviteText(JSON.stringify(invite))).toEqual(invite);
  });

  it("rejects malformed payloads distinctly", () => {
    expect(() => parsePairingInviteText("meshrix-entry://pair#%%%"))
      .toThrowError(expect.objectContaining({ code: "pairing_invite_invalid" }));
    expect(() => parsePairingInviteText("{\"not\":\"an invite\"}"))
      .toThrowError(expect.objectContaining({ code: "pairing_invite_invalid" }));
    expect(() => parsePairingInviteText(42))
      .toThrowError(expect.objectContaining({ code: "pairing_invite_invalid" }));
    // A tampered payload body fails to decode to a valid invite.
    const encoded = encodePairingInvite(inviteFixture());
    const mangled = `${encoded.slice(0, -4)}AAAA`;
    expect(() => parsePairingInviteText(mangled))
      .toThrowError(expect.objectContaining({ code: "pairing_invite_invalid" }));
    expect(() => parsePairingInviteText(encodePairingInvite({
      ...inviteFixture(),
      pairingToken: canned5 as never
    }))).toThrowError(expect.objectContaining({ code: "pairing_invite_invalid" }));
  });

  it("rejects an expired invite before any endpoint contact", () => {
    const invite = inviteFixture({ issuedAt: "2020-01-01T00:00:00Z", expiresAt: "2020-06-01T00:00:00Z" });
    expect(() => parsePairingInviteText(encodePairingInvite(invite)))
      .toThrowError(expect.objectContaining({ code: "pairing_expired" }));
  });
});

describe("pairing session", () => {
  function authorization(session: PairingSession) {
    const snapshot = session.snapshot();
    return {
      account: snapshot.account!,
      target: snapshot.target!,
      permitId: "_" + "A".repeat(42),
      purpose: "pair_device" as const
    };
  }

  it("enrolls a device end-to-end: pending → challenge → proof → enrolled", async () => {
    const endpoint = fakeEndpoint();
    const session = new PairingSession({
      invite: inviteFixture(),
      custody: await custody(),
      endpoint
    });
    expect(session.snapshot().state).toBe("pending");
    const issued = await session.begin();
    expect(issued.state).toBe("challenge_issued");
    expect(issued.challengeId).toBeTruthy();
    const done = await session.submitProof(authorization(session));
    expect(done.state).toBe("enrolled");
    const record = done.record!;
    expect(record.inviteId).toBe("inv.test.1");
    expect(record.capabilityGrantRef).toBe("grant.staged.1");
    // The enrolled record carries a contract-valid endpoint trust binding.
    const binding = parseEndpointTrustBinding(record.trustBinding);
    expect(binding).not.toBeNull();
    expect(binding?.role).toBe("entry");
    expect(binding?.pairedIdentityFingerprint).toBe(record.fingerprint);
    expect(binding?.boundRecoveryKeyId).toBe("rckey.test.1");
    // The proof the endpoint saw verifies under the custodied device key.
    expect(verifyEd25519({
      publicKey: record.devicePublicKey,
      signature: (endpoint as { seenSignature?: string }).seenSignature!,
      transcript: pairingProofTranscript({
        challengeId: record.trustBinding ? `pch.${record.deviceId}` : "",
        inviteId: record.inviteId,
        endpointRouteId: "route.pr.1",
        deviceId: record.deviceId,
        devicePublicKey: record.devicePublicKey,
        entryPeerIdentity: null
      })
    })).toBe(true);
  });

  it("signs and retains the exact paired Peer identities through completion", async () => {
    const c = await custody();
    const device = await enrollDeviceIdentity({ custody: c });
    const entryIdentity: PairingPeerIdentity = {
      peerId: `peer:tenant.pr.1:route.pr.1:${device.deviceId}`,
      signalDeviceId: 1,
      registrationId: 1777,
      identityKey: Buffer.concat([Buffer.from([5]), randomBytes(32)]).toString("base64url")
    };
    const endpointIdentity: PairingPeerIdentity = {
      peerId: "peer:tenant.pr.1:route.pr.1:dev.endpoint.1",
      signalDeviceId: 1,
      registrationId: 2188,
      identityKey: Buffer.concat([Buffer.from([5]), randomBytes(32)]).toString("base64url")
    };
    const endpoint = fakeEndpoint({ endpointPeerIdentity: endpointIdentity });
    const session = new PairingSession({
      invite: inviteFixture(), custody: c, endpoint, device, entryPeerIdentity: entryIdentity
    });
    expect((await session.begin()).state).toBe("challenge_issued");
    const done = await session.submitProof(authorization(session));
    expect(done.state).toBe("enrolled");
    expect(done.record?.endpointPeerIdentity).toEqual(endpointIdentity);
    expect(endpoint.seenSignature).toBeTruthy();
  });

  it("accepts the account authority's canonical null for an absent optional target field", async () => {
    const endpoint = fakeEndpoint();
    const session = new PairingSession({
      invite: inviteFixture(),
      custody: await custody(),
      endpoint
    });
    await session.begin();
    const approved = authorization(session);
    const normalizedTarget = { ...approved.target, vaultWriterRotation: null };
    const result = await session.submitProof({
      ...approved,
      target: normalizedTarget as unknown as typeof approved.target
    });
    expect(result.state).toBe("enrolled");
  });

  it("refuses an incorrect pairing token and records the refusal", async () => {
    const session = new PairingSession({
      invite: inviteFixture({ pairingToken: canned6 }),
      custody: await custody(),
      endpoint: fakeEndpoint()
    });
    const snapshot = await session.begin();
    expect(snapshot.state).toBe("refused");
    expect(snapshot.refusal).toBe("invite_token_invalid");
  });

  it("expires a stale invite without contacting the endpoint", async () => {
    const session = new PairingSession({
      invite: inviteFixture({ issuedAt: "2020-01-01T00:00:00Z", expiresAt: "2020-06-01T00:00:00Z" }),
      custody: await custody(),
      endpoint: fakeEndpoint(),
      now: () => Date.parse("2021-01-01T00:00:00Z")
    });
    expect((await session.begin()).state).toBe("expired");
  });

  it("reports endpoint loss as honest offline state", async () => {
    const session = new PairingSession({
      invite: inviteFixture(),
      custody: await custody(),
      endpoint: fakeEndpoint({ failBegin: "unreachable" })
    });
    expect((await session.begin()).state).toBe("offline");
  });

  it("marks a dropped proof round-trip retry-required, then retries", async () => {
    const endpoint = fakeEndpoint({ failComplete: "unreachable" });
    const session = new PairingSession({
      invite: inviteFixture(),
      custody: await custody(),
      endpoint
    });
    await session.begin();
    expect((await session.submitProof(authorization(session))).state).toBe("retry_required");
    // No blind re-submit happened — the state stays honest until retried.
    const retried = new PairingSession({
      invite: inviteFixture(),
      custody: await custody(),
      endpoint: fakeEndpoint()
    });
    await retried.begin();
    expect((await retried.submitProof(authorization(retried))).state).toBe("enrolled");
  });

  it("interrupt() moves an in-flight session to retry-required", async () => {
    const session = new PairingSession({
      invite: inviteFixture(),
      custody: await custody(),
      endpoint: fakeEndpoint()
    });
    await session.begin();
    expect(session.interrupt().state).toBe("retry_required");
  });
});

describe("invite → trust binding mapping", () => {
  it("produces a contract-valid endpoint-trust-binding", () => {
    const binding = inviteToTrustBinding({
      invite: inviteFixture(),
      devicePublicKey: canned7.padEnd(43, "x"),
      deviceFingerprint: canned8,
      capabilityGrantRef: "grant.staged.1"
    });
    const parsed = parseEndpointTrustBinding(binding);
    expect(parsed).not.toBeNull();
    expect(parsed?.mode).toBe("personal");
    expect(parsed?.endpointPrincipalRef).toBe("prin.pr.1");
    expect(parsed?.trustGeneration).toBe(3);
    expect(parsed?.boundRecoveryKeyId).toBe("rckey.test.1");
  });

  it("is canonical-serializable without secret fields", () => {
    const binding = inviteToTrustBinding({
      invite: inviteFixture(),
      devicePublicKey: canned7.padEnd(43, "x"),
      deviceFingerprint: canned8,
      capabilityGrantRef: "grant.staged.1"
    });
    const serialized = canonicalJson(binding);
    expect(serialized).not.toContain("pairingToken");
    expect(serialized).not.toContain("privateKey");
  });
});
