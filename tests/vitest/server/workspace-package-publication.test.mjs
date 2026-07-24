import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function readPackage(relativeDirectory) {
  return JSON.parse(
    fs.readFileSync(path.join(root, relativeDirectory, "package.json"), "utf8")
  );
}

describe("workspace package publication boundary", () => {
  it("publishes the Meshrix Core package from the LicoLand GitHub organization", () => {
    expect(rootPackage).toMatchObject({
      name: "meshrix",
      description: expect.stringContaining("Meshrix"),
      author: "Meshrix Maintainers",
      repository: {
        type: "git",
        url: "git+https://github.com/LicoLand/Meshrix.git"
      },
      bugs: {
        url: "https://github.com/LicoLand/Meshrix/issues"
      },
      homepage: "https://meshrix.io"
    });
  });

  it("retains the shared @meshrix package and #meshrix import namespaces", () => {
    const foundationWorkspace = "packages/foundation";

    expect(rootPackage.workspaces).toContain(foundationWorkspace);
    expect(readPackage(foundationWorkspace).name).toBe("@meshrix/foundation");
    expect(rootPackage.imports["#meshrix/foundation/*"]).toBe(
      "./packages/foundation/src/*.mjs"
    );
  });

  it("keeps every workspace versioned, licensed, and repository-addressable", () => {
    for (const relativeDirectory of rootPackage.workspaces) {
      const manifest = readPackage(relativeDirectory);
      expect(manifest.version, `${manifest.name} version`).toBe(rootPackage.version);
      expect(manifest.license, `${manifest.name} license`).toBe("GPL-3.0-or-later");
      expect(manifest.repository, `${manifest.name} repository`).toEqual({
        type: "git",
        url: rootPackage.repository.url,
        directory: relativeDirectory
      });
      expect(manifest.engines, `${manifest.name} engines`).toEqual(rootPackage.engines);

      for (const [dependencyName, dependencyVersion] of Object.entries({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies
      })) {
        if (dependencyName.startsWith("@meshrix/")) {
          expect(dependencyVersion, `${manifest.name} -> ${dependencyName}`).toBe(rootPackage.version);
        }
      }
    }
  });

  it("keeps application workspaces private and library workspaces publishable", () => {
    for (const relativeDirectory of rootPackage.workspaces) {
      const manifest = readPackage(relativeDirectory);
      if (relativeDirectory.startsWith("apps/")) {
        expect(manifest.private, manifest.name).toBe(true);
      } else {
        expect(manifest.private, manifest.name).not.toBe(true);
        expect(fs.existsSync(path.join(root, relativeDirectory, "README.md")), manifest.name).toBe(true);
      }
      expect(fs.existsSync(path.join(root, relativeDirectory, "LICENSE")), manifest.name).toBe(true);
    }
  });

  it("packs legal and package documentation without repository instructions", () => {
    const packResult = JSON.parse(
      execFileSync("npm", ["pack", "--workspaces", "--dry-run", "--json"], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024
      })
    );
    const packed = Array.isArray(packResult) ? packResult : Object.values(packResult);
    expect(packed).toHaveLength(rootPackage.workspaces.length);
    for (const artifact of packed) {
      const files = artifact.files.map((entry) => entry.path);
      expect(files).toContain("LICENSE");
      expect(
        artifact.files.filter((entry) => entry.size > 8 * 1024 * 1024),
        `${artifact.name} oversized entries`
      ).toEqual([]);
      if (!readPackage(rootPackage.workspaces.find((directory) => readPackage(directory).name === artifact.name)).private) {
        expect(files).toContain("README.md");
      }
      if (artifact.name === "@meshrix/foundation") {
        expect(files).toContain("config/entity-config/auth/console-roles.json");
        expect(files).toContain("config/entity-config/tools/scopes/auth-admin.json");
      }
    }
  });
});
