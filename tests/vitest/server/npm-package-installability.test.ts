import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createLockBackedNpmRegistry } from "../../../tools/server-scripts/lib/lock-backed-npm-registry.ts";
import {
  packInstallabilityArtifacts,
  prepareInstallabilityConsumer
} from "../../../tools/server-scripts/verify-npm-package-installability.ts";

const execFileAsync: any = promisify(execFile);
const REPO_ROOT: any = path.resolve(import.meta.dirname, "../../..");
const ROOT_LOCK: any = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package-lock.json"), "utf8"));
const PACTIUM_LOCK: any = ROOT_LOCK.packages["node_modules/pactium"];
const PACTIUM_VERSION: any = "0.8.1";
const PACTIUM_RESOLVED: any = `https://registry.npmjs.org/pactium/-/pactium-${PACTIUM_VERSION}.tgz`;

function npmEnvironment(root?: any, registry?: any) : any {
  const allowedNames: any[] = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "COMSPEC",
    "WINDIR"
  ];
  return {
    ...Object.fromEntries(allowedNames
      .filter((name?: any) : any => typeof process.env[name] === "string")
      .map((name?: any) : any => [name, process.env[name]])),
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    npm_config_cache: path.join(root, "npm-cache"),
    npm_config_userconfig: path.join(root, "npmrc"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    ...(registry ? { npm_config_registry: registry } : {})
  };
}

async function runNpm(args?: any[], cwd?: any, env?: any) : Promise<any> {
  try {
    return await execFileAsync("npm", args, { cwd, env, encoding: "utf8" });
  } catch (error: any) {
    const code: any = String(error?.code || "unknown").replace(/[^A-Za-z0-9_]+/gu, "_");
    throw new Error(`synthetic_npm_command_failed_${code}`);
  }
}

async function createSyntheticPactiumArtifact(root?: any) : Promise<any> {
  const packageDirectory: any = path.join(root, "synthetic-pactium");
  const packDirectory: any = path.join(root, "synthetic-pactium-pack");
  await fs.mkdir(packageDirectory, { recursive: true });
  await fs.mkdir(packDirectory, { recursive: true });
  await fs.writeFile(path.join(packageDirectory, "package.json"), `${JSON.stringify({
    name: "pactium",
    version: PACTIUM_VERSION,
    main: "index.js",
    license: "MIT"
  }, null, 2)}\n`);
  await fs.writeFile(path.join(packageDirectory, "index.js"), "module.exports = { version: '0.8.1' };\n");
  await fs.writeFile(path.join(packageDirectory, "LICENSE"), "MIT synthetic fixture\n");
  const environment: any = npmEnvironment(root);
  await fs.mkdir(environment.HOME, { recursive: true });
  await fs.mkdir(environment.npm_config_cache, { recursive: true });
  await fs.writeFile(environment.npm_config_userconfig, "", "utf8");
  await runNpm(
    ["pack", "--ignore-scripts", "--pack-destination", packDirectory],
    packageDirectory,
    environment
  );
  const artifacts: any[] = (await fs.readdir(packDirectory)).filter((name?: any) : any => name.endsWith(".tgz"));
  expect(artifacts).toHaveLength(1);
  const tarballPath: any = path.join(packDirectory, artifacts[0]);
  const bytes: any = await fs.readFile(tarballPath);
  const integrity: any = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  return {
    tarballPath,
    bytes,
    lockEntry: {
      name: "pactium",
      version: PACTIUM_VERSION,
      resolved: PACTIUM_RESOLVED,
      integrity,
      license: "MIT"
    }
  };
}

async function prepareRegistryFixture(root?: any, artifact?: any) : Promise<any> {
  const digest: any = Buffer.from(artifact.lockEntry.integrity.slice("sha512-".length), "base64");
  expect(digest.byteLength).toBe(64);
  const cacheRoot: any = path.join(root, "registry-cache");
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
  await fs.writeFile(cachePath, artifact.bytes);
  const lockPath: any = path.join(root, "fixture-lock.json");
  await fs.writeFile(lockPath, `${JSON.stringify({
    packages: { "node_modules/pactium": artifact.lockEntry }
  })}\n`);
  return createLockBackedNpmRegistry({ lockPath, cacheRoot, extraTarballs: [] });
}

describe("npm artifact installability source", () : any => {
  it("pins the exact public Pactium artifact in each runtime manifest and the root lock", async () : Promise<void> => {
    const rootManifest: any = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
    const foundationManifest: any = JSON.parse(await fs.readFile(
      path.join(REPO_ROOT, "packages/foundation/package.json"), "utf8"
    ));
    const runtimeManifest: any = JSON.parse(await fs.readFile(
      path.join(REPO_ROOT, "packages/server-runtime/package.json"), "utf8"
    ));
    expect(rootManifest.dependencies.pactium).toBe(PACTIUM_VERSION);
    expect(foundationManifest.dependencies.pactium).toBe(PACTIUM_VERSION);
    expect(runtimeManifest.dependencies.pactium).toBe(PACTIUM_VERSION);
    expect(ROOT_LOCK.packages[""].dependencies.pactium).toBe(PACTIUM_VERSION);
    expect(PACTIUM_LOCK).toMatchObject({
      version: PACTIUM_VERSION,
      resolved: PACTIUM_RESOLVED,
      license: "MIT"
    });
    expect(PACTIUM_LOCK.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/u);
  });

  it("rejects the unshipped file dependency and installs the synthetic registry fixture", async () : Promise<void> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-package-artifact-fixture-"));
    let registry: any = null;
    try {
      const pactiumArtifact: any = await createSyntheticPactiumArtifact(root);
      registry = await prepareRegistryFixture(root, pactiumArtifact);
      const environment: any = npmEnvironment(root, registry.registry);
      await fs.mkdir(environment.HOME, { recursive: true });
      await fs.mkdir(environment.npm_config_cache, { recursive: true });
      await fs.writeFile(environment.npm_config_userconfig, "", "utf8");

      const packageDirectory: any = path.join(root, "candidate");
      const vendorDirectory: any = path.join(packageDirectory, "vendor");
      await fs.mkdir(packageDirectory, { recursive: true });
      await fs.mkdir(vendorDirectory, { recursive: true });
      await fs.copyFile(pactiumArtifact.tarballPath, path.join(vendorDirectory, `pactium-${PACTIUM_VERSION}.tgz`));
      const candidateManifest: any = {
        name: "meshrix.js",
        version: "0.0.1",
        main: "index.js",
        files: ["index.js"],
        dependencies: { pactium: `file:vendor/pactium-${PACTIUM_VERSION}.tgz` }
      };
      await fs.writeFile(path.join(packageDirectory, "package.json"), `${JSON.stringify(candidateManifest, null, 2)}\n`);
      await fs.writeFile(path.join(packageDirectory, "index.js"), "module.exports = require('pactium');\n");

      async function packCandidate(packDirectory?: any) : Promise<any> {
        await fs.mkdir(packDirectory, { recursive: true });
        const artifacts: any[] = await packInstallabilityArtifacts({
          packageRecords: [{
            name: "meshrix.js",
            version: "0.0.1",
            absoluteDirectory: packageDirectory
          }],
          packDirectory,
          runPack: (_record?: any, destination?: any) : any => runNpm(
            ["pack", "--json", "--ignore-scripts", "--pack-destination", destination],
            packageDirectory,
            environment
          )
        });
        return artifacts[0];
      }

      const localArtifact: any = await packCandidate(path.join(root, "packed-local"));
      const localBytes: any = await fs.readFile(localArtifact.tarballPath);
      expect(localArtifact.files.some((file?: any) : any => String(file.path).startsWith("vendor/"))).toBe(false);
      const localConsumer: any = path.join(root, "consumer-local");
      await prepareInstallabilityConsumer({
        consumerDirectory: localConsumer,
        packedArtifacts: [localArtifact]
      });
      await expect(runNpm(
        ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", registry.registry],
        localConsumer,
        environment
      )).rejects.toThrow("synthetic_npm_command_failed_");
      expect(await fs.readFile(localArtifact.tarballPath)).toEqual(localBytes);

      candidateManifest.dependencies.pactium = PACTIUM_VERSION;
      await fs.writeFile(path.join(packageDirectory, "package.json"), `${JSON.stringify(candidateManifest, null, 2)}\n`);
      const registryArtifact: any = await packCandidate(path.join(root, "packed-registry"));
      const registryBytes: any = await fs.readFile(registryArtifact.tarballPath);
      const packageJsonOutput: any = await execFileAsync(
        "tar",
        ["-xOf", registryArtifact.tarballPath, "package/package.json"],
        { encoding: "utf8" }
      );
      const packedManifest: any = JSON.parse(packageJsonOutput.stdout);
      expect(packedManifest.dependencies.pactium).toBe(PACTIUM_VERSION);
      expect(registryArtifact.files.some((file?: any) : any => String(file.path).startsWith("vendor/"))).toBe(false);

      const registryConsumer: any = path.join(root, "consumer-registry");
      await prepareInstallabilityConsumer({
        consumerDirectory: registryConsumer,
        packedArtifacts: [registryArtifact]
      });
      await runNpm(
        ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", registry.registry],
        registryConsumer,
        environment
      );

      const installedCandidate: any = JSON.parse(await fs.readFile(
        path.join(registryConsumer, "node_modules/meshrix.js/package.json"), "utf8"
      ));
      const installedPactium: any = JSON.parse(await fs.readFile(
        path.join(registryConsumer, "node_modules/pactium/package.json"), "utf8"
      ));
      expect(installedCandidate.dependencies.pactium).toBe(PACTIUM_VERSION);
      expect(installedPactium.version).toBe(PACTIUM_VERSION);
      expect(installedPactium.license).toBe("MIT");
      expect(await fs.readFile(registryArtifact.tarballPath)).toEqual(registryBytes);
    } finally {
      await registry?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
