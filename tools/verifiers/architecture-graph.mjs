#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { init, parse } from "es-module-lexer";

await init;

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportDir = path.join(repoRoot, "build", "reports");
const jsonReportPath = path.join(reportDir, "architecture-graph.json");
const markdownReportPath = path.join(reportDir, "architecture-graph.md");
const dependencyRules = require("../registry/dependency-rules.registry.json");
const rootPackageJson = require("../../package.json");

const SOURCE_ROOTS = Object.freeze(["apps", "packages", "plugins", "tools"]);
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".vue"]);
const TARGET_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, ".css", ".json"]);
const EXCLUDED_SEGMENTS = new Set([
  ".git",
  "build",
  "coverage",
  "dist",
  "meshrix-data",
  "node_modules",
  "vendor"
]);
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`)
]);

function relativePath(absolutePath) {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

async function pathExists(absolutePath) {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(absolutePath) {
  try {
    return (await fs.stat(absolutePath)).isFile();
  } catch {
    return false;
  }
}

async function listSourceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (EXCLUDED_SEGMENTS.has(entry.name)) {
      continue;
    }
    const absolutePath = path.join(directory, entry.name);
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

async function collectSourceFiles() {
  const files = [];
  for (const sourceRoot of SOURCE_ROOTS) {
    const absoluteRoot = path.join(repoRoot, sourceRoot);
    if (await pathExists(absoluteRoot)) {
      files.push(...await listSourceFiles(absoluteRoot));
    }
  }
  return files.sort((a, b) => relativePath(a).localeCompare(relativePath(b)));
}

function moduleSourceForFile(source, absoluteFile = "") {
  if (path.extname(absoluteFile) !== ".vue") return source;
  return [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)]
    .map((match) => match[1])
    .join("\n");
}

export function extractImportSpecifiers(source, absoluteFile = "") {
  return extractImportEntries(source, absoluteFile).map((entry) => entry.specifier);
}

export function extractImportEntries(source, absoluteFile = "") {
  const [imports] = parse(moduleSourceForFile(source, absoluteFile));
  return imports
    .filter((entry) => typeof entry.n === "string" && entry.n.length > 0)
    .map((entry) => ({
      specifier: entry.n,
      dynamic: entry.d > -1
    }));
}

async function resolveRelativeImport(fromFile, specifier) {
  const basePath = path.resolve(path.dirname(fromFile), specifier);
  return resolveFileTarget(basePath);
}

async function resolveFileTarget(basePath) {
  const candidates = [
    basePath,
    ...[...TARGET_EXTENSIONS].map((extension) => `${basePath}${extension}`),
    ...[...TARGET_EXTENSIONS].map((extension) => path.join(basePath, `index${extension}`))
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return relativePath(candidate);
  }
  return null;
}

function workspaceDescriptors() {
  const descriptors = (rootPackageJson.workspaces || []).map((workspaceRoot) => {
    const absoluteRoot = path.join(repoRoot, workspaceRoot);
    const manifest = require(path.join(absoluteRoot, "package.json"));
    return {
      absoluteRoot,
      manifest,
      relativeRoot: workspaceRoot.replace(/\\/gu, "/")
    };
  });
  return {
    root: { absoluteRoot: repoRoot, manifest: rootPackageJson, relativeRoot: "" },
    scopes: descriptors.sort((a, b) => b.absoluteRoot.length - a.absoluteRoot.length),
    byName: new Map(descriptors.map((descriptor) => [descriptor.manifest.name, descriptor]))
  };
}

function packageScopeForFile(fromFile, workspaces) {
  return workspaces.scopes.find((scope) => (
    fromFile === scope.absoluteRoot || fromFile.startsWith(`${scope.absoluteRoot}${path.sep}`)
  )) || workspaces.root;
}

function patternMatch(map, request) {
  if (!map || typeof map !== "object") return null;
  if (Object.hasOwn(map, request)) return { capture: "", target: map[request] };
  const matches = [];
  for (const [pattern, target] of Object.entries(map)) {
    const star = pattern.indexOf("*");
    if (star < 0 || pattern.indexOf("*", star + 1) >= 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!request.startsWith(prefix) || !request.endsWith(suffix)) continue;
    matches.push({
      capture: request.slice(prefix.length, request.length - suffix.length),
      score: prefix.length + suffix.length,
      target
    });
  }
  matches.sort((a, b) => b.score - a.score);
  return matches[0] || null;
}

function selectMappedTarget(target) {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const candidate of target) {
      const selected = selectMappedTarget(candidate);
      if (selected) return selected;
    }
    return null;
  }
  if (target && typeof target === "object") {
    for (const condition of ["import", "node", "default"]) {
      const selected = selectMappedTarget(target[condition]);
      if (selected) return selected;
    }
  }
  return null;
}

function substitutePattern(target, capture) {
  return target.includes("*") ? target.replace("*", capture) : target;
}

function workspaceRequest(specifier, workspaces) {
  if (!specifier.startsWith("@")) return null;
  const parts = specifier.split("/");
  if (parts.length < 2) return null;
  const packageName = parts.slice(0, 2).join("/");
  const descriptor = workspaces.byName.get(packageName);
  if (!descriptor) return null;
  const subpath = parts.length === 2 ? "." : `./${parts.slice(2).join("/")}`;
  return { descriptor, subpath };
}

function packageNameFromSpecifier(specifier) {
  const parts = String(specifier || "").split("/");
  if (specifier.startsWith("@")) return parts.length >= 2 ? parts.slice(0, 2).join("/") : "";
  return parts[0] || "";
}

function declaredRuntimeDependencies(manifest = {}) {
  return {
    ...(manifest.dependencies || {}),
    ...(manifest.optionalDependencies || {}),
    ...(manifest.peerDependencies || {})
  };
}

async function resolveMappedTarget({ descriptor, target, capture, workspaces, seen }) {
  const selected = selectMappedTarget(target);
  if (!selected) return { reason: "unsupported_conditional_target", target: null };
  const substituted = substitutePattern(selected, capture);
  if (substituted.startsWith(".")) {
    const absoluteTarget = path.resolve(descriptor.absoluteRoot, substituted);
    if (absoluteTarget !== repoRoot && !absoluteTarget.startsWith(`${repoRoot}${path.sep}`)) {
      return { reason: "target_outside_repository", target: null };
    }
    const resolved = await resolveFileTarget(absoluteTarget);
    return resolved
      ? { reason: "", target: resolved }
      : { reason: "mapped_target_missing", target: null };
  }
  return resolvePackageImport(substituted, descriptor.absoluteRoot, workspaces, seen);
}

async function resolvePackageImport(specifier, fromFile, workspaces, seen = new Set()) {
  if (BUILTINS.has(specifier)) return { builtin: true, external: true, reason: "", target: null };
  const cycleKey = `${fromFile}\0${specifier}`;
  if (seen.has(cycleKey)) return { reason: "mapping_cycle", target: null };
  const nextSeen = new Set(seen).add(cycleKey);

  if (specifier.startsWith("#")) {
    const descriptor = packageScopeForFile(fromFile, workspaces);
    const match = patternMatch(descriptor.manifest.imports, specifier);
    if (!match) return { reason: "package_import_not_mapped", target: null };
    return resolveMappedTarget({ descriptor, ...match, workspaces, seen: nextSeen });
  }

  const request = workspaceRequest(specifier, workspaces);
  if (!request) {
    return {
      external: true,
      packageName: packageNameFromSpecifier(specifier),
      reason: "",
      target: null
    };
  }
  const match = patternMatch(request.descriptor.manifest.exports, request.subpath);
  if (!match) return { reason: "workspace_export_not_mapped", target: null };
  return resolveMappedTarget({
    descriptor: request.descriptor,
    ...match,
    workspaces,
    seen: nextSeen
  });
}

async function resolveImportTarget(fromFile, specifier, workspaces) {
  if (specifier.startsWith(".")) {
    const target = await resolveRelativeImport(fromFile, specifier);
    return target
      ? { internal: true, reason: "", target }
      : { internal: true, reason: "relative_target_missing", target: null };
  }
  const result = await resolvePackageImport(specifier, fromFile, workspaces);
  return { internal: !result.external, ...result };
}

export function normalizeLayers(rules = dependencyRules) {
  if (!Array.isArray(rules?.layers) || rules.layers.length === 0) {
    throw new Error("Dependency rules must declare at least one layer.");
  }
  const layers = rules.layers.map((layer, index) => {
    const id = String(layer?.id || "").trim();
    const directory = String(layer?.directory || "").replace(/\/+$/u, "");
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
  const ids = new Set(layers.map((layer) => layer.id));
  const directories = new Set(layers.map((layer) => layer.directory));
  if (ids.size !== layers.length) {
    throw new Error("Dependency layer ids must be unique.");
  }
  if (directories.size !== layers.length) {
    throw new Error("Dependency layer directories must be unique.");
  }
  for (const layer of layers) {
    for (const field of ["allowedDependsOn", "forbiddenDependsOn"]) {
      const references = layer[field];
      if (new Set(references).size !== references.length) {
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
    const overlap = layer.allowedDependsOn.find((id) => layer.forbiddenDependsOn.includes(id));
    if (overlap) {
      throw new Error(`Dependency layer ${layer.id} both allows and forbids ${overlap}.`);
    }
  }
  return layers.sort((a, b) => b.directory.length - a.directory.length);
}

function wildcardExpression(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
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

function specifierKind(specifier) {
  if (specifier.startsWith(".")) return "relative";
  if (specifier.startsWith("#")) return "package-import";
  return "package";
}

function specifierFamily(specifier) {
  if (specifier.startsWith(".")) return "relative";
  if (specifier.startsWith("#")) return "package-import";
  if (specifier.startsWith("@meshrix/")) return "workspace-package";
  if (specifier.startsWith("node:") || BUILTINS.has(specifier)) return "builtin";
  if (specifier.startsWith("@") || /^[A-Za-z0-9_~-]/.test(specifier)) return "external-package";
  return "unsupported";
}

export function normalizeConstraints(rules = dependencyRules, layers = normalizeLayers(rules)) {
  if (!Array.isArray(rules?.constraints)) {
    throw new Error("Dependency rules constraints must be an array.");
  }
  const layerIds = new Set(layers.map((layer) => layer.id));
  const constraintIds = new Set();
  return rules.constraints.map((constraint, index) => {
    const id = String(constraint?.id || "").trim();
    const fromPattern = String(constraint?.fromPattern || "").trim();
    const forbiddenTargets = Array.isArray(constraint?.forbiddenTargets)
      ? constraint.forbiddenTargets.map((target) => String(target || "").trim()).filter(Boolean)
      : [];
    const fromLayers = Array.isArray(constraint?.fromLayers)
      ? constraint.fromLayers.map((layer) => String(layer || "").trim()).filter(Boolean)
      : [];
    const excludedFromPatterns = Array.isArray(constraint?.excludedFromPatterns)
      ? constraint.excludedFromPatterns.map((pattern) => String(pattern || "").trim()).filter(Boolean)
      : [];
    const specifierKinds = Array.isArray(constraint?.specifierKinds)
      ? constraint.specifierKinds.map((kind) => String(kind || "").trim()).filter(Boolean)
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

export function matchingDependencyConstraints(edge, constraints) {
  const kind = specifierKind(String(edge?.specifier || ""));
  return constraints.filter((constraint) => (
    wildcardExpression(constraint.fromPattern).test(String(edge?.from || "")) &&
    !(constraint.excludedFromPatterns || []).some((pattern) =>
      wildcardExpression(pattern).test(String(edge?.from || ""))) &&
    (constraint.fromLayers.length === 0 || constraint.fromLayers.includes(String(edge?.fromLayer || ""))) &&
    constraint.specifierKinds.includes(kind) &&
    constraint.forbiddenTargets.some((target) => wildcardExpression(target).test(String(edge?.to || "")))
  ));
}

function layerDirectoryMatches(relativeFile, directory) {
  if (!directory.includes("*")) {
    return relativeFile === directory || relativeFile.startsWith(`${directory}/`);
  }
  let pattern = "^";
  for (let index = 0; index < directory.length; index += 1) {
    const character = directory[index];
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

function layerForPath(relativeFile, layers) {
  return layers.find((layer) => layerDirectoryMatches(relativeFile, layer.directory)) || null;
}

function exceptionMatches(exception, fromPath, toPath) {
  const fromPrefix = String(exception.from || "").replace(/\/+$/u, "");
  const toPrefix = String(exception.to || "").replace(/\/+$/u, "");
  return fromPrefix && toPrefix && fromPath.startsWith(fromPrefix) && toPath.startsWith(toPrefix);
}

function markdownReport(report) {
  const lines = [
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
} = {}) {
  const layers = normalizeLayers(rules);
  const registeredConstraints = normalizeConstraints(rules, layers);
  if (!Array.isArray(rules.exceptions)) {
    throw new Error("Dependency rules exceptions must be an array.");
  }
  const exceptions = rules.exceptions;
  if (exceptions.length > 0) {
    throw new Error(
      `Dependency rules must declare zero active exceptions; found ${exceptions.length}. ` +
      "Resolve the underlying layer/constraint ownership instead of recording cross-layer exceptions."
    );
  }
  const workspaces = workspaceDescriptors();
  const files = await collectSourceFiles();
  const edges = [];
  const unresolvedImports = [];
  const dependencyUsage = new Map();
  const violations = [];
  const constraintFindings = [];

  function recordDependencyUsage({ from, packageName, specifier, kind }) {
    if (!packageName) return;
    const sourceScope = packageScopeForFile(path.join(repoRoot, from), workspaces);
    if (sourceScope === workspaces.root || sourceScope.manifest.name === packageName) return;
    const key = `${sourceScope.manifest.name}\0${packageName}`;
    let usage = dependencyUsage.get(key);
    if (!usage) {
      usage = {
        sourcePackage: sourceScope.manifest.name,
        sourceRoot: sourceScope.relativeRoot,
        dependency: packageName,
        kind,
        files: new Set(),
        specifiers: new Set()
      };
      dependencyUsage.set(key, usage);
    }
    usage.files.add(from);
    usage.specifiers.add(specifier);
  }

  for (const absoluteFile of files) {
    const from = relativePath(absoluteFile);
    const fromLayer = layerForPath(from, layers);
    if (!fromLayer) {
      violations.push({
        rule: "source-layer-unclassified",
        from,
        to: "",
        specifier: "",
        message: "Every scanned production source file must belong to a dependency layer."
      });
    }
    const source = await fs.readFile(absoluteFile, "utf8");
    let importEntries;
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
      const specifier = importEntry.specifier;
      const family = specifierFamily(specifier);
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
      const resolution = await resolveImportTarget(absoluteFile, specifier, workspaces);
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
          const unresolved = {
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
      const to = resolution.target;
      const targetScope = packageScopeForFile(path.join(repoRoot, to), workspaces);
      if (targetScope !== workspaces.root) {
        recordDependencyUsage({
          from,
          packageName: targetScope.manifest.name,
          specifier,
          kind: "workspace"
        });
      }
      const toLayer = layerForPath(to, layers);
      const edge = {
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
      const edgeIsExcepted = exceptions.some((exception) => exceptionMatches(exception, from, to));
      if (edgeIsExcepted) {
        edge.exception = true;
      } else {
        for (const constraint of matchingDependencyConstraints(edge, registeredConstraints)) {
          const finding = {
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

  const manifestDependencies = [...dependencyUsage.values()]
    .map((usage) => ({
      ...usage,
      files: [...usage.files].sort(),
      specifiers: [...usage.specifiers].sort()
    }))
    .sort((left, right) => (
      left.sourcePackage.localeCompare(right.sourcePackage) || left.dependency.localeCompare(right.dependency)
    ));
  const manifestDependencyViolations = [];
  for (const usage of manifestDependencies) {
    const sourceDescriptor = workspaces.byName.get(usage.sourcePackage);
    const declared = declaredRuntimeDependencies(sourceDescriptor?.manifest);
    if (!Object.hasOwn(declared, usage.dependency)) {
      const violation = {
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
    const targetDescriptor = workspaces.byName.get(usage.dependency);
    if (targetDescriptor && declared[usage.dependency] !== targetDescriptor.manifest.version) {
      const violation = {
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

  const graph = {
    schemaVersion: "v0.0.1:architecture:graph-report-3",
    registryDriven: true,
    nodes: files.map((file) => {
      const nodePath = relativePath(file);
      const layer = layerForPath(nodePath, layers);
      return {
        path: nodePath,
        layer: layer?.id || ""
      };
    }),
    edges,
    constraints: [
      ...layers.flatMap((layer) => [
        {
          rule: `${layer.id}-dependencies-must-be-allowlisted`,
          fromLayer: layer.id,
          allowedLayers: layer.allowedDependsOn
        },
        ...layer.forbiddenDependsOn.map((forbiddenLayer) => ({
          rule: `${layer.id}-must-not-depend-on-${forbiddenLayer}`,
          fromLayer: layer.id,
          forbiddenLayer
        }))
      ]),
      ...registeredConstraints.map((constraint) => ({
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
      relativeEdgeCount: edges.filter((edge) => edge.family === "relative").length,
      packageImportEdgeCount: edges.filter((edge) => edge.family === "package-import").length,
      workspacePackageEdgeCount: edges.filter((edge) => edge.family === "workspace-package").length,
      dynamicInternalEdgeCount: edges.filter((edge) => edge.dynamic).length,
      unresolvedImportCount: unresolvedImports.length,
      manifestDependencyViolationCount: manifestDependencyViolations.length,
      constraintFindingCount: constraintFindings.length,
      exceptionCount: edges.filter((edge) => edge.exception).length,
      violationCount: violations.length
    }
  };
  const report = {
    schemaVersion: graph.schemaVersion,
    generatedAt: new Date().toISOString(),
    verifier: "tools/verifiers/architecture-graph.mjs",
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
  const result = await runArchitectureGraph();
  if (result.violations.length > 0) {
    process.exitCode = 1;
  }
}
