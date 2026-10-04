import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createLockBackedNpmRegistry } from "../../../tools/server-scripts/lib/lock-backed-npm-registry.ts";

const REPO_ROOT: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const LOCK: any = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package-lock.json"), "utf8"));
const ROOT_PACTIUM_LOCK: any = LOCK.packages["node_modules/pactium"];
const PACTIUM_VERSION: any = "0.8.1";
const PACTIUM_RESOLVED: any = `https://registry.npmjs.org/pactium/-/pactium-${PACTIUM_VERSION}.tgz`;
const SYNTHETIC_TARBALL_BYTES: any = Buffer.from("synthetic pactium 0.8.1 registry fixture\n");
const SYNTHETIC_PACTIUM_LOCK: any = {
  name: "pactium",
  version: PACTIUM_VERSION,
  resolved: PACTIUM_RESOLVED,
  integrity: `sha512-${createHash("sha512").update(SYNTHETIC_TARBALL_BYTES).digest("base64")}`,
  license: "MIT"
};

let registryHandle: any = null;

afterEach(async () : Promise<any> => {
  if (registryHandle?.close) await registryHandle.close();
  registryHandle = null;
});

describe("lock-backed npm registry artifacts", () : any => {
  it("records the exact public Pactium resolution in the root lock", async () : Promise<any> => {
    expect(LOCK.packages[""].dependencies.pactium).toBe(PACTIUM_VERSION);
    expect(ROOT_PACTIUM_LOCK).toMatchObject({
      version: PACTIUM_VERSION,
      resolved: PACTIUM_RESOLVED,
      license: "MIT"
    });
    expect(ROOT_PACTIUM_LOCK.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/u);
  });

  it("serves synthetic bytes from a matching isolated lock and cache", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "lock-backed-pactium-synthetic-"));
    try {
      const cacheRoot: any = path.join(root, "cache");
      const token: any = String(SYNTHETIC_PACTIUM_LOCK.integrity).split(/\s+/u)
        .find((candidate?: any) : any => candidate.startsWith("sha512-"));
      expect(token).toBeTruthy();
      const digest: any = Buffer.from(token.slice("sha512-".length), "base64");
      expect(digest.byteLength).toBe(64);
      const cachePath: any = path.join(
        cacheRoot,
        "_cacache",
        "content-v2",
        "sha512",
        digest.toString("hex").slice(0, 2),
        digest.toString("hex").slice(2, 4),
        digest.toString("hex").slice(4)
      );
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      const expectedBytes: any = SYNTHETIC_TARBALL_BYTES;
      await fs.writeFile(cachePath, expectedBytes);
      const lockPath: any = path.join(root, "package-lock.json");
      await fs.writeFile(lockPath, `${JSON.stringify({
        packages: {
          "node_modules/pactium": SYNTHETIC_PACTIUM_LOCK
        }
      })}\n`);
      registryHandle = await createLockBackedNpmRegistry({
        lockPath,
        cacheRoot,
        extraTarballs: []
      });
      const origin: any = registryHandle.registry;
      expect(String(origin)).toMatch(/^http:\/\/127\.0\.0\.1:/u);

      const packument: any = await fetch(new URL("pactium", origin));
      expect(packument.status).toBe(200);
      const packumentBody: any = await packument.json();
      expect(packumentBody.versions[PACTIUM_VERSION]).toBeTruthy();

      const version: any = await fetch(new URL(`pactium/${PACTIUM_VERSION}`, origin));
      expect(version.status).toBe(200);
      const versionBody: any = await version.json();
      expect(String(versionBody.dist.tarball)).toContain(new URL(origin).host);
      expect(String(versionBody.dist.tarball)).not.toContain("registry.npmjs.org");
      expect(versionBody.dist.integrity).toBe(SYNTHETIC_PACTIUM_LOCK.integrity);

      const tarball: any = await fetch(versionBody.dist.tarball);
      expect(tarball.status).toBe(200);
      const bytes: any = Buffer.from(await tarball.arrayBuffer());
      expect(bytes).toEqual(expectedBytes);

      const missing: any = await fetch(new URL("pactium/0.7.0", origin));
      expect(missing.status).toBe(404);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a file-backed lock record before looking up the referenced archive", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "lock-backed-nonregistry-spec-"));
    try {
      const lockPath: any = path.join(root, "package-lock.json");
      await fs.writeFile(lockPath, `${JSON.stringify({
        packages: {
          "node_modules/pactium": {
            name: "pactium",
            version: PACTIUM_VERSION,
            resolved: `file:missing-pactium-${PACTIUM_VERSION}.tgz`,
            integrity: SYNTHETIC_PACTIUM_LOCK.integrity
          }
        }
      })}\n`);
      await expect(createLockBackedNpmRegistry({
        lockPath,
        cacheRoot: path.join(root, "empty-cache"),
        extraTarballs: []
      })).rejects.toThrow("npm_package_lock_registry_untrusted");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

});
