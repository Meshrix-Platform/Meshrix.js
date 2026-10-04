import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { resolveReleaseWorkspaceDirectories } from "../../../tools/server-scripts/lib/release-metadata.ts";
import {
  SUPPLY_CHAIN_MANIFEST_SCHEMA_VERSION,
  buildSupplyChainArtifacts
} from "../../../tools/generators/generate-supply-chain-artifacts.ts";
import {
  normalizeReleaseChannel,
  prepareMcpReleaseOutputDirectory,
  run,
  writeFlattenedReleaseChecksumAuthority
} from "../../../tools/server-scripts/lib/mcp-release-common.ts";
import {
  resolveNodeRuntimeCacheDirectory
} from "../../../tools/server-scripts/lib/mcp-release-portable.ts";
import {
  npmCliArgs,
  resolveNpmCliInvocation
} from "../../../tools/server-scripts/lib/npm-cli-invocation.ts";
import {
  MCP_PORTABLE_TARGETS,
  MCP_RELEASE_TARGETS,
  normalizeMcpPortableTargets
} from "../../../tools/server-scripts/lib/mcp-release-platforms.ts";
import {
  hashCommand,
  parseChecksumIndex,
  validateArchiveNames
} from "../../../tools/server-scripts/verify-mcp-release-assets.ts";

const ROOT: any = path.resolve(import.meta.dirname, "../../..");

function read(relativePath?: any) : any {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("release workflow supply-chain boundary", () : any => {
  it("supplies the actual workspace manifests before a clean container dependency install", async () => {
    const manifest = JSON.parse(read("package.json"));
    const directories = await resolveReleaseWorkspaceDirectories({ rootDir: ROOT, workspaces: manifest.workspaces });
    const dependencyStage = read("Dockerfile").split("FROM deps AS build")[0];
    const copied = [...dependencyStage.matchAll(/^COPY (.+) \.\/$|^COPY (\S+) \.\/\S+$/gmu)].flatMap((match) => (match[1] || match[2]).split(/\s+/u));
    for (const directory of directories) expect(copied, directory).toContain(`${directory}/package.json`);
  });

  it("keeps native execution and external journeys out of the release definition", () : any => {
    const definition: any = JSON.parse(read("tools/registry/release-definition.registry.json"));
    expect(definition.acceptance).toMatchObject({
      stableRequiredClaim: "functional-complete",
      releaseRequiredClaim: "npm-package-installability-passed",
      standardsRegistry: "tools/registry/release-acceptance-standards.registry.json",
    });
    expect(definition.github).not.toHaveProperty("imageVerification");
    expect(definition).not.toHaveProperty("journeyGate");
    expect(definition.container).not.toHaveProperty("platforms");
    expect(definition.container.requiredForRelease).toBe(false);
  });

  it("uses one immutable Node base-image reference across Docker authorities", () : any => {
    const dockerfile: any = read("Dockerfile");
    const deploymentIndex: any = JSON.parse(read("packages/foundation/config/deployment/index.json"));
    const image: any = dockerfile.match(/^ARG NODE_BASE_IMAGE=(.+)$/mu)?.[1] || "";
    expect(image).toMatch(/^docker\.io\/library\/node:24\.\d+\.\d+-bookworm-slim@sha256:[a-f0-9]{64}$/u);
    expect(deploymentIndex.dockerPresets.baseImages.mainService).toBe(image);
    expect(deploymentIndex.dockerPresets.mainService.buildArgs.NODE_BASE_IMAGE).toBe(image);
    expect(dockerfile).not.toContain("default-settings.json");
  });

  it("keeps compose discovery coordinates aligned with its host port and shutdown budget", () : any => {
    const compose: any = read("docker-compose.yml");
    const releaseTemplate: any = read(".github/RELEASE_TEMPLATE.md");
    expect(compose).toContain(
      '"${MESHRIX_BIND_ADDRESS:-127.0.0.1}:${MESHRIX_HOST_PORT:-7228}:7228"'
    );
    expect(compose).toContain("healthcheck:");
    expect(compose).toContain("stop_grace_period: 90s");
    expect(releaseTemplate).toContain("--stop-timeout 90");
    for (const field of [
      "MESHRIX_BOOTSTRAP_URL",
      "MESHRIX_ADVERTISED_BASE_URL",
      "MESHRIX_ACTIVE_SERVICE_URL"
    ]) {
      expect(compose).toContain(
        `${field}: http://${"${MESHRIX_ADVERTISED_HOST:-127.0.0.1}"}:${"${MESHRIX_HOST_PORT:-7228}"}`
      );
      expect(compose).not.toContain(`${field}: http://127.0.0.1:7228`);
    }
  });

  it("keeps the dependency build cache project-isolated", () : any => {
    const dockerfile: any = read("Dockerfile");
    const cacheMount: any =
      "--mount=type=cache,id=meshrix-core-npm,target=${ROOTFS}var/cache/meshrix/npm,sharing=locked";
    expect(dockerfile.split(cacheMount)).toHaveLength(2);
    expect(dockerfile).toContain('--cache="${ROOTFS}var/cache/meshrix/npm"');

    expect(dockerfile).not.toContain("cp -a ${ROOTFS}var/cache/meshrix/npm/. ");
    expect(dockerfile).not.toContain(["", "root", ".npm"].join("/"));
  });

  it("keeps the MCP command in the root npm release contract", () : any => {
    const verifier: any = read("tools/server-scripts/verify-npm-package-installability.ts");
    const rootPackage: any = JSON.parse(read("package.json"));
    expect(verifier).toContain('import { discoverReleaseSet, loadPreparedReleaseSet } from "./publish-release-set.ts";');
    expect(rootPackage.bin?.["meshrix-mcp"]).toBe(
      "dist/apps/server/bin/meshrix-mcp.js"
    );
    expect(verifier).toContain("assertPreparedProductBundleClosure");
    expect(verifier).toContain("bundledPackageNamesInArtifact(artifact.files)");
    expect(verifier).toContain("name === rootPackage.name");
  });

  it("keeps the release directory limited to final files", () : any => {
    const releaseSource: any = read("tools/server-scripts/mcp-release.ts");
    const portableSource: any = read("tools/server-scripts/lib/mcp-release-portable.ts");
    expect(releaseSource).toContain("release_output_contains_non_file_entry");
    expect(releaseSource).toContain("`extracted-${target}`");
    expect(portableSource).toContain("fs.rm(stagingRoot, { recursive: true, force: true })");
    expect(portableSource).toContain("PINNED_DOWNLOAD_TIMEOUT_MS: any = 300000");
  });

  it("uses one canonical Node runtime cache resolver for assembly and source evidence", () : any => {
    const override: any = path.join(ROOT, "build", "fixture-node-runtime-cache");
    const dataDir: any = path.join(ROOT, "build", "fixture-data");
    expect(resolveNodeRuntimeCacheDirectory({
      environment: { MESHRIX_MCP_NODE_RUNTIME_CACHE_DIR: `  ${override}  ` },
      dataDir: ""
    })).toBe(path.resolve(override));
    expect(resolveNodeRuntimeCacheDirectory({ environment: {}, dataDir })).toBe(
      path.join(path.resolve(dataDir), "cache", "mcp-node-runtime")
    );
    expect(() : any => resolveNodeRuntimeCacheDirectory({ environment: {}, dataDir: "" }))
      .toThrow("node_runtime_cache_data_directory_missing");

    const sourceEvidence: any = read("tools/server-scripts/prepare-node-runtime-source-evidence.ts");
    expect(sourceEvidence).toContain(
      'import { resolveNodeRuntimeCacheDirectory } from "./lib/mcp-release-portable.ts";'
    );
    expect(sourceEvidence).toContain("const cacheDir: any = resolveNodeRuntimeCacheDirectory();");
    expect(sourceEvidence).not.toContain("ServerConfig.getDataDir()");
  });

  it("rejects ambiguous archive paths and malformed checksum indexes", () : any => {
    expect(() : any => validateArchiveNames(["root/", "root/file"], "root", "fixture"))
      .not.toThrow();
    expect(() : any => validateArchiveNames(["root/", "root/file", "root/file/"], "root", "fixture"))
      .toThrow("fixture_normalized_path_collision");
    expect(() : any => validateArchiveNames(["root/", "root/FILE", "root/file"], "root", "fixture"))
      .toThrow("fixture_casefold_path_collision");
    expect(() : any => validateArchiveNames(["root/", "root\\file"], "root", "fixture"))
      .toThrow("fixture_unsafe_path_character");
    expect(() : any => parseChecksumIndex(`${"a".repeat(64)}  asset.tgz\n`)).not.toThrow();
    expect(() : any => parseChecksumIndex(`${"a".repeat(64)}  asset.tgz\n${"b".repeat(64)}  asset.tgz\n`))
      .toThrow("mcp_release_checksum_duplicate");
  });

  it("hashes archive subprocess output only after the stream closes", async () : Promise<any> => {
    const payload: any = "portable-release-stream".repeat(1024);
    const digest: any = createHash("sha256").update(payload).digest("hex");
    await expect(hashCommand(process.execPath, [
      "--input-type=module",
      "-e",
      `process.stdout.write(${JSON.stringify(payload)})`
    ])).resolves.toBe(digest);
  });

  it("runs npm through its JavaScript CLI on Windows without a command shell", () : any => {
    const invocation: any = resolveNpmCliInvocation({
      env: { npm_execpath: "/runtime/npm-cli.js" },
      execPath: "/runtime/node",
      isFile: (candidate?: any) : any => candidate === "/runtime/npm-cli.js",
      platform: "win32"
    });
    expect(invocation).toEqual({
      command: "/runtime/node",
      prefixArgs: ["/runtime/npm-cli.js"]
    });
    expect(npmCliArgs(invocation, ["pack", "--json"]))
      .toEqual(["/runtime/npm-cli.js", "pack", "--json"]);
    expect(() : any => resolveNpmCliInvocation({
      env: {},
      execPath: "/runtime/node",
      isFile: () : any => false,
      platform: "win32"
    })).toThrow("npm_cli_entrypoint_not_found");
  });

  it("removes the dedicated output after a release assembly failure", async () : Promise<any> => {
    const outputDir: any = path.join(ROOT, "build", "release", "mcp-failure-cleanup-test");
    await fsPromises.rm(outputDir, { recursive: true, force: true });
    try {
      await expect(run(process.execPath, [
        "tools/server-scripts/mcp-release.ts",
        "--output-dir",
        outputDir,
        "--platforms",
        "unsupported-platform"
      ])).rejects.toBeTruthy();
      await expect(fsPromises.access(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fsPromises.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported release assembly arguments before creating output", async () : Promise<any> => {
    const outputDir: any = path.join(ROOT, "build", "release", "mcp-unknown-argument-test");
    await fsPromises.rm(outputDir, { recursive: true, force: true });
    await expect(run(process.execPath, [
      "tools/server-scripts/mcp-release.ts",
      "--output-dir",
      outputDir,
      "--unsupported-option"
    ])).rejects.toBeTruthy();
    await expect(fsPromises.access(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts only a new or empty dedicated MCP output directory", async () : Promise<any> => {
    const repositoryRoot: any = await fsPromises.mkdtemp(path.join(os.tmpdir(), "meshrix-release-output-"));
    try {
      const releaseRoot: any = path.join(repositoryRoot, "build", "release");
      const allowed: any = path.join(releaseRoot, "mcp");
      await expect(prepareMcpReleaseOutputDirectory(allowed, { repositoryRoot })).resolves.toBe(allowed);

      await fsPromises.writeFile(path.join(allowed, "existing.txt"), "occupied", "utf8");
      await expect(
        prepareMcpReleaseOutputDirectory(allowed, { repositoryRoot })
      ).rejects.toThrow("release_output_directory_not_empty");
      await expect(
        prepareMcpReleaseOutputDirectory(repositoryRoot, { repositoryRoot })
      ).rejects.toThrow("release_output_directory_out_of_scope");
      await expect(
        prepareMcpReleaseOutputDirectory(releaseRoot, { repositoryRoot })
      ).rejects.toThrow("release_output_directory_out_of_scope");
      await expect(
        prepareMcpReleaseOutputDirectory(path.join(releaseRoot, "nested", "mcp"), { repositoryRoot })
      ).rejects.toThrow("release_output_directory_out_of_scope");
      await expect(
        prepareMcpReleaseOutputDirectory(path.join(repositoryRoot, "outside"), { repositoryRoot })
      ).rejects.toThrow("release_output_directory_out_of_scope");
      await expect(
        prepareMcpReleaseOutputDirectory(path.dirname(repositoryRoot), { repositoryRoot })
      ).rejects.toThrow("release_output_directory_out_of_scope");

      const fileOutput: any = path.join(releaseRoot, "file-target");
      await fsPromises.writeFile(fileOutput, "not-a-directory", "utf8");
      await expect(
        prepareMcpReleaseOutputDirectory(fileOutput, { repositoryRoot })
      ).rejects.toThrow("release_output_not_directory");

      const symlinkTarget: any = path.join(repositoryRoot, "symlink-target");
      const symlinkOutput: any = path.join(releaseRoot, "linked");
      await fsPromises.mkdir(symlinkTarget);
      await fsPromises.symlink(symlinkTarget, symlinkOutput);
      await expect(
        prepareMcpReleaseOutputDirectory(symlinkOutput, { repositoryRoot })
      ).rejects.toThrow("release_output_symlink_rejected");

      const ancestorRepository: any = path.join(repositoryRoot, "ancestor-repository");
      const ancestorTarget: any = path.join(repositoryRoot, "ancestor-target");
      await Promise.all([fsPromises.mkdir(ancestorRepository), fsPromises.mkdir(ancestorTarget)]);
      await fsPromises.symlink(ancestorTarget, path.join(ancestorRepository, "build"));
      await expect(prepareMcpReleaseOutputDirectory(
        path.join(ancestorRepository, "build", "release", "mcp"),
        { repositoryRoot: ancestorRepository }
      )).rejects.toThrow("release_output_ancestor_symlink_rejected");
    } finally {
      await fsPromises.rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("writes outer checksums with final flat asset names and rejects collisions", async () : Promise<any> => {
    const temporaryRoot: any = await fsPromises.mkdtemp(path.join(os.tmpdir(), "meshrix-release-checksum-"));
    try {
      const first: any = path.join(temporaryRoot, "mcp");
      const second: any = path.join(temporaryRoot, "supply-chain");
      await Promise.all([fsPromises.mkdir(first), fsPromises.mkdir(second)]);
      await Promise.all([
        fsPromises.writeFile(path.join(first, "connector.tar.gz"), "connector", "utf8"),
        fsPromises.writeFile(path.join(second, "bom.cdx.json"), "sbom", "utf8")
      ]);
      const outputPath: any = path.join(temporaryRoot, "RELEASE_SHA256SUMS");
      const result: any = await writeFlattenedReleaseChecksumAuthority({
        assetDirectories: [first, second],
        outputPath
      });
      expect(result.assetNames).toEqual(["bom.cdx.json", "connector.tar.gz"]);
      const checksumText: any = await fsPromises.readFile(outputPath, "utf8");
      expect(checksumText).not.toContain("mcp/");
      expect(checksumText).not.toContain("supply-chain/");

      await fsPromises.writeFile(path.join(second, "connector.tar.gz"), "collision", "utf8");
      await expect(writeFlattenedReleaseChecksumAuthority({
        assetDirectories: [first, second],
        outputPath: path.join(temporaryRoot, "nested", "RELEASE_SHA256SUMS")
      })).rejects.toThrow("release_asset_flat_name_collision");
    } finally {
      await fsPromises.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("requires every external dependency, including Pactium, to use the official registry", () : any => {
    const lockfile: any = JSON.parse(read("package-lock.json"));
    const externalEntries: any = (Object.entries(lockfile.packages) as [string, any][])
      .filter(([packagePath, packageEntry]: any[]) : any => packagePath.startsWith("node_modules/") && packageEntry.link !== true);
    const registryEntries: any = externalEntries;
    expect(registryEntries.length).toBeGreaterThan(0);
    for (const [, packageEntry] of registryEntries) {
      expect(new URL(packageEntry.resolved).origin).toBe("https://registry.npmjs.org");
    }
    const pactiumVersion: any = "0.8.1";
    const pactiumResolved: any = `https://registry.npmjs.org/pactium/-/pactium-${pactiumVersion}.tgz`;
    const rootManifest: any = JSON.parse(read("package.json"));
    const foundationManifest: any = JSON.parse(read("packages/foundation/package.json"));
    const runtimeManifest: any = JSON.parse(read("packages/server-runtime/package.json"));
    expect(rootManifest.dependencies.pactium).toBe(pactiumVersion);
    expect(foundationManifest.peerDependencies.pactium).toBe(pactiumVersion);
    expect(runtimeManifest.peerDependencies.pactium).toBe(pactiumVersion);
    expect(foundationManifest.dependencies?.pactium).toBeUndefined();
    expect(runtimeManifest.dependencies?.pactium).toBeUndefined();
    expect(lockfile.packages[""].dependencies.pactium).toBe(pactiumVersion);
    expect(lockfile.packages["node_modules/pactium"]).toMatchObject({
      version: pactiumVersion,
      resolved: pactiumResolved,
      license: "MIT"
    });
    expect(lockfile.packages["node_modules/pactium"].integrity).toMatch(/^sha512-/u);

    const fixture: any = structuredClone(lockfile);
    fixture.packages[registryEntries[0][0]].resolved = "https://registry.example.test/package.tgz";
    expect(() : any => buildSupplyChainArtifacts(`${JSON.stringify(fixture)}\n`))
      .toThrow("official npm registry origin");

    const vendoredFixture: any = structuredClone(lockfile);
    vendoredFixture.packages["node_modules/pactium"].resolved = "file:vendor/other-package.tgz";
    vendoredFixture.packages[""].dependencies.pactium = "file:vendor/other-package.tgz";
    expect(() : any => buildSupplyChainArtifacts(`${JSON.stringify(vendoredFixture)}\n`))
      .toThrow("official npm registry origin");
  });

  it("uses a governed schema identity for the reproducible supply-chain manifest", () : any => {
    const artifacts: any = buildSupplyChainArtifacts(read("package-lock.json"));
    expect(JSON.parse(artifacts.manifest).schemaVersion)
      .toBe(SUPPLY_CHAIN_MANIFEST_SCHEMA_VERSION);
  });

  it("accepts only a strict npm dist-tag channel and lets release commands finish naturally", async () : Promise<any> => {
    expect(normalizeReleaseChannel("stable")).toBe("stable");
    expect(normalizeReleaseChannel("next-release")).toBe("next-release");
    for (const invalid of ["", "Stable", "v1", "1.0.0", "next release", "../next", "next_tag"]) {
      expect(() : any => normalizeReleaseChannel(invalid)).toThrow("release_channel_dist_tag_invalid");
    }
    await expect(run(
      process.execPath,
      ["-e", "setTimeout(() => process.stdout.write('done'), 40)"]
    )).resolves.toMatchObject({ stdout: "done" });
  });
});
