#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SUPPLY_CHAIN_FILES: Readonly<Record<string, any>> = Object.freeze({
  sbom: "bom.cdx.json",
  notices: "THIRD_PARTY_NOTICES.txt",
  manifest: "supply-chain-manifest.json"
});
export const SUPPLY_CHAIN_MANIFEST_SCHEMA_VERSION: any =
  "v0.0.1:supply-chain:artifact-manifest-1";

const GENERATOR_ID: any = "tools/generators/generate-supply-chain-artifacts.ts";
const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OFFICIAL_NPM_REGISTRY_ORIGIN: any = "https://registry.npmjs.org";

function sha256(value?: any) : any {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function compareText(left?: any, right?: any) : any {
  return left < right ? -1 : left > right ? 1 : 0;
}

function metadataText(value?: any, label?: any) : any {
  const text: any = String(value || "").trim();
  if (!text || text.length > 512 || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new Error(`${label} is missing or contains unsafe control characters`);
  }
  return text;
}

function packageNameFromLockPath(lockPath?: any) : any {
  const marker: any = "node_modules/";
  const markerIndex: any = lockPath.lastIndexOf(marker);
  if (markerIndex < 0) {
    throw new Error("Production dependency has an invalid lockfile path");
  }
  const pathParts: any = lockPath.slice(markerIndex + marker.length).split("/");
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

function packageCoordinates(packageName?: any) : any {
  if (!packageName.startsWith("@")) {
    return { name: packageName };
  }
  const separator: any = packageName.indexOf("/");
  return {
    group: packageName.slice(0, separator),
    name: packageName.slice(separator + 1)
  };
}

function npmPurl(packageName?: any, version?: any) : any {
  const coordinates: any = packageCoordinates(packageName);
  const namespace: any = coordinates.group ? `${encodeURIComponent(coordinates.group)}/` : "";
  return `pkg:npm/${namespace}${encodeURIComponent(coordinates.name)}@${encodeURIComponent(version)}`;
}

function integrityHash(integrity?: any) : any {
  const supportedAlgorithms: Readonly<Record<string, any>> = Object.freeze({
    sha256: { cyclonedx: "SHA-256", bytes: 32 },
    sha384: { cyclonedx: "SHA-384", bytes: 48 },
    sha512: { cyclonedx: "SHA-512", bytes: 64 }
  });
  for (const item of String(integrity || "").trim().split(/\s+/u)) {
    const separator: any = item.indexOf("-");
    if (separator < 1) continue;
    const sourceAlgorithm: any = item.slice(0, separator).toLowerCase();
    const algorithm: any = supportedAlgorithms[sourceAlgorithm];
    if (!algorithm) continue;
    const digest: any = Buffer.from(item.slice(separator + 1), "base64");
    if (digest.length !== algorithm.bytes) continue;
    return { alg: algorithm.cyclonedx, content: digest.toString("hex") };
  }
  throw new Error("Production dependency is missing a supported integrity digest");
}

function dependencyNames(packageEntry?: any) : any {
  return [...new Set<any>([
    ...Object.keys(packageEntry?.dependencies || {}),
    ...Object.keys(packageEntry?.optionalDependencies || {})
  ])].sort(compareText);
}

function resolveDependencyPath(packages?: any, fromPath?: any, dependencyName?: any) : any {
  let cursor: any = fromPath;
  while (true) {
    const candidate: any = cursor
      ? `${cursor}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    const candidateEntry: any = packages[candidate];
    if (candidateEntry && candidateEntry.dev !== true && candidateEntry.link !== true) {
      return candidate;
    }
    if (!cursor) return null;
    const ancestorIndex: any = cursor.lastIndexOf("/node_modules/");
    if (ancestorIndex >= 0) {
      cursor = cursor.slice(0, ancestorIndex);
      continue;
    }
    if (cursor.startsWith("node_modules/")) {
      cursor = "";
      continue;
    }
    const parentSeparator: any = cursor.lastIndexOf("/");
    cursor = parentSeparator >= 0 ? cursor.slice(0, parentSeparator) : "";
  }
}

function normalizeLockfile(lockfile?: any) : any {
  if (!lockfile || lockfile.lockfileVersion !== 3 || !lockfile.packages?.[""]) {
    throw new Error("Supply-chain generation requires a package-lock v3 root package");
  }

  const packages: any = lockfile.packages;
  for (const [packagePath, packageEntry] of (Object.entries(packages) as [string, any][])) {
    if (!packagePath.startsWith("node_modules/") || packageEntry?.link === true) continue;
    let resolvedUrl: any;
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

  const externalEntries: any = (Object.entries(packages) as [string, any][])
    .filter(([packagePath, packageEntry]: any[]) : any => (
      packagePath.startsWith("node_modules/")
      && packageEntry?.dev !== true
      && packageEntry?.link !== true
    ))
    .sort(([left]: any[], [right]: any[]) : any => compareText(left, right));

  const pathToRef: any = new Map<any, any>();
  const componentsByRef: any = new Map<any, any>();
  for (const [packagePath, packageEntry] of externalEntries) {
    const packageName: any = packageNameFromLockPath(packagePath);
    const version: any = metadataText(packageEntry.version, "Production dependency version");
    const licenseExpression: any = metadataText(packageEntry.license, "Production dependency license");
    const purl: any = npmPurl(packageName, version);
    const digest: any = integrityHash(packageEntry.integrity);
    pathToRef.set(packagePath, purl);

    const existing: any = componentsByRef.get(purl);
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
      dependencies: new Set<any>()
    });
  }

  for (const [packagePath, packageEntry] of externalEntries) {
    const component: any = componentsByRef.get(pathToRef.get(packagePath));
    for (const dependencyName of dependencyNames(packageEntry)) {
      const dependencyPath: any = resolveDependencyPath(packages, packagePath, dependencyName);
      const dependencyRef: any = dependencyPath ? pathToRef.get(dependencyPath) : null;
      if (dependencyRef && dependencyRef !== component.purl) {
        component.dependencies.add(dependencyRef);
      }
    }
  }

  const rootDependencies: any = new Set<any>();
  for (const [packagePath, packageEntry] of (Object.entries(packages) as [string, any][])) {
    const isInternalPackage: any = packagePath === ""
      || (!packagePath.startsWith("node_modules/") && packageEntry?.link !== true);
    if (!isInternalPackage) continue;
    for (const dependencyName of dependencyNames(packageEntry)) {
      const dependencyPath: any = resolveDependencyPath(packages, packagePath, dependencyName);
      const dependencyRef: any = dependencyPath ? pathToRef.get(dependencyPath) : null;
      if (dependencyRef) rootDependencies.add(dependencyRef);
    }
  }

  const reachableRefs: any = new Set<any>(inventoryRootRefs(rootDependencies, componentsByRef));
  const components: any = [...componentsByRef.values()]
    .filter((component?: any) : any => reachableRefs.has(component.purl))
    .sort((left?: any, right?: any) : any => compareText(left.purl, right.purl));
  return { components, rootDependencies };
}

function inventoryRootRefs(rootDependencies?: any, componentsByRef?: any) : any {
  const reachable: any = new Set<any>(rootDependencies);
  const queue: any[] = [...reachable];
  while (queue.length > 0) {
    const component: any = componentsByRef.get(queue.shift());
    if (!component) continue;
    for (const dependencyRef of component.dependencies) {
      if (reachable.has(dependencyRef)) continue;
      reachable.add(dependencyRef);
      queue.push(dependencyRef);
    }
  }
  return reachable;
}

function cyclonedxComponent(component?: any) : any {
  const coordinates: any = packageCoordinates(component.packageName);
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

function buildSbom(lockfile?: any, inventory?: any) : any {
  const rootPackage: any = lockfile.packages[""];
  const rootName: any = metadataText(rootPackage.name || lockfile.name, "Root package name");
  const rootVersion: any = metadataText(rootPackage.version || lockfile.version, "Root package version");
  const rootLicense: any = metadataText(rootPackage.license, "Root package license");
  const rootRef: any = npmPurl(rootName, rootVersion);
  const dependencies: any = [
    {
      ref: rootRef,
      dependsOn: [...inventory.rootDependencies].sort(compareText)
    },
    ...inventory.components.map((component?: any) : any => ({
      ref: component.purl,
      dependsOn: [...component.dependencies].sort(compareText)
    }))
  ].sort((left?: any, right?: any) : any => compareText(left.ref, right.ref));

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

function buildNotices(inventory?: any) : any {
  const lines: any[] = [
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

function stableJson(value?: any) : any {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function assertSupplyChainPrivacy(value?: any, label: any = "Supply-chain artifact") : any {
  const text: any = typeof value === "string" ? value : JSON.stringify(value);
  const leakPatterns: any[] = [
    /\/Users\/[A-Za-z0-9._-]+(?:\/|\b)/u,
    /\/home\/[A-Za-z0-9._-]+(?:\/|\b)/u,
    /\/private\/var\/folders\//u,
    /[A-Za-z]:\\Users\\[^\\\s]+/u,
    /Bearer\s+(?!\[redacted\])\S+/u,
    /\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9._-]{8,}\b/u,
    /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/u
  ];
  if (leakPatterns.some((pattern?: any) : any => pattern.test(text))) {
    throw new Error(`${label} contains local or sensitive data`);
  }
}

export function buildSupplyChainArtifacts(lockfileText?: any) : any {
  const lockfile: any = JSON.parse(lockfileText);
  const inventory: any = normalizeLockfile(lockfile);
  const sbom: any = stableJson(buildSbom(lockfile, inventory));
  const notices: any = buildNotices(inventory);
  assertSupplyChainPrivacy(sbom, "SBOM");
  assertSupplyChainPrivacy(notices, "Third-party notices");

  const requiredCount: any = inventory.components.filter((component?: any) : any => !component.optional).length;
  const licenseExpressions: any = [...new Set<any>(
    inventory.components.map((component?: any) : any => component.licenseExpression)
  )].sort(compareText);
  const manifest: Record<string, any> = {
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
  const manifestText: any = stableJson(manifest);
  assertSupplyChainPrivacy(manifestText, "Supply-chain manifest");
  return { sbom, notices, manifest: manifestText, summary: manifest.summary };
}

export async function generateSupplyChainArtifacts({ projectRoot = repoRoot, outputDir }: Record<string, any> = {}) : Promise<any> {
  const resolvedOutputDir: any = outputDir || path.join(projectRoot, "build", "reports", "supply-chain");
  const lockfileText: any = await fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8");
  const artifacts: any = buildSupplyChainArtifacts(lockfileText);
  await fs.mkdir(resolvedOutputDir, { recursive: true });
  await Promise.all((Object.values(SUPPLY_CHAIN_FILES) as any[]).map((filename?: any) : any => (
    fs.rm(path.join(resolvedOutputDir, filename), { force: true })
  )));
  await Promise.all([
    fs.writeFile(path.join(resolvedOutputDir, SUPPLY_CHAIN_FILES.sbom), artifacts.sbom, { flag: "wx" }),
    fs.writeFile(path.join(resolvedOutputDir, SUPPLY_CHAIN_FILES.notices), artifacts.notices, { flag: "wx" }),
    fs.writeFile(path.join(resolvedOutputDir, SUPPLY_CHAIN_FILES.manifest), artifacts.manifest, { flag: "wx" })
  ]);
  return artifacts.summary;
}

function parseArgs(argv?: any) : any {
  const args: Record<string, any> = { outputDir: path.join(repoRoot, "build", "reports", "supply-chain") };
  for (let index: any = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output" && argv[index + 1]) {
      args.outputDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error("Usage: generate-supply-chain-artifacts.ts [--output <directory>]");
  }
  return args;
}

function safeErrorMessage(error?: any) : any {
  return String(error instanceof Error ? error.message : error)
    .replace(/\/Users\/[^\s'"]+/gu, "<local-path>")
    .replace(/\/home\/[^\s'"]+/gu, "<local-path>")
    .replace(/[A-Za-z]:\\Users\\[^\s"]+/gu, "<local-path>")
    .replace(/Bearer\s+\S+/gu, "Bearer [redacted]")
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9._-]+\b/gu, "[redacted]");
}

async function main() : Promise<any> {
  const args: any = parseArgs(process.argv.slice(2));
  const summary: any = await generateSupplyChainArtifacts({ outputDir: args.outputDir });
  console.log(JSON.stringify({
    ok: true,
    productionComponents: summary.productionComponents,
    requiredComponents: summary.requiredComponents,
    optionalComponents: summary.optionalComponents,
    reportLeakScan: summary.reportLeakScan
  }));
}

const invokedPath: any = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error?: any) : any => {
    console.error(`[supply-chain] ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
