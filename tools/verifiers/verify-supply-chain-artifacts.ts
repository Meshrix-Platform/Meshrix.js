#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  SUPPLY_CHAIN_FILES,
  SUPPLY_CHAIN_MANIFEST_SCHEMA_VERSION,
  assertSupplyChainPrivacy,
  buildSupplyChainArtifacts,
  generateSupplyChainArtifacts
} from "../generators/generate-supply-chain-artifacts.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function sha256(value?: any) : any {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function compareText(left?: any, right?: any) : any {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invariant(condition?: any, message?: any) : any {
  if (!condition) throw new Error(message);
}

async function readArtifact(inputDir?: any, filename?: any) : Promise<any> {
  try {
    return await fs.readFile(path.join(inputDir, filename), "utf8");
  } catch {
    throw new Error(`Required supply-chain artifact is missing: ${filename}`);
  }
}

function validateStructure(artifacts?: any, lockfileText?: any) : any {
  const sbom: any = JSON.parse(artifacts.sbom);
  const manifest: any = JSON.parse(artifacts.manifest);
  invariant(sbom.bomFormat === "CycloneDX", "SBOM format must be CycloneDX");
  invariant(sbom.specVersion === "1.5", "SBOM spec version must be 1.5");
  invariant(sbom.version === 1, "SBOM document version must be 1");
  invariant(Array.isArray(sbom.components), "SBOM components must be an array");
  invariant(Array.isArray(sbom.dependencies), "SBOM dependencies must be an array");
  invariant(
    manifest.schemaVersion === SUPPLY_CHAIN_MANIFEST_SCHEMA_VERSION,
    "Supply-chain manifest schema is unsupported"
  );
  invariant(manifest.scope === "production", "Supply-chain manifest scope must be production");
  invariant(
    manifest.noticeKind === "dependency-license-inventory",
    "Third-party notice kind must describe inventory-only coverage"
  );
  invariant(manifest.source?.sha256 === sha256(lockfileText), "Lockfile digest does not match");
  invariant(
    manifest.summary?.licensePolicyEvaluated === false,
    "License inventory must not claim an unapproved compatibility policy"
  );
  invariant(
    manifest.summary?.legalTextCoverageEvaluated === false,
    "Notice inventory must not claim unverified upstream legal-text coverage"
  );
  invariant(manifest.summary?.reportLeakScan === true, "Privacy scan evidence is missing");
  invariant(
    manifest.summary?.productionComponents === sbom.components.length,
    "SBOM component count does not match the manifest"
  );

  const componentRefs: any = sbom.components.map((component?: any) : any => component["bom-ref"]);
  invariant(componentRefs.every(Boolean), "Every SBOM component requires a bom-ref");
  invariant(new Set<any>(componentRefs).size === componentRefs.length, "SBOM component refs must be unique");
  invariant(
    componentRefs.every((ref?: any, index?: any) : any => index === 0 || compareText(componentRefs[index - 1], ref) <= 0),
    "SBOM components must be deterministically sorted"
  );
  invariant(
    sbom.components.every((component?: any) : any => (
      component.purl === component["bom-ref"]
      && ["required", "optional"].includes(component.scope)
      && typeof component.licenses?.[0]?.expression === "string"
      && /^[0-9a-f]+$/u.test(component.hashes?.[0]?.content || "")
    )),
    "SBOM component metadata is incomplete"
  );

  const allowedRefs: any = new Set<any>([sbom.metadata?.component?.["bom-ref"], ...componentRefs]);
  invariant(
    sbom.dependencies.every((dependency?: any) : any => (
      allowedRefs.has(dependency.ref)
      && Array.isArray(dependency.dependsOn)
      && dependency.dependsOn.every((ref?: any) : any => allowedRefs.has(ref))
    )),
    "SBOM dependency graph references an unknown component"
  );
  const rootRef: any = sbom.metadata?.component?.["bom-ref"];
  const graph: any = new Map<any, any>(sbom.dependencies.map((dependency?: any) : any => [dependency.ref, dependency.dependsOn]));
  const reachableRefs: any = new Set<any>([rootRef]);
  const queue: any[] = [rootRef];
  while (queue.length > 0) {
    for (const dependencyRef of graph.get(queue.shift()) || []) {
      if (reachableRefs.has(dependencyRef)) continue;
      reachableRefs.add(dependencyRef);
      queue.push(dependencyRef);
    }
  }
  invariant(
    componentRefs.every((ref?: any) : any => reachableRefs.has(ref)),
    "SBOM contains a component outside the production dependency graph"
  );

  invariant(Array.isArray(manifest.artifacts), "Supply-chain artifact manifest is invalid");
  for (const descriptor of manifest.artifacts) {
    const artifactText: any = descriptor.file === SUPPLY_CHAIN_FILES.sbom
      ? artifacts.sbom
      : descriptor.file === SUPPLY_CHAIN_FILES.notices
        ? artifacts.notices
        : null;
    invariant(artifactText !== null, "Supply-chain manifest names an unknown artifact");
    invariant(descriptor.sha256 === sha256(artifactText), `Artifact digest mismatch: ${descriptor.file}`);
    invariant(descriptor.bytes === Buffer.byteLength(artifactText), `Artifact size mismatch: ${descriptor.file}`);
  }
  invariant(
    artifacts.notices.includes(`Components: ${sbom.components.length}`),
    "Third-party notices do not declare the SBOM component count"
  );
}

export async function verifySupplyChainArtifacts({ projectRoot = repoRoot, inputDir }: Record<string, any> = {}) : Promise<any> {
  const resolvedInputDir: any = inputDir || path.join(projectRoot, "build", "reports", "supply-chain");
  const lockfileText: any = await fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8");
  const expectedFilenames: any = (Object.values(SUPPLY_CHAIN_FILES) as any[]).sort(compareText);
  let outputEntries: any;
  try {
    outputEntries = await fs.readdir(resolvedInputDir, { withFileTypes: true });
  } catch {
    throw new Error("Supply-chain artifact directory is missing");
  }
  const outputFilenames: any = outputEntries
    .map((entry?: any) : any => entry.name)
    .sort(compareText);
  invariant(
    outputEntries.every((entry?: any) : any => entry.isFile())
      && JSON.stringify(outputFilenames) === JSON.stringify(expectedFilenames),
    "Supply-chain artifact directory contains an unexpected entry"
  );
  const actual: Record<string, any> = {
    sbom: await readArtifact(resolvedInputDir, SUPPLY_CHAIN_FILES.sbom),
    notices: await readArtifact(resolvedInputDir, SUPPLY_CHAIN_FILES.notices),
    manifest: await readArtifact(resolvedInputDir, SUPPLY_CHAIN_FILES.manifest)
  };
  for (const [label, value] of (Object.entries(actual) as [string, any][])) {
    assertSupplyChainPrivacy(value, label);
  }
  validateStructure(actual, lockfileText);

  const expected: any = buildSupplyChainArtifacts(lockfileText);
  for (const filename of ["sbom", "notices", "manifest"]) {
    invariant(actual[filename] === expected[filename], `Artifact is not reproducible: ${filename}`);
  }
  return JSON.parse(actual.manifest).summary;
}

async function expectFailure(operation?: any, label?: any) : Promise<any> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(`Negative verification did not fail: ${label}`);
}

export async function runNegativeSelfTest() : Promise<any> {
  const temporaryRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-supply-chain-"));
  const outputDir: any = path.join(temporaryRoot, "artifacts");
  try {
    const lockfileText: any = await fs.readFile(path.join(repoRoot, "package-lock.json"), "utf8");
    await generateSupplyChainArtifacts({ projectRoot: repoRoot, outputDir });
    await verifySupplyChainArtifacts({ projectRoot: repoRoot, inputDir: outputDir });

    const sbomPath: any = path.join(outputDir, SUPPLY_CHAIN_FILES.sbom);
    const validSbom: any = await fs.readFile(sbomPath, "utf8");
    await fs.writeFile(sbomPath, validSbom.replace('"specVersion": "1.5"', '"specVersion": "1.4"'));
    await expectFailure(
      () : any => verifySupplyChainArtifacts({ projectRoot: repoRoot, inputDir: outputDir }),
      "tampered SBOM"
    );

    await generateSupplyChainArtifacts({ projectRoot: repoRoot, outputDir });
    const manifestPath: any = path.join(outputDir, SUPPLY_CHAIN_FILES.manifest);
    const manifest: any = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.artifacts[0].sha256 = "0".repeat(64);
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expectFailure(
      () : any => verifySupplyChainArtifacts({ projectRoot: repoRoot, inputDir: outputDir }),
      "tampered manifest digest"
    );

    await generateSupplyChainArtifacts({ projectRoot: repoRoot, outputDir });
    const unexpectedPath: any = path.join(outputDir, "unexpected-artifact.txt");
    await fs.writeFile(unexpectedPath, "unexpected\n");
    await expectFailure(
      () : any => verifySupplyChainArtifacts({ projectRoot: repoRoot, inputDir: outputDir }),
      "unexpected artifact"
    );
    await fs.rm(unexpectedPath, { force: true });

    await expectFailure(
      async () : Promise<any> => assertSupplyChainPrivacy(["Bearer", "unredacted-negative-test-token"].join(" "), "Negative fixture"),
      "sensitive report content"
    );

    const unsafeMetadataLock: any = JSON.parse(lockfileText);
    const firstProductionPath: any = (Object.entries(unsafeMetadataLock.packages) as [string, any][])
      .find(([packagePath, packageEntry]: any[]) : any => (
        packagePath.startsWith("node_modules/")
        && packageEntry.dev !== true
        && packageEntry.link !== true
      ))?.[0];
    invariant(Boolean(firstProductionPath), "Negative fixture requires a production dependency");
    unsafeMetadataLock.packages[firstProductionPath].license = "MIT\nInjected: value";
    await expectFailure(
      async () : Promise<any> => buildSupplyChainArtifacts(`${JSON.stringify(unsafeMetadataLock)}\n`),
      "unsafe lockfile metadata"
    );

    const invalidIntegrityLock: any = JSON.parse(lockfileText);
    invalidIntegrityLock.packages[firstProductionPath].integrity = "sha512-invalid";
    await expectFailure(
      async () : Promise<any> => buildSupplyChainArtifacts(`${JSON.stringify(invalidIntegrityLock)}\n`),
      "invalid dependency integrity"
    );

    const untrustedOriginLock: any = JSON.parse(lockfileText);
    untrustedOriginLock.packages[firstProductionPath].resolved = "https://registry.example.test/package.tgz";
    await expectFailure(
      async () : Promise<any> => buildSupplyChainArtifacts(`${JSON.stringify(untrustedOriginLock)}\n`),
      "non-official npm registry origin"
    );

    const missingOriginLock: any = JSON.parse(lockfileText);
    delete missingOriginLock.packages[firstProductionPath].resolved;
    await expectFailure(
      async () : Promise<any> => buildSupplyChainArtifacts(`${JSON.stringify(missingOriginLock)}\n`),
      "missing npm registry origin"
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv?: any) : any {
  const args: Record<string, any> = {
    inputDir: path.join(repoRoot, "build", "reports", "supply-chain"),
    selfTest: false
  };
  for (let index: any = 0; index < argv.length; index += 1) {
    if (argv[index] === "--input" && argv[index + 1]) {
      args.inputDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (argv[index] === "--self-test") {
      args.selfTest = true;
      continue;
    }
    throw new Error("Usage: verify-supply-chain-artifacts.ts [--input <directory>] [--self-test]");
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
  const summary: any = await verifySupplyChainArtifacts({ inputDir: args.inputDir });
  if (args.selfTest) await runNegativeSelfTest();
  console.log(JSON.stringify({
    ok: true,
    productionComponents: summary.productionComponents,
    reportLeakScan: summary.reportLeakScan,
    negativeSelfTest: args.selfTest
  }));
}

main().catch((error?: any) : any => {
  console.error(`[supply-chain] ${safeErrorMessage(error)}`);
  process.exitCode = 1;
});
