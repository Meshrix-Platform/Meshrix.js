import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLockBackedNpmRegistry,
  rewritePackedVendoredFileDependencies
} from "../../../tools/server-scripts/lib/lock-backed-npm-registry.ts";

const REPO_ROOT: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const VENDOR_TARBALL: any = path.join(REPO_ROOT, "vendor/pactium-0.8.0.tgz");
const LOCK: any = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package-lock.json"), "utf8"));
const PACTIUM_LOCK: any = LOCK.packages["node_modules/pactium"];

let registryHandle: any = null;

afterEach(async () : Promise<any> => {
  if (registryHandle?.close) await registryHandle.close();
  registryHandle = null;
});

describe("lock-backed npm registry file: packages", () : any => {
  it("serves lock-vendored pactium 0.8.0 from the local mirror without a public npmjs hit", async () : Promise<any> => {
    expect(PACTIUM_LOCK.version).toBe("0.8.0");
    expect(String(PACTIUM_LOCK.resolved)).toMatch(/^file:/u);
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "lock-backed-pactium-"));
    try {
      await fs.copyFile(VENDOR_TARBALL, path.join(root, "pactium-0.8.0.tgz"));
      const lockPath: any = path.join(root, "package-lock.json");
      await fs.writeFile(lockPath, `${JSON.stringify({
        packages: {
          "node_modules/pactium": {
            name: "pactium",
            version: "0.8.0",
            resolved: "file:pactium-0.8.0.tgz",
            integrity: PACTIUM_LOCK.integrity
          }
        }
      })}\n`);
      const cacheRoot: any = path.join(root, "cache");
      await fs.mkdir(cacheRoot);
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
      expect(packumentBody.versions["0.8.0"]).toBeTruthy();

      const version: any = await fetch(new URL("pactium/0.8.0", origin));
      expect(version.status).toBe(200);
      const versionBody: any = await version.json();
      expect(String(versionBody.dist.tarball)).toContain(new URL(origin).host);
      expect(String(versionBody.dist.tarball)).not.toContain("registry.npmjs.org");

      const tarball: any = await fetch(versionBody.dist.tarball);
      expect(tarball.status).toBe(200);
      const bytes: any = Buffer.from(await tarball.arrayBuffer());
      expect(bytes.byteLength).toBeGreaterThan(0);

      const missing: any = await fetch(new URL("pactium/0.7.0", origin));
      expect(missing.status).toBe(404);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rewrites packed file:vendor specs to lock versions so the local mirror can serve them", async () : Promise<any> => {
    const execFileAsync: any = promisify(execFile);
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "lock-backed-rewrite-"));
    try {
      const packageRoot: any = path.join(root, "package");
      await fs.mkdir(packageRoot);
      await fs.writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify({
        name: "meshrix.js",
        version: "0.0.1",
        dependencies: {
          pactium: "file:vendor/pactium-0.8.0.tgz"
        }
      }, null, 2)}\n`);
      const tarballPath: any = path.join(root, "packed.tgz");
      await execFileAsync("tar", ["-czf", tarballPath, "-C", root, "package"]);
      expect(await rewritePackedVendoredFileDependencies(tarballPath)).toBe(true);
      const extractRoot: any = path.join(root, "extracted");
      await fs.mkdir(extractRoot);
      await execFileAsync("tar", ["-xzf", tarballPath, "-C", extractRoot]);
      const rewritten: any = JSON.parse(
        await fs.readFile(path.join(extractRoot, "package", "package.json"), "utf8")
      );
      expect(rewritten.dependencies.pactium).toBe("0.8.0");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
