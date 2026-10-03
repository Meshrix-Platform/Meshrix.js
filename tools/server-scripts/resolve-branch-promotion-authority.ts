#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { canonicalJson } from "../../packages/contracts/src/serialization/canonical-json.ts";
import {
  assertManifestMatchesRun,
  buildReleaseWorkflowDispatchPayload,
  createReleaseAuthorityManifest,
  createStableAuthorityManifest,
  decideReleaseBranchDispatch,
  releaseTagCreationAction,
  requireCurrentReleaseDeploymentEnvironment,
  selectExactPromotionArtifact,
  selectSuccessfulPromotionRun,
  validateOriginatingReleaseRun,
  validatePromotionRunSelection,
  validateReleaseDispatchContext,
  validateReleaseAuthorityManifest,
  validateStableAuthorityManifest,
} from "./lib/release-deployment/authority.ts";
import {
  assertReleaseDeploymentReceipt,
  NPM_PACKAGE_INSTALLABILITY_CLAIM,
  RELEASE_DEPLOYMENT_CLAIM,
  sha256,
} from "./lib/release-deployment/contract.ts";
import {
  createNpmPackageInstallabilityReadiness
} from "./lib/release-evidence-readiness.ts";
import {
  RELEASE_REPORT_PROVENANCE_SCHEMA,
  releaseEvidenceReportPayloadDigest
} from "./lib/release-report-provenance.ts";
import { validateAcceptedCandidateReceipt } from "./lib/platform-acceptance-generation-store.ts";
import { validateReleaseCandidateIdentity } from "./verify-release-candidate-identity.ts";

const STABLE_INPUT_FILES = Object.freeze([
  "SOURCE_CANDIDATE.json",
  "accepted-candidate.json",
  "npm-package-installability.json",
]);
const STABLE_FILES = Object.freeze([
  ...STABLE_INPUT_FILES,
  "stable-authority-manifest.json",
]);
const RELEASE_FILES = Object.freeze([
  ...STABLE_FILES,
  "release-authority-manifest.json",
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

async function createBundleDirectory(bundlePath: string): Promise<string> {
  const absolute = path.resolve(bundlePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  try {
    await fs.mkdir(absolute);
  } catch {
    fail("promotion_authority_bundle_output_exists");
  }
  return absolute;
}

async function writeBundleFile(bundlePath: string, filename: string, bytes: Buffer): Promise<void> {
  const destination = path.join(bundlePath, filename);
  const temporary = path.join(bundlePath, `.${filename}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function removeCreatedBundle(bundlePath: string, filenames: readonly string[]): Promise<void> {
  await Promise.all(filenames.map((filename) =>
    fs.rm(path.join(bundlePath, filename), { force: true }).catch(() => undefined)
  ));
  await fs.rmdir(bundlePath).catch(() => undefined);
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

async function validateNpmQualification(
  filePath: string,
  candidate: any,
): Promise<{ bytes: Buffer; digest: string; report: any }> {
  const bytes = await readBoundedFile(filePath);
  let report: any;
  try {
    report = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("promotion_authority_npm_report_json_invalid");
  }
  const readiness = createNpmPackageInstallabilityReadiness(
    report,
    "build/reports/npm-package-installability.json",
  );
  const provenance = report?.releaseEvidenceProvenance;
  if (
    report?.schemaVersion !== "v0.0.1:release:npm-package-installability-report-1" ||
    report?.verifier !== "tools/server-scripts/verify-npm-package-installability.ts" ||
    readiness.releaseReady !== true ||
    provenance?.schemaVersion !== RELEASE_REPORT_PROVENANCE_SCHEMA ||
    provenance?.commandId !== "npm-package-installability" ||
    provenance?.producer !== "tools/server-scripts/verify-npm-package-installability.ts" ||
    provenance?.candidateDigest !== candidate.candidate_digest ||
    typeof provenance?.runId !== "string" || !provenance.runId.trim() ||
    !Number.isFinite(Date.parse(provenance?.recordedAt)) ||
    provenance?.reportPayloadDigest !== releaseEvidenceReportPayloadDigest(report)
  ) {
    fail("promotion_authority_npm_report_invalid");
  }
  const releasePackages = Array.isArray(candidate.release_packages) ? candidate.release_packages : [];
  const artifacts = Array.isArray(report?.candidate?.artifacts) ? report.candidate.artifacts : [];
  const expected = new Map(releasePackages.map((item: any) => [item.name, item.version]));
  const actual = new Map(artifacts.map((item: any) => [item?.name, item?.version]));
  if (
    releasePackages.length === 0 ||
    report.candidate.version !== releasePackages[0].version ||
    artifacts.length !== expected.size ||
    actual.size !== artifacts.length ||
    [...expected].some(([name, version]) => actual.get(name) !== version)
  ) {
    fail("promotion_authority_npm_candidate_mismatch");
  }
  return { bytes, digest: sha256(bytes), report };
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
  runSelection,
}: Record<string, any>): Promise<any> {
  await requireExactBundleFiles(bundlePath, STABLE_FILES);
  const candidatePath = path.join(bundlePath, "SOURCE_CANDIDATE.json");
  const functionalPath = path.join(bundlePath, "accepted-candidate.json");
  const npmPath = path.join(bundlePath, "npm-package-installability.json");
  const manifestPath = path.join(bundlePath, "stable-authority-manifest.json");
  const { bytes: candidateBytes, candidate } = await validatedCandidate(candidatePath);
  await compareExpectedCandidate(candidate, expectedCandidatePath);
  const functional = await validateFunctional(functionalPath, candidate);
  const npmQualification = await validateNpmQualification(npmPath, candidate);
  const manifest = validateStableAuthorityManifest(await readJson(manifestPath));
  const run = runSelection
    ? validatePromotionRunSelection(runSelection)
    : validatePromotionRunSelection(await readJson(runPath));
  assertManifestMatchesRun(manifest, run);
  if (
    manifest.sourceRevision !== candidate.source_revision ||
    manifest.candidateDigest !== candidate.candidate_digest ||
    manifest.candidateFileDigest !== sha256(candidateBytes) ||
    manifest.functionalReceiptDigest !== functional.digest ||
    manifest.npmQualificationClaim !== NPM_PACKAGE_INSTALLABILITY_CLAIM ||
    manifest.npmQualificationReceiptDigest !== npmQualification.digest
  ) {
    fail("stable_authority_bundle_mismatch");
  }
  return { candidate, functional, manifest, npmQualification };
}

async function verifyReleaseBundle({
  bundlePath,
  expectedCandidatePath,
  runPath,
  runSelection,
}: Record<string, any>): Promise<any> {
  const releaseManifestPath = path.join(bundlePath, "release-authority-manifest.json");
  const releaseManifest = validateReleaseAuthorityManifest(await readJson(releaseManifestPath));
  const expectedFiles = releaseManifest.deploymentClaim
    ? [...RELEASE_FILES, "release-deployment.json"]
    : RELEASE_FILES;
  await requireExactBundleFiles(bundlePath, expectedFiles);
  const candidatePath = path.join(bundlePath, "SOURCE_CANDIDATE.json");
  const functionalPath = path.join(bundlePath, "accepted-candidate.json");
  const npmPath = path.join(bundlePath, "npm-package-installability.json");
  const stableManifestPath = path.join(bundlePath, "stable-authority-manifest.json");
  const { bytes: candidateBytes, candidate } = await validatedCandidate(candidatePath);
  await compareExpectedCandidate(candidate, expectedCandidatePath);
  const functional = await validateFunctional(functionalPath, candidate);
  const npmQualification = await validateNpmQualification(npmPath, candidate);
  const stableManifestBytes = await readBoundedFile(stableManifestPath);
  const stableManifest = validateStableAuthorityManifest(
    JSON.parse(stableManifestBytes.toString("utf8")),
  );
  const run = runSelection
    ? validatePromotionRunSelection(runSelection)
    : validatePromotionRunSelection(await readJson(runPath));
  assertManifestMatchesRun(releaseManifest, run);
  let deployment: any = null;
  let deploymentDigest: any = null;
  if (releaseManifest.deploymentClaim) {
    const deploymentBytes = await readBoundedFile(path.join(bundlePath, "release-deployment.json"));
    deployment = JSON.parse(deploymentBytes.toString("utf8"));
    assertReleaseDeploymentReceipt(deployment);
    if (deployment.executionEnvironment.runnerEnvironment !== "github-hosted") {
      fail("release_authority_deployment_not_hosted");
    }
    deploymentDigest = sha256(deploymentBytes);
  }
  if (
    stableManifest.sourceRevision !== candidate.source_revision ||
    stableManifest.candidateDigest !== candidate.candidate_digest ||
    stableManifest.candidateFileDigest !== sha256(candidateBytes) ||
    stableManifest.functionalReceiptDigest !== functional.digest ||
    releaseManifest.sourceRevision !== candidate.source_revision ||
    releaseManifest.candidateDigest !== candidate.candidate_digest ||
    releaseManifest.candidateFileDigest !== sha256(candidateBytes) ||
    releaseManifest.functionalReceiptDigest !== functional.digest ||
    stableManifest.npmQualificationClaim !== NPM_PACKAGE_INSTALLABILITY_CLAIM ||
    stableManifest.npmQualificationReceiptDigest !== npmQualification.digest ||
    releaseManifest.npmQualificationClaim !== NPM_PACKAGE_INSTALLABILITY_CLAIM ||
    releaseManifest.npmQualificationReceiptDigest !== npmQualification.digest ||
    releaseManifest.deploymentReceiptDigest !== deploymentDigest ||
    releaseManifest.stableManifestDigest !== sha256(stableManifestBytes) ||
    (deployment && (
      deployment.sourceRevision !== candidate.source_revision ||
      deployment.candidateDigest !== candidate.candidate_digest ||
      deployment.functionalReceiptDigest !== functional.digest
    ))
  ) {
    fail("release_authority_bundle_mismatch");
  }
  return { candidate, deployment, functional, npmQualification, releaseManifest, stableManifest };
}

function currentRun(options: Record<string, string>, stage: "stable" | "release", sourceRevision: string): any {
  return validatePromotionRunSelection({
    branch: stage,
    event: stage === "release" ? String(options.event || "push") : "push",
    headSha: sourceRevision,
    runAttempt: Number(requireOption(options, "run-attempt")),
    runId: requireOption(options, "run-id"),
    workflowPath: stage === "stable"
      ? ".github/workflows/ci.yml"
      : ".github/workflows/release-branch.yml",
  });
}

function githubRepository(value: string): string {
  if (!/^[^/\s]+\/[^/\s]+$/u.test(value)) fail("github_repository_invalid");
  return value;
}

function githubHeaders(token: string): Record<string, string> {
  if (!token) fail("github_token_missing");
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function githubTagObjectCommit(
  repository: string,
  tag: string,
  headers: Record<string, string>,
  fetchImplementation: typeof fetch,
): Promise<string | null> {
  const referenceResponse = await fetchImplementation(
    `https://api.github.com/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
    { headers, redirect: "error" },
  );
  if (referenceResponse.status === 404) return null;
  if (!referenceResponse.ok) fail("release_tag_lookup_failed");
  let object: any = (await referenceResponse.json())?.object;
  const visited = new Set<string>();
  while (object?.type === "tag") {
    const objectSha = String(object.sha || "");
    if (!/^[a-f0-9]{40}$/u.test(objectSha) || visited.has(objectSha)) {
      fail("release_tag_object_invalid");
    }
    visited.add(objectSha);
    const tagResponse = await fetchImplementation(
      `https://api.github.com/repos/${repository}/git/tags/${objectSha}`,
      { headers, redirect: "error" },
    );
    if (!tagResponse.ok) fail("release_tag_lookup_failed");
    object = (await tagResponse.json())?.object;
  }
  if (object?.type !== "commit" || !/^[a-f0-9]{40}$/u.test(String(object.sha || ""))) {
    fail("release_tag_object_invalid");
  }
  return object.sha;
}

export async function ensureImmutableReleaseTag({
  repository,
  tag,
  sourceRevision,
  token = process.env.GH_TOKEN || "",
  fetchImplementation = fetch,
}: Record<string, any> = {}): Promise<any> {
  const repositoryName = githubRepository(String(repository || ""));
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(String(tag || ""))) {
    fail("release_tag_invalid");
  }
  if (!/^[a-f0-9]{40}$/u.test(String(sourceRevision || ""))) fail("release_tag_source_revision_invalid");
  const headers = githubHeaders(String(token || ""));
  let existingRevision = await githubTagObjectCommit(repositoryName, tag, headers, fetchImplementation);
  let action = releaseTagCreationAction(existingRevision, sourceRevision);
  if (action === "create") {
    const response = await fetchImplementation(
      `https://api.github.com/repos/${repositoryName}/git/refs`,
      {
        method: "POST",
        headers,
        redirect: "error",
        body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: sourceRevision }),
      },
    );
    if (response.status !== 201) {
      // A concurrent identical run may create the ref after the initial 404.
      existingRevision = await githubTagObjectCommit(repositoryName, tag, headers, fetchImplementation);
      if (releaseTagCreationAction(existingRevision, sourceRevision) !== "verify") {
        fail("release_tag_create_failed");
      }
    }
    const observedRevision = await githubTagObjectCommit(repositoryName, tag, headers, fetchImplementation);
    if (releaseTagCreationAction(observedRevision, sourceRevision) !== "verify") {
      fail("release_tag_not_observed");
    }
    action = "verify";
  }
  return { action, tag, sourceRevision };
}

export async function dispatchReleaseWorkflow({
  repository,
  tag,
  sourceRevision,
  runId,
  runAttempt,
  sourceEvent,
  bootstrapCandidate = "",
  releaseVersion,
  token = process.env.GH_TOKEN || "",
  fetchImplementation = fetch,
}: Record<string, any> = {}): Promise<any> {
  const repositoryName = githubRepository(String(repository || ""));
  const payload = buildReleaseWorkflowDispatchPayload({
    tag,
    canonicalTag: tag,
    sourceRevision,
    tagRevision: sourceRevision,
    sourceRunId: runId,
    sourceRunAttempt: runAttempt,
    sourceEvent,
    repository: repositoryName,
    bootstrapCandidate,
    releaseVersion,
  });
  const response = await fetchImplementation(
    `https://api.github.com/repos/${repositoryName}/actions/workflows/release.yml/dispatches`,
    {
      method: "POST",
      headers: githubHeaders(String(token || "")),
      redirect: "error",
      body: JSON.stringify(payload),
    },
  );
  if (response.status !== 204) fail("release_workflow_dispatch_failed");
  return {
    tag,
    sourceRevision,
    sourceRunId: String(runId),
    sourceRunAttempt: Number(runAttempt),
  };
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
  if (command === "verify-originating-run") {
    const result = validateOriginatingReleaseRun(
      await readJson(requireOption(options, "input")),
      {
        repository: requireOption(options, "repository"),
        runId: requireOption(options, "run-id"),
        runAttempt: Number(requireOption(options, "run-attempt")),
        sourceRevision: requireOption(options, "source-revision"),
        event: requireOption(options, "event"),
      },
    );
    if (!result.pending) await writeJsonAtomic(requireOption(options, "output"), result.selection);
    return { command, ...result };
  }
  if (command === "verify-release-dispatch") {
    const dispatch = validateReleaseDispatchContext({
      tag: requireOption(options, "tag"),
      canonicalTag: requireOption(options, "canonical-tag"),
      sourceRevision: requireOption(options, "source-revision"),
      tagRevision: requireOption(options, "tag-revision"),
      sourceRunId: requireOption(options, "source-run-id"),
      sourceRunAttempt: requireOption(options, "source-run-attempt"),
      sourceEvent: requireOption(options, "source-event"),
      repository: requireOption(options, "repository"),
      bootstrapCandidate: options["bootstrap-candidate"] || "",
      releaseVersion: requireOption(options, "release-version"),
    });
    return { command, ...dispatch };
  }
  if (command === "decide-release-branch-dispatch") {
    const decision = decideReleaseBranchDispatch({
      event: requireOption(options, "event"),
      refType: requireOption(options, "ref-type"),
      refName: requireOption(options, "ref-name"),
      releaseVersion: requireOption(options, "release-version"),
      bootstrapCandidate: options["bootstrap-candidate"] || "",
    });
    return { command, ...decision };
  }
  if (command === "ensure-release-tag") {
    const result = await ensureImmutableReleaseTag({
      repository: requireOption(options, "repository"),
      tag: requireOption(options, "tag"),
      sourceRevision: requireOption(options, "source-revision"),
    });
    return { command, ...result };
  }
  if (command === "dispatch-release") {
    const result = await dispatchReleaseWorkflow({
      repository: requireOption(options, "repository"),
      tag: requireOption(options, "tag"),
      sourceRevision: requireOption(options, "source-revision"),
      runId: requireOption(options, "run-id"),
      runAttempt: Number(requireOption(options, "run-attempt")),
      sourceEvent: requireOption(options, "source-event"),
      bootstrapCandidate: options["bootstrap-candidate"] || "",
      releaseVersion: requireOption(options, "release-version"),
    });
    return { command, ...result };
  }
  if (command === "create-stable-bundle") {
    const candidatePath = requireOption(options, "candidate");
    const functionalPath = requireOption(options, "functional");
    const { bytes: candidateBytes, candidate } = await validatedCandidate(candidatePath);
    const functional = await validateFunctional(functionalPath, candidate);
    const npmQualification = await validateNpmQualification(
      requireOption(options, "npm-report"),
      candidate,
    );
    const run = currentRun(options, "stable", candidate.source_revision);
    const manifest = createStableAuthorityManifest({
      artifactName: `stable-authority-${candidate.source_revision}`,
      candidateDigest: candidate.candidate_digest,
      candidateFileDigest: sha256(candidateBytes),
      functionalReceiptDigest: functional.digest,
      npmQualificationReceiptDigest: npmQualification.digest,
      runAttempt: run.runAttempt,
      runId: run.runId,
      sourceRevision: candidate.source_revision,
    });
    const bundlePath = await createBundleDirectory(requireOption(options, "bundle"));
    try {
      await writeBundleFile(bundlePath, "SOURCE_CANDIDATE.json", candidateBytes);
      await writeBundleFile(bundlePath, "accepted-candidate.json", functional.bytes);
      await writeBundleFile(bundlePath, "npm-package-installability.json", npmQualification.bytes);
      await writeBundleFile(
        bundlePath,
        "stable-authority-manifest.json",
        Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
      );
      await requireExactBundleFiles(bundlePath, STABLE_FILES);
      await verifyStableBundle({
        bundlePath,
        expectedCandidatePath: candidatePath,
        runSelection: run,
      });
      return { command, stage: "stable" };
    } catch (error) {
      await removeCreatedBundle(bundlePath, STABLE_FILES);
      throw error;
    }
  }
  if (command === "verify-stable-bundle") {
    await verifyStableBundle({
      bundlePath: requireOption(options, "bundle"),
      expectedCandidatePath: requireOption(options, "expected-candidate"),
      runPath: requireOption(options, "run"),
    });
    return { command, stage: "stable" };
  }
  if (command === "create-release-bundle") {
    const stableBundlePath = requireOption(options, "stable-bundle");
    const stable = await verifyStableBundle({
      bundlePath: stableBundlePath,
      expectedCandidatePath: requireOption(options, "expected-candidate"),
      runPath: requireOption(options, "stable-run"),
    });
    const candidatePath = path.join(stableBundlePath, "SOURCE_CANDIDATE.json");
    const candidateBytes = await readBoundedFile(candidatePath);
    const stableManifestBytes = await readBoundedFile(
      path.join(stableBundlePath, "stable-authority-manifest.json"),
    );
    let deploymentReceiptDigest: string | null = null;
    let deploymentClaim: string | null = null;
    let deploymentBytes: Buffer | null = null;
    if (options.deployment) {
      deploymentBytes = await readBoundedFile(options.deployment);
      const deployment = JSON.parse(deploymentBytes.toString("utf8"));
      assertReleaseDeploymentReceipt(deployment);
      const observedEnvironment = await requireCurrentReleaseDeploymentEnvironment(
        deployment.executionEnvironment,
      );
      if (observedEnvironment.runnerEnvironment !== "github-hosted") {
        fail("release_authority_deployment_not_hosted");
      }
      if (
        deployment.sourceRevision !== stable.candidate.source_revision ||
        deployment.candidateDigest !== stable.candidate.candidate_digest ||
        deployment.functionalReceiptDigest !== stable.functional.digest
      ) {
        fail("release_authority_deployment_mismatch");
      }
      deploymentReceiptDigest = sha256(deploymentBytes);
      deploymentClaim = RELEASE_DEPLOYMENT_CLAIM;
    }
    const run = currentRun(options, "release", stable.candidate.source_revision);
    const manifest = createReleaseAuthorityManifest({
      artifactName: `release-authority-${stable.candidate.source_revision}`,
      candidateDigest: stable.candidate.candidate_digest,
      candidateFileDigest: sha256(candidateBytes),
      deploymentClaim,
      deploymentReceiptDigest,
      functionalReceiptDigest: stable.functional.digest,
      npmQualificationReceiptDigest: stable.npmQualification.digest,
      runAttempt: run.runAttempt,
      runId: run.runId,
      sourceRevision: stable.candidate.source_revision,
      stableManifestDigest: sha256(stableManifestBytes),
      event: run.event,
    });
    const bundlePath = await createBundleDirectory(requireOption(options, "bundle"));
    const bundleFiles = manifest.deploymentClaim
      ? [...RELEASE_FILES, "release-deployment.json"]
      : RELEASE_FILES;
    try {
      for (const filename of STABLE_FILES) {
        await writeBundleFile(
          bundlePath,
          filename,
          await readBoundedFile(path.join(stableBundlePath, filename)),
        );
      }
      await writeBundleFile(
        bundlePath,
        "release-authority-manifest.json",
        Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
      );
      if (deploymentBytes) {
        await writeBundleFile(bundlePath, "release-deployment.json", deploymentBytes);
      }
      await requireExactBundleFiles(bundlePath, bundleFiles);
      await verifyReleaseBundle({
        bundlePath,
        expectedCandidatePath: requireOption(options, "expected-candidate"),
        runSelection: run,
      });
      return { command, stage: "release" };
    } catch (error) {
      await removeCreatedBundle(bundlePath, bundleFiles);
      throw error;
    }
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
