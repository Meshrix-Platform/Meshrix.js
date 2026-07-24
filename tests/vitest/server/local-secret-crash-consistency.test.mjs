import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let failLockAssertion = false;

vi.mock("../../../packages/foundation/src/security/secrets/local-secret-storage.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    async assertLocalSecretMutationLockOwned(lock) {
      if (failLockAssertion) {
        const error = new Error("Injected local secret mutation lock loss.");
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
} from "../../../packages/foundation/src/security/secrets/local-secret-store.mjs";

const roots = [];
const target = Object.freeze({
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
const expectedScope = Object.freeze({
  serviceId: "fixture-service",
  requiredScopes: ["fixture:read"],
  host: "service.example.test",
  protocol: "https"
});

afterEach(async () => {
  failLockAssertion = false;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("local secret crash consistency", () => {
  it("keeps the previously committed value resolvable when rotation loses its lock", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-secret-crash-"));
    roots.push(dataDir);
    await initializeLocalSecret({ dataDir, target, payload: { token: "material-before" } });

    failLockAssertion = true;
    await expect(rotateLocalSecret({
      dataDir,
      target,
      payload: { token: "material-after" },
      expectedRevision: 1
    })).rejects.toMatchObject({ code: "local_secret_store_lock_lost" });
    failLockAssertion = false;

    await expect(resolveLocalSecretPayload({
      dataDir,
      secretRef: target.secretRef,
      expectedScope
    })).resolves.toMatchObject({
      revision: 1,
      payload: { token: "material-before" }
    });
  });
});
