import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify as cryptoVerify,
  X509Certificate
} from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_API_ROUTES,
  accountDeviceAuthorityTranscript,
  accountDesktopSessionTranscript,
  canonicalAccountActionTarget,
  type AccountActionTarget,
  type AccountAuthorityBinding,
  type AccountManagedRouteBinding
} from "@meshrix/contracts/account";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { createEndpointIdentityStore } from "@meshrix/gateway/private-endpoint";
import { loadPrivateEndpointConfig } from "../../../apps/mcp-gateway-installer/src/private-endpoint/config.ts";
import { claimManagedEndpoint } from "../../../apps/mcp-gateway-installer/src/private-endpoint/claim.ts";
import { createFileEndpointIdentityDurablePort } from "@meshrix/gateway/private-endpoint";
const canned1 = "MESH_CLAIM_TEST_RELAY_CREDENTIAL";
const canned2 = "MESH_CLAIM_TEST_ADMIN_TOKEN";
const canned3 = "https://account.example.test";
const canned4 = "";




const ED25519_SPKI_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const RELAY_CREDENTIAL_ENV = canned1;
const ADMIN_TOKEN_ENV = canned2;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function publicKeyFromRaw(value: string) {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_DER_PREFIX, Buffer.from(value, "base64url")]), format: "der", type: "spki" });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

async function makeEndpointConfig(dir: string) {
  const tlsKeyPath = join(dir, "endpoint.key");
  const tlsCertPath = join(dir, "endpoint.crt");
  const gatewayConfigPath = join(dir, "gateway.json");
  const configPath = join(dir, "endpoint.json");
  const openssl = spawnSync("openssl", ["req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1", "-subj", "/CN=endpoint", "-keyout", tlsKeyPath, "-out", tlsCertPath], { stdio: "ignore" });
  if (openssl.status !== 0) throw new Error("openssl failed to generate the TLS test certificate");
  await writeFile(gatewayConfigPath, JSON.stringify({ profile: "local", services: [] }));
  let identity = generateKeyPairSync("ed25519");
  let identitySpki = identity.publicKey.export({ format: "der", type: "spki" });
  let identityFingerprint = createHash("sha256").update(identitySpki).digest("base64url");
  while (!/^[A-Za-z0-9]/u.test(identityFingerprint)) {
    identity = generateKeyPairSync("ed25519");
    identitySpki = identity.publicKey.export({ format: "der", type: "spki" });
    identityFingerprint = createHash("sha256").update(identitySpki).digest("base64url");
  }
  const endpointTrustKey = identitySpki.toString("base64url");
  await writeFile(configPath, JSON.stringify({
    profile: "private-endpoint",
    relay: { url: "wss://relay.example.test", credential: ("env:"+RELAY_CREDENTIAL_ENV) },
    endpoint: {
      tenantId: "tenant.account.claim.test",
      deviceId: "endpoint.account.claim.test",
      routeId: "route.account.claim.test",
      mode: "personal",
      admissionGeneration: 1,
      revocationRevision: 0,
      pairedIdentityKey: endpointTrustKey,
      pairedIdentityFingerprint: identityFingerprint,
      trustGeneration: 1,
      endpointPrincipalRef: "principal.account.claim.test",
      capabilityGrantRef: "grant.endpoint.account.claim.test"
    },
    innerTls: { key: ("file:"+tlsKeyPath), cert: ("file:"+tlsCertPath) },
    gateway: { configPath: gatewayConfigPath },
    reconnect: { initialDelayMs: 50, maxDelayMs: 1_000 },
    admin: { listen: { host: "127.0.0.1", port: 0 } }
  }));
  return { configPath, tlsCert: await readFile(tlsCertPath, "utf8") };
}

describe("managed endpoint claim", () => {
  it("uses raw PKCE verifiers, binds factor approval to the prepared claim and retries with durable endpoint custody", async () => {
    const dir = await mkdtemp(join(tmpdir(), "meshrix-endpoint-claim-"));
    const previousRelay = process.env[RELAY_CREDENTIAL_ENV];
    const previousAdmin = process.env[ADMIN_TOKEN_ENV];
    process.env[RELAY_CREDENTIAL_ENV] = "relay-credential-for-test-only";
    process.env[ADMIN_TOKEN_ENV] = "loopback-admin-token-for-test-only";
    try {
      const fixture = await makeEndpointConfig(dir);
      const initialConfig = await loadPrivateEndpointConfig(fixture.configPath);
      const operatorConfig = JSON.parse(await readFile(fixture.configPath, "utf8"));
      await writeFile(fixture.configPath, JSON.stringify({ ...operatorConfig,
        endpoint: { ...operatorConfig.endpoint, mode: "enterprise" } }));
      expect((await loadPrivateEndpointConfig(fixture.configPath)).admission.mode).toBe("enterprise");
      let unavailableTeamCalls = 0;
      await expect(claimManagedEndpoint({ configPath: fixture.configPath,
        authorityOrigin: canned3,
        fetch: async () => { unavailableTeamCalls += 1; throw new Error("unexpected synthetic authority call"); }
      })).rejects.toMatchObject({ code: "team_not_available" });
      expect(unavailableTeamCalls).toBe(0);
      await writeFile(fixture.configPath, JSON.stringify(operatorConfig));
      const tlsCertificate = new X509Certificate(fixture.tlsCert);
      const digestRef = createHash("sha256").update(tlsCertificate.publicKey.export({ format: "der", type: "spki" })).digest("base64url");
      const account: AccountAuthorityBinding = Object.freeze({ accountId: "A".repeat(32), authEpoch: 4 });
      const vaultId = "vault.account.claim.test";
      const claimId = "C".repeat(32);
      const permitId = "_" + "P".repeat(41) + "A";
      const relayAdmission = "R".repeat(48);
      const transactions = new Map<string, { purpose: string; verifierDigest: string; body: Record<string, unknown> }>();
      const browserUrls: string[] = [];
      let target: AccountActionTarget | undefined;
      let completedOperationId: string | undefined;
      let loginPollCount = 0;
      let completionCallCount = 0;
      const requestRedirectModes: Array<{ path: string; redirect: RequestRedirect | undefined }> = [];

      const verifyDesktopProof = (pathname: string, body: Record<string, unknown>) => {
        const proof = body.desktopProof as Record<string, unknown>;
        const unsigned = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "desktopProof"));
        const clientPublicKey = String(proof.clientPublicKey);
        const bodyDigest = sha256(canonicalJson(unsigned));
        expect(proof.bodyDigest).toBe(bodyDigest);
        const transcript = accountDesktopSessionTranscript({
          method: "POST",
          pathname,
          account,
          clientPublicKey,
          credentialDigest: sha256(String(proof.credential)),
          nonce: String(proof.nonce),
          bodyDigest
        });
        expect(cryptoVerify(null, Buffer.from(transcript, "utf8"), publicKeyFromRaw(clientPublicKey), Buffer.from(String(proof.signature), "base64url"))).toBe(true);
      };

      let managedRoute: AccountManagedRouteBinding = {
        accountId: account.accountId,
        authEpoch: account.authEpoch,
        tenantId: "tenant.server.personal.assigned",
        routeId: "route.account.claim.test",
        endpointDeviceId: "endpoint.account.claim.test",
        endpointPublicKey: canned4,
        endpointPinRef: digestRef,
        vaultId
      };

      const fetchImpl: typeof fetch = async (request, init) => {
        const url = new URL(String(request));
        requestRedirectModes.push({ path: url.pathname, redirect: init?.redirect });
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (url.pathname === ACCOUNT_API_ROUTES.desktopTransaction) {
          const id = transactions.size.toString(36).padStart(32, "0");
          transactions.set(id, { purpose: String(body.purpose), verifierDigest: String(body.verifierDigest), body });
          if (body.purpose === "step_up") {
            expect(body.claimId).toBe(claimId);
            expect(body.actionPurpose).toBe("pair_device");
            expect(body.target).toEqual(target);
            verifyDesktopProof(url.pathname, body);
          }
          return jsonResponse({ transactionId: id, browserUrl: `https://account.example.test/account?transactionId=${id}` });
        }
        const poll = url.pathname.match(/\/desktop\/transactions\/([^/]+)\/poll$/u);
        if (poll) {
          const transaction = transactions.get(decodeURIComponent(poll[1] as string));
          if (!transaction) throw new Error("unexpected transaction poll");
          expect(sha256(String(body.verifier))).toBe(transaction.verifierDigest);
          if (transaction.purpose === "login") {
            loginPollCount += 1;
            return jsonResponse({ state: "complete", purpose: "login", account, deviceSessionCredential: ("S".repeat(47)+loginPollCount), permitId: null, target: null });
          }
          return jsonResponse({ state: "complete", purpose: "step_up", actionPurpose: "pair_device", account, deviceSessionCredential: null, permitId, target });
        }
        if (url.pathname.includes("/acknowledge")) return jsonResponse({ acknowledged: true });
        if (url.pathname === ACCOUNT_API_ROUTES.deviceEndpointClaimPrepare) {
          verifyDesktopProof(url.pathname, body);
          expect(body).not.toHaveProperty("tenantId");
          expect(body.routeId).toBe(managedRoute.routeId);
          expect(body.endpointPinRef).toBe(digestRef);
          const endpointPublicKey = String(body.endpointPublicKey);
          managedRoute = { ...managedRoute, endpointPublicKey };
          target = Object.freeze({
            tenantId: managedRoute.tenantId,
            routeId: managedRoute.routeId,
            deviceId: managedRoute.endpointDeviceId,
            devicePublicKey: endpointPublicKey,
            grantRef: "grant.endpoint.claim.test",
            scopes: Object.freeze(["endpoint:claim"])
          });
          return jsonResponse({ claimId, account, vaultId, target, expiresAt: new Date(Date.now() + 60_000).toISOString() });
        }
        if (url.pathname === ACCOUNT_API_ROUTES.deviceEndpointClaimComplete) {
          verifyDesktopProof(url.pathname, body);
          expect(body.claimId).toBe(claimId);
          expect(body.permitId).toBe(permitId);
          completionCallCount += 1;
          if (completedOperationId !== undefined) expect(body.operationId).toBe(completedOperationId);
          completedOperationId = String(body.operationId);
          const endpointProof = body.endpointProof as Record<string, unknown>;
          const { signature, ...unsignedProof } = endpointProof;
          expect(unsignedProof).toMatchObject({ purpose: "claim_endpoint", tenantId: managedRoute.tenantId,
            routeId: managedRoute.routeId, endpointPinRef: digestRef, claimId, permitId });
          expect(unsignedProof.targetDigest).toBe(sha256(canonicalAccountActionTarget(target!)));
          expect(cryptoVerify(null, Buffer.from(accountDeviceAuthorityTranscript(unsignedProof as never), "utf8"), publicKeyFromRaw(managedRoute.endpointPublicKey), Buffer.from(String(signature), "base64url"))).toBe(true);
          if (completionCallCount === 1) throw new Error("authority committed, response lost");
          return jsonResponse({ claimed: true, account, tenantId: managedRoute.tenantId, routeId: managedRoute.routeId,
            endpointDeviceId: managedRoute.endpointDeviceId, endpointPublicKey: managedRoute.endpointPublicKey,
            endpointPinRef: digestRef, vaultId, mode: "personal", relayAdmission, admissionGeneration: 2, revocationRevision: 0, expiresAt: null });
        }
        if (url.pathname === ACCOUNT_API_ROUTES.deviceManagedRoute) {
          const proof = body.proof as Record<string, unknown>;
          const { signature, ...unsignedProof } = proof;
          expect(unsignedProof).toMatchObject({ purpose: "managed_route", tenantId: managedRoute.tenantId, routeId: managedRoute.routeId, deviceId: managedRoute.endpointDeviceId });
          expect(cryptoVerify(null, Buffer.from(accountDeviceAuthorityTranscript(unsignedProof as never), "utf8"), publicKeyFromRaw(managedRoute.endpointPublicKey), Buffer.from(String(signature), "base64url"))).toBe(true);
          return jsonResponse({ managedRoute });
        }
        throw new Error(`unexpected endpoint claim request: ${url.pathname}`);
      };

      const claimInput = {
        configPath: fixture.configPath,
        authorityOrigin: canned3,
        fetch: fetchImpl,
        pollIntervalMs: 100,
        openBrowser: async (url: string) => { browserUrls.push(url); }
      } as const;
      await expect(claimManagedEndpoint(claimInput)).rejects.toMatchObject({
        code: "account_authority_unavailable",
        message: "Account authority could not be reached."
      });
      const result = await claimManagedEndpoint(claimInput);

      expect(result).toMatchObject({ outcome: "claimed", accountId: account.accountId, authEpoch: account.authEpoch,
        tenantId: managedRoute.tenantId, routeId: managedRoute.routeId, vaultId });
      expect(browserUrls).toHaveLength(3);
      expect(browserUrls.every((url) => new URL(url).searchParams.size === 1)).toBe(true);
      expect(completedOperationId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(completionCallCount).toBe(2);
      expect(loginPollCount).toBe(2);
      expect(requestRedirectModes.length).toBeGreaterThan(0);
      expect(requestRedirectModes.every(({ redirect }) => redirect === "error")).toBe(true);
      expect([...transactions.values()].filter((transaction) => transaction.purpose === "step_up")).toHaveLength(1);
      const updatedConfig = JSON.parse(await readFile(fixture.configPath, "utf8")) as { account: { vaultId: string; signingKey: string }; relay: { credential: string }; endpoint: { admissionGeneration: number; tenantId: string; routeId: string }; admin: { token: string } };
      expect(updatedConfig.account.vaultId).toBe(vaultId);
      expect(updatedConfig.endpoint.admissionGeneration).toBe(2);
      expect(updatedConfig.endpoint.tenantId).toBe(managedRoute.tenantId);
      expect(updatedConfig.endpoint.routeId).toBe(managedRoute.routeId);
      expect(updatedConfig.admin.token).toMatch(/^file:/u);
      const canonicalConfig = await loadPrivateEndpointConfig(fixture.configPath);
      expect(canonicalConfig.admission.tenantId).toBe(managedRoute.tenantId);
      expect(canonicalConfig.sessionUrl).toContain(`/session/${managedRoute.tenantId}/${managedRoute.routeId}`);
      expect(canonicalConfig.adminToken).toBe(initialConfig.adminToken);
      expect(updatedConfig.relay.credential).toMatch(/^file:/u);
      const secretPath = join(dir, updatedConfig.account.signingKey.slice("file:".length));
      const secretStat = await stat(secretPath);
      expect(secretStat.mode & 0o777).toBe(0o600);
      const relayPath = join(dir, updatedConfig.relay.credential.slice("file:".length));
      expect((await readFile(relayPath, "utf8")).trim()).toBe(relayAdmission);
      expect((await stat(relayPath)).mode & 0o777).toBe(0o600);
      const identity = createEndpointIdentityStore(createFileEndpointIdentityDurablePort(join(dir, ".meshrix-private-endpoint-state.json")));
      expect(identity.device("endpoint.account.claim.test")).toMatchObject({
        role: "endpoint",
        tenantId: managedRoute.tenantId,
        routeId: managedRoute.routeId,
        accountBinding: account,
        admissionGeneration: 2,
        revoked: false
      });
    } finally {
      if (previousRelay === undefined) delete process.env[RELAY_CREDENTIAL_ENV]; else process.env[RELAY_CREDENTIAL_ENV] = previousRelay;
      if (previousAdmin === undefined) delete process.env[ADMIN_TOKEN_ENV]; else process.env[ADMIN_TOKEN_ENV] = previousAdmin;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
