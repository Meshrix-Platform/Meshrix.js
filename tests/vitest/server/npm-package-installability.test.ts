import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { assertNoLeak } from "../../../tools/server-scripts/lib/report-evidence-safety.ts";

import { scanPublicArtifact, scanPublicArtifactFiles } from "../../../tools/server-scripts/lib/public-artifact-boundary.ts";

import { createLockBackedNpmRegistry } from "../../../tools/server-scripts/lib/lock-backed-npm-registry.ts";
import {
  assertPreparedProductBundleClosure,
  bundledPackageNamesInArtifact,
  failureCode,
  listInstallabilityTarballFiles,
  prepareInstallabilityConsumer
} from "../../../tools/server-scripts/verify-npm-package-installability.ts";
import {
  consumerFailureSummary,
  verifyInstalledModuleIdentity,
  browserForServer,
  packageTypeSpecifiers,
  NPM_PACKAGE_CONSUMER_FAILURE_CODES,
  NPM_PACKAGE_CONSUMER_FAILURE_STAGES
} from "../../../tools/server-scripts/npm-package-consumer.ts";

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
    const result = await execFileAsync("npm", args, { cwd, env, encoding: "utf8" });
    return result;
  } catch (error: any) {
    const code: any = String(error?.code || "unknown").replace(/[^A-Za-z0-9_]+/gu, "_");
    throw new Error(`synthetic_npm_command_failed_${code}`);
  }
}

async function createSyntheticArtifact(root?: any, { name = "pactium", version = PACTIUM_VERSION, dependencies = {}, main = "index.js", index = "module.exports = { version: '0.8.1' };\n", scripts = {}, bundledPackages = {}, license = name === "pactium" ? "MIT" : "Apache-2.0" }: Record<string, any> = {}) : Promise<any> {
  const packageDirectory: any = path.join(root, `synthetic-${name.replace(/[^a-z0-9]+/giu, "-")}-${version}`);
  const packDirectory: any = path.join(root, `synthetic-${name.replace(/[^a-z0-9]+/giu, "-")}-${version}-pack`);
  await fs.mkdir(packageDirectory, { recursive: true });
  await fs.mkdir(packDirectory, { recursive: true });
  await fs.writeFile(path.join(packageDirectory, "package.json"), `${JSON.stringify({
    name,
    version,
    main,
    license,
    dependencies,
    ...(Object.keys(bundledPackages).length ? { bundleDependencies: Object.keys(bundledPackages) } : {}),
    scripts
  }, null, 2)}\n`);
  await fs.writeFile(path.join(packageDirectory, main), index);
  for (const [bundledName, version] of Object.entries(bundledPackages)) {
    const bundledDirectory = path.join(packageDirectory, "node_modules", bundledName);
    await fs.mkdir(bundledDirectory, { recursive: true });
    await fs.writeFile(path.join(bundledDirectory, "package.json"), JSON.stringify({ name: bundledName, version, main: "index.js" }));
    await fs.writeFile(path.join(bundledDirectory, "index.js"), "module.exports = { bundled: true };\n");
  }
  await fs.writeFile(path.join(packageDirectory, "LICENSE"), `${license} synthetic fixture\n`);
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
      license
    }
  };
}

describe("npm artifact installability source", () : any => {
  it("checks declaration exports without treating a stylesheet as a TypeScript namespace", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "packages/ui-console/package.json"), "utf8"));
    const specifiers = packageTypeSpecifiers(manifest);
    expect(specifiers).toHaveLength(15);
    expect(specifiers).toContain("@meshrix/ui-console/binary-checkbox");
    expect(specifiers).not.toContain("@meshrix/ui-console/styles.css");
    expect(packageTypeSpecifiers({ name: "fixture", exports: { "./style": { types: "./style.d.ts", default: "./style.css" } } }))
      .toEqual(["fixture/style"]);
  });
  it("installs registry products with private bundled dependencies without fetching them separately", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-bundle-registry-"));
    let registry: any;
    try {
      const artifact = await createSyntheticArtifact(root, {
        name: "meshrix.js", version: "0.0.1",
        dependencies: { "@meshrix/contracts": "0.0.1" },
        bundledPackages: { "@meshrix/contracts": "0.0.1" },
        index: "module.exports = require('@meshrix/contracts');\n"
      });
      const lockPath = path.join(root, "lock.json");
      await fs.writeFile(lockPath, JSON.stringify({ packages: {} }));
      registry = await createLockBackedNpmRegistry({ lockPath, cacheRoot: path.join(root, "cache"), extraTarballs: [
        { name: "meshrix.js", version: "0.0.1", tarballPath: artifact.tarballPath }
      ] });
      expect((await fetch(new URL("@meshrix%2Fcontracts", registry.registry))).status).toBe(404);
      const consumer = path.join(root, "consumer");
      await prepareInstallabilityConsumer({ consumerDirectory: consumer, packageRecord: { name: "meshrix.js", version: "0.0.1" } });
      const env = npmEnvironment(root, registry.registry);
      await runNpm(["install", "--no-audit", "--no-fund", "--registry", registry.registry], consumer, env);
      const result = await execFileAsync(process.execPath, ["-e", "process.stdout.write(String(require('meshrix.js').bundled))"], { cwd: consumer, env });
      expect(result.stdout).toBe("true");
    } finally { await registry?.close(); await fs.rm(root, { recursive: true, force: true }); }
  }, 30000);

  it("walks admitted generated directories and scans contents without admitting neighboring outputs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-generated-directory-"));
    try {
      await fs.mkdir(path.join(root, "build/dist"), { recursive: true });
      await fs.mkdir(path.join(root, "build/reports"), { recursive: true });
      const credential = ["Bearer", "synthetic".repeat(3)].join(" ");
      await fs.writeFile(path.join(root, "build/dist/index.html"), credential);
      await fs.writeFile(path.join(root, "build/reports/runtime.json"), "{}");
      const scan = await scanPublicArtifact(root, { allowedGeneratedOutputPrefixes: ["build/dist"] });
      expect(scan.summary.scannedTextFileCount).toBe(1);
      expect(scan.findings.map(({ relativePath, ruleId }: { relativePath: string; ruleId: string }) => ({ relativePath, ruleId })))
        .toEqual([{ relativePath: "build/dist/index.html", ruleId: "bearer_credential" }, { relativePath: "build/reports", ruleId: "generated_or_local_output" }]);
      expect(JSON.stringify(scan)).not.toContain(credential);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each([".map", ".mts", ".cts", ".ps1", ".cmd", ".bat"])("scans credential material in delivered %s text", async (extension) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-delivered-text-"));
    try {
      const name = `fixture${extension}`;
      const credential = ["Bearer", "synthetic".repeat(3)].join(" ");
      await fs.writeFile(path.join(root, name), JSON.stringify({ synthetic: credential }));
      const report = await scanPublicArtifactFiles(root, [name]);
      expect(report.ok).toBe(false);
      expect(report.findings).toMatchObject([{ relativePath: name, ruleId: "bearer_credential" }]);
      expect(JSON.stringify(report)).not.toContain(credential);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("retains browser same-origin evidence without recording private endpoints", async () => {
    const origin = "http://127.0.0.1:4173";
    const callbacks = new Map<string, (value: any) => void>();
    const page = {
      on(event: string, callback: (value: any) => void) { callbacks.set(event, callback); },
      async goto() { callbacks.get("request")?.({ url: () => `${origin}/asset.js` }); },
      async evaluate() { return origin; },
      async close() {}
    };
    const evidence = await browserForServer({ async newPage() { return page; } }, origin);
    expect(evidence).toEqual({ sameOrigin: true, requestOriginCount: 1, pageErrors: 0 });
    expect(() => assertNoLeak(evidence, "browser evidence")).not.toThrow();
    expect(JSON.stringify(evidence)).not.toContain(origin);
    page.evaluate = async () => "https://example.com";
    await expect(browserForServer({ async newPage() { return page; } }, origin)).rejects.toThrow("npm_package_console_cross_origin_asset");
  });

  it("checks installed root and private component module identity through normal Node resolution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-module-identity-"));
    const foundation = path.join(root, "node_modules/@meshrix/foundation");
    const runtime = path.join(root, "node_modules/@meshrix/server-runtime");
    const registry = "@meshrix/foundation/security/authorization/tag-store-provider-registry";
    const alias = "#meshrix/foundation/security/authorization/tag-store-provider-registry";
    try {
      await fs.mkdir(foundation, { recursive: true });
      await fs.mkdir(runtime, { recursive: true });
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
        name: "meshrix.js", type: "module", bundleDependencies: ["@meshrix/foundation", "@meshrix/server-runtime"],
        imports: { [alias]: { source: "./unused-source.ts", default: registry } }
      }));
      await fs.writeFile(path.join(foundation, "package.json"), JSON.stringify({
        name: "@meshrix/foundation", type: "module", exports: { "./security/authorization/tag-store-provider-registry": "./registry.js" }
      }));
      await fs.writeFile(path.join(foundation, "registry.js"), "export const registry = new Map();\n");
      await fs.writeFile(path.join(runtime, "package.json"), JSON.stringify({ name: "@meshrix/server-runtime", type: "module", imports: { [alias]: registry } }));
      await expect(verifyInstalledModuleIdentity(root)).resolves.toEqual({ aliasCount: 2, componentCount: 2, sharedRegistry: true });
      await fs.cp(foundation, path.join(runtime, "node_modules/@meshrix/foundation"), { recursive: true });
      await expect(verifyInstalledModuleIdentity(root)).rejects.toThrow("npm_package_module_identity_mismatch");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("scans admitted ESM and usage-skill content without admitting unrelated build output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-artifact-content-"));
    try {
      const paths = ["adapter.mjs", "build/usage-skills/example/SKILL.md", "build/reports/runtime.json"];
      for (const name of paths) {
        await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await fs.writeFile(path.join(root, name), "synthetic public content\n");
      }
      const options = { allowedGeneratedOutputPrefixes: ["build/usage-skills"] };
      expect(await scanPublicArtifactFiles(root, paths.slice(0, 2), options)).toMatchObject({
        ok: true, summary: { scannedTextFileCount: 2 }
      });
      const credential = ["Bearer", "synthetic".repeat(3)].join(" ");
      await fs.writeFile(path.join(root, paths[0]), `export const credential = ${JSON.stringify(credential)};\n`);
      await fs.writeFile(path.join(root, paths[1]), credential);
      const rejected = await scanPublicArtifactFiles(root, paths, options);
      expect(rejected.ok).toBe(false);
      expect(rejected.findings.map(({ relativePath, ruleId }: { relativePath: string; ruleId: string }) => ({ relativePath, ruleId }))).toEqual([
        { relativePath: paths[0], ruleId: "bearer_credential" },
        { relativePath: paths[2], ruleId: "generated_or_local_output" },
        { relativePath: paths[1], ruleId: "bearer_credential" }
      ]);
      expect(JSON.stringify(rejected)).not.toContain(credential);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("bounds consumer and controller failure diagnostics to published codes and stages", () : void => {
    expect(consumerFailureSummary(new Error("npm_package_unapproved_diagnostic_test_only"))).toEqual({
      success: false,
      errorCode: "npm_package_consumer_failed"
    });
    expect(consumerFailureSummary(new Error("npm_package_console_asset_failed"))).toEqual({
      success: false,
      errorCode: "npm_package_console_asset_failed"
    });
    expect(consumerFailureSummary(Object.assign(new Error("npm install failed"), {
      stderr: "npm ERR! code ERESOLVE"
    }))).toEqual({
      success: false,
      errorCode: "npm_package_dependency_resolution_failed"
    });
    expect(consumerFailureSummary({ stderr: "npm error code E404" })).toEqual({
      success: false, errorCode: "npm_package_registry_package_missing"
    });
    expect(consumerFailureSummary({ stderr: "npm warn ERESOLVE overriding peer dependency\nERR_PACKAGE_IMPORT_NOT_DEFINED" })).toEqual({
      success: false, errorCode: "npm_package_module_resolution_failed"
    });
    expect(NPM_PACKAGE_CONSUMER_FAILURE_STAGES.has("ui_browser")).toBe(true);
    expect(NPM_PACKAGE_CONSUMER_FAILURE_STAGES.has("private_diagnostic_test_only")).toBe(false);
    expect(failureCode(new Error("npm_package_unapproved_diagnostic_test_only")))
      .toBe("npm_package_installability_failed");
    expect(failureCode(new Error("npm_package_consumer_runtime_failed")))
      .toBe("npm_package_consumer_runtime_failed");
    expect(NPM_PACKAGE_CONSUMER_FAILURE_CODES.has("npm_package_consumer_runtime_failed")).toBe(false);
    expect(NPM_PACKAGE_CONSUMER_FAILURE_CODES.has("npm_package_mcp_proxy_failed")).toBe(true);
  });

  it("accepts exactly the private packages explicitly bundled by the two public products", async () : Promise<void> => {
    const rootPackage: any = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
    const gatewayManifest: any = JSON.parse(await fs.readFile(
      path.join(REPO_ROOT, "packages/gateway/package.json"), "utf8"
    ));
    const releaseSet: any = {
      version: rootPackage.version,
      packages: [
        { name: "@meshrix/gateway", version: gatewayManifest.version, directory: "packages/gateway", root: false },
        { name: rootPackage.name, version: rootPackage.version, directory: ".", root: true }
      ]
    };
    const bundleFiles = (manifest?: any) : string[] => [
      "package.json",
      "LICENSE",
      ...manifest.bundleDependencies.flatMap((name?: any) : string[] => [
        `node_modules/${name}/package.json`,
        `node_modules/${name}/LICENSE`
      ]),
      ...(manifest.name === rootPackage.name ? ["THIRD_PARTY_NOTICES.md"] : [])
    ];
    const artifacts: any[] = [
      {
        name: gatewayManifest.name,
        version: gatewayManifest.version,
        manifest: gatewayManifest,
        files: bundleFiles(gatewayManifest)
      },
      {
        name: rootPackage.name,
        version: rootPackage.version,
        manifest: rootPackage,
        files: bundleFiles(rootPackage)
      }
    ];

    await expect(assertPreparedProductBundleClosure({
      rootDir: REPO_ROOT,
      rootPackage,
      releaseSet,
      packedArtifacts: artifacts
    })).resolves.toMatchObject({
      publicPackageCount: 2,
      privateWorkspaceCount: rootPackage.bundleDependencies.length,
      bundledPackageCountByProduct: {
        "@meshrix/gateway": gatewayManifest.bundleDependencies.length,
        "meshrix.js": rootPackage.bundleDependencies.length
      }
    });
    expect(bundledPackageNamesInArtifact([
      "node_modules/@meshrix/contracts/package.json",
      "node_modules/@meshrix/contracts/LICENSE"
    ])).toEqual(["@meshrix/contracts"]);
    expect(bundledPackageNamesInArtifact([
      "node_modules/@meshrix/contracts/package.json",
      "node_modules/@meshrix/unlisted/package.json"
    ])).toEqual(["@meshrix/contracts", "@meshrix/unlisted"]);
    expect(() => bundledPackageNamesInArtifact([
      "node_modules/@meshrix/contracts/node_modules/hidden/package.json"
    ])).toThrow("npm_package_bundled_package_path_invalid");

    const undeclaredBundle: any = {
      ...artifacts[1],
      files: [...artifacts[1].files, "node_modules/@meshrix/unlisted/package.json"]
    };
    await expect(assertPreparedProductBundleClosure({
      rootDir: REPO_ROOT,
      rootPackage,
      releaseSet,
      packedArtifacts: [artifacts[0], undeclaredBundle]
    })).rejects.toThrow("npm_package_bundled_packages_mismatch");
  });

  it("pins the root-owned Pactium artifact and declares it as a peer for each private runtime module", async () : Promise<void> => {
    const rootManifest: any = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
    const foundationManifest: any = JSON.parse(await fs.readFile(
      path.join(REPO_ROOT, "packages/foundation/package.json"), "utf8"
    ));
    const runtimeManifest: any = JSON.parse(await fs.readFile(
      path.join(REPO_ROOT, "packages/server-runtime/package.json"), "utf8"
    ));
    expect(rootManifest.dependencies.pactium).toBe(PACTIUM_VERSION);
    expect(foundationManifest.peerDependencies.pactium).toBe(PACTIUM_VERSION);
    expect(runtimeManifest.peerDependencies.pactium).toBe(PACTIUM_VERSION);
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
      expect(await listInstallabilityTarballFiles(internalArtifact.tarballPath)).toEqual(
        expect.arrayContaining(["package.json", "index.js", "LICENSE"])
      );
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
        packageRecord: { name: "meshrix.js", version: "0.0.2" },
        allowScripts: { "meshrix.js": true }
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
