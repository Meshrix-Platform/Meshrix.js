import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertReleaseVersion,
  parseReleaseArguments,
  prepareRelease
} from "../../../tools/server-scripts/prepare-release.ts";

const INITIAL_VERSION: any = "0.0.1";
const WORKSPACES: readonly any[] = Object.freeze(["packages/contracts", "apps/server"]);
const GATEWAY_MANIFEST: any = "packages/protocols/mcp/adapter/gateway-installer/package.json";

async function writeJson(rootDir?: any, relativePath?: any, value?: any) : Promise<any> {
  const filePath: any = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createFixture({ lockDependencyVersion = INITIAL_VERSION }: Record<string, any> = {}) : Promise<any> {
  const rootDir: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-release-prepare-"));
  await writeJson(rootDir, "package.json", {
    name: "meshrix",
    version: INITIAL_VERSION,
    workspaces: WORKSPACES,
    dependencies: {
      "@meshrix/contracts": INITIAL_VERSION,
      "external-package": "^1.0.0"
    }
  });
  await writeJson(rootDir, "packages/contracts/package.json", {
    name: "@meshrix/contracts",
    version: INITIAL_VERSION,
    schemaVersion: "fixture-schema-current"
  });
  await writeJson(rootDir, "apps/server/package.json", {
    name: "@meshrix/server",
    version: INITIAL_VERSION,
    private: true,
    dependencies: {
      "@meshrix/contracts": INITIAL_VERSION
    }
  });
  await writeJson(rootDir, GATEWAY_MANIFEST, {
    name: "meshrix-mcp-connector",
    version: INITIAL_VERSION,
    type: "module"
  });
  await writeJson(rootDir, "package-lock.json", {
    name: "meshrix",
    version: INITIAL_VERSION,
    lockfileVersion: 3,
    packages: {
      "": {
        name: "meshrix",
        version: INITIAL_VERSION,
        workspaces: WORKSPACES,
        dependencies: {
          "@meshrix/contracts": lockDependencyVersion,
          "external-package": "^1.0.0"
        }
      },
      "packages/contracts": {
        name: "@meshrix/contracts",
        version: INITIAL_VERSION,
        schemaVersion: "fixture-schema-current"
      },
      "apps/server": {
        name: "@meshrix/server",
        version: INITIAL_VERSION,
        dependencies: {
          "@meshrix/contracts": lockDependencyVersion
        }
      },
      "node_modules/@meshrix/contracts": {
        resolved: "packages/contracts",
        link: true
      },
      "node_modules/@meshrix/server": {
        resolved: "apps/server",
        link: true
      }
    }
  });
  await fs.writeFile(
    path.join(rootDir, "CHANGELOG.md"),
    "# Changelog\n\n## Unreleased\n\n- Added the release fixture.\n",
    "utf8"
  );
  return rootDir;
}

async function withFixture(options?: any, testCase?: any) : Promise<any> {
  const rootDir: any = await createFixture(options);
  try {
    return await testCase(rootDir);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

describe("release package version preparation", () : any => {
  it("atomically synchronizes manifests, internal dependencies, lock entries, and changelog", async () : Promise<any> => {
    await withFixture({}, async (rootDir?: any) : Promise<any> => {
      const version: any = "1.2.3-beta.1";
      const result: any = await prepareRelease({
        rootDir,
        version,
        date: "2026-07-11"
      });

      expect(result).toMatchObject({
        ok: true,
        mode: "write",
        version,
        manifestCount: 4,
        workspaceCount: 2
      });
      const rootPackage: any = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
      const contracts: any = JSON.parse(
        await fs.readFile(path.join(rootDir, "packages/contracts/package.json"), "utf8")
      );
      const server: any = JSON.parse(
        await fs.readFile(path.join(rootDir, "apps/server/package.json"), "utf8")
      );
      const gateway: any = JSON.parse(await fs.readFile(path.join(rootDir, GATEWAY_MANIFEST), "utf8"));
      const lock: any = JSON.parse(await fs.readFile(path.join(rootDir, "package-lock.json"), "utf8"));
      const changelog: any = await fs.readFile(path.join(rootDir, "CHANGELOG.md"), "utf8");

      expect(rootPackage.version).toBe(version);
      expect(rootPackage.dependencies).toEqual({
        "@meshrix/contracts": version,
        "external-package": "^1.0.0"
      });
      expect(contracts).toMatchObject({
        version,
        schemaVersion: "fixture-schema-current"
      });
      expect(server).toMatchObject({
        version,
        dependencies: { "@meshrix/contracts": version }
      });
      expect(gateway.version).toBe(version);
      expect(lock.version).toBe(version);
      expect(lock.packages[""].version).toBe(version);
      expect(lock.packages["packages/contracts"].version).toBe(version);
      expect(lock.packages["apps/server"]).toMatchObject({
        version,
        dependencies: { "@meshrix/contracts": version }
      });
      expect(lock.packages["node_modules/@meshrix/contracts"]).toEqual({
        resolved: "packages/contracts",
        link: true
      });
      expect(changelog).toContain("## [1.2.3-beta.1] - 2026-07-11");
      expect(changelog).toContain("- Added the release fixture.");
      await expect(prepareRelease({ rootDir, version, check: true })).resolves.toMatchObject({
        ok: true,
        mode: "check",
        changedFiles: []
      });
    });
  });

  it("keeps check mode read-only and rejects invalid versions or inconsistent lock dependencies", async () : Promise<any> => {
    expect(parseReleaseArguments(["--check", INITIAL_VERSION])).toMatchObject({
      check: true,
      version: INITIAL_VERSION
    });
    expect(parseReleaseArguments(["--check", "--tag", "v1.2.3-beta.1"]).version).toBe(
      "1.2.3-beta.1"
    );
    expect(() : any => assertReleaseVersion("01.2.3")).toThrow(/valid SemVer/);
    expect(() : any => assertReleaseVersion("1.2.3+build.1")).toThrow(/without build metadata/);

    await withFixture({ lockDependencyVersion: "0.0.0" }, async (rootDir?: any) : Promise<any> => {
      const changelogPath: any = path.join(rootDir, "CHANGELOG.md");
      await fs.writeFile(
        changelogPath,
        "# Changelog\n\n## Unreleased\n\nNo unreleased changes.\n\n## [0.0.1] - 2026-07-11\n\n- Initial release.\n",
        "utf8"
      );
      const lockPath: any = path.join(rootDir, "package-lock.json");
      const before: any = await fs.readFile(lockPath, "utf8");
      await expect(
        prepareRelease({ rootDir, version: INITIAL_VERSION, check: true })
      ).rejects.toMatchObject({
        code: "release_state_mismatch",
        findings: expect.arrayContaining([
          expect.objectContaining({ code: "release_internal_dependency_version_mismatch" })
        ])
      });
      expect(await fs.readFile(lockPath, "utf8")).toBe(before);
    });
  });
});
