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
    npm_config_ignore_scripts: "false",
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

async function createSyntheticArtifact(root?: any, { name = "pactium", version = PACTIUM_VERSION, dependencies = {}, main = "index.js", index = "module.exports = { version: '0.8.1' };\n", scripts = {} }: Record<string, any> = {}) : Promise<any> {
  const packageDirectory: any = path.join(root, `synthetic-${name.replace(/[^a-z0-9]+/giu, "-")}-${version}`);
  const packDirectory: any = path.join(root, `synthetic-${name.replace(/[^a-z0-9]+/giu, "-")}-${version}-pack`);
  await fs.mkdir(packageDirectory, { recursive: true });
  await fs.mkdir(packDirectory, { recursive: true });
  await fs.writeFile(path.join(packageDirectory, "package.json"), `${JSON.stringify({
    name,
    version,
    main,
    license: "MIT",
    dependencies,
    scripts
  }, null, 2)}\n`);
  await fs.writeFile(path.join(packageDirectory, main), index);
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
      name,
      version,
      resolved: PACTIUM_RESOLVED,
      integrity,
      license: "MIT"
    }
  };
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

  it("detects undeclared internal dependencies while installing one unchanged artifact from the registry", async () : Promise<void> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-package-artifact-fixture-"));
    let registry: any = null;
    try {
      const internalArtifact: any = await createSyntheticArtifact(root, {
        name: "@meshrix/contracts",
        version: "0.0.1",
        index: "module.exports = { contractVersion: '0.0.1' };\n"
      });
      const undeclaredRootArtifact: any = await createSyntheticArtifact(root, {
        name: "meshrix.js",
        version: "0.0.1",
        index: "module.exports = require('@meshrix/contracts');\n"
      });
      const declaredRootArtifact: any = await createSyntheticArtifact(root, {
        name: "meshrix.js",
        version: "0.0.2",
        dependencies: { "@meshrix/contracts": "0.0.1" },
        index: "module.exports = require('@meshrix/contracts');\n",
        scripts: {
          postinstall: "node -e \"require('@meshrix/contracts'); require('node:fs').writeFileSync('postinstall-ran','yes')\""
        }
      });
      const registryCache: any = path.join(root, "registry-cache");
      const fixtureLockPath: any = path.join(root, "fixture-lock.json");
      const digest: any = Buffer.from(declaredRootArtifact.lockEntry.integrity.slice("sha512-".length), "base64");
      const digestHex: any = digest.toString("hex");
      const cachedArtifactPath: any = path.join(
        registryCache,
        "_cacache",
        "content-v2",
        "sha512",
        digestHex.slice(0, 2),
        digestHex.slice(2, 4),
        digestHex.slice(4)
      );
      await fs.mkdir(path.dirname(cachedArtifactPath), { recursive: true });
      await fs.writeFile(cachedArtifactPath, declaredRootArtifact.bytes);
      await fs.writeFile(fixtureLockPath, `${JSON.stringify({
        packages: {
          "node_modules/meshrix.js": {
            ...declaredRootArtifact.lockEntry,
            resolved: "https://registry.npmjs.org/meshrix.js/-/meshrix.js-0.0.2.tgz",
            hasInstallScript: true,
            dependencies: { "@meshrix/contracts": "0.0.1" }
          }
        }
      })}\n`);
      registry = await createLockBackedNpmRegistry({
        lockPath: fixtureLockPath,
        cacheRoot: registryCache,
        extraTarballs: [
          ...[internalArtifact, undeclaredRootArtifact, declaredRootArtifact].map((artifact?: any) : any => ({
            name: artifact.lockEntry.name,
            version: artifact.lockEntry.version,
            tarballPath: artifact.tarballPath
          }))
        ]
      });
      const environment: any = npmEnvironment(root, registry.registry);
      await fs.mkdir(environment.HOME, { recursive: true });
      await fs.mkdir(environment.npm_config_cache, { recursive: true });
      await fs.writeFile(environment.npm_config_userconfig, "", "utf8");

      const internalPackageVersion: any = await fetch(new URL("@meshrix%2Fcontracts/0.0.1", registry.registry));
      expect(internalPackageVersion.status).toBe(200);
      const registryMetadata: any = await internalPackageVersion.json();
      expect(registryMetadata).toMatchObject({
        name: "@meshrix/contracts",
        version: "0.0.1",
        dist: { integrity: internalArtifact.lockEntry.integrity }
      });
      const installableRootMetadata: any = await fetch(new URL("meshrix.js/0.0.2", registry.registry));
      expect(await installableRootMetadata.json()).toMatchObject({ hasInstallScript: true });
      const undeclaredConsumer: any = path.join(root, "consumer-undeclared");
      await prepareInstallabilityConsumer({
        consumerDirectory: undeclaredConsumer,
        packageRecord: { name: "meshrix.js", version: "0.0.1" }
      });
      await runNpm(
        ["install", "--no-audit", "--no-fund", "--registry", registry.registry],
        undeclaredConsumer,
        environment
      );
      await expect(runNpm(
        ["exec", "--offline", "--", "node", "-e", "require('meshrix.js')"],
        undeclaredConsumer,
        environment
      )).rejects.toThrow("synthetic_npm_command_failed_");
      await expect(fs.access(path.join(undeclaredConsumer, "node_modules", "@meshrix", "contracts")))
        .rejects.toMatchObject({ code: "ENOENT" });

      const declaredConsumer: any = path.join(root, "consumer-declared");
      await prepareInstallabilityConsumer({
        consumerDirectory: declaredConsumer,
        packageRecord: { name: "meshrix.js", version: "0.0.2" }
      });
      await runNpm(
        ["install", "--no-audit", "--no-fund", "--registry", registry.registry],
        declaredConsumer,
        environment
      );
      const installedPactium: any = JSON.parse(await fs.readFile(
        path.join(declaredConsumer, "node_modules/@meshrix/contracts/package.json"), "utf8"
      ));
      expect(installedPactium.version).toBe("0.0.1");
      expect(await runNpm(
        ["exec", "--offline", "--", "node", "-e", "process.stdout.write(require('meshrix.js').contractVersion)"],
        declaredConsumer,
        environment
      )).toMatchObject({ stdout: "0.0.1" });
      expect(await fs.readFile(
        path.join(declaredConsumer, "node_modules/meshrix.js/postinstall-ran"),
        "utf8"
      )).toBe("yes");
      expect(JSON.parse(await fs.readFile(path.join(declaredConsumer, "node_modules/meshrix.js/package.json"), "utf8")))
        .toMatchObject({ name: "meshrix.js", version: "0.0.2", dependencies: { "@meshrix/contracts": "0.0.1" } });
    } finally {
      await registry?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
