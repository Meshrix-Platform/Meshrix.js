#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createProcessIdentityRequestHeaders,
  createProcessIdentityService,
  generateProcessIdentityClientKeyPair,
  verifyClientIdentityPackageSignature,
  verifyProcessIdentityRevocationReceiptSignature
} from "../../packages/foundation/src/security/process-identity/index.ts";
import { createMemoryCapabilityBindingGuard } from "../../packages/foundation/src/security/authorization/capability-binding-guard.ts";
import { createMemoryOpaqueCapabilityKeyProvider } from "../../packages/foundation/src/security/authorization/opaque-capability-key.ts";
import { startHttpServer } from "../../apps/server/runtime/http-server.ts";

function localRequest(headers: Record<string, any> = {}) : any {
  return {
    headers: {
      host: "127.0.0.1:0",
      ...headers
    },
    socket: { remoteAddress: "127.0.0.1" }
  };
}

async function fetchJson(url?: any, options: Record<string, any> = {}) : Promise<any> {
  const response: any = await fetch(url, options);
  const text: any = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    payload: text.trim() ? JSON.parse(text) : {}
  };
}

function signedHeaders({ packageObject, privateKeyPem, method, url, body, nonce }: Record<string, any>) : any {
  return {
    "Content-Type": "application/json",
    ...createProcessIdentityRequestHeaders({
      privateKeyPem,
      method,
      url,
      body,
      clientIdentityPackage: packageObject,
      nonce
    })
  };
}

function clientFingerprint(suffix?: any) : any {
  return {
    fingerprintId: `fp-${suffix}`,
    machineInstanceId: `machine-${suffix}`,
    appInstanceId: `app-${suffix}`,
    runtimeInstanceId: `runtime-${suffix}`
  };
}

async function verifyServiceFlow() : Promise<any> {
  const dataDir: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-process-identity-service-"));
  const service: any = createProcessIdentityService({
    dataDir,
    claimToken: "claim-token-service",
    capabilityKeyProvider: createMemoryOpaqueCapabilityKeyProvider(),
    capabilityBindingGuard: createMemoryCapabilityBindingGuard()
  });
  try {
    const clientKey: any = generateProcessIdentityClientKeyPair();
    const denied: any = await service.bootstrapClaim({
      request: localRequest(),
      input: {
        claimToken: "wrong",
        clientId: "client-a",
        installationId: "install-a",
        clientFingerprint: clientFingerprint("service"),
        processPublicKeyPem: clientKey.publicKeyPem,
        defaultIdentityHash: "sha256:default-a",
        nonce: "claim-nonce-a"
      }
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.reasonCode, "bootstrap_claim_token_invalid");

    const claimed: any = await service.bootstrapClaim({
      request: localRequest(),
      input: {
        claimToken: "claim-token-service",
        clientId: "client-a",
        installationId: "install-a",
        clientFingerprint: clientFingerprint("service"),
        processPublicKeyPem: clientKey.publicKeyPem,
        defaultIdentityHash: "sha256:default-a",
        nonce: "claim-nonce-a"
      }
    });
    assert.equal(claimed.ok, true);
    assert.equal(claimed.clientIdentityPackage.clientId, "client-a");
    assert.equal(claimed.clientIdentityPackage.serverId, claimed.serverIdentity.serverId);
    assert.equal(claimed.clientIdentityPackage.clientFingerprint.fingerprintId, "fp-service");
    assert.equal(claimed.binding.requireServer, true);
    assert.equal(claimed.binding.requirePackage, true);
    assert.equal(claimed.binding.requireProcessKey, true);
    assert.equal(claimed.binding.requireProcessPublicKey, true);
    assert.equal(claimed.binding.requireIdentityGeneration, true);
    assert.equal(claimed.binding.requireDefaultIdentity, true);
    assert.equal(claimed.binding.requireFingerprintId, true);
    assert.equal(claimed.binding.requireMachineInstance, true);
    assert.equal(claimed.binding.requireAppInstance, true);
    assert.equal(claimed.binding.requireRuntimeInstance, true);
    assert.equal(claimed.binding.requireClientFingerprint, true);
    assert.equal(
      verifyClientIdentityPackageSignature({
        packageObject: claimed.clientIdentityPackage,
        serverPublicKeyPem: claimed.serverIdentity.publicKeyPem
      }).ok,
      true
    );

    const duplicate: any = await service.bootstrapClaim({
      request: localRequest(),
      input: {
        claimToken: "claim-token-service",
        clientId: "client-b",
        processPublicKeyPem: clientKey.publicKeyPem,
        defaultIdentityHash: "sha256:default-b"
      }
    });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.reasonCode, "bootstrap_claim_already_consumed");

    const rotateBody: any = JSON.stringify({ reason: "service-rotate" });
    const rotateUrl: any = new URL("/api/process-identity/package/rotate", "http://127.0.0.1");
    const headers: any = signedHeaders({
      packageObject: claimed.clientIdentityPackage,
      privateKeyPem: clientKey.privateKeyPem,
      method: "POST",
      url: rotateUrl,
      body: rotateBody,
      nonce: "service-rotate-nonce"
    });
    const request: any = localRequest(headers);
    const verification: any = await service.verifySignedRequest({
      request,
      requestBody: Buffer.from(rotateBody),
      url: rotateUrl,
      method: "POST",
      operation: {
        id: "process_identity.package.rotate",
        processIdentity: { required: true, authorizes: true, requireBinding: true }
      }
    });
    assert.equal(verification.ok, true);
    request.__meshrixProcessIdentity = verification;

    const badFingerprintHeaders: any = signedHeaders({
      packageObject: claimed.clientIdentityPackage,
      privateKeyPem: clientKey.privateKeyPem,
      method: "POST",
      url: rotateUrl,
      body: rotateBody,
      nonce: "service-bad-fingerprint"
    });
    badFingerprintHeaders["x-meshrix-runtime-instance-id"] = "runtime-copy";
    const wrongFingerprint: any = await service.verifySignedRequest({
      request: localRequest(badFingerprintHeaders),
      requestBody: Buffer.from(rotateBody),
      url: rotateUrl,
      method: "POST",
      operation: {
        id: "process_identity.package.rotate",
        processIdentity: { required: true, authorizes: true, requireBinding: true }
      }
    });
    assert.equal(wrongFingerprint.ok, false);
    assert.equal(wrongFingerprint.reasonCode, "process_identity_client_fingerprint_mismatch");

    const replay: any = await service.verifySignedRequest({
      request,
      requestBody: Buffer.from(rotateBody),
      url: rotateUrl,
      method: "POST",
      operation: {
        id: "process_identity.package.rotate",
        processIdentity: { required: true, authorizes: true, requireBinding: true }
      }
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.reasonCode, "process_identity_nonce_replay");

    const rotated: any = await service.rotateClientIdentityPackage({
      request,
      input: { reason: "service-rotate" }
    });
    assert.equal(rotated.ok, true);
    assert.equal(rotated.clientIdentityPackage.identityGeneration, 2);
    assert.notEqual(rotated.clientIdentityPackage.packageId, claimed.clientIdentityPackage.packageId);

    const badBody: any = await service.verifySignedRequest({
      request: localRequest(signedHeaders({
        packageObject: rotated.clientIdentityPackage,
        privateKeyPem: clientKey.privateKeyPem,
        method: "POST",
        url: rotateUrl,
        body: rotateBody,
        nonce: "service-bad-body"
      })),
      requestBody: Buffer.from(JSON.stringify({ reason: "tampered" })),
      url: rotateUrl,
      method: "POST",
      operation: {
        id: "process_identity.package.rotate",
        processIdentity: { required: true, authorizes: true, requireBinding: true }
      }
    });
    assert.equal(badBody.ok, false);
    assert.equal(badBody.reasonCode, "process_identity_body_hash_mismatch");

    const revokeInput: Record<string, any> = {
      reason: "verifier-revocation",
      endpoint: "/api/process-identity/package/revoke"
    };
    const revokeBody: any = JSON.stringify(revokeInput);
    const revokeUrl: any = new URL("/api/process-identity/package/revoke", "http://127.0.0.1");
    const revokeRequest: any = localRequest(signedHeaders({
      packageObject: rotated.clientIdentityPackage,
      privateKeyPem: clientKey.privateKeyPem,
      method: "POST",
      url: revokeUrl,
      body: revokeBody,
      nonce: "service-revoke-nonce"
    }));
    const revokeVerification: any = await service.verifySignedRequest({
      request: revokeRequest,
      requestBody: Buffer.from(revokeBody),
      url: revokeUrl,
      method: "POST",
      operation: {
        id: "process_identity.package.revoke",
        processIdentity: { required: true, authorizes: true, requireBinding: true }
      }
    });
    assert.equal(revokeVerification.ok, true);
    revokeRequest.__meshrixProcessIdentity = revokeVerification;
    const revoked: any = await service.revokeClientIdentityPackage({
      request: revokeRequest,
      input: revokeInput
    });
    assert.equal(revoked.ok, true);
    assert.equal(revoked.revocationReceipt.status, "revoked");
    assert.match(revoked.revocationReceipt.receiptDigestSha256, /^[a-f0-9]{64}$/u);
    const receiptDecision: any = await service.verifyClientIdentityRevocationReceipt({
      receipt: revoked.revocationReceipt,
      expected: revokeInput
    });
    assert.equal(receiptDecision.ok, true);
    assert.equal(receiptDecision.receiptDigestSha256, revoked.revocationReceipt.receiptDigestSha256);
  } finally {
    service.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function verifyHttpFlow() : Promise<any> {
  const dataDir: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-process-identity-http-"));
  const previousToken: any = process.env.MESHRIX_PROCESS_IDENTITY_CLAIM_TOKEN;
  process.env.MESHRIX_PROCESS_IDENTITY_CLAIM_TOKEN = "claim-token-http";
  const server: any = await startHttpServer({
    userDataPath: dataDir,
    runtimeOptions: { profile: "minimal" }
  });
  try {
    const clientKey: any = generateProcessIdentityClientKeyPair();
    const claim: any = await fetchJson(`${server.url}/api/process-identity/bootstrap/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        claimToken: "claim-token-http",
        clientId: "client-http",
        installationId: "install-http",
        clientFingerprint: clientFingerprint("http"),
        processPublicKeyPem: clientKey.publicKeyPem,
        defaultIdentityHash: "sha256:default-http",
        nonce: "http-claim-nonce"
      })
    });
    assert.equal(claim.status, 200);
    assert.equal(claim.payload.ok, true);

    const rotateBody: any = JSON.stringify({ reason: "http-rotate" });
    const rotateUrl: any = `${server.url}/api/process-identity/package/rotate`;
    const rotateHeaders: any = signedHeaders({
      packageObject: claim.payload.clientIdentityPackage,
      privateKeyPem: clientKey.privateKeyPem,
      method: "POST",
      url: rotateUrl,
      body: rotateBody,
      nonce: "http-rotate-nonce"
    });
    const rotated: any = await fetchJson(rotateUrl, {
      method: "POST",
      headers: rotateHeaders,
      body: rotateBody
    });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.payload.ok, true);
    assert.equal(rotated.payload.clientIdentityPackage.identityGeneration, 2);

    const replay: any = await fetchJson(rotateUrl, {
      method: "POST",
      headers: rotateHeaders,
      body: rotateBody
    });
    assert.ok([401, 403].includes(replay.status), `replay must be rejected, got ${replay.status}`);

    const revokeInput: Record<string, any> = {
      reason: "verifier-revocation",
      endpoint: "/api/process-identity/package/revoke"
    };
    const revokeBody: any = JSON.stringify(revokeInput);
    const revokeUrl: any = `${server.url}/api/process-identity/package/revoke`;
    const revoked: any = await fetchJson(revokeUrl, {
      method: "POST",
      headers: signedHeaders({
        packageObject: rotated.payload.clientIdentityPackage,
        privateKeyPem: clientKey.privateKeyPem,
        method: "POST",
        url: revokeUrl,
        body: revokeBody,
        nonce: "http-revoke-nonce"
      }),
      body: revokeBody
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.payload.ok, true);
    assert.equal(revoked.payload.revocationReceipt.status, "revoked");
    assert.match(revoked.payload.revocationReceipt.receiptDigestSha256, /^[a-f0-9]{64}$/u);
    assert.equal(
      verifyProcessIdentityRevocationReceiptSignature({
        receipt: revoked.payload.revocationReceipt,
        serverIdentity: revoked.payload.revocationReceipt.serverIdentity,
        expected: revokeInput
      }).ok,
      true
    );

    const revokedAgain: any = await fetchJson(revokeUrl, {
      method: "POST",
      headers: signedHeaders({
        packageObject: rotated.payload.clientIdentityPackage,
        privateKeyPem: clientKey.privateKeyPem,
        method: "POST",
        url: revokeUrl,
        body: revokeBody,
        nonce: "http-revoke-after-revoked"
      }),
      body: revokeBody
    });
    assert.ok([401, 403].includes(revokedAgain.status), `revoked package must be rejected, got ${revokedAgain.status}`);
  } finally {
    await server.close();
    if (previousToken === undefined) {
      delete process.env.MESHRIX_PROCESS_IDENTITY_CLAIM_TOKEN;
    } else {
      process.env.MESHRIX_PROCESS_IDENTITY_CLAIM_TOKEN = previousToken;
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

await verifyServiceFlow();
await verifyHttpFlow();

console.log("[process-identity] ok");
