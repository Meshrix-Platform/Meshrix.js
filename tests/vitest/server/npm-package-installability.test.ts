import { execFile } from "node:child_process";
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
const PACTIUM_TARBALL: any = path.join(REPO_ROOT, "vendor/pactium-0.8.0.tgz");

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

async function prepareRegistryFixture(root?: any) : Promise<any> {
  expect(PACTIUM_LOCK.resolved).toBe("https://registry.npmjs.org/pactium/-/pactium-0.8.0.tgz");
  expect(PACTIUM_LOCK.license).toBe("GPL-3.0-or-later");
  const integrityToken: any = String(PACTIUM_LOCK.integrity).split(/\s+/u)
    .find((candidate?: any) : any => candidate.startsWith("sha512-"));
  expect(integrityToken).toBeTruthy();
  const digest: any = Buffer.from(integrityToken.slice("sha512-".length), "base64");
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
  await fs.copyFile(PACTIUM_TARBALL, cachePath);
  const lockPath: any = path.join(root, "fixture-lock.json");
  await fs.writeFile(lockPath, `${JSON.stringify({
    packages: { "node_modules/pactium": PACTIUM_LOCK }
  })}\n`);
  return createLockBackedNpmRegistry({ lockPath, cacheRoot, extraTarballs: [] });
}

describe("npm artifact installability source", () : any => {
  it("rejects the unchanged unshipped file dependency and installs the unchanged registry artifact", async () : Promise<void> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-package-artifact-fixture-"));
    let registry: any = null;
    try {
      registry = await prepareRegistryFixture(root);
      const environment: any = npmEnvironment(root, registry.registry);
      await fs.mkdir(environment.HOME, { recursive: true });
      await fs.mkdir(environment.npm_config_cache, { recursive: true });
      await fs.writeFile(environment.npm_config_userconfig, "", "utf8");

      const packageDirectory: any = path.join(root, "candidate");
      const vendorDirectory: any = path.join(packageDirectory, "vendor");
      await fs.mkdir(packageDirectory, { recursive: true });
      await fs.mkdir(vendorDirectory, { recursive: true });
      await fs.copyFile(PACTIUM_TARBALL, path.join(vendorDirectory, "pactium-0.8.0.tgz"));
      const candidateManifest: any = {
        name: "meshrix.js",
        version: "0.0.1",
        main: "index.js",
        files: ["index.js"],
        dependencies: { pactium: "file:vendor/pactium-0.8.0.tgz" }
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

      candidateManifest.dependencies.pactium = "0.8.0";
      await fs.writeFile(path.join(packageDirectory, "package.json"), `${JSON.stringify(candidateManifest, null, 2)}\n`);
      const registryArtifact: any = await packCandidate(path.join(root, "packed-registry"));
      const registryBytes: any = await fs.readFile(registryArtifact.tarballPath);
      const packageJsonOutput: any = await execFileAsync(
        "tar",
        ["-xOf", registryArtifact.tarballPath, "package/package.json"],
        { encoding: "utf8" }
      );
      const packedManifest: any = JSON.parse(packageJsonOutput.stdout);
      expect(packedManifest.dependencies.pactium).toBe("0.8.0");
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
      expect(installedCandidate.dependencies.pactium).toBe("0.8.0");
      expect(installedPactium.version).toBe("0.8.0");
      expect(installedPactium.license).toBe("GPL-3.0-or-later");
      expect(await fs.readFile(registryArtifact.tarballPath)).toEqual(registryBytes);
    } finally {
      await registry?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
