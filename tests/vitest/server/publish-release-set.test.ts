import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  compareReleaseVersions,
  discoverReleaseSet,
  parsePublishArguments,
  publishReleaseSet,
  releaseTagForVersion
} from "../../../tools/server-scripts/publish-release-set.ts";

const ROOT: any = path.resolve(import.meta.dirname, "../../..");
const DEPENDENCY_FIELDS: any[] = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
];

function integrityFor(name?: any) : any {
  return `sha512-${createHash("sha512").update(`fixture:${name}`).digest("base64")}`;
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

function createInjectedNpmRunner({ registry = new Map<any, any>() }: Record<string, any> = {}) : any {
  const calls: any[] = [];
  const publishCalls: any[] = [];
  const tarballs: any = new Map<any, any>();
  const runner: any = async (args: any, { cwd }: Record<string, any>) : Promise<any> => {
    calls.push({ args: [...args], cwd });
    if (args[0] === "pack") {
      const manifest: any = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"));
      const filename: any = filenameFor(manifest.name, manifest.version);
      const integrity: any = integrityFor(manifest.name);
      const destination: any = args[args.indexOf("--pack-destination") + 1];
      const tarballPath: any = path.join(destination, filename);
      await fs.writeFile(tarballPath, `fixture:${manifest.name}`, "utf8");
      tarballs.set(tarballPath, {
        spec: `${manifest.name}@${manifest.version}`,
        integrity,
        name: manifest.name
      });
      return {
        exitCode: 0,
        stdout: JSON.stringify([{
          name: manifest.name,
          version: manifest.version,
          filename,
          integrity
        }]),
        stderr: ""
      };
    }
    if (args[0] === "view") {
      const key: any = args[2] === "dist-tags" ? tagsKey(args[1]) : args[1];
      if (!registry.has(key)) {
        return { exitCode: 1, stdout: "", stderr: "npm error code E404" };
      }
      return { exitCode: 0, stdout: JSON.stringify(registry.get(key)), stderr: "" };
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
      publishCalls.push({ args: [...args], ...tarball });
      return { exitCode: 0, stdout: "+ fixture", stderr: "" };
    }
    if (args[0] === "install") {
      return { exitCode: 0, stdout: "fixture install", stderr: "" };
    }
    if (args[0] === "audit" && args[1] === "signatures") {
      return { exitCode: 0, stdout: JSON.stringify({ verifiedSignatures: 9 }), stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "fixture unsupported command" };
  };
  return { calls, publishCalls, registry, runner };
}

describe("npm release-set publication", () : any => {
  it("discovers public workspaces plus the connector and orders every internal dependency before the root", async () : Promise<any> => {
    const releaseSet: any = await discoverReleaseSet({ rootDir: ROOT });
    const names: any = releaseSet.packages.map(({ name }: Record<string, any>) : any => name);
    const positions: any = new Map<any, any>(names.map((name?: any, index?: any) : any => [name, index]));

    expect(names).toHaveLength(9);
    expect(names).toContain("meshrix-mcp-connector");
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

  it("keeps dry-run fully offline while packing the complete real release set", async () : Promise<any> => {
    const injected: any = createInjectedNpmRunner();
    const result: any = await publishReleaseSet({
      rootDir: ROOT,
      dryRun: true,
      runner: injected.runner,
      environment: {}
    });

    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      version: "0.0.1",
      tag: "latest",
      packageCount: 9
    });
    expect(result.packages.map(({ action }: Record<string, any>) : any => action)).toEqual(Array(9).fill("planned"));
    expect(injected.calls).toHaveLength(9);
    expect(injected.calls.every(({ args }: Record<string, any>) : any => args[0] === "pack")).toBe(true);
  });

  it("preflights every package against the registry without publication credentials or mutations", async () : Promise<any> => {
    const injected: any = createInjectedNpmRunner();
    const result: any = await publishReleaseSet({
      rootDir: ROOT,
      preflight: true,
      runner: injected.runner,
      environment: { NPM_TOKEN: "<unused-preflight-token>" }
    });

    expect(result).toMatchObject({
      ok: true,
      dryRun: false,
      preflight: true,
      version: "0.0.1",
      tag: "latest",
      packageCount: 9
    });
    expect(result.packages.map(({ action }: Record<string, any>) : any => action)).toEqual(Array(9).fill("publish"));
    expect(injected.calls.filter(({ args }: Record<string, any>) : any => args[0] === "pack")).toHaveLength(9);
    expect(injected.calls.filter(({ args }: Record<string, any>) : any => args[0] === "view")).toHaveLength(18);
    expect(injected.calls.some(({ args }: Record<string, any>) : any => (
      args[0] === "publish" || args[0] === "install" || args[0] === "audit"
    ))).toBe(false);
  });

  it("keeps local dry-run and registry preflight as separate modes", () : any => {
    expect(parsePublishArguments(["--preflight", "--tag", "next"]))
      .toEqual({ dryRun: false, preflight: true, tag: "next", help: false });
    expect(() : any => parsePublishArguments(["--dry-run", "--preflight"]))
      .toThrowError(expect.objectContaining({ code: "release_set_argument_conflict" }));
  });

  it("publishes missing tarballs with provenance once and skips matching immutable versions on rerun", async () : Promise<any> => {
    const releaseSet: any = await discoverReleaseSet({ rootDir: ROOT });
    const alreadyPublished: any = releaseSet.packages[0];
    const registry: any = new Map<any, any>();
    addPublishedVersion(registry, alreadyPublished);
    const injected: any = createInjectedNpmRunner({ registry });

    const first: any = await publishReleaseSet({
      rootDir: ROOT,
      runner: injected.runner,
      environment: {}
    });
    expect(first.packages.filter(({ action }: Record<string, any>) : any => action === "skipped").map(({ name }: Record<string, any>) : any => name))
      .toEqual([alreadyPublished.name]);
    expect(first.packages.filter(({ action }: Record<string, any>) : any => action === "published")).toHaveLength(8);
    expect(injected.calls.slice(0, 9).every(({ args }: Record<string, any>) : any => args[0] === "pack")).toBe(true);
    expect(injected.publishCalls.map(({ name }: Record<string, any>) : any => name)).toEqual(
      first.packages.filter(({ action }: Record<string, any>) : any => action === "published").map(({ name }: Record<string, any>) : any => name)
    );
    for (const { args } of injected.publishCalls) {
      expect(args).toContain("--provenance");
      expect(args.slice(args.indexOf("--access"), args.indexOf("--access") + 2))
        .toEqual(["--access", "public"]);
      expect(args.slice(args.indexOf("--tag"), args.indexOf("--tag") + 2))
        .toEqual(["--tag", "latest"]);
      expect(args.join(" ")).not.toContain("npm@latest");
    }
    expect(injected.calls.some(({ args }: Record<string, any>) : any => args[0] === "install")).toBe(true);
    expect(injected.calls.some(({ args }: Record<string, any>) : any => (
      args[0] === "audit" && args[1] === "signatures" && args.includes("--include-attestations")
    ))).toBe(true);

    const publishedCallCount: any = injected.publishCalls.length;
    const second: any = await publishReleaseSet({
      rootDir: ROOT,
      runner: injected.runner,
      environment: {}
    });
    expect(second.packages.every(({ action }: Record<string, any>) : any => action === "skipped")).toBe(true);
    expect(injected.publishCalls).toHaveLength(publishedCallCount);
  });

  it("fails closed when an immutable registry version has different content", async () : Promise<any> => {
    const releaseSet: any = await discoverReleaseSet({ rootDir: ROOT });
    const first: any = releaseSet.packages[0];
    const registry: any = new Map<any, any>();
    addPublishedVersion(registry, first, { integrity: integrityFor("different-content") });
    const injected: any = createInjectedNpmRunner({ registry });

    await expect(publishReleaseSet({
      rootDir: ROOT,
      runner: injected.runner,
      environment: {}
    })).rejects.toMatchObject({ code: "release_set_registry_integrity_mismatch" });
    expect(injected.publishCalls).toHaveLength(0);
  });

  it("preflights every package before publishing when a late immutable version conflicts", async () : Promise<any> => {
    const releaseSet: any = await discoverReleaseSet({ rootDir: ROOT });
    const last: any = releaseSet.packages.at(-1);
    const registry: any = new Map<any, any>();
    addPublishedVersion(registry, last, { integrity: integrityFor("different-content") });
    const injected: any = createInjectedNpmRunner({ registry });

    await expect(publishReleaseSet({
      rootDir: ROOT,
      runner: injected.runner,
      environment: {}
    })).rejects.toMatchObject({ code: "release_set_registry_integrity_mismatch" });
    expect(injected.publishCalls).toHaveLength(0);
    expect(injected.calls.filter(({ args }: Record<string, any>) : any => args[0] === "view")).toHaveLength(18);
  });

  it("requires signatures and provenance before accepting an existing immutable version", async () : Promise<any> => {
    const releaseSet: any = await discoverReleaseSet({ rootDir: ROOT });
    const first: any = releaseSet.packages[0];
    const registry: any = new Map<any, any>();
    addPublishedVersion(registry, first, {
      distribution: {
        integrity: integrityFor(first.name),
        signatures: publishedDistribution(first.name, first.version).signatures
      }
    });
    const injected: any = createInjectedNpmRunner({ registry });

    await expect(publishReleaseSet({
      rootDir: ROOT,
      runner: injected.runner,
      environment: {}
    })).rejects.toMatchObject({ code: "release_set_registry_provenance_missing" });
    expect(injected.publishCalls).toHaveLength(0);
  });

  it("preserves a newer tag for an existing version and rejects tag regression for a missing version", async () : Promise<any> => {
    const releaseSet: any = await discoverReleaseSet({ rootDir: ROOT });
    const first: any = releaseSet.packages[0];
    const existingRegistry: any = new Map<any, any>();
    addPublishedVersion(existingRegistry, first, { taggedVersion: "9.0.0" });
    const existingInjected: any = createInjectedNpmRunner({ registry: existingRegistry });
    const result: any = await publishReleaseSet({
      rootDir: ROOT,
      runner: existingInjected.runner,
      environment: {}
    });
    expect(result.packages.find(({ name }: Record<string, any>) : any => name === first.name)?.action).toBe("skipped");
    expect(existingRegistry.get(tagsKey(first.name))).toEqual({ latest: "9.0.0" });

    const missingRegistry: any = new Map<any, any>([[tagsKey(first.name), { latest: "9.0.0" }]]);
    const missingInjected: any = createInjectedNpmRunner({ registry: missingRegistry });
    await expect(publishReleaseSet({
      rootDir: ROOT,
      runner: missingInjected.runner,
      environment: {}
    })).rejects.toMatchObject({ code: "release_set_registry_tag_regression" });
    expect(missingInjected.publishCalls).toHaveLength(0);
  });

  it("fails closed when an existing version would require an OIDC dist-tag repair", async () : Promise<any> => {
    const releaseSet: any = await discoverReleaseSet({ rootDir: ROOT });
    const first: any = releaseSet.packages[0];
    const registry: any = new Map<any, any>();
    addPublishedVersion(registry, first, { taggedVersion: "0.0.0" });
    const injected: any = createInjectedNpmRunner({ registry });

    await expect(publishReleaseSet({
      rootDir: ROOT,
      runner: injected.runner,
      environment: {}
    })).rejects.toMatchObject({ code: "release_set_registry_tag_repair_required" });
    expect(injected.publishCalls).toHaveLength(0);
  });

  it("fails closed when npm cannot cryptographically verify the published package set", async () : Promise<any> => {
    const injected: any = createInjectedNpmRunner();
    const runner: any = async (args?: any, context?: any) : Promise<any> => {
      if (args[0] === "audit" && args[1] === "signatures") {
        return { exitCode: 1, stdout: "", stderr: "fixture signature failure" };
      }
      return injected.runner(args, context);
    };

    await expect(publishReleaseSet({
      rootDir: ROOT,
      runner,
      environment: {}
    })).rejects.toMatchObject({ code: "release_set_registry_signature_audit_failed" });
  });

  it("uses only latest or next and refuses raw npm token publication", async () : Promise<any> => {
    expect(releaseTagForVersion("1.2.3")).toBe("latest");
    expect(releaseTagForVersion("1.2.3-rc.1")).toBe("next");
    expect(compareReleaseVersions("1.2.3", "1.2.3-rc.9")).toBeGreaterThan(0);
    expect(compareReleaseVersions("1.2.3-rc.10", "1.2.3-rc.2")).toBeGreaterThan(0);
    expect(compareReleaseVersions("100000000000000000000.0.0", "9.0.0")).toBeGreaterThan(0);
    const injected: any = createInjectedNpmRunner();
    await expect(publishReleaseSet({
      rootDir: ROOT,
      runner: injected.runner,
      environment: { NPM_TOKEN: "<raw-token>" }
    })).rejects.toMatchObject({ code: "release_set_raw_npm_token_forbidden" });
    expect(injected.calls).toHaveLength(0);
  });
});
