import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { init, parse } from "es-module-lexer";
import { describe, expect, it } from "vitest";
import { validateLocalJsonSchemaReference } from "../../../tools/verifiers/registry-json-schema.ts";

await init;

const PROJECT_ROOT: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DOMAIN_PACKAGES: readonly any[] = Object.freeze(["agents", "capabilities"]);
const MODULE_EXTENSIONS: any = new Set<any>([".cjs", ".js", ".ts", ".ts", ".tsx"]);
const GENERATED_DIRECTORY_NAMES: any = new Set<any>(["build", "coverage", "dist", "node_modules"]);
const PACKAGE_ROOT_ENTRIES: readonly any[] = Object.freeze([
  "LICENSE",
  "README.md",
  "manifest.module.json",
  "package.json",
  "src"
]);

function readJson(relativePath?: any) : any {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, relativePath), "utf8"));
}

function manifestFor(packageId?: any) : any {
  return readJson(`packages/${packageId}/manifest.module.json`);
}

function listFiles(absolutePath?: any) : any {
  const stat: any = fs.statSync(absolutePath);
  if (stat.isFile()) return [absolutePath];
  const files: any[] = [];
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    const childPath: any = path.join(absolutePath, entry.name);
    if (entry.isDirectory()) {
      if (GENERATED_DIRECTORY_NAMES.has(entry.name)) continue;
      files.push(...listFiles(childPath));
    } else if (entry.isFile()) {
      files.push(childPath);
    }
  }
  return files.sort();
}

const DECORATIVE_GENERIC_DIRECTORY_NAMES: any = new Set<any>([
  "common",
  "helpers",
  "internal",
  "lib",
  "misc",
  "shared",
  "tools",
  "utils"
]);

function listEmptyDirectories(absolutePath?: any) : any {
  const empty: any[] = [];
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (GENERATED_DIRECTORY_NAMES.has(entry.name)) continue;
    const childPath: any = path.join(absolutePath, entry.name);
    const childEntries: any = fs.readdirSync(childPath, { withFileTypes: true });
    if (childEntries.length === 0) {
      empty.push(childPath);
    } else {
      empty.push(...listEmptyDirectories(childPath));
    }
  }
  return empty;
}

function listDecorativeWrapperDirectories(absolutePath?: any) : any {
  const decorative: any[] = [];
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (GENERATED_DIRECTORY_NAMES.has(entry.name)) continue;
    const childPath: any = path.join(absolutePath, entry.name);
    const childEntries: any = fs.readdirSync(childPath, { withFileTypes: true })
      .filter((child?: any) : any => !GENERATED_DIRECTORY_NAMES.has(child.name));
    const files: any = childEntries.filter((child?: any) : any => child.isFile());
    const directories: any = childEntries.filter((child?: any) : any => child.isDirectory());
    const meaningfulFiles: any = files.filter((child?: any) : any => path.basename(child.name) !== ".gitkeep");
    if (meaningfulFiles.length === 0 && directories.length === 1) {
      decorative.push(childPath);
    }
    decorative.push(...listDecorativeWrapperDirectories(childPath));
  }
  return decorative;
}

function relativePath(absolutePath?: any) : any {
  return path.relative(PROJECT_ROOT, absolutePath).split(path.sep).join("/");
}

function wildcardExpression(pattern?: any) : any {
  const escaped: any = String(pattern)
    .split("*")
    .map((segment?: any) : any => segment.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "u");
}

function executableSourcePaths(suite?: any) : any {
  return (Array.isArray(suite.args) ? suite.args : [])
    .filter((argument?: any) : any => /\.(?:cjs|js|mjs|ts|tsx)$/u.test(String(argument)))
    .filter((argument?: any) : any => {
      const normalized: any = String(argument).split(path.sep).join("/");
      return !normalized.startsWith("/") && !normalized.split("/").includes("..");
    })
    .filter((argument?: any) : any => {
      const absolutePath: any = path.join(PROJECT_ROOT, argument);
      return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile();
    });
}

function packageIdFromInternalSpecifier(specifier?: any) : any {
  const match: any = String(specifier).match(/^(?:@meshrix\/|#meshrix\/)([^/]+)/u);
  return match?.[1] || null;
}

function layerForResolvedPath(absolutePath?: any, dependencyRules?: any) : any {
  const relative: any = relativePath(absolutePath);
  return dependencyRules.layers
    .filter((layer?: any) : any => relative === layer.directory || relative.startsWith(`${layer.directory}/`))
    .sort((left?: any, right?: any) : any => right.directory.length - left.directory.length)[0]?.id || null;
}

function actualInternalDependencies(packageId?: any, sourceFiles?: any, dependencyRules?: any) : any {
  const dependencies: any = new Set<any>();
  for (const sourceFile of sourceFiles.filter((file?: any) : any => MODULE_EXTENSIONS.has(path.extname(file)))) {
    const source: any = fs.readFileSync(sourceFile, "utf8");
    const [imports] = parse(source);
    for (const entry of imports) {
      const specifier: any = entry.n;
      if (!specifier) continue;
      const packageDependency: any = packageIdFromInternalSpecifier(specifier);
      if (packageDependency) {
        dependencies.add(packageDependency);
        continue;
      }
      if (specifier.startsWith(".")) {
        const resolved: any = path.resolve(path.dirname(sourceFile), specifier);
        const layer: any = layerForResolvedPath(resolved, dependencyRules);
        if (layer) dependencies.add(layer);
      }
    }
  }
  dependencies.delete(packageId);
  return [...dependencies].sort();
}

function packageManifestInternalDependencies(packageId?: any) : any {
  const packageManifest: any = readJson(`packages/${packageId}/package.json`);
  const declared: Record<string, any> = {
    ...(packageManifest.dependencies || {}),
    ...(packageManifest.optionalDependencies || {}),
    ...(packageManifest.peerDependencies || {})
  };
  return Object.keys(declared)
    .map(packageIdFromInternalSpecifier)
    .filter(Boolean)
    .sort();
}

describe("domains.manifest", () : any => {
  describe.each(DOMAIN_PACKAGES)("package: %s", (packageId?: any) : any => {
    const packageDirectory: any = path.join(PROJECT_ROOT, "packages", packageId);
    const manifestPath: any = `packages/${packageId}/manifest.module.json`;

    it("conforms to the domain-package schema", async () : Promise<any> => {
      const manifest: any = manifestFor(packageId);
      const issues: any = await validateLocalJsonSchemaReference(manifest, manifestPath, {
        registryDir: PROJECT_ROOT
      });

      expect(issues).toEqual([]);
      expect(manifest.id).toBe(packageId);
      expect(manifest.directory).toBe(`packages/${packageId}`);
    });

    it("owns every current src root with a non-empty exact file count", () : any => {
      const manifest: any = manifestFor(packageId);
      const sourceDirectory: any = path.join(packageDirectory, "src");
      const ownershipPaths: any = manifest.sourceOwnership.map((entry?: any) : any => entry.path);
      const ownershipFeatures: any = manifest.sourceOwnership.map((entry?: any) : any => entry.feature);
      const sourceRoots: any = fs.readdirSync(sourceDirectory, { withFileTypes: true })
        .map((entry?: any) : any => `src/${entry.name}`)
        .sort();

      expect(new Set<any>(ownershipPaths).size).toBe(ownershipPaths.length);
      expect(new Set<any>(ownershipFeatures).size).toBe(ownershipFeatures.length);
      expect([...ownershipPaths].sort()).toEqual(sourceRoots);

      const ownedFiles: any[] = [];
      for (const ownership of manifest.sourceOwnership) {
        const ownedPath: any = path.join(packageDirectory, ownership.path);
        expect(fs.existsSync(ownedPath), `${packageId}:${ownership.path} must exist`).toBe(true);
        const files: any = listFiles(ownedPath);
        expect(files.length, `${packageId}:${ownership.path} must not be empty`).toBeGreaterThan(0);
        expect(files.length, `${packageId}:${ownership.path} fileCount is stale`).toBe(ownership.fileCount);
        expect(files.some((file?: any) : any => path.basename(file) === ".gitkeep")).toBe(false);
        ownedFiles.push(...files);
      }

      expect([...new Set<any>(ownedFiles)].sort()).toEqual(listFiles(sourceDirectory));
    });

    it("contains no decorative empty directory or placeholder test tree", () : any => {
      const packageEntries: any = fs.readdirSync(packageDirectory)
        .filter((entry?: any) : any => !GENERATED_DIRECTORY_NAMES.has(entry))
        .sort();
      expect(packageEntries).toEqual([...PACKAGE_ROOT_ENTRIES].sort());
      expect(listEmptyDirectories(packageDirectory).map(relativePath)).toEqual([]);
      expect(
        listFiles(packageDirectory).filter((file?: any) : any => path.basename(file) === ".gitkeep").map(relativePath)
      ).toEqual([]);
      expect(fs.existsSync(path.join(packageDirectory, "tests"))).toBe(false);

      const sourceDirectory: any = path.join(packageDirectory, "src");
      const genericTopLevel: any = fs.readdirSync(sourceDirectory, { withFileTypes: true })
        .filter((entry?: any) : any => entry.isDirectory() && DECORATIVE_GENERIC_DIRECTORY_NAMES.has(entry.name))
        .map((entry?: any) : any => relativePath(path.join(sourceDirectory, entry.name)));
      expect(genericTopLevel).toEqual([]);
      expect(listDecorativeWrapperDirectories(sourceDirectory).map(relativePath)).toEqual([]);
    });
  });

  it("resolves every feature testSuite pattern to a runnable registered source", () : any => {
    const registry: any = readJson("tools/registry/tests.registry.json");
    expect(Array.isArray(registry.suites)).toBe(true);

    for (const packageId of DOMAIN_PACKAGES) {
      const manifest: any = manifestFor(packageId);
      for (const ownership of manifest.sourceOwnership) {
        for (const suitePattern of ownership.testSuites) {
          const expression: any = wildcardExpression(suitePattern);
          const matchedSuites: any = registry.suites.filter((suite?: any) : any => expression.test(suite.id));
          expect(
            matchedSuites.length,
            `${packageId}:${ownership.feature} testSuite ${suitePattern} matches no registered suite`
          ).toBeGreaterThan(0);

          const runnableSuites: any = matchedSuites.filter((suite?: any) : any => (
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

  it("treats testSuite wildcards as match requirements rather than future intent", () : any => {
    const expression: any = wildcardExpression("agent-*.runtime");
    expect(expression.test("agent-memory.runtime")).toBe(true);
    expect(expression.test("agent-memory.integration")).toBe(false);
    expect(wildcardExpression("workspace-governance.runtime").test("workspace-governance.runtime")).toBe(true);
  });

  it("binds public API declarations to active aliases and package exports", () : any => {
    const registry: any = readJson("tools/registry/public-api.registry.json");
    const activeAliases: any = registry.aliases.filter((entry?: any) : any => entry.status === "active");

    for (const packageId of DOMAIN_PACKAGES) {
      const manifest: any = manifestFor(packageId);
      const packageManifest: any = readJson(`packages/${packageId}/package.json`);
      expect(packageManifest.exports?.["./*"]).toMatchObject({
        types: "./dist/*.d.ts",
        source: "./src/*.ts",
        default: "./dist/*.js"
      });

      for (const apiEntry of manifest.publicApi) {
        const alias: any = activeAliases.find((entry?: any) : any => entry.alias === apiEntry);
        expect(alias, `${packageId}:${apiEntry} must be an active exact public alias`).toBeDefined();
        expect(alias.domainPackage).toBe(packageId);
        expect(alias.targetPath).toContain(`packages/${packageId}/src/`);
      }
    }
  });

  it("matches declared dependencies to source imports, package manifests, and layer rules", () : any => {
    const dependencyRules: any = readJson("tools/registry/dependency-rules.registry.json");

    for (const packageId of DOMAIN_PACKAGES) {
      const manifest: any = manifestFor(packageId);
      const sourceFiles: any = manifest.sourceOwnership.flatMap((ownership?: any) : any => (
        listFiles(path.join(PROJECT_ROOT, manifest.directory, ownership.path))
      ));
      const actualDependencies: any = actualInternalDependencies(packageId, sourceFiles, dependencyRules);
      const declaredDependencies: any = [...manifest.dependsOn].sort();
      const packageDependencies: any = packageManifestInternalDependencies(packageId);
      const layer: any = dependencyRules.layers.find((entry?: any) : any => entry.id === packageId);

      expect(layer, `${packageId} must have a dependency-rule layer`).toBeDefined();
      expect(declaredDependencies).toEqual(actualDependencies);
      expect(packageDependencies).toEqual(actualDependencies);
      expect(actualDependencies.every((dependency?: any) : any => layer.allowedDependsOn.includes(dependency))).toBe(true);
      expect(actualDependencies.some((dependency?: any) : any => layer.forbiddenDependsOn.includes(dependency))).toBe(false);
    }
  });
});
