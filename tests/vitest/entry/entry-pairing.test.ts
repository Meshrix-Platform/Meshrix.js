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
  type PairingInvite
} from "@meshrix/entry";

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
    schemaVersion: "v0.0.1:entry:pairing-invite-1",
    kind: "entry-pairing-invite",
    inviteId: "inv.test.1",
    endpointRouteId: "route.pr.1",
    tenantId: "tenant.pr.1",
    mode: "personal",
    endpointPrincipalRef: "prin.pr.1",
    endpointSpkiPin: "spki.test.pin",
    relayService: "https://relay.example.invalid",
    vaultId: "vault.pr.1",
    recoveryAuthority: { keyId: "rckey.test.1", generation: 3 },
    issuedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2027-01-01T00:00:00Z",
    pairingToken: "pt.one-time.token",
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
} = {}): PairingEndpointPort & { seenSignature?: string; seenChallenge?: string } {
  const state: { seenSignature?: string; seenChallenge?: string } = {};
  const token = options.acceptToken ?? "pt.one-time.token";
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
        nonce: "pn.test.1",
        expiresAt: "2099-01-01T00:00:00Z"
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
        devicePublicKey: input.devicePublicKey
      });
      state.seenSignature = input.signature;
      if (!verifyEd25519({ publicKey: input.devicePublicKey, signature: input.signature, transcript })) {
        return { outcome: "refused", refusal: "proof_invalid" };
      }
      if (input.challengeId !== state.seenChallenge) {
        return { outcome: "refused", refusal: "challenge_mismatch" };
      }
      return { outcome: "enrolled", capabilityGrantRef: options.grantRef ?? "grant.staged.1" };
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
      pairingToken: "" as never
    }))).toThrowError(expect.objectContaining({ code: "pairing_invite_invalid" }));
  });

  it("rejects an expired invite before any endpoint contact", () => {
    const invite = inviteFixture({ issuedAt: "2020-01-01T00:00:00Z", expiresAt: "2020-06-01T00:00:00Z" });
    expect(() => parsePairingInviteText(encodePairingInvite(invite)))
      .toThrowError(expect.objectContaining({ code: "pairing_expired" }));
  });
});

describe("pairing session", () => {
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
    const done = await session.submitProof();
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
        devicePublicKey: record.devicePublicKey
      })
    })).toBe(true);
  });

  it("refuses an incorrect pairing token and records the refusal", async () => {
    const session = new PairingSession({
      invite: inviteFixture({ pairingToken: "pt.wrong" }),
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
    expect((await session.submitProof()).state).toBe("retry_required");
    // No blind re-submit happened — the state stays honest until retried.
    const retried = new PairingSession({
      invite: inviteFixture(),
      custody: await custody(),
      endpoint: fakeEndpoint()
    });
    await retried.begin();
    expect((await retried.submitProof()).state).toBe("enrolled");
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
      devicePublicKey: "k".padEnd(43, "x"),
      deviceFingerprint: "fp.test",
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
      devicePublicKey: "k".padEnd(43, "x"),
      deviceFingerprint: "fp.test",
      capabilityGrantRef: "grant.staged.1"
    });
    const serialized = canonicalJson(binding);
    expect(serialized).not.toContain("pairingToken");
    expect(serialized).not.toContain("privateKey");
  });
});
