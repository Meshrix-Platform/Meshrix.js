import {
  FUNCTIONAL_CLAIM,
  RELEASE_AUTHORITY_MANIFEST_SCHEMA,
  RELEASE_DEPLOYMENT_CLAIM,
  STABLE_AUTHORITY_MANIFEST_SCHEMA,
} from "./contract.ts";

const SHA1 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const WORKFLOW_PATH = /^\.github\/workflows\/[a-z0-9][a-z0-9._-]*\.ya?ml$/u;
const BRANCH = /^(stable|release)$/u;
const ARTIFACT_NAME = /^(stable|release)-authority-[a-f0-9]{40}$/u;

const STABLE_MANIFEST_KEYS = Object.freeze([
  "artifactName",
  "branch",
  "candidateDigest",
  "candidateFileDigest",
  "event",
  "functionalClaim",
  "functionalReceiptDigest",
  "runAttempt",
  "runId",
  "schemaVersion",
  "sourceRevision",
  "stage",
  "workflowPath",
]);

const RELEASE_MANIFEST_KEYS = Object.freeze([
  "artifactName",
  "branch",
  "candidateDigest",
  "candidateFileDigest",
  "deploymentClaim",
  "deploymentReceiptDigest",
  "event",
  "functionalClaim",
  "functionalReceiptDigest",
  "runAttempt",
  "runId",
  "schemaVersion",
  "sourceRevision",
  "stableManifestDigest",
  "stage",
  "workflowPath",
]);

function fail(code: string, detail = code): never {
  throw Object.assign(new Error(detail), { code });
}

function isRecord(value: any): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: any, keys: readonly string[]): boolean {
  return isRecord(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function requireText(value: any, pattern: RegExp, code: string): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}

function requireRunId(value: any): string {
  const normalized = String(value ?? "");
  if (!/^[1-9][0-9]*$/u.test(normalized)) fail("promotion_authority_run_id_invalid");
  return normalized;
}

function requireRunAttempt(value: any): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    fail("promotion_authority_run_attempt_invalid");
  }
  return normalized;
}

export interface PromotionRunSelection {
  branch: "stable" | "release";
  event: "push";
  headSha: string;
  runAttempt: number;
  runId: string;
  workflowPath: string;
}

const RUN_SELECTION_KEYS = Object.freeze([
  "branch", "event", "headSha", "runAttempt", "runId", "workflowPath",
]);

export function validatePromotionRunSelection(value: any): PromotionRunSelection {
  if (!hasExactKeys(value, RUN_SELECTION_KEYS)) fail("promotion_authority_run_selection_invalid");
  const branch = requireText(value.branch, BRANCH, "promotion_authority_branch_invalid") as "stable" | "release";
  const workflowPath = requireText(
    value.workflowPath,
    WORKFLOW_PATH,
    "promotion_authority_workflow_path_invalid",
  );
  const expectedWorkflow = branch === "stable"
    ? ".github/workflows/ci.yml"
    : ".github/workflows/release-branch.yml";
  if (workflowPath !== expectedWorkflow) fail("promotion_authority_workflow_path_invalid");
  if (value.event !== "push") fail("promotion_authority_event_invalid");
  return Object.freeze({
    branch,
    event: "push",
    headSha: requireText(value.headSha, SHA1, "promotion_authority_head_sha_invalid"),
    runAttempt: requireRunAttempt(value.runAttempt),
    runId: requireRunId(value.runId),
    workflowPath,
  });
}

export function selectSuccessfulPromotionRun(
  inventory: any,
  { workflowPath, branch, headSha }: Record<string, any> = {},
): PromotionRunSelection {
  requireText(workflowPath, WORKFLOW_PATH, "promotion_authority_workflow_path_invalid");
  requireText(branch, BRANCH, "promotion_authority_branch_invalid");
  requireText(headSha, SHA1, "promotion_authority_head_sha_invalid");
  const runs = Array.isArray(inventory?.workflow_runs) ? inventory.workflow_runs : null;
  if (!runs) fail("promotion_authority_run_inventory_invalid");
  const matches = runs.filter((run: any) =>
    isRecord(run) &&
    run.path === workflowPath &&
    run.event === "push" &&
    run.head_branch === branch &&
    run.head_sha === headSha &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    /^[1-9][0-9]*$/u.test(String(run.id ?? "")) &&
    Number.isSafeInteger(Number(run.run_attempt)) &&
    Number(run.run_attempt) >= 1
  );
  if (matches.length === 0) fail("promotion_authority_run_missing");
  const highestAttempt = Math.max(...matches.map((run: any) => Number(run.run_attempt)));
  const selected = matches.filter((run: any) => Number(run.run_attempt) === highestAttempt);
  if (selected.length !== 1) fail("promotion_authority_run_ambiguous");
  return validatePromotionRunSelection({
    branch,
    event: "push",
    headSha,
    runAttempt: highestAttempt,
    runId: requireRunId(selected[0].id),
    workflowPath,
  });
}

export interface PromotionArtifactSelection {
  archiveDownloadUrl: string;
  artifactId: string;
  name: string;
}

export function selectExactPromotionArtifact(
  inventory: any,
  { artifactName }: Record<string, any> = {},
): PromotionArtifactSelection {
  requireText(artifactName, ARTIFACT_NAME, "promotion_authority_artifact_name_invalid");
  const artifacts = Array.isArray(inventory?.artifacts) ? inventory.artifacts : null;
  if (!artifacts) fail("promotion_authority_artifact_inventory_invalid");
  const matches = artifacts.filter((artifact: any) =>
    isRecord(artifact) && artifact.name === artifactName && artifact.expired === false
  );
  if (matches.length === 0) fail("promotion_authority_artifact_missing");
  if (matches.length !== 1) fail("promotion_authority_artifact_ambiguous");
  const artifact = matches[0];
  const artifactId = requireRunId(artifact.id);
  if (typeof artifact.archive_download_url !== "string" || !artifact.archive_download_url) {
    fail("promotion_authority_artifact_url_invalid");
  }
  return Object.freeze({
    archiveDownloadUrl: artifact.archive_download_url,
    artifactId,
    name: artifactName,
  });
}

function normalizedCommonManifest(input: any, stage: "stable" | "release"): Record<string, any> {
  if (!isRecord(input)) fail(`${stage}_authority_manifest_invalid`);
  const expectedBranch = stage;
  const expectedWorkflow = stage === "stable"
    ? ".github/workflows/ci.yml"
    : ".github/workflows/release-branch.yml";
  const sourceRevision = requireText(
    input.sourceRevision,
    SHA1,
    `${stage}_authority_source_revision_invalid`,
  );
  const candidateDigest = requireText(
    input.candidateDigest,
    SHA256,
    `${stage}_authority_candidate_digest_invalid`,
  );
  const candidateFileDigest = requireText(
    input.candidateFileDigest,
    SHA256,
    `${stage}_authority_candidate_file_digest_invalid`,
  );
  const functionalReceiptDigest = requireText(
    input.functionalReceiptDigest,
    SHA256,
    `${stage}_authority_functional_receipt_digest_invalid`,
  );
  if (input.stage !== stage) fail(`${stage}_authority_stage_invalid`);
  if (input.branch !== expectedBranch) fail(`${stage}_authority_branch_invalid`);
  if (input.event !== "push") fail(`${stage}_authority_event_invalid`);
  if (input.workflowPath !== expectedWorkflow) fail(`${stage}_authority_workflow_path_invalid`);
  if (input.artifactName !== `${stage}-authority-${sourceRevision}`) {
    fail(`${stage}_authority_artifact_name_invalid`);
  }
  if (input.functionalClaim !== FUNCTIONAL_CLAIM) {
    fail(`${stage}_authority_functional_claim_invalid`);
  }
  return {
    artifactName: input.artifactName,
    branch: expectedBranch,
    candidateDigest,
    candidateFileDigest,
    event: "push",
    functionalClaim: FUNCTIONAL_CLAIM,
    functionalReceiptDigest,
    runAttempt: requireRunAttempt(input.runAttempt),
    runId: requireRunId(input.runId),
    sourceRevision,
    stage,
    workflowPath: expectedWorkflow,
  };
}

export function validateStableAuthorityManifest(manifest: any): any {
  if (!hasExactKeys(manifest, STABLE_MANIFEST_KEYS)) fail("stable_authority_manifest_fields_invalid");
  if (manifest.schemaVersion !== STABLE_AUTHORITY_MANIFEST_SCHEMA) {
    fail("stable_authority_manifest_schema_invalid");
  }
  return Object.freeze({
    ...normalizedCommonManifest(manifest, "stable"),
    schemaVersion: STABLE_AUTHORITY_MANIFEST_SCHEMA,
  });
}

export function createStableAuthorityManifest(input: any): any {
  return validateStableAuthorityManifest({
    ...input,
    schemaVersion: STABLE_AUTHORITY_MANIFEST_SCHEMA,
    stage: "stable",
    branch: "stable",
    event: "push",
    workflowPath: ".github/workflows/ci.yml",
    functionalClaim: FUNCTIONAL_CLAIM,
  });
}

export function validateReleaseAuthorityManifest(manifest: any): any {
  if (!hasExactKeys(manifest, RELEASE_MANIFEST_KEYS)) fail("release_authority_manifest_fields_invalid");
  if (manifest.schemaVersion !== RELEASE_AUTHORITY_MANIFEST_SCHEMA) {
    fail("release_authority_manifest_schema_invalid");
  }
  if (manifest.deploymentClaim !== RELEASE_DEPLOYMENT_CLAIM) {
    fail("release_authority_deployment_claim_invalid");
  }
  const deploymentReceiptDigest = requireText(
    manifest.deploymentReceiptDigest,
    SHA256,
    "release_authority_deployment_receipt_digest_invalid",
  );
  const stableManifestDigest = requireText(
    manifest.stableManifestDigest,
    SHA256,
    "release_authority_stable_manifest_digest_invalid",
  );
  return Object.freeze({
    ...normalizedCommonManifest(manifest, "release"),
    deploymentClaim: RELEASE_DEPLOYMENT_CLAIM,
    deploymentReceiptDigest,
    schemaVersion: RELEASE_AUTHORITY_MANIFEST_SCHEMA,
    stableManifestDigest,
  });
}

export function createReleaseAuthorityManifest(input: any): any {
  return validateReleaseAuthorityManifest({
    ...input,
    schemaVersion: RELEASE_AUTHORITY_MANIFEST_SCHEMA,
    stage: "release",
    branch: "release",
    event: "push",
    workflowPath: ".github/workflows/release-branch.yml",
    functionalClaim: FUNCTIONAL_CLAIM,
    deploymentClaim: RELEASE_DEPLOYMENT_CLAIM,
  });
}

export function assertManifestMatchesRun(manifest: any, run: PromotionRunSelection): void {
  if (
    manifest.runId !== run.runId ||
    manifest.runAttempt !== run.runAttempt ||
    manifest.workflowPath !== run.workflowPath ||
    manifest.branch !== run.branch ||
    manifest.event !== run.event ||
    manifest.sourceRevision !== run.headSha
  ) {
    fail("promotion_authority_manifest_run_mismatch");
  }
}
