import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let failLockAssertion: any = false;

vi.mock("../../../packages/foundation/src/security/secrets/local-secret-storage.ts", async (importOriginal?: any) : Promise<any> => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    async assertLocalSecretMutationLockOwned(lock?: any) : Promise<any> {
      if (failLockAssertion) {
        const error: any = new Error("Injected local secret mutation lock loss.");
        error.code = "local_secret_store_lock_lost";
        throw error;
      }
      return actual.assertLocalSecretMutationLockOwned(lock);
    }
  };
});

import {
  initializeLocalSecret,
  resolveLocalSecretPayload,
  rotateLocalSecret
} from "../../../packages/foundation/src/security/secrets/local-secret-store.ts";
import {
  createMemoryLocalSecretKeyProvider
} from "../../../packages/foundation/src/security/secrets/local-secret-key-provider.ts";

const roots: any[] = [];
const target: Readonly<Record<string, any>> = Object.freeze({
  provider: "fixture-provider",
  family: "fixture-family",
  authType: "bearer",
  secretRef: "secret://fixture/service",
  scope: {
    serviceId: "fixture-service",
    scopes: ["fixture:read"],
    allowedHosts: ["service.example.test"],
    allowedProtocols: ["https"]
  }
});
const expectedScope: Readonly<Record<string, any>> = Object.freeze({
  serviceId: "fixture-service",
  requiredScopes: ["fixture:read"],
  host: "service.example.test",
  protocol: "https"
});

afterEach(async () : Promise<any> => {
  failLockAssertion = false;
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("local secret crash consistency", () : any => {
  it("keeps the previously committed value resolvable when rotation loses its lock", async () : Promise<any> => {
    const dataDir: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-secret-crash-"));
    roots.push(dataDir);
    const keyProvider: any = createMemoryLocalSecretKeyProvider();
    await initializeLocalSecret({ dataDir, target, payload: { token: "material-before" }, keyProvider });

    failLockAssertion = true;
    await expect(rotateLocalSecret({
      dataDir,
      target,
      payload: { token: "material-after" },
      expectedRevision: 1,
      keyProvider
    })).rejects.toMatchObject({ code: "local_secret_store_lock_lost" });
    failLockAssertion = false;

    await expect(resolveLocalSecretPayload({
      dataDir,
      secretRef: target.secretRef,
      expectedScope,
      keyProvider
    })).resolves.toMatchObject({
      revision: 1,
      payload: { token: "material-before" }
    });
  });
});
