import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { init, parse } from "es-module-lexer";
import { describe, expect, it } from "vitest";
import { validateLocalJsonSchemaReference } from "../../../tools/verifiers/registry-json-schema.mjs";

await init;

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DOMAIN_PACKAGES = Object.freeze(["agents", "capabilities"]);
const MODULE_EXTENSIONS = new Set([".cjs", ".js", ".mjs", ".ts", ".tsx"]);
const GENERATED_DIRECTORY_NAMES = new Set(["build", "coverage", "dist", "node_modules"]);
const PACKAGE_ROOT_ENTRIES = Object.freeze([
  "LICENSE",
  "README.md",
  "manifest.module.json",
  "package.json",
  "src"
]);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, relativePath), "utf8"));
}

function manifestFor(packageId) {
  return readJson(`packages/${packageId}/manifest.module.json`);
}

function listFiles(absolutePath) {
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) return [absolutePath];
  const files = [];
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    const childPath = path.join(absolutePath, entry.name);
    if (entry.isDirectory()) {
      if (GENERATED_DIRECTORY_NAMES.has(entry.name)) continue;
      files.push(...listFiles(childPath));
    } else if (entry.isFile()) {
      files.push(childPath);
    }
  }
  return files.sort();
}

const DECORATIVE_GENERIC_DIRECTORY_NAMES = new Set([
  "common",
  "helpers",
  "internal",
  "lib",
  "misc",
  "shared",
  "tools",
  "utils"
]);

function listEmptyDirectories(absolutePath) {
  const empty = [];
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (GENERATED_DIRECTORY_NAMES.has(entry.name)) continue;
    const childPath = path.join(absolutePath, entry.name);
    const childEntries = fs.readdirSync(childPath, { withFileTypes: true });
    if (childEntries.length === 0) {
      empty.push(childPath);
    } else {
      empty.push(...listEmptyDirectories(childPath));
    }
  }
  return empty;
}

function listDecorativeWrapperDirectories(absolutePath) {
  const decorative = [];
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (GENERATED_DIRECTORY_NAMES.has(entry.name)) continue;
    const childPath = path.join(absolutePath, entry.name);
    const childEntries = fs.readdirSync(childPath, { withFileTypes: true })
      .filter((child) => !GENERATED_DIRECTORY_NAMES.has(child.name));
    const files = childEntries.filter((child) => child.isFile());
    const directories = childEntries.filter((child) => child.isDirectory());
    const meaningfulFiles = files.filter((child) => path.basename(child.name) !== ".gitkeep");
    if (meaningfulFiles.length === 0 && directories.length === 1) {
      decorative.push(childPath);
    }
    decorative.push(...listDecorativeWrapperDirectories(childPath));
  }
  return decorative;
}

function relativePath(absolutePath) {
  return path.relative(PROJECT_ROOT, absolutePath).split(path.sep).join("/");
}

function wildcardExpression(pattern) {
  const escaped = String(pattern)
    .split("*")
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "u");
}

function executableSourcePaths(suite) {
  return (Array.isArray(suite.args) ? suite.args : [])
    .filter((argument) => /\.(?:cjs|js|mjs|ts|tsx)$/u.test(String(argument)))
    .filter((argument) => {
      const normalized = String(argument).split(path.sep).join("/");
      return !normalized.startsWith("/") && !normalized.split("/").includes("..");
    })
    .filter((argument) => {
      const absolutePath = path.join(PROJECT_ROOT, argument);
      return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile();
    });
}

function packageIdFromInternalSpecifier(specifier) {
  const match = String(specifier).match(/^(?:@meshrix\/|#meshrix\/)([^/]+)/u);
  return match?.[1] || null;
}

function layerForResolvedPath(absolutePath, dependencyRules) {
  const relative = relativePath(absolutePath);
  return dependencyRules.layers
    .filter((layer) => relative === layer.directory || relative.startsWith(`${layer.directory}/`))
    .sort((left, right) => right.directory.length - left.directory.length)[0]?.id || null;
}

function actualInternalDependencies(packageId, sourceFiles, dependencyRules) {
  const dependencies = new Set();
  for (const sourceFile of sourceFiles.filter((file) => MODULE_EXTENSIONS.has(path.extname(file)))) {
    const source = fs.readFileSync(sourceFile, "utf8");
    const [imports] = parse(source);
    for (const entry of imports) {
      const specifier = entry.n;
      if (!specifier) continue;
      const packageDependency = packageIdFromInternalSpecifier(specifier);
      if (packageDependency) {
        dependencies.add(packageDependency);
        continue;
      }
      if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(sourceFile), specifier);
        const layer = layerForResolvedPath(resolved, dependencyRules);
        if (layer) dependencies.add(layer);
      }
    }
  }
  dependencies.delete(packageId);
  return [...dependencies].sort();
}

function packageManifestInternalDependencies(packageId) {
  const packageManifest = readJson(`packages/${packageId}/package.json`);
  const declared = {
    ...(packageManifest.dependencies || {}),
    ...(packageManifest.optionalDependencies || {}),
    ...(packageManifest.peerDependencies || {})
  };
  return Object.keys(declared)
    .map(packageIdFromInternalSpecifier)
    .filter(Boolean)
    .sort();
}

describe("domains.manifest", () => {
  describe.each(DOMAIN_PACKAGES)("package: %s", (packageId) => {
    const packageDirectory = path.join(PROJECT_ROOT, "packages", packageId);
    const manifestPath = `packages/${packageId}/manifest.module.json`;

    it("conforms to the domain-package schema", async () => {
      const manifest = manifestFor(packageId);
      const issues = await validateLocalJsonSchemaReference(manifest, manifestPath, {
        registryDir: PROJECT_ROOT
      });

      expect(issues).toEqual([]);
      expect(manifest.id).toBe(packageId);
      expect(manifest.directory).toBe(`packages/${packageId}`);
    });

    it("owns every current src root with a non-empty exact file count", () => {
      const manifest = manifestFor(packageId);
      const sourceDirectory = path.join(packageDirectory, "src");
      const ownershipPaths = manifest.sourceOwnership.map((entry) => entry.path);
      const ownershipFeatures = manifest.sourceOwnership.map((entry) => entry.feature);
      const sourceRoots = fs.readdirSync(sourceDirectory, { withFileTypes: true })
        .map((entry) => `src/${entry.name}`)
        .sort();

      expect(new Set(ownershipPaths).size).toBe(ownershipPaths.length);
      expect(new Set(ownershipFeatures).size).toBe(ownershipFeatures.length);
      expect([...ownershipPaths].sort()).toEqual(sourceRoots);

      const ownedFiles = [];
      for (const ownership of manifest.sourceOwnership) {
        const ownedPath = path.join(packageDirectory, ownership.path);
        expect(fs.existsSync(ownedPath), `${packageId}:${ownership.path} must exist`).toBe(true);
        const files = listFiles(ownedPath);
        expect(files.length, `${packageId}:${ownership.path} must not be empty`).toBeGreaterThan(0);
        expect(files.length, `${packageId}:${ownership.path} fileCount is stale`).toBe(ownership.fileCount);
        expect(files.some((file) => path.basename(file) === ".gitkeep")).toBe(false);
        ownedFiles.push(...files);
      }

      expect([...new Set(ownedFiles)].sort()).toEqual(listFiles(sourceDirectory));
    });

    it("contains no decorative empty directory or placeholder test tree", () => {
      const packageEntries = fs.readdirSync(packageDirectory)
        .filter((entry) => !GENERATED_DIRECTORY_NAMES.has(entry))
        .sort();
      expect(packageEntries).toEqual([...PACKAGE_ROOT_ENTRIES].sort());
      expect(listEmptyDirectories(packageDirectory).map(relativePath)).toEqual([]);
      expect(
        listFiles(packageDirectory).filter((file) => path.basename(file) === ".gitkeep").map(relativePath)
      ).toEqual([]);
      expect(fs.existsSync(path.join(packageDirectory, "tests"))).toBe(false);

      const sourceDirectory = path.join(packageDirectory, "src");
      const genericTopLevel = fs.readdirSync(sourceDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && DECORATIVE_GENERIC_DIRECTORY_NAMES.has(entry.name))
        .map((entry) => relativePath(path.join(sourceDirectory, entry.name)));
      expect(genericTopLevel).toEqual([]);
      expect(listDecorativeWrapperDirectories(sourceDirectory).map(relativePath)).toEqual([]);
    });
  });

  it("resolves every feature testSuite pattern to a runnable registered source", () => {
    const registry = readJson("tools/registry/tests.registry.json");
    expect(Array.isArray(registry.suites)).toBe(true);

    for (const packageId of DOMAIN_PACKAGES) {
      const manifest = manifestFor(packageId);
      for (const ownership of manifest.sourceOwnership) {
        for (const suitePattern of ownership.testSuites) {
          const expression = wildcardExpression(suitePattern);
          const matchedSuites = registry.suites.filter((suite) => expression.test(suite.id));
          expect(
            matchedSuites.length,
            `${packageId}:${ownership.feature} testSuite ${suitePattern} matches no registered suite`
          ).toBeGreaterThan(0);

          const runnableSuites = matchedSuites.filter((suite) => (
            suite.flakePolicy !== "skip" && executableSourcePaths(suite).length > 0
          ));
          expect(
            runnableSuites.length,
            `${packageId}:${ownership.feature} testSuite ${suitePattern} has no runnable source`
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it("treats testSuite wildcards as match requirements rather than future intent", () => {
    const expression = wildcardExpression("agent-*.runtime");
    expect(expression.test("agent-memory.runtime")).toBe(true);
    expect(expression.test("agent-memory.integration")).toBe(false);
    expect(wildcardExpression("workspace-governance.runtime").test("workspace-governance.runtime")).toBe(true);
  });

  it("binds public API declarations to active aliases and package exports", () => {
    const registry = readJson("tools/registry/public-api.registry.json");
    const activeAliases = registry.aliases.filter((entry) => entry.status === "active");

    for (const packageId of DOMAIN_PACKAGES) {
      const manifest = manifestFor(packageId);
      const packageManifest = readJson(`packages/${packageId}/package.json`);
      expect(packageManifest.exports?.["./*"]).toBe("./src/*.mjs");

      for (const apiEntry of manifest.publicApi) {
        const alias = activeAliases.find((entry) => entry.alias === apiEntry);
        expect(alias, `${packageId}:${apiEntry} must be an active exact public alias`).toBeDefined();
        expect(alias.domainPackage).toBe(packageId);
        expect(alias.targetPath).toContain(`packages/${packageId}/src/`);
      }
    }
  });

  it("matches declared dependencies to source imports, package manifests, and layer rules", () => {
    const dependencyRules = readJson("tools/registry/dependency-rules.registry.json");

    for (const packageId of DOMAIN_PACKAGES) {
      const manifest = manifestFor(packageId);
      const sourceFiles = manifest.sourceOwnership.flatMap((ownership) => (
        listFiles(path.join(PROJECT_ROOT, manifest.directory, ownership.path))
      ));
      const actualDependencies = actualInternalDependencies(packageId, sourceFiles, dependencyRules);
      const declaredDependencies = [...manifest.dependsOn].sort();
      const packageDependencies = packageManifestInternalDependencies(packageId);
      const layer = dependencyRules.layers.find((entry) => entry.id === packageId);

      expect(layer, `${packageId} must have a dependency-rule layer`).toBeDefined();
      expect(declaredDependencies).toEqual(actualDependencies);
      expect(packageDependencies).toEqual(actualDependencies);
      expect(actualDependencies.every((dependency) => layer.allowedDependsOn.includes(dependency))).toBe(true);
      expect(actualDependencies.some((dependency) => layer.forbiddenDependsOn.includes(dependency))).toBe(false);
    }
  });
});
