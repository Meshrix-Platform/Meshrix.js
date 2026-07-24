#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SUPPLY_CHAIN_FILES = Object.freeze({
  sbom: "bom.cdx.json",
  notices: "THIRD_PARTY_NOTICES.txt",
  manifest: "supply-chain-manifest.json"
});
export const SUPPLY_CHAIN_MANIFEST_SCHEMA_VERSION =
  "v0.0.1:supply-chain:artifact-manifest-1";

const GENERATOR_ID = "tools/generators/generate-supply-chain-artifacts.mjs";
const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OFFICIAL_NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function metadataText(value, label) {
  const text = String(value || "").trim();
  if (!text || text.length > 512 || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new Error(`${label} is missing or contains unsafe control characters`);
  }
  return text;
}

function packageNameFromLockPath(lockPath) {
  const marker = "node_modules/";
  const markerIndex = lockPath.lastIndexOf(marker);
  if (markerIndex < 0) {
    throw new Error("Production dependency has an invalid lockfile path");
  }
  const pathParts = lockPath.slice(markerIndex + marker.length).split("/");
  if (pathParts[0]?.startsWith("@")) {
    if (pathParts.length !== 2 || !pathParts[1]) {
      throw new Error("Scoped production dependency has an invalid lockfile path");
    }
    return `${pathParts[0]}/${pathParts[1]}`;
  }
  if (pathParts.length !== 1 || !pathParts[0]) {
    throw new Error("Production dependency has an empty package name");
  }
  return pathParts[0];
}

function packageCoordinates(packageName) {
  if (!packageName.startsWith("@")) {
    return { name: packageName };
  }
  const separator = packageName.indexOf("/");
  return {
    group: packageName.slice(0, separator),
    name: packageName.slice(separator + 1)
  };
}

function npmPurl(packageName, version) {
  const coordinates = packageCoordinates(packageName);
  const namespace = coordinates.group ? `${encodeURIComponent(coordinates.group)}/` : "";
  return `pkg:npm/${namespace}${encodeURIComponent(coordinates.name)}@${encodeURIComponent(version)}`;
}

function integrityHash(integrity) {
  const supportedAlgorithms = Object.freeze({
    sha256: { cyclonedx: "SHA-256", bytes: 32 },
    sha384: { cyclonedx: "SHA-384", bytes: 48 },
    sha512: { cyclonedx: "SHA-512", bytes: 64 }
  });
  for (const item of String(integrity || "").trim().split(/\s+/u)) {
    const separator = item.indexOf("-");
    if (separator < 1) continue;
    const sourceAlgorithm = item.slice(0, separator).toLowerCase();
    const algorithm = supportedAlgorithms[sourceAlgorithm];
    if (!algorithm) continue;
    const digest = Buffer.from(item.slice(separator + 1), "base64");
    if (digest.length !== algorithm.bytes) continue;
    return { alg: algorithm.cyclonedx, content: digest.toString("hex") };
  }
  throw new Error("Production dependency is missing a supported integrity digest");
}

function dependencyNames(packageEntry) {
  return [...new Set([
    ...Object.keys(packageEntry?.dependencies || {}),
    ...Object.keys(packageEntry?.optionalDependencies || {})
  ])].sort(compareText);
}

function resolveDependencyPath(packages, fromPath, dependencyName) {
  let cursor = fromPath;
  while (true) {
    const candidate = cursor
      ? `${cursor}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    const candidateEntry = packages[candidate];
    if (candidateEntry && candidateEntry.dev !== true && candidateEntry.link !== true) {
      return candidate;
    }
    if (!cursor) return null;
    const ancestorIndex = cursor.lastIndexOf("/node_modules/");
    if (ancestorIndex >= 0) {
      cursor = cursor.slice(0, ancestorIndex);
      continue;
    }
    if (cursor.startsWith("node_modules/")) {
      cursor = "";
      continue;
    }
    const parentSeparator = cursor.lastIndexOf("/");
    cursor = parentSeparator >= 0 ? cursor.slice(0, parentSeparator) : "";
  }
}

function normalizeLockfile(lockfile) {
  if (!lockfile || lockfile.lockfileVersion !== 3 || !lockfile.packages?.[""]) {
    throw new Error("Supply-chain generation requires a package-lock v3 root package");
  }

  const packages = lockfile.packages;
  for (const [packagePath, packageEntry] of Object.entries(packages)) {
    if (!packagePath.startsWith("node_modules/") || packageEntry?.link === true) continue;
    let resolvedUrl;
    try {
      resolvedUrl = new URL(String(packageEntry?.resolved || ""));
    } catch {
      throw new Error("External dependency is missing an absolute npm registry URL");
    }
    if (
      resolvedUrl.origin !== OFFICIAL_NPM_REGISTRY_ORIGIN
      || resolvedUrl.protocol !== "https:"
      || resolvedUrl.username
      || resolvedUrl.password
      || resolvedUrl.search
      || resolvedUrl.hash
    ) {
      throw new Error("External dependency does not resolve from the official npm registry origin");
    }
  }

  const externalEntries = Object.entries(packages)
    .filter(([packagePath, packageEntry]) => (
      packagePath.startsWith("node_modules/")
      && packageEntry?.dev !== true
      && packageEntry?.link !== true
    ))
    .sort(([left], [right]) => compareText(left, right));

  const pathToRef = new Map();
  const componentsByRef = new Map();
  for (const [packagePath, packageEntry] of externalEntries) {
    const packageName = packageNameFromLockPath(packagePath);
    const version = metadataText(packageEntry.version, "Production dependency version");
    const licenseExpression = metadataText(packageEntry.license, "Production dependency license");
    const purl = npmPurl(packageName, version);
    const digest = integrityHash(packageEntry.integrity);
    pathToRef.set(packagePath, purl);

    const existing = componentsByRef.get(purl);
    if (existing) {
      if (
        existing.packageName !== packageName
        || existing.version !== version
        || existing.licenseExpression !== licenseExpression
        || existing.digest.alg !== digest.alg
        || existing.digest.content !== digest.content
      ) {
        throw new Error("Conflicting production dependency metadata shares one package URL");
      }
      existing.optional = existing.optional && packageEntry.optional === true;
      existing.lockPaths.push(packagePath);
      continue;
    }

    componentsByRef.set(purl, {
      packageName,
      version,
      licenseExpression,
      purl,
      digest,
      optional: packageEntry.optional === true,
      lockPaths: [packagePath],
      dependencies: new Set()
    });
  }

  for (const [packagePath, packageEntry] of externalEntries) {
    const component = componentsByRef.get(pathToRef.get(packagePath));
    for (const dependencyName of dependencyNames(packageEntry)) {
      const dependencyPath = resolveDependencyPath(packages, packagePath, dependencyName);
      const dependencyRef = dependencyPath ? pathToRef.get(dependencyPath) : null;
      if (dependencyRef && dependencyRef !== component.purl) {
        component.dependencies.add(dependencyRef);
      }
    }
  }

  const rootDependencies = new Set();
  for (const [packagePath, packageEntry] of Object.entries(packages)) {
    const isInternalPackage = packagePath === ""
      || (!packagePath.startsWith("node_modules/") && packageEntry?.link !== true);
    if (!isInternalPackage) continue;
    for (const dependencyName of dependencyNames(packageEntry)) {
      const dependencyPath = resolveDependencyPath(packages, packagePath, dependencyName);
      const dependencyRef = dependencyPath ? pathToRef.get(dependencyPath) : null;
      if (dependencyRef) rootDependencies.add(dependencyRef);
    }
  }

  const reachableRefs = new Set(inventoryRootRefs(rootDependencies, componentsByRef));
  const components = [...componentsByRef.values()]
    .filter((component) => reachableRefs.has(component.purl))
    .sort((left, right) => compareText(left.purl, right.purl));
  return { components, rootDependencies };
}

function inventoryRootRefs(rootDependencies, componentsByRef) {
  const reachable = new Set(rootDependencies);
  const queue = [...reachable];
  while (queue.length > 0) {
    const component = componentsByRef.get(queue.shift());
    if (!component) continue;
    for (const dependencyRef of component.dependencies) {
      if (reachable.has(dependencyRef)) continue;
      reachable.add(dependencyRef);
      queue.push(dependencyRef);
    }
  }
  return reachable;
}

function cyclonedxComponent(component) {
  const coordinates = packageCoordinates(component.packageName);
  return {
    type: "library",
    "bom-ref": component.purl,
    ...(coordinates.group ? { group: coordinates.group } : {}),
    name: coordinates.name,
    version: component.version,
    scope: component.optional ? "optional" : "required",
    hashes: [component.digest],
    licenses: [{ expression: component.licenseExpression }],
    purl: component.purl
  };
}

function buildSbom(lockfile, inventory) {
  const rootPackage = lockfile.packages[""];
  const rootName = metadataText(rootPackage.name || lockfile.name, "Root package name");
  const rootVersion = metadataText(rootPackage.version || lockfile.version, "Root package version");
  const rootLicense = metadataText(rootPackage.license, "Root package license");
  const rootRef = npmPurl(rootName, rootVersion);
  const dependencies = [
    {
      ref: rootRef,
      dependsOn: [...inventory.rootDependencies].sort(compareText)
    },
    ...inventory.components.map((component) => ({
      ref: component.purl,
      dependsOn: [...component.dependencies].sort(compareText)
    }))
  ].sort((left, right) => compareText(left.ref, right.ref));

  return {
    $schema: "https://cyclonedx.org/schema/bom-1.5.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": rootRef,
        name: rootName,
        version: rootVersion,
        licenses: [{ expression: rootLicense }],
        purl: rootRef
      }
    },
    components: inventory.components.map(cyclonedxComponent),
    dependencies
  };
}

function buildNotices(inventory) {
  const lines = [
    "Meshrix Third-Party Dependency Notices",
    "",
    "Scope: production npm dependency graph from package-lock.json",
    `Components: ${inventory.components.length}`,
    "",
    "This index records dependency coordinates, declared license expressions,",
    "and integrity digests. Optional components are platform-selective. The",
    "declared expressions do not replace license files supplied by upstream",
    "packages or the obligations of a particular distribution.",
    ""
  ];

  for (const component of inventory.components) {
    lines.push(
      "---",
      `Package: ${component.packageName}@${component.version}`,
      `PURL: ${component.purl}`,
      `License: ${component.licenseExpression}`,
      `Scope: ${component.optional ? "optional" : "required"}`,
      `Integrity: ${component.digest.alg.toLowerCase()}:${component.digest.content}`,
      ""
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function assertSupplyChainPrivacy(value, label = "Supply-chain artifact") {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const leakPatterns = [
    /\/Users\/[A-Za-z0-9._-]+(?:\/|\b)/u,
    /\/home\/[A-Za-z0-9._-]+(?:\/|\b)/u,
    /\/private\/var\/folders\//u,
    /[A-Za-z]:\\Users\\[^\\\s]+/u,
    /Bearer\s+(?!\[redacted\])\S+/u,
    /\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9._-]{8,}\b/u,
    /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/u
  ];
  if (leakPatterns.some((pattern) => pattern.test(text))) {
    throw new Error(`${label} contains local or sensitive data`);
  }
}

export function buildSupplyChainArtifacts(lockfileText) {
  const lockfile = JSON.parse(lockfileText);
  const inventory = normalizeLockfile(lockfile);
  const sbom = stableJson(buildSbom(lockfile, inventory));
  const notices = buildNotices(inventory);
  assertSupplyChainPrivacy(sbom, "SBOM");
  assertSupplyChainPrivacy(notices, "Third-party notices");

  const requiredCount = inventory.components.filter((component) => !component.optional).length;
  const licenseExpressions = [...new Set(
    inventory.components.map((component) => component.licenseExpression)
  )].sort(compareText);
  const manifest = {
    schemaVersion: SUPPLY_CHAIN_MANIFEST_SCHEMA_VERSION,
    generator: GENERATOR_ID,
    scope: "production",
    noticeKind: "dependency-license-inventory",
    source: {
      lockfile: "package-lock.json",
      lockfileVersion: lockfile.lockfileVersion,
      sha256: sha256(lockfileText)
    },
    artifacts: [
      { file: SUPPLY_CHAIN_FILES.sbom, sha256: sha256(sbom), bytes: Buffer.byteLength(sbom) },
      { file: SUPPLY_CHAIN_FILES.notices, sha256: sha256(notices), bytes: Buffer.byteLength(notices) }
    ],
    summary: {
      productionComponents: inventory.components.length,
      requiredComponents: requiredCount,
      optionalComponents: inventory.components.length - requiredCount,
      licenseExpressions,
      licensePolicyEvaluated: false,
      legalTextCoverageEvaluated: false,
      reportLeakScan: true
    }
  };
  const manifestText = stableJson(manifest);
  assertSupplyChainPrivacy(manifestText, "Supply-chain manifest");
  return { sbom, notices, manifest: manifestText, summary: manifest.summary };
}

export async function generateSupplyChainArtifacts({ projectRoot = repoRoot, outputDir } = {}) {
  const resolvedOutputDir = outputDir || path.join(projectRoot, "build", "reports", "supply-chain");
  const lockfileText = await fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8");
  const artifacts = buildSupplyChainArtifacts(lockfileText);
  await fs.mkdir(resolvedOutputDir, { recursive: true });
  await Promise.all(Object.values(SUPPLY_CHAIN_FILES).map((filename) => (
    fs.rm(path.join(resolvedOutputDir, filename), { force: true })
  )));
  await Promise.all([
    fs.writeFile(path.join(resolvedOutputDir, SUPPLY_CHAIN_FILES.sbom), artifacts.sbom, { flag: "wx" }),
    fs.writeFile(path.join(resolvedOutputDir, SUPPLY_CHAIN_FILES.notices), artifacts.notices, { flag: "wx" }),
    fs.writeFile(path.join(resolvedOutputDir, SUPPLY_CHAIN_FILES.manifest), artifacts.manifest, { flag: "wx" })
  ]);
  return artifacts.summary;
}

function parseArgs(argv) {
  const args = { outputDir: path.join(repoRoot, "build", "reports", "supply-chain") };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output" && argv[index + 1]) {
      args.outputDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error("Usage: generate-supply-chain-artifacts.mjs [--output <directory>]");
  }
  return args;
}

function safeErrorMessage(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/\/Users\/[^\s'"]+/gu, "<local-path>")
    .replace(/\/home\/[^\s'"]+/gu, "<local-path>")
    .replace(/[A-Za-z]:\\Users\\[^\s"]+/gu, "<local-path>")
    .replace(/Bearer\s+\S+/gu, "Bearer [redacted]")
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9._-]+\b/gu, "[redacted]");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = await generateSupplyChainArtifacts({ outputDir: args.outputDir });
  console.log(JSON.stringify({
    ok: true,
    productionComponents: summary.productionComponents,
    requiredComponents: summary.requiredComponents,
    optionalComponents: summary.optionalComponents,
    reportLeakScan: summary.reportLeakScan
  }));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`[supply-chain] ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
