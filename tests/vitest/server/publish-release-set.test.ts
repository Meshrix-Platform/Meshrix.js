import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  compareReleaseVersions,
  createNpmRunner,
  discoverReleaseSet,
  loadPreparedReleaseSet,
  parsePublishArguments,
  PREPARED_RELEASE_SET_FILENAME,
  preflightReleaseSet,
  prepareReleaseSet,
  publishReleaseSet,
  releaseTagForVersion
} from "../../../tools/server-scripts/publish-release-set.ts";
import { resolveReleaseWorkspaceDirectories } from "../../../tools/server-scripts/lib/release-metadata.ts";

const ROOT: any = path.resolve(import.meta.dirname, "../../..");
const DEPENDENCY_FIELDS: any[] = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
];
const AGENT_PLUGIN_PACKAGE_NAMES: readonly any[] = Object.freeze([
  "@meshrix/agent-antigravity-adapter",
  "@meshrix/agent-claude-code-adapter",
  "@meshrix/agent-codex-adapter",
  "@meshrix/agent-kimi-adapter",
  "@meshrix/agent-openclaw-adapter",
  "@meshrix/agent-opencode-adapter",
  "@meshrix/agent-pi-adapter",
  "@meshrix/client-adapter-kit"
]);
const ARTIFACT_DIRECTORIES: string[] = [];

afterEach(async () : Promise<any> => {
  await Promise.all(ARTIFACT_DIRECTORIES.splice(0).map((directory?: any) : Promise<any> => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

function archiveBytesFor(name?: any) : any {
  return Buffer.from(`fixture:${name}`);
}

function integrityFor(name?: any) : any {
  return `sha512-${createHash("sha512").update(archiveBytesFor(name)).digest("base64")}`;
}

function filenameFor(name?: any, version?: any) : any {
  return `${name.replace(/^@/u, "").replace(/\//gu, "-")}-${version}.tgz`;
}

function tagsKey(name?: any) : any {
  return `dist-tags:${name}`;
}

function publishedDistribution(name?: any, version?: any, integrity: any = integrityFor(name)) : any {
  return {
    integrity,
    signatures: [{
      keyid: `SHA256:${Buffer.from(`key:${name}`).toString("base64")}`,
      sig: Buffer.from(`signature:${name}`).toString("base64")
    }],
    attestations: {
      url: `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(name)}@${version}`,
      provenance: {
        predicateType: "https://slsa.dev/provenance/v1"
      }
    }
  };
}

function addPublishedVersion(registry?: any, packageRecord?: any, {
  integrity = integrityFor(packageRecord.name),
  tag = "latest",
  taggedVersion = packageRecord.version,
  distribution = publishedDistribution(packageRecord.name, packageRecord.version, integrity)
}: Record<string, any> = {}) : any {
  registry.set(`${packageRecord.name}@${packageRecord.version}`, distribution);
  registry.set(tagsKey(packageRecord.name), { [tag]: taggedVersion });
}

async function newArtifactDirectory() : Promise<any> {
  const directory: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-release-fixture-"));
  ARTIFACT_DIRECTORIES.push(directory);
  return directory;
}

async function prepareFixtures(injected?: any) : Promise<any> {
  const artifactDirectory: any = await newArtifactDirectory();
  await prepareReleaseSet({
    rootDir: ROOT,
    artifactDirectory,
    runner: injected.runner,
    environment: {}
  });
  return artifactDirectory;
}

async function packageCount() : Promise<any> {
  return (await discoverReleaseSet({ rootDir: ROOT })).packages.length;
}

function createInjectedNpmRunner({
  registry = new Map<any, any>(),
  packFormat = "legacy",
  viewFormat = "legacy"
}: Record<string, any> = {}) : any {
  const calls: any[] = [];
  const publishCalls: any[] = [];
  const tagRepairCalls: any[] = [];
  const tarballs: any = new Map<any, any>();
  const runner: any = async (args: any, { cwd, authToken }: Record<string, any>) : Promise<any> => {
    calls.push({ args: [...args], cwd, authToken });
    if (args[0] === "pack") {
      const packageDirectory: any = args.at(-1);
      const manifest: any = JSON.parse(await fs.readFile(path.join(packageDirectory, "package.json"), "utf8"));
      const filename: any = filenameFor(manifest.name, manifest.version);
      const integrity: any = integrityFor(manifest.name);
      const destination: any = args[args.indexOf("--pack-destination") + 1];
      const tarballPath: any = path.join(destination, filename);
      await fs.writeFile(tarballPath, archiveBytesFor(manifest.name));
      tarballs.set(tarballPath, {
        spec: `${manifest.name}@${manifest.version}`,
        integrity,
        name: manifest.name
      });
      const artifact = {
        name: manifest.name,
        version: manifest.version,
        filename,
        integrity
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify(packFormat === "npm12" ? { [manifest.name]: artifact } : [artifact]),
        stderr: ""
      };
    }
    if (args[0] === "view") {
      const key: any = args[2] === "dist-tags" ? tagsKey(args[1]) : args[1];
      if (!registry.has(key)) {
        return { exitCode: 1, stdout: "", stderr: "npm error code E404" };
      }
      const metadata = registry.get(key);
      return {
        exitCode: 0,
        stdout: JSON.stringify(viewFormat === "npm12" ? [metadata] : metadata),
        stderr: ""
      };
    }
    if (args[0] === "publish") {
      const tarball: any = tarballs.get(args[1]);
      if (!tarball) return { exitCode: 1, stdout: "", stderr: "fixture missing tarball" };
      const tag: any = args[args.indexOf("--tag") + 1];
      const version: any = tarball.spec.slice(tarball.spec.lastIndexOf("@") + 1);
      registry.set(
        tarball.spec,
        publishedDistribution(tarball.name, version, tarball.integrity)
      );
      registry.set(tagsKey(tarball.name), {
        ...(registry.get(tagsKey(tarball.name)) || {}),
        [tag]: version
      });
      publishCalls.push({ args: [...args], ...tarball, authToken });
      return { exitCode: 0, stdout: "+ fixture", stderr: "" };
    }
    if (args[0] === "dist-tag" && args[1] === "add") {
      const [, , spec, tag] = args;
      const separator: any = spec.lastIndexOf("@");
      const name: any = spec.slice(0, separator);
      const version: any = spec.slice(separator + 1);
      tagRepairCalls.push({ name, version, tag, authToken });
      registry.set(tagsKey(name), { ...(registry.get(tagsKey(name)) || {}), [tag]: version });
      return { exitCode: 0, stdout: "fixture tag repaired", stderr: "" };
    }
    if (args[0] === "install") {
      return { exitCode: 0, stdout: "fixture install", stderr: "" };
    }
    if (args[0] === "audit" && args[1] === "signatures") {
      return { exitCode: 0, stdout: JSON.stringify({ verifiedSignatures: 9 }), stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "fixture unsupported command" };
  };
  return { calls, publishCalls, tagRepairCalls, registry, runner };
}

describe("npm release-set publication", () : any => {
  it("discovers only public workspaces and orders dependencies before the root", async () : Promise<any> => {
    const releaseSet: any = await discoverReleaseSet({ rootDir: ROOT });
    const names: any = releaseSet.packages.map(({ name }: Record<string, any>) : any => name);
    const positions: any = new Map<any, any>(names.map((name?: any, index?: any) : any => [name, index]));

    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("meshrix-mcp-connector");
    expect(names).toContain("@meshrix/gateway");
    for (const packageName of AGENT_PLUGIN_PACKAGE_NAMES) expect(names).toContain(packageName);
    expect(names).not.toContain("@meshrix/server");
    expect(names).not.toContain("@meshrix/console");
    expect(names.at(-1)).toBe("meshrix.js");

    for (const packageRecord of releaseSet.packages) {
      for (const field of DEPENDENCY_FIELDS) {
        for (const dependencyName of Object.keys(packageRecord.manifest[field] || {})) {
          if (!dependencyName.startsWith("@meshrix/")) continue;
          expect(positions.get(dependencyName), `${packageRecord.name} -> ${dependencyName}`)
            .toBeLessThan(positions.get(packageRecord.name));
        }
      }
    }
  });

  it("expands only the governed agent-plugin workspace boundary", async () : Promise<any> => {
    const rootPackage: any = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
    const directories: any = await resolveReleaseWorkspaceDirectories({
      rootDir: ROOT,
      workspaces: rootPackage.workspaces
    });

    expect(directories.filter((directory?: any) : any => directory.startsWith("plugins/agents/")))
      .toEqual([
        "plugins/agents/antigravity",
        "plugins/agents/claude-code",
        "plugins/agents/client-adapter-kit",
        "plugins/agents/codex",
        "plugins/agents/kimi",
        "plugins/agents/meshrix-self-maintenance",
        "plugins/agents/openclaw",
        "plugins/agents/opencode",
        "plugins/agents/pi"
      ]);
    await expect(resolveReleaseWorkspaceDirectories({
      rootDir: ROOT,
      workspaces: ["packages/*"]
    })).rejects.toMatchObject({ code: "release_set_workspace_path_invalid" });
  });

  it("prepares one credential-free manifest and exposes the root tarball by its exact bytes", async () : Promise<any> => {
    const injected: any = createInjectedNpmRunner();
    const artifactDirectory: any = await newArtifactDirectory();
    const result: any = await prepareReleaseSet({
      rootDir: ROOT,
      artifactDirectory,
      runner: injected.runner,
      environment: { NODE_AUTH_TOKEN: "synthetic" }
    });
    const manifestPath: any = path.join(artifactDirectory, PREPARED_RELEASE_SET_FILENAME);
    const manifest: any = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const prepared: any = await loadPreparedReleaseSet({ rootDir: ROOT, artifactDirectory });
    const rootArtifact: any = prepared.packages.find(({ name }: Record<string, any>) : any => name === "meshrix.js");

    expect(result).toMatchObject({ ok: true, prepared: true, packageCount: await packageCount() });
    expect(result.packages.every((row?: any) : any => (
      Object.keys(row).sort().join(",") === "filename,integrity,name,version"
    ))).toBe(true);
    expect(manifest).toMatchObject({ schemaVersion: "meshrix.npm-release-set/v1", version: "0.0.1", tag: "latest" });
    expect(manifest.packages.every((row?: any) : any => (
      Object.keys(row).sort().join(",") === "filename,integrity,name,version" &&
      !path.isAbsolute(row.filename)
    ))).toBe(true);
    expect(JSON.stringify({ result, manifest })).not.toContain(artifactDirectory);
    expect(rootArtifact.filename).toBe(filenameFor("meshrix.js", "0.0.1"));
    expect(rootArtifact.tarballPath).toBe(path.join(artifactDirectory, rootArtifact.filename));
    expect(await fs.readFile(rootArtifact.tarballPath, "utf8")).toBe("fixture:meshrix.js");
    expect(injected.calls.filter(({ args }: Record<string, any>) : any => args[0] === "pack"))
      .toHaveLength(await packageCount());
  });

  it.each([
    { label: "legacy", packFormat: "legacy", viewFormat: "legacy" },
    { label: "npm 12", packFormat: "npm12", viewFormat: "npm12" }
  ])("preflights exact prepared archives without repacking using $label JSON output", async ({ packFormat, viewFormat }: Record<string, any>) : Promise<any> => {
    const injected: any = createInjectedNpmRunner({ packFormat, viewFormat });
    const artifactDirectory: any = await prepareFixtures(injected);
    const result: any = await preflightReleaseSet({
      rootDir: ROOT,
      artifactDirectory,
      runner: injected.runner,
      environment: { NPM_TOKEN: "synthetic" }
    });
    const count: any = await packageCount();

    expect(result).toMatchObject({ ok: true, preflight: true, version: "0.0.1", tag: "latest", packageCount: count });
    expect(result.packages.map(({ action }: Record<string, any>) : any => action)).toEqual(Array(count).fill("publish"));
    expect(injected.calls.filter(({ args }: Record<string, any>) : any => args[0] === "pack")).toHaveLength(count);
    expect(injected.calls.filter(({ args }: Record<string, any>) : any => args[0] === "view")).toHaveLength(count * 2);
    expect(injected.calls.some(({ args }: Record<string, any>) : any => (
      args[0] === "publish" || args[0] === "dist-tag" || args[0] === "install" || args[0] === "audit"
    ))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(artifactDirectory);
  });

  it("rejects missing, substituted, and malformed prepared archives before registry access", async () : Promise<any> => {
    const missingNpm: any = createInjectedNpmRunner();
    const missingDirectory: any = await prepareFixtures(missingNpm);
    const missingManifest: any = JSON.parse(await fs.readFile(path.join(missingDirectory, PREPARED_RELEASE_SET_FILENAME), "utf8"));
    await fs.rm(path.join(missingDirectory, missingManifest.packages[0].filename));
    await expect(preflightReleaseSet({ rootDir: ROOT, artifactDirectory: missingDirectory, runner: missingNpm.runner }))
      .rejects.toMatchObject({ code: "release_set_tarball_missing" });
    expect(missingNpm.calls.some(({ args }: Record<string, any>) : any => args[0] === "view")).toBe(false);

    const substitutedNpm: any = createInjectedNpmRunner();
    const substitutedDirectory: any = await prepareFixtures(substitutedNpm);
    const substitutedManifest: any = JSON.parse(await fs.readFile(path.join(substitutedDirectory, PREPARED_RELEASE_SET_FILENAME), "utf8"));
    await fs.writeFile(path.join(substitutedDirectory, substitutedManifest.packages[0].filename), "substituted archive");
    await expect(publishReleaseSet({ rootDir: ROOT, artifactDirectory: substitutedDirectory, runner: substitutedNpm.runner }))
      .rejects.toMatchObject({ code: "release_set_prepared_archive_integrity_mismatch" });
    expect(substitutedNpm.publishCalls).toHaveLength(0);
    expect(substitutedNpm.calls.some(({ args }: Record<string, any>) : any => args[0] === "view")).toBe(false);

    const malformedNpm: any = createInjectedNpmRunner();
    const malformedDirectory: any = await prepareFixtures(malformedNpm);
    const malformedPath: any = path.join(malformedDirectory, PREPARED_RELEASE_SET_FILENAME);
    const malformed: any = JSON.parse(await fs.readFile(malformedPath, "utf8"));
    malformed.packages[0].filename = "../elsewhere.tgz";
    await fs.writeFile(malformedPath, JSON.stringify(malformed));
    await expect(preflightReleaseSet({ rootDir: ROOT, artifactDirectory: malformedDirectory, runner: malformedNpm.runner }))
      .rejects.toMatchObject({ code: "release_set_prepared_archive_invalid" });
    expect(malformedNpm.calls.some(({ args }: Record<string, any>) : any => args[0] === "view")).toBe(false);
  });

  it("packs once, preflights the complete set, publishes dependency-first and resumes an exact partial release", async () : Promise<any> => {
    const releaseSet: any = await discoverReleaseSet({ rootDir: ROOT });
    const count: any = releaseSet.packages.length;
    const existing: any = releaseSet.packages[0];
    const registry: any = new Map<any, any>();
    addPublishedVersion(registry, existing);
    const injected: any = createInjectedNpmRunner({ registry });
    const artifactDirectory: any = await prepareFixtures(injected);

    const first: any = await publishReleaseSet({ rootDir: ROOT, artifactDirectory, runner: injected.runner, environment: {} });
    expect(first.packages.filter(({ action }: Record<string, any>) : any => action === "skipped").map(({ name }: Record<string, any>) : any => name))
      .toEqual([existing.name]);
    expect(first.packages.filter(({ action }: Record<string, any>) : any => action === "published"))
      .toHaveLength(count - 1);
    expect(injected.publishCalls.map(({ name }: Record<string, any>) : any => name)).toEqual(
      first.packages.filter(({ action }: Record<string, any>) : any => action === "published").map(({ name }: Record<string, any>) : any => name)
    );
    expect(injected.publishCalls.at(-1)?.name).toBe("meshrix.js");
    for (const published of injected.publishCalls) {
      const mutationIndex: any = injected.calls.findIndex(({ args }: Record<string, any>) : any => (
        args[0] === "publish" && args[1] === published.args[1]
      ));
      const packageReads: any[] = injected.calls.flatMap(({ args }: Record<string, any>, index?: any) : any[] => (
        args[0] === "view" && (args[1] === published.name || args[1] === published.spec)
          ? [index]
          : []
      ));
      expect(packageReads.filter((index?: any) : any => index < mutationIndex)).toHaveLength(4);
      expect(packageReads.filter((index?: any) : any => index > mutationIndex).length).toBeGreaterThanOrEqual(2);
    }
    expect(injected.calls.filter(({ args }: Record<string, any>) : any => args[0] === "pack")).toHaveLength(count);
    expect(injected.calls.some(({ args }: Record<string, any>) : any => args[0] === "install")).toBe(true);
    expect(injected.calls.some(({ args }: Record<string, any>) : any => (
      args[0] === "audit" && args[1] === "signatures" && args.includes("--include-attestations")
    ))).toBe(true);
    for (const { args } of injected.publishCalls) {
      expect(args).toContain("--provenance");
      expect(args.slice(args.indexOf("--access"), args.indexOf("--access") + 2)).toEqual(["--access", "public"]);
      expect(args.slice(args.indexOf("--tag"), args.indexOf("--tag") + 2)).toEqual(["--tag", "latest"]);
      expect(args.join(" ")).not.toContain("npm@latest");
    }

    const mutationCount: any = injected.publishCalls.length;
    const second: any = await publishReleaseSet({ rootDir: ROOT, artifactDirectory, runner: injected.runner, environment: {} });
    expect(second.packages.every(({ action }: Record<string, any>) : any => action === "skipped")).toBe(true);
    expect(injected.publishCalls).toHaveLength(mutationCount);
    expect(injected.calls.filter(({ args }: Record<string, any>) : any => args[0] === "pack")).toHaveLength(count);
  });

  it("preflights every package before mutating when a later immutable version conflicts", async () : Promise<any> => {
    const releaseSet: any = await discoverReleaseSet({ rootDir: ROOT });
    const last: any = releaseSet.packages.at(-1);
    const registry: any = new Map<any, any>();
    addPublishedVersion(registry, last, { integrity: integrityFor("different-content") });
    const injected: any = createInjectedNpmRunner({ registry });
    const artifactDirectory: any = await prepareFixtures(injected);

    await expect(publishReleaseSet({ rootDir: ROOT, artifactDirectory, runner: injected.runner, environment: {} }))
      .rejects.toMatchObject({ code: "release_set_registry_integrity_mismatch" });
    expect(injected.publishCalls).toHaveLength(0);
    expect(injected.calls.filter(({ args }: Record<string, any>) : any => args[0] === "view")).toHaveLength(releaseSet.packages.length * 2);
  });

  it("rejects a changed prepared archive before any registry mutation", async () : Promise<any> => {
    const injected: any = createInjectedNpmRunner();
    const artifactDirectory: any = await prepareFixtures(injected);
    const prepared: any = await loadPreparedReleaseSet({ rootDir: ROOT, artifactDirectory });
    const count: any = await packageCount();
    const firstArchive: any = prepared.packages[0].tarballPath;
    const runner: any = async (args?: any, context?: any) : Promise<any> => {
      const result: any = await injected.runner(args, context);
      if (args[0] === "view" && args[2] === "dist-tags" && args[1] === "meshrix.js") {
        await fs.writeFile(firstArchive, "replaced while registry preflight was running");
      }
      return result;
    };
    await expect(publishReleaseSet({ rootDir: ROOT, artifactDirectory, runner, environment: {} }))
      .rejects.toMatchObject({ code: "release_set_prepared_archive_integrity_mismatch" });
    expect(injected.publishCalls).toHaveLength(0);
    expect(injected.calls.filter(({ args }: Record<string, any>) : any => args[0] === "view")).toHaveLength(count * 2);
  });

  it("fails closed when npm cannot verify signatures or provenance", async () : Promise<any> => {
    const releaseSet: any = await discoverReleaseSet({ rootDir: ROOT });
    const first: any = releaseSet.packages[0];
    const registry: any = new Map<any, any>();
    addPublishedVersion(registry, first, {
      distribution: {
        integrity: integrityFor(first.name),
        signatures: publishedDistribution(first.name, first.version).signatures
      }
    });
    const provenanceNpm: any = createInjectedNpmRunner({ registry });
    const provenanceDirectory: any = await prepareFixtures(provenanceNpm);
    await expect(publishReleaseSet({
      rootDir: ROOT,
      artifactDirectory: provenanceDirectory,
      runner: provenanceNpm.runner,
      environment: {}
    })).rejects.toMatchObject({ code: "release_set_registry_provenance_missing" });
    expect(provenanceNpm.publishCalls).toHaveLength(0);

    const auditNpm: any = createInjectedNpmRunner();
    const auditDirectory: any = await prepareFixtures(auditNpm);
    const runner: any = async (args?: any, context?: any) : Promise<any> => {
      if (args[0] === "audit" && args[1] === "signatures") {
        return { exitCode: 1, stdout: "", stderr: "fixture signature failure" };
      }
      return auditNpm.runner(args, context);
    };
    await expect(publishReleaseSet({
      rootDir: ROOT,
      artifactDirectory: auditDirectory,
      runner,
      environment: {}
    })).rejects.toMatchObject({ code: "release_set_registry_signature_audit_failed" });
  });

  it("repairs only an older tag on identical bytes and preserves a newer tag", async () : Promise<any> => {
    const releaseSet: any = await discoverReleaseSet({ rootDir: ROOT });
    const first: any = releaseSet.packages[0];
    const registry: any = new Map<any, any>();
    addPublishedVersion(registry, first, { taggedVersion: "0.0.0" });
    const injected: any = createInjectedNpmRunner({ registry });
    const artifactDirectory: any = await prepareFixtures(injected);
    const preflight: any = await preflightReleaseSet({ rootDir: ROOT, artifactDirectory, runner: injected.runner });
    expect(preflight.packages.find(({ name }: Record<string, any>) : any => name === first.name)?.action)
      .toBe("repair-tag");

    const result: any = await publishReleaseSet({ rootDir: ROOT, artifactDirectory, runner: injected.runner, environment: {} });
    expect(result.packages.find(({ name }: Record<string, any>) : any => name === first.name)?.action)
      .toBe("tag-repaired");
    expect(injected.tagRepairCalls).toEqual([
      expect.objectContaining({ name: first.name, version: first.version, tag: "latest", authToken: undefined })
    ]);
    expect(injected.publishCalls.some(({ name }: Record<string, any>) : any => name === first.name)).toBe(false);
    expect(registry.get(tagsKey(first.name))).toEqual({ latest: first.version });

    const newerRegistry: any = new Map<any, any>();
    addPublishedVersion(newerRegistry, first, { taggedVersion: "9.0.0" });
    const newerNpm: any = createInjectedNpmRunner({ registry: newerRegistry });
    const newerDirectory: any = await prepareFixtures(newerNpm);
    const newerResult: any = await publishReleaseSet({ rootDir: ROOT, artifactDirectory: newerDirectory, runner: newerNpm.runner, environment: {} });
    expect(newerResult.packages.find(({ name }: Record<string, any>) : any => name === first.name)?.action).toBe("skipped");
    expect(newerRegistry.get(tagsKey(first.name))).toEqual({ latest: "9.0.0" });
    expect(newerNpm.tagRepairCalls).toHaveLength(0);
  });

  it("rejects a tag regression for a missing version", async () : Promise<any> => {
    const releaseSet: any = await discoverReleaseSet({ rootDir: ROOT });
    const first: any = releaseSet.packages[0];
    const registry: any = new Map<any, any>([[tagsKey(first.name), { latest: "9.0.0" }]]);
    const injected: any = createInjectedNpmRunner({ registry });
    const artifactDirectory: any = await prepareFixtures(injected);
    await expect(publishReleaseSet({ rootDir: ROOT, artifactDirectory, runner: injected.runner, environment: {} }))
      .rejects.toMatchObject({ code: "release_set_registry_tag_regression" });
    expect(injected.publishCalls).toHaveLength(0);
  });

  it("uses the prerelease next channel and preserves its newer version", async () : Promise<any> => {
    const fixtureRoot: any = await newArtifactDirectory();
    await fs.writeFile(path.join(fixtureRoot, "package.json"), JSON.stringify({
      name: "meshrix.js",
      version: "1.2.3-rc.10",
      workspaces: []
    }));
    const artifactDirectory: any = await newArtifactDirectory();
    const registry: any = new Map<any, any>([[tagsKey("meshrix.js"), { next: "1.2.3-rc.2" }]]);
    const injected: any = createInjectedNpmRunner({ registry });
    await prepareReleaseSet({ rootDir: fixtureRoot, artifactDirectory, runner: injected.runner, environment: {} });

    const preflight: any = await preflightReleaseSet({ rootDir: fixtureRoot, artifactDirectory, runner: injected.runner });
    expect(preflight).toMatchObject({ version: "1.2.3-rc.10", tag: "next", packageCount: 1 });
    expect(preflight.packages[0].action).toBe("publish");
    const published: any = await publishReleaseSet({ rootDir: fixtureRoot, artifactDirectory, runner: injected.runner, environment: {} });
    expect(published.packages[0].action).toBe("published");
    expect(registry.get(tagsKey("meshrix.js"))).toEqual({ next: "1.2.3-rc.10" });

    registry.set(tagsKey("meshrix.js"), { next: "1.2.3-rc.12" });
    const rerun: any = await publishReleaseSet({ rootDir: fixtureRoot, artifactDirectory, runner: injected.runner, environment: {} });
    expect(rerun.packages[0].action).toBe("skipped");
    expect(registry.get(tagsKey("meshrix.js"))).toEqual({ next: "1.2.3-rc.12" });
    expect(injected.publishCalls).toHaveLength(1);
  });

  it("requires explicit candidate-bound bootstrap and prevents silent raw-token fallback", async () : Promise<any> => {
    expect(releaseTagForVersion("1.2.3")).toBe("latest");
    expect(releaseTagForVersion("1.2.3-rc.1")).toBe("next");
    expect(compareReleaseVersions("1.2.3", "1.2.3-rc.9")).toBeGreaterThan(0);
    expect(compareReleaseVersions("1.2.3-rc.10", "1.2.3-rc.2")).toBeGreaterThan(0);
    expect(compareReleaseVersions("100000000000000000000.0.0", "9.0.0")).toBeGreaterThan(0);

    const defaultNpm: any = createInjectedNpmRunner();
    const defaultDirectory: any = await prepareFixtures(defaultNpm);
    await expect(publishReleaseSet({
      rootDir: ROOT,
      artifactDirectory: defaultDirectory,
      runner: defaultNpm.runner,
      environment: { NODE_AUTH_TOKEN: "synthetic" }
    })).rejects.toMatchObject({ code: "release_set_raw_npm_token_forbidden" });
    expect(defaultNpm.calls.some(({ args }: Record<string, any>) : any => args[0] === "view")).toBe(false);

    const bootstrapNpm: any = createInjectedNpmRunner();
    const bootstrapDirectory: any = await prepareFixtures(bootstrapNpm);
    await expect(publishReleaseSet({
      rootDir: ROOT,
      artifactDirectory: bootstrapDirectory,
      authMode: "bootstrap",
      bootstrapCandidate: "0.0.2",
      runner: bootstrapNpm.runner,
      environment: { NODE_AUTH_TOKEN: "synthetic" }
    })).rejects.toMatchObject({ code: "release_set_bootstrap_candidate_invalid" });
    expect(bootstrapNpm.calls.some(({ args }: Record<string, any>) : any => args[0] === "view")).toBe(false);

    const successfulNpm: any = createInjectedNpmRunner();
    const successfulDirectory: any = await prepareFixtures(successfulNpm);
    const successful: any = await publishReleaseSet({
      rootDir: ROOT,
      artifactDirectory: successfulDirectory,
      authMode: "bootstrap",
      bootstrapCandidate: "0.0.1",
      runner: successfulNpm.runner,
      environment: { NODE_AUTH_TOKEN: "synthetic" }
    });
    expect(successful.authMode).toBe("bootstrap");
    expect(successfulNpm.publishCalls.every(({ authToken }: Record<string, any>) : any => authToken === "synthetic")).toBe(true);
    expect(successfulNpm.calls.filter(({ args }: Record<string, any>) : any => (
      args[0] === "view" || args[0] === "install" || args[0] === "audit" || args[0] === "pack"
    )).every(({ authToken }: Record<string, any>) : any => authToken === undefined)).toBe(true);
    expect(JSON.stringify(successful)).not.toContain("synthetic");
    expect(JSON.stringify(successful)).not.toContain(successfulDirectory);
  });

  it("isolates all npm credentials from read/build commands and scopes bootstrap to mutations", async () : Promise<any> => {
    const calls: any[] = [];
    const runner: any = createNpmRunner({
      environment: {
        NODE_AUTH_TOKEN: "ambient-synthetic",
        NPM_TOKEN: "other-synthetic",
        npm_config_userconfig: "/fixture/user.npmrc",
        NPM_CONFIG_GLOBALCONFIG: "/fixture/global.npmrc",
        GITHUB_ACTIONS: "true"
      },
      exec: async (command?: any, args?: any, options?: any) : Promise<any> => {
        calls.push({ command, args, env: options.env });
        return { stdout: "", stderr: "" };
      }
    });

    await runner(["pack", "--ignore-scripts"], { cwd: "/fixture/artifacts" });
    await runner(["view", "meshrix.js", "dist", "--json"], { cwd: "/fixture/artifacts" });
    await runner(["publish", "meshrix.js-0.0.1.tgz"], { cwd: "/fixture/artifacts", authToken: "mutation-synthetic" });
    await runner(["dist-tag", "add", "meshrix.js@0.0.1", "latest"], { cwd: "/fixture/artifacts", authToken: "mutation-synthetic" });
    await expect(runner(["install"], { cwd: "/fixture/artifacts", authToken: "mutation-synthetic" }))
      .rejects.toMatchObject({ code: "release_set_auth_scope_invalid" });

    expect(calls).toHaveLength(4);
    expect(calls[0].env.NODE_AUTH_TOKEN).toBeUndefined();
    expect(calls[0].env.NPM_TOKEN).toBeUndefined();
    expect(calls[0].env.npm_config_userconfig).toBe(os.devNull);
    expect(calls[0].env.npm_config_globalconfig).toBe(os.devNull);
    expect(calls[0].env.GITHUB_ACTIONS).toBe("true");
    expect(calls[1].env.NODE_AUTH_TOKEN).toBeUndefined();
    expect(calls[2].env.NODE_AUTH_TOKEN).toBe("mutation-synthetic");
    expect(calls[2].env.NPM_TOKEN).toBeUndefined();
    expect(calls[3].env.NODE_AUTH_TOKEN).toBe("mutation-synthetic");
  });

  it("accepts only the exact prepared-artifact and explicit bootstrap CLI forms", () : any => {
    expect(parsePublishArguments(["--prepare", "--artifact-dir", "/fixture/artifacts"]))
      .toEqual({
        prepare: true,
        preflight: false,
        artifactDirectory: "/fixture/artifacts",
        authMode: "oidc",
        bootstrapCandidate: undefined,
        tag: undefined,
        help: false
      });
    expect(parsePublishArguments([
      "--artifact-dir=/fixture/artifacts",
      "--auth", "bootstrap",
      "--bootstrap-candidate", "0.0.1"
    ])).toMatchObject({ authMode: "bootstrap", bootstrapCandidate: "0.0.1" });
    expect(() : any => parsePublishArguments(["--preflight"]))
      .toThrowError(expect.objectContaining({ code: "release_set_argument_missing" }));
    expect(() : any => parsePublishArguments(["--dry-run", "--artifact-dir", "/fixture/artifacts"]))
      .toThrowError(expect.objectContaining({ code: "release_set_argument_unknown" }));
    expect(() : any => parsePublishArguments(["--artifact-dir", "/fixture/artifacts", "--auth", "bootstrap"]))
      .toThrowError(expect.objectContaining({ code: "release_set_argument_missing" }));
    expect(() : any => parsePublishArguments(["--prepare", "--preflight", "--artifact-dir", "/fixture/artifacts"]))
      .toThrowError(expect.objectContaining({ code: "release_set_argument_conflict" }));
  });
});
