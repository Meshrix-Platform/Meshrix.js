import { createHash, generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ACCOUNT_API_ROUTES, accountDesktopSessionTranscript, type AccountDesktopPairingBootstrapRequest } from "@meshrix/contracts/account";
import { rawPublicKeyBase64Url } from "@meshrix/entry";
import {
  accountDesktopProofDigest,
  DesktopAccountClient,
  normalizeAccountOrigin,
  validateAccountBrowserUrl
} from "../../../apps/entry-gui/src/main/account-client.ts";

const ACCOUNT_ORIGIN = "https://account.meshrix.invalid";

describe("installed account handoff client", () => {
  it("keeps the PKCE verifier in main memory and sends only its digest to the worker", async () => {
    let postedUrl = "";
    let postedBody: Record<string, unknown> | null = null;
    let credentials: RequestCredentials | undefined;
    const client = new DesktopAccountClient({
      origin: ACCOUNT_ORIGIN,
      fetch: async (input, init) => {
        postedUrl = String(input);
        credentials = init?.credentials;
        postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          transactionId: "txn.test.login",
          browserUrl: `${ACCOUNT_ORIGIN}/account?transactionId=txn.test.login`
        });
      }
    });

    const transaction = await client.createTransaction({ purpose: "login", clientPublicKey: "public.desktop.key" });

    expect(postedUrl).toBe(`${ACCOUNT_ORIGIN}${ACCOUNT_API_ROUTES.desktopTransaction}`);
    expect(credentials).toBe("omit");
    expect(postedBody?.verifierDigest).toEqual(expect.any(String));
    expect(JSON.stringify(postedBody)).not.toContain(transaction.verifier);
    expect(transaction.browserUrl).not.toContain(transaction.verifier);
    expect(transaction.browserUrl).toContain("transactionId=txn.test.login");
  });

  it("signs step-up transaction creation with the current desktop session over the exact request body", async () => {
    const pair = generateKeyPairSync("ed25519");
    const credential = "desktop-session-credential-used-for-step-up";
    const account = { accountId: "account.test.1", authEpoch: 2 };
    let postedBody: Record<string, unknown> | null = null;
    const client = new DesktopAccountClient({
      origin: ACCOUNT_ORIGIN,
      fetch: async (_input, init) => {
        postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          transactionId: "txn.test.stepup",
          browserUrl: `${ACCOUNT_ORIGIN}/account?transactionId=txn.test.stepup`
        });
      }
    });
    const clientPublicKey = rawPublicKeyBase64Url(pair.publicKey);
    const target = {
      tenantId: "tenant.test.1",
      routeId: "route.test.1",
      deviceId: "device.entry.1",
      devicePublicKey: "entry-key-for-target",
      grantRef: "grant.test.1",
      scopes: ["mcp:invoke"]
    };

    await client.createTransaction({
      purpose: "step_up",
      actionPurpose: "grant_access",
      clientPublicKey,
      target,
      desktopAuth: { account, credential, privateKey: pair.privateKey }
    });

    expect(postedBody?.purpose).toBe("step_up");
    const proof = postedBody?.desktopProof as Record<string, string>;
    const unsignedBody = { ...postedBody };
    delete unsignedBody.desktopProof;
    expect(proof.credential).toBe(credential);
    expect(proof.clientPublicKey).toBe(clientPublicKey);
    expect(proof.bodyDigest).toBe(accountDesktopProofDigest(unsignedBody));
    const transcript = accountDesktopSessionTranscript({
      method: "POST",
      pathname: ACCOUNT_API_ROUTES.desktopTransaction,
      account,
      clientPublicKey,
      credentialDigest: createHash("sha256").update(credential, "utf8").digest("base64url"),
      nonce: proof.nonce,
      bodyDigest: proof.bodyDigest
    });
    expect(cryptoVerify(null, Buffer.from(transcript, "utf8"), pair.publicKey, Buffer.from(proof.signature, "base64url"))).toBe(true);
  });

  it("requires the configured origin and one exact opaque transaction in the browser URL", () => {
    expect(normalizeAccountOrigin(ACCOUNT_ORIGIN)).toBe(ACCOUNT_ORIGIN);
    expect(() => normalizeAccountOrigin("https://account.meshrix.invalid/path"))
      .toThrowError(expect.objectContaining({ code: "account_origin_invalid" }));
    expect(() => validateAccountBrowserUrl(
      `${ACCOUNT_ORIGIN}/account?transactionId=txn.test.login&verifier=secret`,
      ACCOUNT_ORIGIN,
      "txn.test.login"
    )).toThrowError(expect.objectContaining({ code: "account_browser_url_invalid" }));
  });

  it("accepts only a bootstrap response bound to the invite pin and Entry key", async () => {
    const request: AccountDesktopPairingBootstrapRequest = {
      tenantId: "tenant.test.1",
      routeId: "route.test.1",
      entryDeviceId: "device.entry.1",
      entryDevicePublicKey: "entry.public.key",
      endpointPinRef: "spki.endpoint.pin",
      mode: "personal",
      proof: {
        credential: "opaque.desktop.session.credential",
        clientPublicKey: "desktop.public.key",
        nonce: "nonce.test.1",
        bodyDigest: "digest.test.1",
        signature: "signature.test.1"
      }
    };
    const response = {
      bootstrapId: "bootstrap.test.1",
      account: { accountId: "account.test.1", authEpoch: 2 },
      tenantId: request.tenantId,
      routeId: request.routeId,
      entryDeviceId: request.entryDeviceId,
      endpointDeviceId: "device.endpoint.1",
      endpointPinRef: "spki.endpoint.pin",
      role: "entry",
      mode: "personal",
      admissionGeneration: 3,
      revocationRevision: 5,
      relayAdmission: "rly.admission.opaque.token.value",
      expiresAt: "2099-01-01T00:00:00.000Z"
    };
    const client = new DesktopAccountClient({
      origin: ACCOUNT_ORIGIN,
      fetch: async () => Response.json(response)
    });
    expect(await client.createPairingBootstrap(request)).toEqual(response);
    let teamCalls = 0;
    const unavailableTeam = new DesktopAccountClient({ origin: ACCOUNT_ORIGIN,
      fetch: async () => { teamCalls += 1; return Response.json({ ...response, mode: "enterprise" }); } });
    await expect(unavailableTeam.createPairingBootstrap({ ...request, mode: "enterprise" }))
      .rejects.toThrowError(expect.objectContaining({ code: "team_not_available" }));
    expect(teamCalls).toBe(0);
    const wrongNamespace = new DesktopAccountClient({ origin: ACCOUNT_ORIGIN,
      fetch: async () => Response.json({ ...response, tenantId: "tenant.other.account" }) });
    await expect(wrongNamespace.createPairingBootstrap(request))
      .rejects.toThrowError(expect.objectContaining({ code: "account_bootstrap_invalid" }));


    const wrongPin = new DesktopAccountClient({
      origin: ACCOUNT_ORIGIN,
      fetch: async () => Response.json({ ...response, endpointPinRef: "spki.other.pin" })
    });
    await expect(wrongPin.createPairingBootstrap(request))
      .rejects.toThrowError(expect.objectContaining({ code: "account_bootstrap_invalid" }));
  });

  it("signs a scoped device revoke and accepts only the exact idempotent authority receipt", async () => {
    const pair = generateKeyPairSync("ed25519");
    const account = { accountId: "account.test.1", authEpoch: 4 };
    const credential = "desktop-session-credential-for-revoke";
    const clientPublicKey = rawPublicKeyBase64Url(pair.publicKey);
    const request = {
      operationId: "device-revoke.operation.1",
      tenantId: "tenant.test.1",
      routeId: "route.test.1",
      deviceId: "device.entry.1"
    };
    const response = { ...request, authorityRevoked: true, target: "device", enforcement: "pending" };
    let postedBody: Record<string, unknown> | null = null;
    let postedUrl = "";
    const client = new DesktopAccountClient({
      origin: ACCOUNT_ORIGIN,
      fetch: async (input, init) => {
        postedUrl = String(input);
        postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json(response);
      }
    });

    expect(await client.revokeDevice({
      ...request,
      account,
      credential,
      clientPublicKey,
      privateKey: pair.privateKey
    })).toEqual(response);
    expect(postedUrl).toBe(`${ACCOUNT_ORIGIN}${ACCOUNT_API_ROUTES.deviceRevoke}`);
    const proof = postedBody?.desktopProof as Record<string, string>;
    const unsignedBody = { ...postedBody };
    delete unsignedBody.desktopProof;
    expect(proof.credential).toBe(credential);
    expect(proof.bodyDigest).toBe(accountDesktopProofDigest(unsignedBody));
    const transcript = accountDesktopSessionTranscript({
      method: "POST",
      pathname: ACCOUNT_API_ROUTES.deviceRevoke,
      account,
      clientPublicKey,
      credentialDigest: createHash("sha256").update(credential, "utf8").digest("base64url"),
      nonce: proof.nonce,
      bodyDigest: proof.bodyDigest
    });
    expect(cryptoVerify(null, Buffer.from(transcript, "utf8"), pair.publicKey, Buffer.from(proof.signature, "base64url"))).toBe(true);

    const mismatched = new DesktopAccountClient({
      origin: ACCOUNT_ORIGIN,
      fetch: async () => Response.json({ ...response, deviceId: "device.other.1" })
    });
    await expect(mismatched.revokeDevice({ ...request, account, credential, clientPublicKey, privateKey: pair.privateKey }))
      .rejects.toThrowError(expect.objectContaining({ code: "account_device_revoke_invalid" }));
  });
});
