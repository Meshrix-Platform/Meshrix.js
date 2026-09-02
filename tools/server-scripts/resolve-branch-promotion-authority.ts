#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { canonicalJson } from "../../packages/contracts/src/serialization/canonical-json.ts";
import {
  assertManifestMatchesRun,
  createReleaseAuthorityManifest,
  createStableAuthorityManifest,
  selectExactPromotionArtifact,
  selectSuccessfulPromotionRun,
  validatePromotionRunSelection,
  validateReleaseAuthorityManifest,
  validateStableAuthorityManifest,
} from "./lib/release-deployment/authority.ts";
import {
  assertReleaseDeploymentReceipt,
  sha256,
} from "./lib/release-deployment/contract.ts";
import { validateAcceptedCandidateReceipt } from "./lib/platform-acceptance-generation-store.ts";
import { validateReleaseCandidateIdentity } from "./verify-release-candidate-identity.ts";

const STABLE_FILES = Object.freeze([
  "SOURCE_CANDIDATE.json",
  "accepted-candidate.json",
  "stable-authority-manifest.json",
]);
const RELEASE_FILES = Object.freeze([
  ...STABLE_FILES,
  "release-authority-manifest.json",
  "release-deployment.json",
]);
const MAX_AUTHORITY_FILE_BYTES = 4 * 1024 * 1024;

function fail(code: string, detail = code): never {
  throw Object.assign(new Error(detail), { code });
}

function parseArgs(argv: string[]): { command: string; options: Record<string, string> } {
  const [command = "", ...rest] = argv;
  const options: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail("promotion_authority_argument_invalid");
    }
    const key = name.slice(2);
    if (Object.hasOwn(options, key)) fail("promotion_authority_argument_duplicate");
    options[key] = value;
  }
  return { command, options };
}

function requireOption(options: Record<string, string>, key: string): string {
  const value = options[key];
  if (!value) fail(`promotion_authority_${key.replaceAll("-", "_")}_required`);
  return value;
}

async function readBoundedFile(filePath: string): Promise<Buffer> {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_AUTHORITY_FILE_BYTES) {
    fail("promotion_authority_file_invalid");
  }
  return fs.readFile(filePath);
}

async function readJson(filePath: string): Promise<any> {
  const bytes = await readBoundedFile(filePath);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("promotion_authority_json_invalid");
  }
}

async function writeJsonAtomic(filePath: string, value: any): Promise<void> {
  const absolute = path.resolve(filePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, absolute);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function requireExactBundleFiles(bundlePath: string, expected: readonly string[]): Promise<void> {
  const entries = await fs.readdir(bundlePath, { withFileTypes: true }).catch(() => null);
  if (!entries || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    fail("promotion_authority_bundle_invalid");
  }
  const actual = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    fail("promotion_authority_bundle_fields_invalid");
  }
}

async function validatedCandidate(filePath: string): Promise<{ bytes: Buffer; candidate: any }> {
  const bytes = await readBoundedFile(filePath);
  let candidate: any;
  try {
    candidate = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("promotion_authority_candidate_json_invalid");
  }
  validateReleaseCandidateIdentity(candidate);
  return { bytes, candidate };
}

async function validateFunctional(
  filePath: string,
  candidate: any,
): Promise<{ bytes: Buffer; digest: string }> {
  const bytes = await readBoundedFile(filePath);
  try {
    const receipt = validateAcceptedCandidateReceipt(JSON.parse(bytes.toString("utf8")), {
      candidateDigest: candidate.candidate_digest,
      sourceRevision: candidate.source_revision,
    });
    if (!candidate.supported_profiles.includes(receipt.selectedProfile)) {
      fail("promotion_authority_functional_receipt_invalid");
    }
  } catch {
    fail("promotion_authority_functional_receipt_invalid");
  }
  return { bytes, digest: sha256(bytes) };
}

async function compareExpectedCandidate(actual: any, expectedPath: string): Promise<void> {
  const expected = await validatedCandidate(expectedPath);
  if (canonicalJson(actual) !== canonicalJson(expected.candidate)) {
    fail("promotion_authority_checkout_candidate_mismatch");
  }
}

async function verifyStableBundle({
  bundlePath,
  expectedCandidatePath,
  runPath,
}: Record<string, string>): Promise<any> {
  await requireExactBundleFiles(bundlePath, STABLE_FILES);
  const candidatePath = path.join(bundlePath, "SOURCE_CANDIDATE.json");
  const functionalPath = path.join(bundlePath, "accepted-candidate.json");
  const manifestPath = path.join(bundlePath, "stable-authority-manifest.json");
  const { bytes: candidateBytes, candidate } = await validatedCandidate(candidatePath);
  await compareExpectedCandidate(candidate, expectedCandidatePath);
  const functional = await validateFunctional(functionalPath, candidate);
  const manifest = validateStableAuthorityManifest(await readJson(manifestPath));
  const run = validatePromotionRunSelection(await readJson(runPath));
  assertManifestMatchesRun(manifest, run);
  if (
    manifest.sourceRevision !== candidate.source_revision ||
    manifest.candidateDigest !== candidate.candidate_digest ||
    manifest.candidateFileDigest !== sha256(candidateBytes) ||
    manifest.functionalReceiptDigest !== functional.digest
  ) {
    fail("stable_authority_bundle_mismatch");
  }
  return { candidate, functional, manifest };
}

async function verifyReleaseBundle({
  bundlePath,
  expectedCandidatePath,
  runPath,
}: Record<string, string>): Promise<any> {
  await requireExactBundleFiles(bundlePath, RELEASE_FILES);
  const candidatePath = path.join(bundlePath, "SOURCE_CANDIDATE.json");
  const functionalPath = path.join(bundlePath, "accepted-candidate.json");
  const deploymentPath = path.join(bundlePath, "release-deployment.json");
  const stableManifestPath = path.join(bundlePath, "stable-authority-manifest.json");
  const releaseManifestPath = path.join(bundlePath, "release-authority-manifest.json");
  const { bytes: candidateBytes, candidate } = await validatedCandidate(candidatePath);
  await compareExpectedCandidate(candidate, expectedCandidatePath);
  const functional = await validateFunctional(functionalPath, candidate);
  const deploymentBytes = await readBoundedFile(deploymentPath);
  const deployment = JSON.parse(deploymentBytes.toString("utf8"));
  assertReleaseDeploymentReceipt(deployment);
  const stableManifestBytes = await readBoundedFile(stableManifestPath);
  const stableManifest = validateStableAuthorityManifest(
    JSON.parse(stableManifestBytes.toString("utf8")),
  );
  const releaseManifest = validateReleaseAuthorityManifest(await readJson(releaseManifestPath));
  const run = validatePromotionRunSelection(await readJson(runPath));
  assertManifestMatchesRun(releaseManifest, run);
  if (
    stableManifest.sourceRevision !== candidate.source_revision ||
    stableManifest.candidateDigest !== candidate.candidate_digest ||
    stableManifest.candidateFileDigest !== sha256(candidateBytes) ||
    stableManifest.functionalReceiptDigest !== functional.digest ||
    releaseManifest.sourceRevision !== candidate.source_revision ||
    releaseManifest.candidateDigest !== candidate.candidate_digest ||
    releaseManifest.candidateFileDigest !== sha256(candidateBytes) ||
    releaseManifest.functionalReceiptDigest !== functional.digest ||
    releaseManifest.deploymentReceiptDigest !== sha256(deploymentBytes) ||
    releaseManifest.stableManifestDigest !== sha256(stableManifestBytes) ||
    deployment.sourceRevision !== candidate.source_revision ||
    deployment.candidateDigest !== candidate.candidate_digest ||
    deployment.functionalReceiptDigest !== functional.digest
  ) {
    fail("release_authority_bundle_mismatch");
  }
  return { candidate, deployment, functional, releaseManifest, stableManifest };
}

function currentRun(options: Record<string, string>, stage: "stable" | "release", sourceRevision: string): any {
  return validatePromotionRunSelection({
    branch: stage,
    event: "push",
    headSha: sourceRevision,
    runAttempt: Number(requireOption(options, "run-attempt")),
    runId: requireOption(options, "run-id"),
    workflowPath: stage === "stable"
      ? ".github/workflows/ci.yml"
      : ".github/workflows/release-branch.yml",
  });
}

export async function runAuthorityCommand(argv: string[]): Promise<any> {
  const { command, options } = parseArgs(argv);
  if (command === "select-run") {
    const selection = selectSuccessfulPromotionRun(await readJson(requireOption(options, "input")), {
      workflowPath: requireOption(options, "workflow-path"),
      branch: requireOption(options, "branch"),
      headSha: requireOption(options, "head-sha"),
    });
    await writeJsonAtomic(requireOption(options, "output"), selection);
    return { command, runId: selection.runId, runAttempt: selection.runAttempt };
  }
  if (command === "select-artifact") {
    const selection = selectExactPromotionArtifact(await readJson(requireOption(options, "input")), {
      artifactName: requireOption(options, "artifact-name"),
    });
    await writeJsonAtomic(requireOption(options, "output"), selection);
    return { command, artifactId: selection.artifactId };
  }
  if (command === "create-stable-manifest") {
    const candidatePath = requireOption(options, "candidate");
    const functionalPath = requireOption(options, "functional");
    const { bytes: candidateBytes, candidate } = await validatedCandidate(candidatePath);
    const functional = await validateFunctional(functionalPath, candidate);
    const run = currentRun(options, "stable", candidate.source_revision);
    const manifest = createStableAuthorityManifest({
      artifactName: `stable-authority-${candidate.source_revision}`,
      candidateDigest: candidate.candidate_digest,
      candidateFileDigest: sha256(candidateBytes),
      functionalReceiptDigest: functional.digest,
      runAttempt: run.runAttempt,
      runId: run.runId,
      sourceRevision: candidate.source_revision,
    });
    await writeJsonAtomic(requireOption(options, "output"), manifest);
    return { command, stage: "stable" };
  }
  if (command === "verify-stable-bundle") {
    await verifyStableBundle({
      bundlePath: requireOption(options, "bundle"),
      expectedCandidatePath: requireOption(options, "expected-candidate"),
      runPath: requireOption(options, "run"),
    });
    return { command, stage: "stable" };
  }
  if (command === "create-release-manifest") {
    const bundlePath = requireOption(options, "bundle");
    const stable = await verifyStableBundle({
      bundlePath,
      expectedCandidatePath: requireOption(options, "expected-candidate"),
      runPath: requireOption(options, "stable-run"),
    });
    const candidatePath = path.join(bundlePath, "SOURCE_CANDIDATE.json");
    const deploymentPath = requireOption(options, "deployment");
    const candidateBytes = await readBoundedFile(candidatePath);
    const deploymentBytes = await readBoundedFile(deploymentPath);
    const deployment = JSON.parse(deploymentBytes.toString("utf8"));
    assertReleaseDeploymentReceipt(deployment);
    if (
      deployment.sourceRevision !== stable.candidate.source_revision ||
      deployment.candidateDigest !== stable.candidate.candidate_digest ||
      deployment.functionalReceiptDigest !== stable.functional.digest
    ) {
      fail("release_authority_deployment_mismatch");
    }
    const run = currentRun(options, "release", stable.candidate.source_revision);
    const stableManifestBytes = await readBoundedFile(
      path.join(bundlePath, "stable-authority-manifest.json"),
    );
    const manifest = createReleaseAuthorityManifest({
      artifactName: `release-authority-${stable.candidate.source_revision}`,
      candidateDigest: stable.candidate.candidate_digest,
      candidateFileDigest: sha256(candidateBytes),
      deploymentReceiptDigest: sha256(deploymentBytes),
      functionalReceiptDigest: stable.functional.digest,
      runAttempt: run.runAttempt,
      runId: run.runId,
      sourceRevision: stable.candidate.source_revision,
      stableManifestDigest: sha256(stableManifestBytes),
    });
    await writeJsonAtomic(requireOption(options, "output"), manifest);
    return { command, stage: "release" };
  }
  if (command === "verify-release-bundle") {
    await verifyReleaseBundle({
      bundlePath: requireOption(options, "bundle"),
      expectedCandidatePath: requireOption(options, "expected-candidate"),
      runPath: requireOption(options, "run"),
    });
    return { command, stage: "release" };
  }
  fail("promotion_authority_command_invalid");
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  runAuthorityCommand(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`),
    (error) => {
      process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || "promotion_authority_failed" })}\n`);
      process.exitCode = 1;
    },
  );
}
