#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { init, parse } from "es-module-lexer";

await init;

const require: any = createRequire(import.meta.url);
const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportDir: any = path.join(repoRoot, "build", "reports");
const jsonReportPath: any = path.join(reportDir, "architecture-graph.json");
const markdownReportPath: any = path.join(reportDir, "architecture-graph.md");
const dependencyRules: any = require("../registry/dependency-rules.registry.json");
const rootPackageJson: any = require("../../package.json");

const SOURCE_ROOTS: readonly any[] = Object.freeze(["apps", "packages", "plugins", "tools"]);
const SOURCE_EXTENSIONS: any = new Set<any>([".js", ".mjs", ".ts", ".cjs", ".tsx", ".vue"]);
const TARGET_EXTENSIONS: any = new Set<any>([...SOURCE_EXTENSIONS, ".css", ".json"]);
const EXCLUDED_SEGMENTS: any = new Set<any>([
  ".git",
  "build",
  "coverage",
  "dist",
  "meshrix-data",
  "node_modules",
  "vendor"
]);
const BUILTINS: any = new Set<any>([
  ...builtinModules,
  ...builtinModules.map((name?: any) : any => `node:${name}`)
]);

function relativePath(absolutePath?: any) : any {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

async function pathExists(absolutePath?: any) : Promise<any> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(absolutePath?: any) : Promise<any> {
  try {
    return (await fs.stat(absolutePath)).isFile();
  } catch {
    return false;
  }
}

async function listSourceFiles(directory?: any) : Promise<any> {
  const entries: any = await fs.readdir(directory, { withFileTypes: true });
  const files: any[] = [];
  for (const entry of entries) {
    if (EXCLUDED_SEGMENTS.has(entry.name)) {
      continue;
    }
    const absolutePath: any = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(absolutePath));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(absolutePath);
    }
  }
  return files;
}

async function collectSourceFiles() : Promise<any> {
  const files: any[] = [];
  for (const sourceRoot of SOURCE_ROOTS) {
    const absoluteRoot: any = path.join(repoRoot, sourceRoot);
    if (await pathExists(absoluteRoot)) {
      files.push(...await listSourceFiles(absoluteRoot));
    }
  }
  return files.sort((a?: any, b?: any) : any => relativePath(a).localeCompare(relativePath(b)));
}

function moduleSourceForFile(source?: any, absoluteFile: any = "") : any {
  if (path.extname(absoluteFile) !== ".vue") return source;
  return [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)]
    .map((match?: any) : any => match[1])
    .join("\n");
}

export function extractImportSpecifiers(source?: any, absoluteFile: any = "") : any {
  return extractImportEntries(source, absoluteFile).map((entry?: any) : any => entry.specifier);
}

export function extractImportEntries(source?: any, absoluteFile: any = "") : any {
  const [imports] = parse(moduleSourceForFile(source, absoluteFile));
  return imports
    .filter((entry?: any) : any => typeof entry.n === "string" && entry.n.length > 0)
    .map((entry?: any) : any => ({
      specifier: entry.n,
      dynamic: entry.d > -1
    }));
}

async function resolveRelativeImport(fromFile?: any, specifier?: any) : Promise<any> {
  const basePath: any = path.resolve(path.dirname(fromFile), specifier);
  return resolveFileTarget(basePath);
}

async function resolveFileTarget(basePath?: any) : Promise<any> {
  const candidates: any[] = [
    basePath,
    ...[...TARGET_EXTENSIONS].map((extension?: any) : any => `${basePath}${extension}`),
    ...[...TARGET_EXTENSIONS].map((extension?: any) : any => path.join(basePath, `index${extension}`))
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return relativePath(candidate);
  }
  return null;
}

async function expandWorkspaceRoots() : Promise<any> {
  const roots: any[] = [];
  for (const configuredRoot of rootPackageJson.workspaces || []) {
    const workspaceRoot: any = String(configuredRoot || "").replace(/\\/gu, "/");
    if (!workspaceRoot.includes("*")) {
      roots.push(workspaceRoot);
      continue;
    }
    if (!workspaceRoot.endsWith("/*") || workspaceRoot.slice(0, -2).includes("*")) {
      throw new Error(`Unsupported workspace pattern: ${workspaceRoot}`);
    }
    const parentRoot: any = workspaceRoot.slice(0, -2);
    const entries: any = await fs.readdir(path.join(repoRoot, parentRoot), { withFileTypes: true });
    const matches: any[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const relativeRoot: any = `${parentRoot}/${entry.name}`;
      if (await fileExists(path.join(repoRoot, relativeRoot, "package.json"))) {
        matches.push(relativeRoot);
      }
    }
    if (matches.length === 0) {
      throw new Error(`Workspace pattern resolved no packages: ${workspaceRoot}`);
    }
    roots.push(...matches.sort((a?: any, b?: any) : any => a.localeCompare(b)));
  }
  if (new Set<any>(roots).size !== roots.length) {
    throw new Error("Workspace configuration resolves duplicate package roots.");
  }
  return roots;
}

async function workspaceDescriptors() : Promise<any> {
  const descriptors: any[] = [];
  for (const workspaceRoot of await expandWorkspaceRoots()) {
    const absoluteRoot: any = path.join(repoRoot, workspaceRoot);
    const manifest: any = JSON.parse(await fs.readFile(path.join(absoluteRoot, "package.json"), "utf8"));
    descriptors.push({
      absoluteRoot,
      manifest,
      relativeRoot: workspaceRoot.replace(/\\/gu, "/")
    });
  }
  const names: any = descriptors.map((descriptor?: any) : any => descriptor.manifest.name);
  if (names.some((name?: any) : any => typeof name !== "string" || !name) || new Set<any>(names).size !== names.length) {
    throw new Error("Workspace package names must be present and unique.");
  }
  return {
    root: { absoluteRoot: repoRoot, manifest: rootPackageJson, relativeRoot: "" },
    scopes: descriptors.sort((a?: any, b?: any) : any => b.absoluteRoot.length - a.absoluteRoot.length),
    byName: new Map<any, any>(descriptors.map((descriptor?: any) : any => [descriptor.manifest.name, descriptor]))
  };
}

function packageExportMatch(exportsMap?: any, request?: any) : any {
  if (request === "." && (typeof exportsMap === "string" || Array.isArray(exportsMap))) {
    return { capture: "", target: exportsMap };
  }
  return patternMatch(exportsMap, request);
}

function packageScopeForFile(fromFile?: any, workspaces?: any) : any {
  return workspaces.scopes.find((scope?: any) : any => (
    fromFile === scope.absoluteRoot || fromFile.startsWith(`${scope.absoluteRoot}${path.sep}`)
  )) || workspaces.root;
}

function patternMatch(map?: any, request?: any) : any {
  if (!map || typeof map !== "object") return null;
  if (Object.hasOwn(map, request)) return { capture: "", target: map[request] };
  const matches: any[] = [];
  for (const [pattern, target] of (Object.entries(map) as [string, any][])) {
    const star: any = pattern.indexOf("*");
    if (star < 0 || pattern.indexOf("*", star + 1) >= 0) continue;
    const prefix: any = pattern.slice(0, star);
    const suffix: any = pattern.slice(star + 1);
    if (!request.startsWith(prefix) || !request.endsWith(suffix)) continue;
    matches.push({
      capture: request.slice(prefix.length, request.length - suffix.length),
      score: prefix.length + suffix.length,
      target
    });
  }
  matches.sort((a?: any, b?: any) : any => b.score - a.score);
  return matches[0] || null;
}

function selectMappedTarget(target?: any) : any {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const candidate of target) {
      const selected: any = selectMappedTarget(candidate);
      if (selected) return selected;
    }
    return null;
  }
  if (target && typeof target === "object") {
    for (const condition of ["source", "import", "node", "default", "types"]) {
      const selected: any = selectMappedTarget(target[condition]);
      if (selected) return selected;
    }
  }
  return null;
}

function substitutePattern(target?: any, capture?: any) : any {
  return target.includes("*") ? target.replace("*", capture) : target;
}

function workspaceRequest(specifier?: any, workspaces?: any) : any {
  if (!specifier.startsWith("@")) return null;
  const parts: any = specifier.split("/");
  if (parts.length < 2) return null;
  const packageName: any = parts.slice(0, 2).join("/");
  const descriptor: any = workspaces.byName.get(packageName);
  if (!descriptor) return null;
  const subpath: any = parts.length === 2 ? "." : `./${parts.slice(2).join("/")}`;
  return { descriptor, subpath };
}

function packageNameFromSpecifier(specifier?: any) : any {
  const parts: any = String(specifier || "").split("/");
  if (specifier.startsWith("@")) return parts.length >= 2 ? parts.slice(0, 2).join("/") : "";
  return parts[0] || "";
}

function declaredRuntimeDependencies(manifest: Record<string, any> = {}) : any {
  return {
    ...(manifest.dependencies || {}),
    ...(manifest.optionalDependencies || {}),
    ...(manifest.peerDependencies || {})
  };
}

async function resolveMappedTarget({ descriptor, target, capture, workspaces, seen }: Record<string, any>) : Promise<any> {
  const selected: any = selectMappedTarget(target);
  if (!selected) return { reason: "unsupported_conditional_target", target: null };
  const substituted: any = substitutePattern(selected, capture);
  if (substituted.startsWith(".")) {
    const absoluteTarget: any = path.resolve(descriptor.absoluteRoot, substituted);
    if (absoluteTarget !== repoRoot && !absoluteTarget.startsWith(`${repoRoot}${path.sep}`)) {
      return { reason: "target_outside_repository", target: null };
    }
    const resolved: any = await resolveFileTarget(absoluteTarget);
    return resolved
      ? { reason: "", target: resolved }
      : { reason: "mapped_target_missing", target: null };
  }
  return resolvePackageImport(substituted, descriptor.absoluteRoot, workspaces, seen);
}

async function resolvePackageImport(specifier?: any, fromFile?: any, workspaces?: any, seen: any = new Set<any>()) : Promise<any> {
  if (BUILTINS.has(specifier)) return { builtin: true, external: true, reason: "", target: null };
  const cycleKey: any = `${fromFile}\0${specifier}`;
  if (seen.has(cycleKey)) return { reason: "mapping_cycle", target: null };
  const nextSeen: any = new Set<any>(seen).add(cycleKey);

  if (specifier.startsWith("#")) {
    const descriptor: any = packageScopeForFile(fromFile, workspaces);
    const match: any = patternMatch(descriptor.manifest.imports, specifier);
    if (!match) return { reason: "package_import_not_mapped", target: null };
    return resolveMappedTarget({ descriptor, ...match, workspaces, seen: nextSeen });
  }

  const request: any = workspaceRequest(specifier, workspaces);
  if (!request) {
    return {
      external: true,
      packageName: packageNameFromSpecifier(specifier),
      reason: "",
      target: null
    };
  }
  const match: any = packageExportMatch(request.descriptor.manifest.exports, request.subpath);
  if (!match) return { reason: "workspace_export_not_mapped", target: null };
  return resolveMappedTarget({
    descriptor: request.descriptor,
    ...match,
    workspaces,
    seen: nextSeen
  });
}

async function resolveImportTarget(fromFile?: any, specifier?: any, workspaces?: any) : Promise<any> {
  if (specifier.startsWith(".")) {
    const target: any = await resolveRelativeImport(fromFile, specifier);
    return target
      ? { internal: true, reason: "", target }
      : { internal: true, reason: "relative_target_missing", target: null };
  }
  const result: any = await resolvePackageImport(specifier, fromFile, workspaces);
  return { internal: !result.external, ...result };
}

export function normalizeLayers(rules: any = dependencyRules) : any {
  if (!Array.isArray(rules?.layers) || rules.layers.length === 0) {
    throw new Error("Dependency rules must declare at least one layer.");
  }
  const layers: any = rules.layers.map((layer?: any, index?: any) : any => {
    const id: any = String(layer?.id || "").trim();
    const directory: any = String(layer?.directory || "").replace(/\/+$/u, "");
    if (!id || !directory) {
      throw new Error(`Dependency layer at index ${index} must declare id and directory.`);
    }
    if (!Array.isArray(layer.allowedDependsOn) || !Array.isArray(layer.forbiddenDependsOn)) {
      throw new Error(`Dependency layer ${id} must declare allow and deny lists.`);
    }
    if (layer.allowedDependsOn.length + layer.forbiddenDependsOn.length === 0) {
      throw new Error(`Dependency layer ${id} must declare at least one effective dependency rule.`);
    }
    return {
      id,
      name: String(layer.name || id),
      directory,
      allowedDependsOn: [...layer.allowedDependsOn],
      forbiddenDependsOn: [...layer.forbiddenDependsOn]
    };
  });
  const ids: any = new Set<any>(layers.map((layer?: any) : any => layer.id));
  const directories: any = new Set<any>(layers.map((layer?: any) : any => layer.directory));
  if (ids.size !== layers.length) {
    throw new Error("Dependency layer ids must be unique.");
  }
  if (directories.size !== layers.length) {
    throw new Error("Dependency layer directories must be unique.");
  }
  for (const layer of layers) {
    for (const field of ["allowedDependsOn", "forbiddenDependsOn"]) {
      const references: any = layer[field];
      if (new Set<any>(references).size !== references.length) {
        throw new Error(`Dependency layer ${layer.id} ${field} contains duplicate references.`);
      }
      for (const referencedId of references) {
        if (!ids.has(referencedId)) {
          throw new Error(`Dependency layer ${layer.id} references unknown layer ${referencedId}.`);
        }
        if (referencedId === layer.id) {
          throw new Error(`Dependency layer ${layer.id} cannot reference itself.`);
        }
      }
    }
    const overlap: any = layer.allowedDependsOn.find((id?: any) : any => layer.forbiddenDependsOn.includes(id));
    if (overlap) {
      throw new Error(`Dependency layer ${layer.id} both allows and forbids ${overlap}.`);
    }
  }
  return layers.sort((a?: any, b?: any) : any => b.directory.length - a.directory.length);
}

function wildcardExpression(pattern?: any) : any {
  let source: any = "^";
  for (let index: any = 0; index < pattern.length; index += 1) {
    const character: any = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (character === "*") {
      source += "[^/]*";
      continue;
    }
    source += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
}

function specifierKind(specifier?: any) : any {
  if (specifier.startsWith(".")) return "relative";
  if (specifier.startsWith("#")) return "package-import";
  return "package";
}

function specifierFamily(specifier?: any) : any {
  if (specifier.startsWith(".")) return "relative";
  if (specifier.startsWith("#")) return "package-import";
  if (specifier.startsWith("@meshrix/")) return "workspace-package";
  if (specifier.startsWith("node:") || BUILTINS.has(specifier)) return "builtin";
  if (specifier.startsWith("@") || /^[A-Za-z0-9_~-]/.test(specifier)) return "external-package";
  return "unsupported";
}

export function normalizeConstraints(rules: any = dependencyRules, layers: any = normalizeLayers(rules)) : any {
  if (!Array.isArray(rules?.constraints)) {
    throw new Error("Dependency rules constraints must be an array.");
  }
  const layerIds: any = new Set<any>(layers.map((layer?: any) : any => layer.id));
  const constraintIds: any = new Set<any>();
  return rules.constraints.map((constraint?: any, index?: any) : any => {
    const id: any = String(constraint?.id || "").trim();
    const fromPattern: any = String(constraint?.fromPattern || "").trim();
    const forbiddenTargets: any = Array.isArray(constraint?.forbiddenTargets)
      ? constraint.forbiddenTargets.map((target?: any) : any => String(target || "").trim()).filter(Boolean)
      : [];
    const fromLayers: any = Array.isArray(constraint?.fromLayers)
      ? constraint.fromLayers.map((layer?: any) : any => String(layer || "").trim()).filter(Boolean)
      : [];
    const excludedFromPatterns: any = Array.isArray(constraint?.excludedFromPatterns)
      ? constraint.excludedFromPatterns.map((pattern?: any) : any => String(pattern || "").trim()).filter(Boolean)
      : [];
    const specifierKinds: any = Array.isArray(constraint?.specifierKinds)
      ? constraint.specifierKinds.map((kind?: any) : any => String(kind || "").trim()).filter(Boolean)
      : ["relative", "package", "package-import"];
    if (!id || !fromPattern || forbiddenTargets.length === 0) {
      throw new Error(`Dependency constraint at index ${index} must declare id, fromPattern, and forbiddenTargets.`);
    }
    if (constraintIds.has(id)) {
      throw new Error(`Dependency constraint id ${id} must be unique.`);
    }
    constraintIds.add(id);
    for (const layer of fromLayers) {
      if (!layerIds.has(layer)) {
        throw new Error(`Dependency constraint ${id} references unknown source layer ${layer}.`);
      }
    }
    for (const kind of specifierKinds) {
      if (!["relative", "package", "package-import"].includes(kind)) {
        throw new Error(`Dependency constraint ${id} has unknown specifier kind ${kind}.`);
      }
    }
    return {
      id,
      description: String(constraint.description || id),
      fromPattern,
      excludedFromPatterns,
      fromLayers,
      specifierKinds,
      forbiddenTargets,
      severity: constraint.severity === "warning" ? "warning" : "error"
    };
  });
}

export function matchingDependencyConstraints(edge?: any, constraints?: any) : any {
  const kind: any = specifierKind(String(edge?.specifier || ""));
  return constraints.filter((constraint?: any) : any => (
    wildcardExpression(constraint.fromPattern).test(String(edge?.from || "")) &&
    !(constraint.excludedFromPatterns || []).some((pattern?: any) : any =>
      wildcardExpression(pattern).test(String(edge?.from || ""))) &&
    (constraint.fromLayers.length === 0 || constraint.fromLayers.includes(String(edge?.fromLayer || ""))) &&
    constraint.specifierKinds.includes(kind) &&
    constraint.forbiddenTargets.some((target?: any) : any => wildcardExpression(target).test(String(edge?.to || "")))
  ));
}

function layerDirectoryMatches(relativeFile?: any, directory?: any) : any {
  if (!directory.includes("*")) {
    return relativeFile === directory || relativeFile.startsWith(`${directory}/`);
  }
  let pattern: any = "^";
  for (let index: any = 0; index < directory.length; index += 1) {
    const character: any = directory[index];
    if (character === "*" && directory[index + 1] === "*" && directory[index + 2] === "/") {
      pattern += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (character === "*" && directory[index + 1] === "*") {
      pattern += ".*";
      index += 1;
      continue;
    }
    if (character === "*") {
      pattern += "[^/]+";
      continue;
    }
    pattern += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`${pattern}(?:/|$)`, "u").test(relativeFile);
}

function layerForPath(relativeFile?: any, layers?: any) : any {
  return layers.find((layer?: any) : any => layerDirectoryMatches(relativeFile, layer.directory)) || null;
}

function exceptionMatches(exception?: any, fromPath?: any, toPath?: any) : any {
  const fromPrefix: any = String(exception.from || "").replace(/\/+$/u, "");
  const toPrefix: any = String(exception.to || "").replace(/\/+$/u, "");
  return fromPrefix && toPrefix && fromPath.startsWith(fromPrefix) && toPath.startsWith(toPrefix);
}

function markdownReport(report?: any) : any {
  const lines: any[] = [
    "# Architecture Graph Report",
    "",
    `- Registry driven: ${report.graph.registryDriven}`,
    `- Nodes: ${report.graph.summary.totalNodes}`,
    `- Edges: ${report.graph.summary.totalEdges}`,
    `- Relative edges: ${report.graph.summary.relativeEdgeCount}`,
    `- Package-import (#meshrix/*) edges: ${report.graph.summary.packageImportEdgeCount}`,
    `- Workspace-package (@meshrix/*) edges: ${report.graph.summary.workspacePackageEdgeCount}`,
    `- Dynamic internal edges: ${report.graph.summary.dynamicInternalEdgeCount}`,
    `- Unresolved internal imports: ${report.graph.summary.unresolvedImportCount}`,
    `- Workspace dependency findings: ${report.graph.summary.manifestDependencyViolationCount}`,
    `- Constraints: ${report.graph.constraints.length}`,
    `- Violations: ${report.violations.length}`,
    `- Exceptions: ${report.graph.summary.exceptionCount}`,
    ""
  ];
  if (report.violations.length > 0) {
    lines.push("## Violations", "");
    for (const violation of report.violations) {
      lines.push(`- ${violation.rule}: ${violation.from} -> ${violation.to} (${violation.specifier})`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export async function runArchitectureGraph({
  verbose = true,
  writeReport = true,
  rules = dependencyRules
}: Record<string, any> = {}) : Promise<any> {
  const layers: any = normalizeLayers(rules);
  const registeredConstraints: any = normalizeConstraints(rules, layers);
  if (!Array.isArray(rules.exceptions)) {
    throw new Error("Dependency rules exceptions must be an array.");
  }
  const exceptions: any = rules.exceptions;
  if (exceptions.length > 0) {
    throw new Error(
      `Dependency rules must declare zero active exceptions; found ${exceptions.length}. ` +
      "Resolve the underlying layer/constraint ownership instead of recording cross-layer exceptions."
    );
  }
  const workspaces: any = await workspaceDescriptors();
  const files: any = await collectSourceFiles();
  const edges: any[] = [];
  const unresolvedImports: any[] = [];
  const dependencyUsage: any = new Map<any, any>();
  const violations: any[] = [];
  const constraintFindings: any[] = [];

  function recordDependencyUsage({ from, packageName, specifier, kind }: Record<string, any>) : any {
    if (!packageName) return;
    const sourceScope: any = packageScopeForFile(path.join(repoRoot, from), workspaces);
    if (sourceScope === workspaces.root || sourceScope.manifest.name === packageName) return;
    const key: any = `${sourceScope.manifest.name}\0${packageName}`;
    let usage: any = dependencyUsage.get(key);
    if (!usage) {
      usage = {
        sourcePackage: sourceScope.manifest.name,
        sourceRoot: sourceScope.relativeRoot,
        dependency: packageName,
        kind,
        files: new Set<any>(),
        specifiers: new Set<any>()
      };
      dependencyUsage.set(key, usage);
    }
    usage.files.add(from);
    usage.specifiers.add(specifier);
  }

  for (const absoluteFile of files) {
    const from: any = relativePath(absoluteFile);
    const fromLayer: any = layerForPath(from, layers);
    if (!fromLayer) {
      violations.push({
        rule: "source-layer-unclassified",
        from,
        to: "",
        specifier: "",
        message: "Every scanned production source file must belong to a dependency layer."
      });
    }
    const source: any = await fs.readFile(absoluteFile, "utf8");
    let importEntries: any;
    try {
      importEntries = extractImportEntries(source, absoluteFile);
    } catch {
      violations.push({
        rule: "source-import-parse-failed",
        from,
        to: "",
        specifier: "",
        message: "Source imports could not be parsed."
      });
      continue;
    }
    for (const importEntry of importEntries) {
      const specifier: any = importEntry.specifier;
      const family: any = specifierFamily(specifier);
      if (family === "unsupported") {
        violations.push({
          rule: "unsupported-import-specifier-family",
          from,
          to: "",
          specifier,
          message: "Production import specifier family is not classified by the architecture graph."
        });
        continue;
      }
      const resolution: any = await resolveImportTarget(absoluteFile, specifier, workspaces);
      if (!resolution.target) {
        if (resolution.external && !resolution.builtin) {
          recordDependencyUsage({
            from,
            packageName: resolution.packageName,
            specifier,
            kind: "external"
          });
        }
        if (resolution.internal) {
          const unresolved: Record<string, any> = {
            from,
            specifier,
            dynamic: importEntry.dynamic,
            family,
            reason: resolution.reason || "unresolved_internal_import"
          };
          unresolvedImports.push(unresolved);
          violations.push({
            rule: "unresolved-internal-import",
            from,
            to: "",
            specifier,
            reason: unresolved.reason,
            message: `Internal import could not be resolved (${unresolved.reason}).`
          });
        }
        continue;
      }
      const to: any = resolution.target;
      const targetScope: any = packageScopeForFile(path.join(repoRoot, to), workspaces);
      if (targetScope !== workspaces.root) {
        recordDependencyUsage({
          from,
          packageName: targetScope.manifest.name,
          specifier,
          kind: "workspace"
        });
      }
      const toLayer: any = layerForPath(to, layers);
      const edge: Record<string, any> = {
        from,
        to,
        specifier,
        family,
        dynamic: importEntry.dynamic,
        kind: specifierKind(specifier),
        fromLayer: fromLayer?.id || "",
        toLayer: toLayer?.id || ""
      };
      edges.push(edge);
      if (!toLayer) {
        violations.push({
          rule: "target-layer-unclassified",
          from,
          to,
          specifier,
          message: "Every resolved internal target must belong to a dependency layer."
        });
        continue;
      }
      const edgeIsExcepted: any = exceptions.some((exception?: any) : any => exceptionMatches(exception, from, to));
      if (edgeIsExcepted) {
        edge.exception = true;
      } else {
        for (const constraint of matchingDependencyConstraints(edge, registeredConstraints)) {
          const finding: Record<string, any> = {
            rule: constraint.id,
            from,
            to,
            specifier,
            severity: constraint.severity,
            message: constraint.description
          };
          constraintFindings.push(finding);
          if (constraint.severity === "error") {
            violations.push(finding);
          }
        }
      }
      if (!fromLayer || fromLayer.id === toLayer.id) {
        continue;
      }
      if (edgeIsExcepted) {
        continue;
      }
      if (fromLayer.forbiddenDependsOn.includes(toLayer.id)) {
        violations.push({
          rule: `${fromLayer.id}-must-not-depend-on-${toLayer.id}`,
          from,
          to,
          specifier,
          message: `${fromLayer.name} must not import ${toLayer.name}.`
        });
        continue;
      }
      if (!fromLayer.allowedDependsOn.includes(toLayer.id)) {
        violations.push({
          rule: `${fromLayer.id}-dependency-not-allowed`,
          from,
          to,
          specifier,
          message: `${fromLayer.name} has no allowlisted dependency on ${toLayer.name}.`
        });
      }
    }
  }

  const manifestDependencies: any = [...dependencyUsage.values()]
    .map((usage?: any) : any => ({
      ...usage,
      files: [...usage.files].sort(),
      specifiers: [...usage.specifiers].sort()
    }))
    .sort((left?: any, right?: any) : any => (
      left.sourcePackage.localeCompare(right.sourcePackage) || left.dependency.localeCompare(right.dependency)
    ));
  const manifestDependencyViolations: any[] = [];
  for (const usage of manifestDependencies) {
    const sourceDescriptor: any = workspaces.byName.get(usage.sourcePackage);
    const declared: any = declaredRuntimeDependencies(sourceDescriptor?.manifest);
    if (!Object.hasOwn(declared, usage.dependency)) {
      const violation: Record<string, any> = {
        rule: "workspace-runtime-dependency-not-declared",
        from: usage.files[0] || usage.sourceRoot,
        to: usage.dependency,
        specifier: usage.specifiers[0] || usage.dependency,
        sourcePackage: usage.sourcePackage,
        dependency: usage.dependency,
        message: `${usage.sourcePackage} must declare runtime dependency ${usage.dependency}.`
      };
      manifestDependencyViolations.push(violation);
      violations.push(violation);
      continue;
    }
    const targetDescriptor: any = workspaces.byName.get(usage.dependency);
    if (targetDescriptor && declared[usage.dependency] !== targetDescriptor.manifest.version) {
      const violation: Record<string, any> = {
        rule: "workspace-runtime-dependency-version-mismatch",
        from: `${usage.sourceRoot}/package.json`,
        to: `${targetDescriptor.relativeRoot}/package.json`,
        specifier: usage.dependency,
        sourcePackage: usage.sourcePackage,
        dependency: usage.dependency,
        declaredVersion: declared[usage.dependency],
        workspaceVersion: targetDescriptor.manifest.version,
        message: `${usage.sourcePackage} dependency ${usage.dependency} must match the workspace version.`
      };
      manifestDependencyViolations.push(violation);
      violations.push(violation);
    }
  }

  const graph: Record<string, any> = {
    schemaVersion: "v0.0.1:architecture:graph-report-3",
    registryDriven: true,
    nodes: files.map((file?: any) : any => {
      const nodePath: any = relativePath(file);
      const layer: any = layerForPath(nodePath, layers);
      return {
        path: nodePath,
        layer: layer?.id || ""
      };
    }),
    edges,
    constraints: [
      ...layers.flatMap((layer?: any) : any => [
        {
          rule: `${layer.id}-dependencies-must-be-allowlisted`,
          fromLayer: layer.id,
          allowedLayers: layer.allowedDependsOn
        },
        ...layer.forbiddenDependsOn.map((forbiddenLayer?: any) : any => ({
          rule: `${layer.id}-must-not-depend-on-${forbiddenLayer}`,
          fromLayer: layer.id,
          forbiddenLayer
        }))
      ]),
      ...registeredConstraints.map((constraint?: any) : any => ({
        rule: constraint.id,
        fromPattern: constraint.fromPattern,
        excludedFromPatterns: constraint.excludedFromPatterns,
        fromLayers: constraint.fromLayers,
        specifierKinds: constraint.specifierKinds,
        forbiddenTargets: constraint.forbiddenTargets,
        severity: constraint.severity
      }))
    ],
    summary: {
      totalNodes: files.length,
      totalEdges: edges.length,
      relativeEdgeCount: edges.filter((edge?: any) : any => edge.family === "relative").length,
      packageImportEdgeCount: edges.filter((edge?: any) : any => edge.family === "package-import").length,
      workspacePackageEdgeCount: edges.filter((edge?: any) : any => edge.family === "workspace-package").length,
      dynamicInternalEdgeCount: edges.filter((edge?: any) : any => edge.dynamic).length,
      unresolvedImportCount: unresolvedImports.length,
      manifestDependencyViolationCount: manifestDependencyViolations.length,
      constraintFindingCount: constraintFindings.length,
      exceptionCount: edges.filter((edge?: any) : any => edge.exception).length,
      violationCount: violations.length
    }
  };
  const report: Record<string, any> = {
    schemaVersion: graph.schemaVersion,
    generatedAt: new Date().toISOString(),
    verifier: "tools/verifiers/architecture-graph.ts",
    graph,
    manifestDependencies,
    manifestDependencyViolations,
    constraintFindings,
    unresolvedImports,
    violations
  };

  if (writeReport) {
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(jsonReportPath, `${JSON.stringify(report, null, 2)}\n`);
    await fs.writeFile(markdownReportPath, markdownReport(report));
  }

  if (verbose) {
    console.log(`[architecture-graph] nodes=${graph.summary.totalNodes} edges=${graph.summary.totalEdges} unresolved=${unresolvedImports.length} violations=${violations.length}`);
    if (writeReport) {
      console.log(`[architecture-graph] report: ${relativePath(jsonReportPath)}`);
    }
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result: any = await runArchitectureGraph();
  if (result.violations.length > 0) {
    process.exitCode = 1;
  }
}
