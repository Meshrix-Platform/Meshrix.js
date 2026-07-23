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
} from "../generators/generate-supply-chain-artifacts.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function readArtifact(inputDir, filename) {
  try {
    return await fs.readFile(path.join(inputDir, filename), "utf8");
  } catch {
    throw new Error(`Required supply-chain artifact is missing: ${filename}`);
  }
}

function validateStructure(artifacts, lockfileText) {
  const sbom = JSON.parse(artifacts.sbom);
  const manifest = JSON.parse(artifacts.manifest);
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

  const componentRefs = sbom.components.map((component) => component["bom-ref"]);
  invariant(componentRefs.every(Boolean), "Every SBOM component requires a bom-ref");
  invariant(new Set(componentRefs).size === componentRefs.length, "SBOM component refs must be unique");
  invariant(
    componentRefs.every((ref, index) => index === 0 || compareText(componentRefs[index - 1], ref) <= 0),
    "SBOM components must be deterministically sorted"
  );
  invariant(
    sbom.components.every((component) => (
      component.purl === component["bom-ref"]
      && ["required", "optional"].includes(component.scope)
      && typeof component.licenses?.[0]?.expression === "string"
      && /^[0-9a-f]+$/u.test(component.hashes?.[0]?.content || "")
    )),
    "SBOM component metadata is incomplete"
  );

  const allowedRefs = new Set([sbom.metadata?.component?.["bom-ref"], ...componentRefs]);
  invariant(
    sbom.dependencies.every((dependency) => (
      allowedRefs.has(dependency.ref)
      && Array.isArray(dependency.dependsOn)
      && dependency.dependsOn.every((ref) => allowedRefs.has(ref))
    )),
    "SBOM dependency graph references an unknown component"
  );
  const rootRef = sbom.metadata?.component?.["bom-ref"];
  const graph = new Map(sbom.dependencies.map((dependency) => [dependency.ref, dependency.dependsOn]));
  const reachableRefs = new Set([rootRef]);
  const queue = [rootRef];
  while (queue.length > 0) {
    for (const dependencyRef of graph.get(queue.shift()) || []) {
      if (reachableRefs.has(dependencyRef)) continue;
      reachableRefs.add(dependencyRef);
      queue.push(dependencyRef);
    }
  }
  invariant(
    componentRefs.every((ref) => reachableRefs.has(ref)),
    "SBOM contains a component outside the production dependency graph"
  );

  invariant(Array.isArray(manifest.artifacts), "Supply-chain artifact manifest is invalid");
  for (const descriptor of manifest.artifacts) {
    const artifactText = descriptor.file === SUPPLY_CHAIN_FILES.sbom
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

export async function verifySupplyChainArtifacts({ projectRoot = repoRoot, inputDir } = {}) {
  const resolvedInputDir = inputDir || path.join(projectRoot, "build", "reports", "supply-chain");
  const lockfileText = await fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8");
  const expectedFilenames = Object.values(SUPPLY_CHAIN_FILES).sort(compareText);
  let outputEntries;
  try {
    outputEntries = await fs.readdir(resolvedInputDir, { withFileTypes: true });
  } catch {
    throw new Error("Supply-chain artifact directory is missing");
  }
  const outputFilenames = outputEntries
    .map((entry) => entry.name)
    .sort(compareText);
  invariant(
    outputEntries.every((entry) => entry.isFile())
      && JSON.stringify(outputFilenames) === JSON.stringify(expectedFilenames),
    "Supply-chain artifact directory contains an unexpected entry"
  );
  const actual = {
    sbom: await readArtifact(resolvedInputDir, SUPPLY_CHAIN_FILES.sbom),
    notices: await readArtifact(resolvedInputDir, SUPPLY_CHAIN_FILES.notices),
    manifest: await readArtifact(resolvedInputDir, SUPPLY_CHAIN_FILES.manifest)
  };
  for (const [label, value] of Object.entries(actual)) {
    assertSupplyChainPrivacy(value, label);
  }
  validateStructure(actual, lockfileText);

  const expected = buildSupplyChainArtifacts(lockfileText);
  for (const filename of ["sbom", "notices", "manifest"]) {
    invariant(actual[filename] === expected[filename], `Artifact is not reproducible: ${filename}`);
  }
  return JSON.parse(actual.manifest).summary;
}

async function expectFailure(operation, label) {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(`Negative verification did not fail: ${label}`);
}

export async function runNegativeSelfTest() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "licomesh-supply-chain-"));
  const outputDir = path.join(temporaryRoot, "artifacts");
  try {
    const lockfileText = await fs.readFile(path.join(repoRoot, "package-lock.json"), "utf8");
    await generateSupplyChainArtifacts({ projectRoot: repoRoot, outputDir });
    await verifySupplyChainArtifacts({ projectRoot: repoRoot, inputDir: outputDir });

    const sbomPath = path.join(outputDir, SUPPLY_CHAIN_FILES.sbom);
    const validSbom = await fs.readFile(sbomPath, "utf8");
    await fs.writeFile(sbomPath, validSbom.replace('"specVersion": "1.5"', '"specVersion": "1.4"'));
    await expectFailure(
      () => verifySupplyChainArtifacts({ projectRoot: repoRoot, inputDir: outputDir }),
      "tampered SBOM"
    );

    await generateSupplyChainArtifacts({ projectRoot: repoRoot, outputDir });
    const manifestPath = path.join(outputDir, SUPPLY_CHAIN_FILES.manifest);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.artifacts[0].sha256 = "0".repeat(64);
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expectFailure(
      () => verifySupplyChainArtifacts({ projectRoot: repoRoot, inputDir: outputDir }),
      "tampered manifest digest"
    );

    await generateSupplyChainArtifacts({ projectRoot: repoRoot, outputDir });
    const unexpectedPath = path.join(outputDir, "unexpected-artifact.txt");
    await fs.writeFile(unexpectedPath, "unexpected\n");
    await expectFailure(
      () => verifySupplyChainArtifacts({ projectRoot: repoRoot, inputDir: outputDir }),
      "unexpected artifact"
    );
    await fs.rm(unexpectedPath, { force: true });

    await expectFailure(
      async () => assertSupplyChainPrivacy(["Bearer", "unredacted-negative-test-token"].join(" "), "Negative fixture"),
      "sensitive report content"
    );

    const unsafeMetadataLock = JSON.parse(lockfileText);
    const firstProductionPath = Object.entries(unsafeMetadataLock.packages)
      .find(([packagePath, packageEntry]) => (
        packagePath.startsWith("node_modules/")
        && packageEntry.dev !== true
        && packageEntry.link !== true
      ))?.[0];
    invariant(Boolean(firstProductionPath), "Negative fixture requires a production dependency");
    unsafeMetadataLock.packages[firstProductionPath].license = "MIT\nInjected: value";
    await expectFailure(
      async () => buildSupplyChainArtifacts(`${JSON.stringify(unsafeMetadataLock)}\n`),
      "unsafe lockfile metadata"
    );

    const invalidIntegrityLock = JSON.parse(lockfileText);
    invalidIntegrityLock.packages[firstProductionPath].integrity = "sha512-invalid";
    await expectFailure(
      async () => buildSupplyChainArtifacts(`${JSON.stringify(invalidIntegrityLock)}\n`),
      "invalid dependency integrity"
    );

    const untrustedOriginLock = JSON.parse(lockfileText);
    untrustedOriginLock.packages[firstProductionPath].resolved = "https://registry.example.test/package.tgz";
    await expectFailure(
      async () => buildSupplyChainArtifacts(`${JSON.stringify(untrustedOriginLock)}\n`),
      "non-official npm registry origin"
    );

    const missingOriginLock = JSON.parse(lockfileText);
    delete missingOriginLock.packages[firstProductionPath].resolved;
    await expectFailure(
      async () => buildSupplyChainArtifacts(`${JSON.stringify(missingOriginLock)}\n`),
      "missing npm registry origin"
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = {
    inputDir: path.join(repoRoot, "build", "reports", "supply-chain"),
    selfTest: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--input" && argv[index + 1]) {
      args.inputDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (argv[index] === "--self-test") {
      args.selfTest = true;
      continue;
    }
    throw new Error("Usage: verify-supply-chain-artifacts.mjs [--input <directory>] [--self-test]");
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
  const summary = await verifySupplyChainArtifacts({ inputDir: args.inputDir });
  if (args.selfTest) await runNegativeSelfTest();
  console.log(JSON.stringify({
    ok: true,
    productionComponents: summary.productionComponents,
    reportLeakScan: summary.reportLeakScan,
    negativeSelfTest: args.selfTest
  }));
}

main().catch((error) => {
  console.error(`[supply-chain] ${safeErrorMessage(error)}`);
  process.exitCode = 1;
});
