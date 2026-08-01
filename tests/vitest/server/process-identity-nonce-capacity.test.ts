import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryCapabilityBindingGuard } from "../../../packages/foundation/src/security/authorization/capability-binding-guard.ts";
import { createMemoryOpaqueCapabilityKeyProvider } from "../../../packages/foundation/src/security/authorization/opaque-capability-key.ts";
import {
  createProcessIdentityRequestHeaders,
  createProcessIdentityService,
  generateProcessIdentityClientKeyPair
} from "../../../packages/foundation/src/security/process-identity/index.ts";

function request(headers: Record<string, any> = {}) : any {
  return {
    headers: { host: "127.0.0.1:0", ...headers },
    socket: { remoteAddress: "127.0.0.1" }
  };
}

describe("process identity nonce capacity", () : any => {
  it("never evicts an unexpired nonce to admit a new signed request", async () : Promise<any> => {
    const dataDir: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-nonce-capacity-"));
    const capabilityKeyProvider: any = createMemoryOpaqueCapabilityKeyProvider();
    const capabilityBindingGuard: any = createMemoryCapabilityBindingGuard();
    const serviceOptions: Record<string, any> = {
      dataDir,
      claimToken: "claim-token",
      capabilityKeyProvider,
      capabilityBindingGuard,
      maxNonceCache: 3,
      nonceTtlMs: 60_000
    };
    try {
      const service: any = createProcessIdentityService(serviceOptions);
      const keyPair: any = generateProcessIdentityClientKeyPair();
      const claimed: any = await service.bootstrapClaim({
        request: request(),
        input: {
          claimToken: "claim-token",
          clientId: "capacity-client",
          installationId: "capacity-installation",
          clientFingerprint: {
            fingerprintId: "capacity-fingerprint",
            machineInstanceId: "capacity-machine",
            appInstanceId: "capacity-app",
            runtimeInstanceId: "capacity-runtime"
          },
          processPublicKeyPem: keyPair.publicKeyPem,
          defaultIdentityHash: "sha256:capacity-default"
        }
      });
      expect(claimed.ok).toBe(true);

      const url: any = new URL("/mcp", "http://127.0.0.1");
      const body: any = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const operation: Record<string, any> = {
        id: "mcp.request",
        processIdentity: { required: true, authorizes: true, requireBinding: true }
      };
      const verifyNonce: any = (nonce?: any, targetService: any = service) : any => targetService.verifySignedRequest({
        request: request(createProcessIdentityRequestHeaders({
          privateKeyPem: keyPair.privateKeyPem,
          method: "POST",
          url,
          body,
          clientIdentityPackage: claimed.clientIdentityPackage,
          nonce
        })),
        requestBody: Buffer.from(body),
        url,
        method: "POST",
        operation
      });

      for (const nonce of ["nonce-1", "nonce-2", "nonce-3"]) {
        await expect(verifyNonce(nonce)).resolves.toMatchObject({ ok: true });
      }
      await expect(verifyNonce("nonce-4")).resolves.toMatchObject({
        ok: false,
        status: 503,
        reasonCode: "process_identity_nonce_capacity_exhausted"
      });
      await expect(verifyNonce("nonce-1")).resolves.toMatchObject({
        ok: false,
        reasonCode: "process_identity_nonce_replay"
      });

      const reloaded: any = createProcessIdentityService(serviceOptions);
      await expect(verifyNonce("nonce-1", reloaded)).resolves.toMatchObject({
        ok: false,
        reasonCode: "process_identity_nonce_replay"
      });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("local MCP process identity rollback", () : any => {
  it("invalidates an issued package without requiring the untrusted client to authorize rollback", async () : Promise<any> => {
    const dataDir: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-local-identity-rollback-"));
    const capabilityKeyProvider: any = createMemoryOpaqueCapabilityKeyProvider();
    const capabilityBindingGuard: any = createMemoryCapabilityBindingGuard();
    const service: any = createProcessIdentityService({
      dataDir,
      capabilityKeyProvider,
      capabilityBindingGuard
    });
    try {
      const keyPair: any = generateProcessIdentityClientKeyPair();
      const clientFingerprint: Record<string, any> = {
        fingerprintId: "rollback-fingerprint",
        machineInstanceId: "rollback-machine",
        appInstanceId: "rollback-app",
        runtimeInstanceId: "rollback-runtime"
      };
      const issued: any = await service.issueLocalMcpClientIdentityPackage({
        input: {
          clientId: "codex",
          installationId: "rollback-installation",
          processPublicKeyPem: keyPair.publicKeyPem,
          clientFingerprint,
          defaultIdentityHash: "sha256:rollback-default"
        }
      });
      expect(issued.ok).toBe(true);

      const url: any = new URL("/mcp", "http://127.0.0.1");
      const body: any = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const operation: Record<string, any> = {
        id: "mcp.request",
        processIdentity: { required: true, authorizes: true, requireBinding: true }
      };
      const verify: any = (nonce?: any) : any => service.verifySignedRequest({
        request: request(createProcessIdentityRequestHeaders({
          privateKeyPem: keyPair.privateKeyPem,
          method: "POST",
          url,
          body,
          clientIdentityPackage: issued.clientIdentityPackage,
          nonce
        })),
        requestBody: Buffer.from(body),
        url,
        method: "POST",
        operation
      });
      const verified: any = await verify("before-rollback");
      expect(verified).toMatchObject({ ok: true });
      await expect(service.revalidateVerifiedRequest({
        verification: verified,
        operation
      })).resolves.toMatchObject({
        ok: true,
        reasonCode: "process_identity_current"
      });

      await expect(service.revokeIssuedLocalMcpClientIdentityPackage({
        clientIdentityPackage: issued.clientIdentityPackage,
        reason: "test_batch_rollback"
      })).resolves.toMatchObject({ ok: true });
      await expect(service.revalidateVerifiedRequest({
        verification: verified,
        operation
      })).resolves.toMatchObject({
        ok: false,
        reasonCode: "process_identity_package_not_active"
      });
      await expect(verify("after-rollback")).resolves.toMatchObject({
        ok: false,
        reasonCode: "process_identity_package_unknown"
      });
    } finally {
      service.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
