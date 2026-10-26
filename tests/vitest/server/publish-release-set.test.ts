import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createNpmRunner,
  discoverReleaseSet,
  loadPreparedReleaseSet,
  parsePublishArguments,
  PREPARED_RELEASE_SET_FILENAME,
  prepareReleaseSet,
  publishReleaseSet,
  releaseTagForVersion
} from "../../../tools/server-scripts/publish-release-set.ts";
import { resolveReleaseWorkspaceDirectories } from "../../../tools/server-scripts/lib/release-metadata.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const ARTIFACT_DIRECTORIES: string[] = [];

afterEach(async () => {
  await Promise.all(ARTIFACT_DIRECTORIES.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

function archiveBytesFor(name: string) {
  return Buffer.from(`fixture:${name}`);
}

function integrityFor(name: string) {
  return `sha512-${createHash("sha512").update(archiveBytesFor(name)).digest("base64")}`;
}

function filenameFor(name: string, version: string) {
  return `${name.replace(/^@/u, "").replace(/\//gu, "-")}-${version}.tgz`;
}

function releaseSpec(name: string, version: string) {
  return `${name}@${version}`;
}

async function newArtifactDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-release-fixture-"));
  ARTIFACT_DIRECTORIES.push(directory);
  return directory;
}

function createInjectedNpmRunner({
  published = new Map<string, string>(),
  packFilesByName = {}
}: {
  published?: Map<string, string>;
  packFilesByName?: Record<string, Array<{ path: string }>>;
} = {}) {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const publishCalls: Array<{ args: string[]; name: string }> = [];
  const packedNames: string[] = [];
  const archivePackCalls: Array<{ name: string; cwd?: string; packageDirectory: string }> = [];
  const bundledModules: Array<{ name: string; version: string; private: boolean }> = [];
  const tarballs = new Map<string, { name: string; version: string; integrity: string }>();

  const runner = async (args: string[], { cwd }: { cwd?: string } = {}) => {
    calls.push({ args: [...args], cwd });
    if (args[0] === "pack") {
      const dryRun = args.includes("--dry-run");
      const destinationIndex = args.indexOf("--pack-destination");
      const sourceDirectory = args.at(-1);
      const packageDirectory = destinationIndex >= 0 && destinationIndex + 2 < args.length
        ? sourceDirectory!
        : dryRun
          ? sourceDirectory!
          : cwd!;
      if (destinationIndex >= 0 && !dryRun) {
        archivePackCalls.push({ name: "", cwd, packageDirectory });
      }
      const manifest = JSON.parse(await fs.readFile(path.join(packageDirectory, "package.json"), "utf8"));
      if (destinationIndex >= 0 && !dryRun) archivePackCalls.at(-1)!.name = manifest.name;
      const filename = filenameFor(manifest.name, manifest.version);
      const files = packFilesByName[manifest.name] || [{ path: "package.json" }];
      const artifact = {
        name: manifest.name,
        version: manifest.version,
        filename,
        integrity: integrityFor(manifest.name),
        files,
        bundled: manifest.bundleDependencies || manifest.bundledDependencies || []
      };
      if (dryRun) return { exitCode: 0, stdout: JSON.stringify([artifact]), stderr: "" };

      const destination = args[destinationIndex + 1];
      const archivePath = path.join(destination, filename);
      try {
        const bundleManifest = JSON.parse(await fs.readFile(
          path.join(cwd!, "node_modules/@meshrix/contracts/package.json"),
          "utf8"
        ));
        bundledModules.push({
          name: bundleManifest.name,
          version: bundleManifest.version,
          private: bundleManifest.private
        });
      } catch {
        // This public workspace does not consume the private test module.
      }
      await fs.writeFile(archivePath, archiveBytesFor(manifest.name));
      tarballs.set(archivePath, {
        name: manifest.name,
        version: manifest.version,
        integrity: integrityFor(manifest.name)
      });
      packedNames.push(manifest.name);
      return { exitCode: 0, stdout: JSON.stringify([artifact]), stderr: "" };
    }

    if (args[0] === "view") {
      const integrity = published.get(args[1]);
      return integrity === undefined
        ? { exitCode: 1, stdout: "", stderr: "npm error code E404" }
        : { exitCode: 0, stdout: JSON.stringify(integrity), stderr: "" };
    }

    if (args[0] === "publish") {
      const archive = tarballs.get(args[1]);
      if (!archive) return { exitCode: 1, stdout: "", stderr: "fixture archive missing" };
      publishCalls.push({ args: [...args], name: archive.name });
      published.set(releaseSpec(archive.name, archive.version), archive.integrity);
      return { exitCode: 0, stdout: "+ fixture", stderr: "" };
    }

    return { exitCode: 1, stdout: "", stderr: "fixture unsupported command" };
  };

  return { calls, publishCalls, packedNames, archivePackCalls, bundledModules, published, runner };
}

async function prepareFixtures(injected: ReturnType<typeof createInjectedNpmRunner>) {
  const artifactDirectory = await newArtifactDirectory();
  await prepareReleaseSet({ rootDir: ROOT, artifactDirectory, runner: injected.runner, environment: {} });
  return artifactDirectory;
}

async function newBundleFixture() {
  const rootDir = await newArtifactDirectory();
  const workspaceDirectories = ["packages/gateway", "packages/contracts"];
  await fs.writeFile(path.join(rootDir, "package.json"), JSON.stringify({
    name: "meshrix.js",
    version: "1.2.3",
    workspaces: workspaceDirectories,
    dependencies: { "@meshrix/gateway": "1.2.3", "@meshrix/contracts": "1.2.3" },
    bundleDependencies: ["@meshrix/contracts"]
  }));
  await fs.mkdir(path.join(rootDir, "packages/gateway"), { recursive: true });
  await fs.mkdir(path.join(rootDir, "packages/contracts"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "packages/gateway/package.json"), JSON.stringify({
    name: "@meshrix/gateway",
    version: "1.2.3",
    dependencies: { "@meshrix/contracts": "1.2.3" },
    bundleDependencies: ["@meshrix/contracts"]
  }));
  await fs.writeFile(path.join(rootDir, "packages/contracts/package.json"), JSON.stringify({
    name: "@meshrix/contracts",
    version: "1.2.3",
    private: true
  }));
  return rootDir;
}

async function newReleaseDiscoveryFixture({
  rootDependencies = { "@meshrix/gateway": "1.2.3" },
  rootBundleDependencies = [],
  packages = []
}: {
  rootDependencies?: Record<string, string>;
  rootBundleDependencies?: string[];
  packages?: Array<{ directory: string; manifest: Record<string, unknown> }>;
} = {}) {
  const rootDir = await newArtifactDirectory();
  const workspacePackages = [
    {
      directory: "packages/gateway",
      manifest: { name: "@meshrix/gateway", version: "1.2.3", dependencies: {} }
    },
    {
      directory: "packages/contracts",
      manifest: { name: "@meshrix/contracts", version: "1.2.3", private: true }
    },
    ...packages
  ];
  await fs.writeFile(path.join(rootDir, "package.json"), JSON.stringify({
    name: "meshrix.js",
    version: "1.2.3",
    workspaces: workspacePackages.map(({ directory }) => directory),
    dependencies: rootDependencies,
    bundleDependencies: rootBundleDependencies
  }));
  for (const { directory, manifest } of workspacePackages) {
    const packageDirectory = path.join(rootDir, directory);
    await fs.mkdir(packageDirectory, { recursive: true });
    await fs.writeFile(path.join(packageDirectory, "package.json"), JSON.stringify(manifest));
  }
  return rootDir;
}

describe("npm release-set publication", () => {
  it("discovers public workspaces in dependency order and preserves the prepared archive API", async () => {
    const releaseSet = await discoverReleaseSet({ rootDir: ROOT });
    expect(releaseSet.packages.map(({ name }: { name: string }) => name))
      .toEqual(["@meshrix/gateway", "meshrix.js"]);

    const injected = createInjectedNpmRunner();
    const artifactDirectory = await prepareFixtures(injected);
    const prepared = await loadPreparedReleaseSet({ rootDir: ROOT, artifactDirectory });
    const manifest = JSON.parse(await fs.readFile(path.join(artifactDirectory, PREPARED_RELEASE_SET_FILENAME), "utf8"));

    expect(prepared.packages).toHaveLength(2);
    expect(manifest.packages.map(({ name }: { name: string }) => name))
      .toEqual(["@meshrix/gateway", "meshrix.js"]);
    expect(prepared.packages.every(({ integrity }: { integrity: string }) => integrity.startsWith("sha512-")))
      .toBe(true);
    expect(injected.packedNames).toEqual(["@meshrix/gateway", "meshrix.js"]);
    const rootArchive = prepared.packages.find(({ name }: { name: string }) => name === "meshrix.js")!;
    expect(await fs.readFile(rootArchive.tarballPath, "utf8")).toBe("fixture:meshrix.js");
    expect(JSON.stringify(manifest)).not.toContain(artifactDirectory);
  });

  it("bundles private runtime dependencies into the public archive set", async () => {
    const rootDir = await newBundleFixture();
    const injected = createInjectedNpmRunner();
    const artifactDirectory = await newArtifactDirectory();
    const prepared = await prepareReleaseSet({ rootDir, artifactDirectory, runner: injected.runner, environment: {} });

    expect(prepared.packages.map(({ name }: { name: string }) => name))
      .toEqual(["@meshrix/gateway", "meshrix.js"]);
    expect(injected.packedNames).toEqual(["@meshrix/gateway", "meshrix.js"]);
    expect(injected.bundledModules).toEqual([
      { name: "@meshrix/contracts", version: "1.2.3", private: true }
    ]);
    expect(injected.calls.filter(({ args }) => args[0] === "pack" && args.includes("--dry-run")))
      .toHaveLength(2);
  });

  it("packs a physical private bundle that a clean consumer can install offline", async () => {
    const rootDir = await newReleaseDiscoveryFixture();
    const rootManifestPath = path.join(rootDir, "package.json");
    const rootManifest = JSON.parse(await fs.readFile(rootManifestPath, "utf8"));
    rootManifest.files = ["README.md"];
    await fs.writeFile(rootManifestPath, JSON.stringify(rootManifest));
    await fs.writeFile(path.join(rootDir, "README.md"), "Isolated public release fixture.\n");

    const gatewayDirectory = path.join(rootDir, "packages/gateway");
    const gatewayManifest = {
      name: "@meshrix/gateway",
      version: "1.2.3",
      type: "module",
      license: "Apache-2.0",
      files: ["dist", "LICENSE", "README.md"],
      types: "./dist/index.d.ts",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
          default: "./dist/index.js"
        }
      },
      dependencies: { "@meshrix/contracts": "1.2.3" },
      bundleDependencies: ["@meshrix/contracts"]
    };
    await fs.writeFile(path.join(gatewayDirectory, "package.json"), JSON.stringify(gatewayManifest));
    await fs.writeFile(path.join(gatewayDirectory, "README.md"), "Gateway release fixture.\n");
    await fs.mkdir(path.join(gatewayDirectory, "dist"), { recursive: true });
    await fs.writeFile(path.join(gatewayDirectory, "dist/index.js"), 'export { contractValue } from "@meshrix/contracts";\n');
    await fs.writeFile(path.join(gatewayDirectory, "dist/index.d.ts"), 'export { contractValue } from "@meshrix/contracts";\n');
    await fs.copyFile(path.join(ROOT, "packages/gateway/LICENSE"), path.join(gatewayDirectory, "LICENSE"));

    const contractsDirectory = path.join(rootDir, "packages/contracts");
    const contractsManifest = {
      name: "@meshrix/contracts",
      version: "1.2.3",
      private: true,
      type: "module",
      license: "Apache-2.0",
      files: ["dist", "LICENSE", "THIRD_PARTY_NOTICES.md"],
      types: "./dist/index.d.ts",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
          default: "./dist/index.js"
        }
      }
    };
    await fs.writeFile(path.join(contractsDirectory, "package.json"), JSON.stringify(contractsManifest));
    await fs.mkdir(path.join(contractsDirectory, "dist"), { recursive: true });
    await fs.writeFile(path.join(contractsDirectory, "dist/index.js"), 'export const contractValue = "bundled-contract";\n');
    await fs.writeFile(path.join(contractsDirectory, "dist/index.d.ts"), 'export declare const contractValue: "bundled-contract";\n');
    await fs.copyFile(path.join(ROOT, "packages/contracts/LICENSE"), path.join(contractsDirectory, "LICENSE"));
    await fs.writeFile(path.join(contractsDirectory, "THIRD_PARTY_NOTICES.md"), "Meshrix Contracts; Apache-2.0.\n");

    const artifactDirectory = await newArtifactDirectory();
    const prepared = await prepareReleaseSet({ rootDir, artifactDirectory });
    const preparedSet = await loadPreparedReleaseSet({ rootDir, artifactDirectory });
    const gatewayArtifact = preparedSet.packages.find(({ name }: { name: string }) => name === "@meshrix/gateway")!;
    const consumerDirectory = await newArtifactDirectory();
    await fs.writeFile(path.join(consumerDirectory, "package.json"), JSON.stringify({
      name: "gateway-pack-consumer",
      version: "1.0.0",
      private: true,
      type: "module"
    }));
    const userConfig = path.join(consumerDirectory, "user.npmrc");
    const globalConfig = path.join(consumerDirectory, "global.npmrc");
    await Promise.all([fs.writeFile(userConfig, ""), fs.writeFile(globalConfig, "")]);
    const cleanNpmEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.toLowerCase().startsWith("npm_config_"))
    );
    const npmRunner = createNpmRunner({
      environment: {
        ...cleanNpmEnvironment,
        npm_config_userconfig: userConfig,
        npm_config_globalconfig: globalConfig,
        // A clean consumer must not depend on a writable or prewarmed host cache.
        npm_config_cache: path.join(consumerDirectory, "npm-cache")
      }
    });
    const installed = await npmRunner([
      "install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", "--no-package-lock", gatewayArtifact.tarballPath
    ], { cwd: consumerDirectory });

    expect(prepared.packageCount).toBe(2);
    expect(gatewayArtifact.integrity).toMatch(/^sha512-/u);
    const installFailure = installed.stderr
      .replaceAll(rootDir, "<source>")
      .replaceAll(artifactDirectory, "<artifacts>")
      .replaceAll(consumerDirectory, "<consumer>")
      .replaceAll(os.homedir(), "<home>")
      .replaceAll(os.tmpdir(), "<temporary-directory>");
    expect(installed.exitCode, installFailure).toBe(0);
    const installedGatewayDirectory = path.join(consumerDirectory, "node_modules/@meshrix/gateway");
    const installedContractsDirectory = path.join(installedGatewayDirectory, "node_modules/@meshrix/contracts");
    const installedContractsManifest = JSON.parse(await fs.readFile(
      path.join(installedContractsDirectory, "package.json"),
      "utf8"
    ));
    expect(installedContractsManifest).toMatchObject({
      name: "@meshrix/contracts",
      version: "1.2.3",
      private: true,
      license: "Apache-2.0",
      types: "./dist/index.d.ts"
    });
    expect(await fs.readFile(path.join(installedContractsDirectory, "LICENSE"), "utf8"))
      .toContain("Apache License");
    expect(await fs.readFile(path.join(installedContractsDirectory, "THIRD_PARTY_NOTICES.md"), "utf8"))
      .toContain("Apache-2.0");
    expect(await fs.readFile(path.join(installedContractsDirectory, "dist/index.d.ts"), "utf8"))
      .toContain("contractValue");
    const gatewayModule = await import(pathToFileURL(
      path.join(installedGatewayDirectory, "dist/index.js")
    ).href);
    expect(gatewayModule.contractValue).toBe("bundled-contract");
  });

  it("cleans partial output after an npm-selected private bundle file is missing", async () => {
    const rootDir = await newReleaseDiscoveryFixture();
    await fs.writeFile(path.join(rootDir, "packages/gateway/package.json"), JSON.stringify({
      name: "@meshrix/gateway",
      version: "1.2.3",
      dependencies: { "@meshrix/contracts": "1.2.3" },
      bundleDependencies: ["@meshrix/contracts"]
    }));
    const injected = createInjectedNpmRunner({
      packFilesByName: {
        "@meshrix/contracts": [{ path: "package.json" }, { path: "dist/missing.js" }]
      }
    });
    const artifactDirectory = await newArtifactDirectory();

    await expect(prepareReleaseSet({
      rootDir,
      artifactDirectory,
      runner: injected.runner,
      environment: {}
    })).rejects.toMatchObject({ code: "release_set_bundle_source_file_missing" });
    expect(await fs.readdir(artifactDirectory)).toEqual([]);
    expect(injected.archivePackCalls).toHaveLength(0);
    const commandDirectories = [...new Set(injected.calls.map(({ cwd }) => cwd))];
    expect(commandDirectories).toHaveLength(1);
    await expect(fs.access(commandDirectories[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps governed agent-plugin workspace expansion in release discovery", async () => {
    const rootPackage = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
    const directories = await resolveReleaseWorkspaceDirectories({
      rootDir: ROOT,
      workspaces: rootPackage.workspaces
    });
    expect(directories.filter((directory: string) => directory.startsWith("plugins/agents/")))
      .toEqual([
        "plugins/agents/antigravity",
        "plugins/agents/claude-code",
        "plugins/agents/codex",
        "plugins/agents/kimi",
        "plugins/agents/meshrix-self-maintenance",
        "plugins/agents/openclaw",
        "plugins/agents/opencode",
        "plugins/agents/pi"
      ]);
    await expect(resolveReleaseWorkspaceDirectories({ rootDir: ROOT, workspaces: ["packages/*"] }))
      .rejects.toMatchObject({ code: "release_set_workspace_path_invalid" });
  });

  it("rebuilds an incomplete owned set and cleans partial output after npm pack fails", async () => {
    const injected = createInjectedNpmRunner();
    const artifactDirectory = await newArtifactDirectory();
    const first = await prepareReleaseSet({ rootDir: ROOT, artifactDirectory, runner: injected.runner, environment: {} });
    const manifest = JSON.parse(await fs.readFile(path.join(artifactDirectory, PREPARED_RELEASE_SET_FILENAME), "utf8"));
    await fs.rm(path.join(artifactDirectory, manifest.packages[0].filename));

    const rebuilt = await prepareReleaseSet({ rootDir: ROOT, artifactDirectory, runner: injected.runner, environment: {} });
    expect(rebuilt).toMatchObject({ ok: true, prepared: true, version: first.version });
    await expect(loadPreparedReleaseSet({ rootDir: ROOT, artifactDirectory })).resolves.toMatchObject({
      version: first.version,
      packages: expect.arrayContaining([expect.objectContaining({ name: "@meshrix/gateway" })])
    });

    const failedDirectory = await newArtifactDirectory();
    let failFirstArchive = true;
    const failAfterWrite = async (args: string[], context?: { cwd?: string }) => {
      const result = await injected.runner(args, context);
      if (args[0] === "pack" && args.includes("--pack-destination") && failFirstArchive) {
        failFirstArchive = false;
        return { ...result, exitCode: 1 };
      }
      return result;
    };
    await expect(prepareReleaseSet({
      rootDir: ROOT,
      artifactDirectory: failedDirectory,
      runner: failAfterWrite,
      environment: {}
    })).rejects.toMatchObject({ code: "release_set_pack_failed" });
    expect(await fs.readdir(failedDirectory)).toEqual([]);
    await expect(prepareReleaseSet({ rootDir: ROOT, artifactDirectory: failedDirectory, runner: injected.runner, environment: {} }))
      .resolves.toMatchObject({ ok: true, prepared: true });
  });

  it("preserves unrelated files when an incomplete artifact directory cannot be rebuilt safely", async () => {
    const injected = createInjectedNpmRunner();
    const artifactDirectory = await prepareFixtures(injected);
    const manifestPath = path.join(artifactDirectory, PREPARED_RELEASE_SET_FILENAME);
    const manifestBefore = await fs.readFile(manifestPath, "utf8");
    await fs.rm(path.join(artifactDirectory, JSON.parse(manifestBefore).packages[0].filename));
    const userFile = path.join(artifactDirectory, "operator-note.txt");
    await fs.writeFile(userFile, "preserve this file\n");

    await expect(prepareReleaseSet({ rootDir: ROOT, artifactDirectory, runner: injected.runner, environment: {} }))
      .rejects.toMatchObject({ code: "release_set_artifact_directory_not_empty" });
    expect(await fs.readFile(userFile, "utf8")).toBe("preserve this file\n");
    expect(await fs.readFile(manifestPath, "utf8")).toBe(manifestBefore);
  });

  it("rejects missing, substituted and malformed archives before registry access", async () => {
    const missingNpm = createInjectedNpmRunner();
    const missingDirectory = await prepareFixtures(missingNpm);
    const missingManifest = JSON.parse(await fs.readFile(path.join(missingDirectory, PREPARED_RELEASE_SET_FILENAME), "utf8"));
    await fs.rm(path.join(missingDirectory, missingManifest.packages[0].filename));
    await expect(publishReleaseSet({ rootDir: ROOT, artifactDirectory: missingDirectory, runner: missingNpm.runner }))
      .rejects.toMatchObject({ code: "release_set_tarball_missing" });
    expect(missingNpm.calls.some(({ args }) => args[0] === "view")).toBe(false);

    const substitutedNpm = createInjectedNpmRunner();
    const substitutedDirectory = await prepareFixtures(substitutedNpm);
    const substitutedManifest = JSON.parse(await fs.readFile(path.join(substitutedDirectory, PREPARED_RELEASE_SET_FILENAME), "utf8"));
    await fs.writeFile(path.join(substitutedDirectory, substitutedManifest.packages[0].filename), "substituted archive");
    await expect(publishReleaseSet({ rootDir: ROOT, artifactDirectory: substitutedDirectory, runner: substitutedNpm.runner }))
      .rejects.toMatchObject({ code: "release_set_prepared_archive_integrity_mismatch" });
    expect(substitutedNpm.publishCalls).toHaveLength(0);
    expect(substitutedNpm.calls.some(({ args }) => args[0] === "view")).toBe(false);

    const malformedNpm = createInjectedNpmRunner();
    const malformedDirectory = await prepareFixtures(malformedNpm);
    const manifestPath = path.join(malformedDirectory, PREPARED_RELEASE_SET_FILENAME);
    const malformed = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    malformed.packages[0].filename = "../elsewhere.tgz";
    await fs.writeFile(manifestPath, JSON.stringify(malformed));
    await expect(publishReleaseSet({ rootDir: ROOT, artifactDirectory: malformedDirectory, runner: malformedNpm.runner }))
      .rejects.toMatchObject({ code: "release_set_prepared_archive_invalid" });
    expect(malformedNpm.calls.some(({ args }) => args[0] === "view")).toBe(false);
  });

  it("rechecks prepared archive bytes after the registry preflight and before publishing", async () => {
    const injected = createInjectedNpmRunner();
    const artifactDirectory = await prepareFixtures(injected);
    const prepared = await loadPreparedReleaseSet({ rootDir: ROOT, artifactDirectory });
    const archivePath = prepared.packages[0].tarballPath;
    let replaced = false;
    const runner = async (args: string[], context?: { cwd?: string }) => {
      const result = await injected.runner(args, context);
      if (args[0] === "view" && !replaced) {
        replaced = true;
        await fs.writeFile(archivePath, "changed after registry preflight");
      }
      return result;
    };

    await expect(publishReleaseSet({ rootDir: ROOT, artifactDirectory, runner, environment: {} }))
      .rejects.toMatchObject({ code: "release_set_prepared_archive_integrity_mismatch" });
    expect(injected.publishCalls).toHaveLength(0);
  });

  it("preflights all immutable package versions, publishes missing archives once, and resumes by integrity", async () => {
    const releaseSet = await discoverReleaseSet({ rootDir: ROOT });
    const alreadyPublished = releaseSet.packages[0];
    const published = new Map([[releaseSpec(alreadyPublished.name, alreadyPublished.version), integrityFor(alreadyPublished.name)]]);
    const injected = createInjectedNpmRunner({ published });
    const artifactDirectory = await prepareFixtures(injected);

    const result = await publishReleaseSet({ rootDir: ROOT, artifactDirectory, runner: injected.runner, environment: {} });
    expect(injected.calls.filter(({ args }) => args[0] === "view")).toHaveLength(releaseSet.packages.length);
    expect(injected.publishCalls.map(({ name }) => name)).toEqual(["meshrix.js"]);
    expect(injected.publishCalls[0].args.slice(0, 4)).toEqual([
      "publish",
      path.join(artifactDirectory, filenameFor("meshrix.js", releaseSet.version)),
      "--access",
      "public"
    ]);
    expect(injected.publishCalls[0].args.slice(4)).toEqual([
      "--tag", "latest", "--ignore-scripts", "--registry", "https://registry.npmjs.org/"
    ]);
    expect(injected.calls.some(({ args }) => ["audit", "dist-tag", "install"].includes(args[0]))).toBe(false);
    expect(result.packages.map(({ action }: { action: string }) => action)).toEqual(["skipped", "published"]);

    const retry = await publishReleaseSet({ rootDir: ROOT, artifactDirectory, runner: injected.runner, environment: {} });
    expect(retry.packages.every(({ action }: { action: string }) => action === "skipped")).toBe(true);
    expect(injected.publishCalls).toHaveLength(1);
  });

  it("checks every registry version before publishing if any existing bytes conflict", async () => {
    const releaseSet = await discoverReleaseSet({ rootDir: ROOT });
    const conflict = releaseSet.packages.at(-1)!;
    const injected = createInjectedNpmRunner({
      published: new Map([[releaseSpec(conflict.name, conflict.version), integrityFor("different bytes")]])
    });
    const artifactDirectory = await prepareFixtures(injected);

    await expect(publishReleaseSet({ rootDir: ROOT, artifactDirectory, runner: injected.runner, environment: {} }))
      .rejects.toMatchObject({ code: "release_set_registry_integrity_mismatch" });
    expect(injected.calls.filter(({ args }) => args[0] === "view")).toHaveLength(releaseSet.packages.length);
    expect(injected.publishCalls).toHaveLength(0);
  });

  it("does not expose npm failure output and passes standard npm credentials and config unchanged", async () => {
    const token = "synthetic-npm-token";
    let receivedEnvironment: NodeJS.ProcessEnv | undefined;
    const directRunner = createNpmRunner({
      environment: {
        NODE_AUTH_TOKEN: token,
        npm_config_userconfig: "/fixture/user.npmrc",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc-token"
      },
      exec: async (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        receivedEnvironment = options.env;
        return { stdout: `token=${token}`, stderr: `npm error token=${token}` };
      }
    });
    const publishOutput = await directRunner(["publish", "archive.tgz"], { cwd: ROOT });
    expect(receivedEnvironment).toMatchObject({
      NODE_AUTH_TOKEN: token,
      npm_config_userconfig: "/fixture/user.npmrc",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc-token"
    });
    expect(JSON.stringify(publishOutput)).not.toContain(token);

    const injected = createInjectedNpmRunner();
    const artifactDirectory = await prepareFixtures(injected);
    const failingRunner = async (args: string[], context?: { cwd?: string }) => {
      if (args[0] === "publish") {
        return { exitCode: 1, stdout: `token=${token}`, stderr: `npm error token=${token}` };
      }
      return injected.runner(args, context);
    };
    const failure = await publishReleaseSet({
      rootDir: ROOT,
      artifactDirectory,
      runner: failingRunner,
      environment: { NODE_AUTH_TOKEN: token }
    }).catch((error: Error) => error);

    expect(failure.message).toContain("could not be published");
    expect(failure.message).not.toContain(token);
    expect(JSON.stringify(failure)).not.toContain(token);
  });

  it("accepts only preparation and archive-directory CLI options", () => {
    expect(parsePublishArguments(["--prepare", "--artifact-dir", "/fixture/artifacts"]))
      .toEqual({ prepare: true, artifactDirectory: "/fixture/artifacts", help: false });
    expect(parsePublishArguments(["--artifact-dir=/fixture/artifacts"]))
      .toEqual({ prepare: false, artifactDirectory: "/fixture/artifacts", help: false });
    expect(parsePublishArguments(["--help"]).help).toBe(true);
  });

  it("selects npm's ordinary latest and next channels from the release version", () => {
    expect(releaseTagForVersion("1.2.3")).toBe("latest");
    expect(releaseTagForVersion("1.2.3-rc.1")).toBe("next");
  });

});
