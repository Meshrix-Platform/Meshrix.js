import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  FUNCTIONAL_CLAIM,
  FIRST_NPM_BOOTSTRAP_VERSION,
  RELEASE_AUTHORITY_MANIFEST_SCHEMA,
  RELEASE_DEPLOYMENT_CLAIM,
  STABLE_AUTHORITY_MANIFEST_SCHEMA,
  validateReleaseExecutionEnvironment,
} from "./contract.ts";

const SHA1 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const WORKFLOW_PATH = /^\.github\/workflows\/[a-z0-9][a-z0-9._-]*\.ya?ml$/u;
const BRANCH = /^(stable|release)$/u;
const ARTIFACT_NAME = /^(stable|release)-authority-[a-f0-9]{40}$/u;
export const RELEASE_DEPLOYMENT_CLEANUP_STATE_SCHEMA = "meshrix.release-deployment.cleanup/2";
const CLEANUP_STATE_KEYS = Object.freeze([
  "backupVolume",
  "candidateDigest",
  "containerName",
  "dataVolume",
  "fixtureContainerName",
  "imageName",
  "networkName",
  "resourceId",
  "schemaVersion",
  "sourceRevision",
  "tempRoot",
]);
const MAX_CLEANUP_STATE_BYTES = 16 * 1024;
const MAX_CLEANUP_PROBE_BYTES = 16 * 1024;

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

function osReleaseFields(source: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of source.split(/\r?\n/u)) {
    const match = /^(ID|VERSION_ID)=(.*)$/u.exec(line);
    if (!match) continue;
    if (Object.prototype.hasOwnProperty.call(fields, match[1])) {
      fail("release_deployment_environment_os_release_invalid");
    }
    const raw = match[2];
    const quoted = /^"([A-Za-z0-9._-]+)"$/u.exec(raw);
    const plain = /^([A-Za-z0-9._-]+)$/u.exec(raw);
    const value = quoted?.[1] || plain?.[1];
    if (!value) fail("release_deployment_environment_os_release_invalid");
    fields[match[1]] = value;
  }
  return fields;
}

export function classifyReleaseDeploymentEnvironment({
  platform = "",
  architecture = "",
  nodeVersion = "",
  osRelease = "",
  githubActions = "",
  runnerEnvironment = "",
  runnerOs = "",
  runnerArchitecture = "",
}: Record<string, string> = {}): any {
  const os = osReleaseFields(osRelease);
  const environment = {
    architecture,
    nodeVersion,
    platform,
    runner: os.ID && os.VERSION_ID ? `${os.ID}-${os.VERSION_ID}` : "",
    runnerEnvironment: "local",
  };
  // GitHub runner variables describe the process context; they are not signed provenance.
  // The release workflow validates the actual run and artifact chain independently.
  if (githubActions === "true") {
    if (runnerEnvironment !== "github-hosted" || runnerOs !== "Linux" || runnerArchitecture !== "X64") {
      fail("release_deployment_environment_runner_context_invalid");
    }
    environment.runnerEnvironment = "github-hosted";
  } else if ((githubActions !== "" && githubActions !== "false") ||
    runnerEnvironment || runnerOs || runnerArchitecture) {
    fail("release_deployment_environment_runner_context_invalid");
  }
  const reasons = validateReleaseExecutionEnvironment(environment);
  if (reasons.length > 0) fail(reasons[0]);
  return Object.freeze(environment);
}

export async function observeReleaseDeploymentEnvironment(): Promise<any> {
  let osRelease: string;
  try {
    osRelease = await fs.readFile("/etc/os-release", "utf8");
  } catch {
    fail("release_deployment_environment_os_release_unavailable");
  }
  return classifyReleaseDeploymentEnvironment({
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.versions.node,
    osRelease,
    githubActions: process.env.GITHUB_ACTIONS || "",
    runnerEnvironment: process.env.RUNNER_ENVIRONMENT || "",
    runnerOs: process.env.RUNNER_OS || "",
    runnerArchitecture: process.env.RUNNER_ARCH || "",
  });
}

export async function requireCurrentReleaseDeploymentEnvironment(value: any): Promise<any> {
  const current = await observeReleaseDeploymentEnvironment();
  const reasons = validateReleaseExecutionEnvironment(value);
  if (reasons.length > 0) fail(reasons[0]);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(Object.keys(current).sort()) ||
    Object.keys(current).some((key) => value[key] !== current[key])) {
    fail("release_deployment_environment_mismatch");
  }
  return current;
}

function isRecord(value: any): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: any, keys: readonly string[]): boolean {
  return isRecord(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export function validateReleaseDeploymentCleanupState(value: any): any {
  if (!hasExactKeys(value, CLEANUP_STATE_KEYS) ||
    value.schemaVersion !== RELEASE_DEPLOYMENT_CLEANUP_STATE_SCHEMA ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      String(value.resourceId || ""),
    ) ||
    !SHA1.test(String(value.sourceRevision || "")) ||
    !SHA256.test(String(value.candidateDigest || ""))) {
    fail("release_deployment_cleanup_state_invalid");
  }
  const id = value.resourceId;
  const expected = {
    containerName: `meshrix-release-smoke-${id}`,
    fixtureContainerName: `meshrix-release-fixture-${id}`,
    imageName: `meshrix-release-smoke:${id}`,
    networkName: `meshrix-release-network-${id}`,
    dataVolume: `meshrix-release-data-${id}`,
    backupVolume: `meshrix-release-backup-${id}`,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) fail("release_deployment_cleanup_state_invalid");
  }
  const expectedRoot = path.join(os.tmpdir(), `meshrix-release-deployment-${id}`);
  if (value.tempRoot !== expectedRoot) fail("release_deployment_cleanup_state_invalid");
  return value;
}

export async function readReleaseDeploymentCleanupState(filePath: string): Promise<any> {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_CLEANUP_STATE_BYTES) {
    fail("release_reducer_cleanup_state_invalid");
  }
  try {
    return validateReleaseDeploymentCleanupState(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch (error: any) {
    if (error?.code === "release_deployment_cleanup_state_invalid") {
      fail("release_reducer_cleanup_state_invalid");
    }
    fail("release_reducer_cleanup_state_invalid");
  }
}

function dockerCleanupProbe(args: string[], captureStdout = false): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    let bytes = 0;
    let overflow = false;
    child.once("error", () => reject(Object.assign(new Error("cleanup probe unavailable"), {
      code: "release_reducer_cleanup_verification_unavailable",
    })));
    if (captureStdout && child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_CLEANUP_PROBE_BYTES) {
          overflow = true;
          child.kill("SIGKILL");
          return;
        }
        stdout += chunk.toString("utf8");
      });
    }
    child.once("close", (code) => {
      if (overflow) {
        reject(Object.assign(new Error("cleanup probe output exceeded bound"), {
          code: "release_reducer_cleanup_verification_unavailable",
        }));
        return;
      }
      resolve({ code, stdout });
    });
  });
}

export async function assertReleaseDeploymentResourcesRemoved(state: any): Promise<void> {
  validateReleaseDeploymentCleanupState(state);
  if ((await dockerCleanupProbe(["info"])).code !== 0) {
    fail("release_reducer_cleanup_verification_unavailable");
  }
  const resources = [
    {
      name: state.containerName,
      args: ["container", "ls", "--all", "--filter", `name=${state.containerName}`, "--format", "{{.Names}}"],
    },
    {
      name: state.fixtureContainerName,
      args: ["container", "ls", "--all", "--filter", `name=${state.fixtureContainerName}`, "--format", "{{.Names}}"],
    },
    {
      name: state.dataVolume,
      args: ["volume", "ls", "--filter", `name=${state.dataVolume}`, "--format", "{{.Name}}"],
    },
    {
      name: state.backupVolume,
      args: ["volume", "ls", "--filter", `name=${state.backupVolume}`, "--format", "{{.Name}}"],
    },
    {
      name: state.imageName,
      args: ["image", "ls", "--all", "--filter", `reference=${state.imageName}`, "--format", "{{.Repository}}:{{.Tag}}"],
    },
    {
      name: state.networkName,
      args: ["network", "ls", "--filter", `name=${state.networkName}`, "--format", "{{.Name}}"],
    },
  ];
  for (const resource of resources) {
    const probe = await dockerCleanupProbe(resource.args, true);
    if (probe.code !== 0) fail("release_reducer_cleanup_verification_unavailable");
    if (probe.stdout.split(/\r?\n/u).some((line) => line.trim() === resource.name)) {
      fail("release_reducer_cleanup_incomplete");
    }
  }
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
  event: "push" | "workflow_dispatch";
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
  const event = requireText(value.event, /^(push|workflow_dispatch)$/u, "promotion_authority_event_invalid") as "push" | "workflow_dispatch";
  if (branch === "stable" && event !== "push") fail("promotion_authority_event_invalid");
  return Object.freeze({
    branch,
    event,
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

export function validateOriginatingReleaseRun(
  run: any,
  {
    repository,
    runId,
    runAttempt,
    sourceRevision,
    event,
  }: Record<string, any> = {},
): { pending: true } | { pending: false; selection: PromotionRunSelection } {
  const expectedRepository = requireText(repository, /^[^/\s]+\/[^/\s]+$/u, "promotion_authority_repository_invalid");
  const expectedRunId = requireRunId(runId);
  const expectedAttempt = requireRunAttempt(runAttempt);
  const expectedRevision = requireText(sourceRevision, SHA1, "promotion_authority_head_sha_invalid");
  const expectedEvent = requireText(event, /^(push|workflow_dispatch)$/u, "promotion_authority_event_invalid");
  if (
    !isRecord(run) ||
    String(run.id ?? "") !== expectedRunId ||
    Number(run.run_attempt) !== expectedAttempt ||
    run.path !== ".github/workflows/release-branch.yml" ||
    run.head_branch !== "release" ||
    run.head_sha !== expectedRevision ||
    run.event !== expectedEvent ||
    run.repository?.full_name !== expectedRepository
  ) {
    fail("promotion_authority_originating_run_mismatch");
  }
  if (run.status === "queued" || run.status === "in_progress" || run.status === "waiting" || run.status === "requested") {
    return { pending: true };
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    fail("promotion_authority_originating_run_unsuccessful");
  }
  return {
    pending: false,
    selection: validatePromotionRunSelection({
      branch: "release",
      event: expectedEvent,
      headSha: expectedRevision,
      runAttempt: expectedAttempt,
      runId: expectedRunId,
      workflowPath: ".github/workflows/release-branch.yml",
    }),
  };
}

export function validateReleaseDispatchContext({
  tag,
  canonicalTag,
  sourceRevision,
  tagRevision,
  sourceRunId,
  sourceRunAttempt,
  sourceEvent,
  repository,
  bootstrapCandidate = "",
  releaseVersion,
}: Record<string, any> = {}): any {
  const normalizedTag = requireText(tag, /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u, "release_dispatch_tag_invalid");
  if (normalizedTag !== canonicalTag) fail("release_dispatch_tag_mismatch");
  const revision = requireText(sourceRevision, SHA1, "release_dispatch_source_revision_invalid");
  if (requireText(tagRevision, SHA1, "release_dispatch_tag_revision_invalid") !== revision) {
    fail("release_dispatch_tag_revision_mismatch");
  }
  const runId = requireRunId(sourceRunId);
  const runAttempt = requireRunAttempt(sourceRunAttempt);
  const event = requireText(sourceEvent, /^(push|workflow_dispatch)$/u, "release_dispatch_source_event_invalid");
  const repositoryName = requireText(repository, /^[^/\s]+\/[^/\s]+$/u, "release_dispatch_repository_invalid");
  const version = requireText(releaseVersion, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u, "release_dispatch_version_invalid");
  const bootstrap = String(bootstrapCandidate || "");
  if (bootstrap && (
    bootstrap !== version ||
    version !== FIRST_NPM_BOOTSTRAP_VERSION ||
    normalizedTag !== `v${FIRST_NPM_BOOTSTRAP_VERSION}` ||
    event !== "workflow_dispatch"
  )) {
    fail("release_dispatch_bootstrap_candidate_invalid");
  }
  return Object.freeze({
    bootstrapCandidate: bootstrap,
    event,
    repository: repositoryName,
    runAttempt,
    runId,
    sourceRevision: revision,
    tag: normalizedTag,
    version,
  });
}

export function decideReleaseBranchDispatch({
  event,
  refType,
  refName,
  releaseVersion,
  bootstrapCandidate = "",
}: Record<string, any> = {}): any {
  const trigger = requireText(event, /^(push|workflow_dispatch)$/u, "release_branch_event_invalid");
  requireText(refType, /^branch$/u, "release_branch_ref_type_invalid");
  requireText(refName, /^release$/u, "release_branch_ref_invalid");
  const version = requireText(
    releaseVersion,
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
    "release_dispatch_version_invalid",
  );
  const bootstrap = String(bootstrapCandidate || "");

  if (version === FIRST_NPM_BOOTSTRAP_VERSION) {
    if (trigger === "push") {
      if (bootstrap) fail("release_dispatch_bootstrap_candidate_invalid");
      return Object.freeze({
        action: "manual-bootstrap-required",
        bootstrapCandidate: version,
        dispatchRelease: false,
      });
    }
    if (bootstrap !== version) fail("release_dispatch_bootstrap_candidate_required");
    return Object.freeze({
      action: "dispatch-bootstrap",
      bootstrapCandidate: bootstrap,
      dispatchRelease: true,
    });
  }

  if (bootstrap) fail("release_dispatch_bootstrap_candidate_invalid");
  return Object.freeze({
    action: "dispatch-oidc",
    bootstrapCandidate: "",
    dispatchRelease: true,
  });
}

export function releaseTagCreationAction(existingRevision: string | null, sourceRevision: string): "create" | "verify" {
  const expected = requireText(sourceRevision, SHA1, "release_tag_source_revision_invalid");
  if (existingRevision === null) return "create";
  const existing = requireText(existingRevision, SHA1, "release_tag_existing_revision_invalid");
  if (existing !== expected) fail("release_tag_target_conflict");
  return "verify";
}

export function buildReleaseWorkflowDispatchPayload(context: any): any {
  const validated = validateReleaseDispatchContext(context);
  return Object.freeze({
    ref: validated.tag,
    inputs: Object.freeze({
      originating_event: validated.event,
      originating_run_attempt: String(validated.runAttempt),
      originating_run_id: validated.runId,
      source_revision: validated.sourceRevision,
      bootstrap_candidate: validated.bootstrapCandidate,
    }),
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
  const event = requireText(input.event, /^(push|workflow_dispatch)$/u, `${stage}_authority_event_invalid`);
  if (stage === "stable" && event !== "push") fail(`${stage}_authority_event_invalid`);
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
    event,
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
    event: input.event || "push",
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
