#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  assertCandidateWorktreeClean as assertCanonicalCandidateWorktreeClean,
  createReleaseCandidateIdentity,
  loadReleaseCandidateIdentity,
  validateReleaseCandidateIdentity,
} from "./verify-release-candidate-identity.ts";

const modulePath: any = fileURLToPath(import.meta.url);
const defaultRepoRoot: any = path.resolve(path.dirname(modulePath), "../..");
const DELIVERY_PLAN: any = "end-to-end-release/enterprise-single-node";
const DELIVERY_FINAL_NODE: any = "aca5ebca-d8b2-4688-a1bf-70dc1d2ce8d4";
const ACCEPTANCE_IMAGE_DOCKERFILE: any =
  "tools/containers/enterprise-single-node-acceptance.Dockerfile";
const WORKER_SUMMARY: any = "worker-summary.json";
const HOST_AUDIT_OBSERVATION: any = "host-audit-observation.json";
const SOURCE_CANDIDATE: any = "SOURCE_CANDIDATE.json";
const ACCEPTANCE_RUNNER: any = "acceptance-runner.json";
const TEST_REGISTRY: any = "tools/registry/tests.registry.json";
const AUDIT_PROFILE: any = "audit-public";
const WORKER_SUMMARY_SCHEMA: any =
  "v0.0.1:meshrix:enterprise-single-node-ubuntu-evidence-1";
const CONTAINER_DEPENDENCY_ROOT: any = "/opt/meshrix-dependency-source/node_modules";
const CONTAINER_WORKER_ROOT: any = "/worker";
const SHA256_PATTERN: any = /^[a-f0-9]{64}$/u;
const SUITE_ID_PATTERN: any = /^[a-z0-9][a-z0-9._-]*$/u;
const DIGEST_PINNED_IMAGE_PATTERN: any =
  /^(?:(?:[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[A-Za-z0-9._-]+)?)@)?sha256:[a-f0-9]{64}$/u;

export const ENTERPRISE_SINGLE_NODE_PHASES: readonly any[] = Object.freeze([
  "initialize-plan",
  "ubuntu-delivery",
  "delivery-receipt",
  "offline-transfer-receipt",
  "platform-acceptance",
]);

function requireCondition(condition?: any, code?: any) : any {
  if (!condition) throw new Error(code);
}

function sha256(value?: any) : any {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value?: any) : any {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key?: any) : any => [key, canonicalJson(value[key])]),
  );
}

function canonicalDigest(value?: any) : any {
  return sha256(JSON.stringify(canonicalJson(value)));
}

function isRecord(value?: any) : any {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(value?: any, expectedKeys?: any, code?: any) : any {
  requireCondition(isRecord(value), code);
  const actual: any = Object.keys(value).sort();
  const expected: any = [...expectedKeys].sort();
  requireCondition(
    actual.length === expected.length &&
      actual.every((key?: any, index?: any) : any => key === expected[index]),
    code,
  );
}

function resolveProfileSuiteIds(registry?: any, profile?: any, visiting: any = new Set<any>()) : any {
  requireCondition(isRecord(registry?.profiles), "enterprise_audit_registry_invalid");
  requireCondition(
    typeof profile === "string" && profile.length > 0,
    "enterprise_audit_profile_invalid",
  );
  requireCondition(!visiting.has(profile), "enterprise_audit_profile_cycle");
  const definition: any = registry.profiles[profile];
  requireCondition(isRecord(definition), "enterprise_audit_profile_unknown");
  requireCondition(
    !definition.dynamic && Array.isArray(definition.suites),
    "enterprise_audit_profile_invalid",
  );
  const nextVisiting: any = new Set<any>(visiting);
  nextVisiting.add(profile);
  const inherited: any = definition.extends
    ? resolveProfileSuiteIds(registry, definition.extends, nextVisiting)
    : [];
  const suiteIds: any[] = [...inherited];
  const seen: any = new Set<any>(inherited);
  for (const suiteId of definition.suites) {
    requireCondition(
      typeof suiteId === "string" && SUITE_ID_PATTERN.test(suiteId),
      "enterprise_audit_suite_id_invalid",
    );
    if (!seen.has(suiteId)) {
      seen.add(suiteId);
      suiteIds.push(suiteId);
    }
  }
  return suiteIds;
}

export function createEnterpriseSingleNodeAuditShards({
  registry,
  profile = AUDIT_PROFILE,
}: Record<string, any> = {}) : any {
  requireCondition(Array.isArray(registry?.suites), "enterprise_audit_registry_invalid");
  const suiteById: any = new Map<any, any>();
  for (const suite of registry.suites) {
    requireCondition(
      isRecord(suite) &&
        typeof suite.id === "string" &&
        SUITE_ID_PATTERN.test(suite.id) &&
        !suiteById.has(suite.id) &&
        Array.isArray(suite.requiredServices) &&
        suite.requiredServices.every((service?: any) : any =>
          typeof service === "string" && service.length > 0),
      "enterprise_audit_suite_invalid",
    );
    suiteById.set(suite.id, suite);
  }
  const allSuiteIds: any = resolveProfileSuiteIds(registry, profile);
  requireCondition(allSuiteIds.length > 0, "enterprise_audit_profile_empty");
  const hostSuiteIds: any[] = [];
  const workerSuiteIds: any[] = [];
  for (const suiteId of allSuiteIds) {
    const suite: any = suiteById.get(suiteId);
    requireCondition(suite, "enterprise_audit_suite_unknown");
    (suite.requiredServices.length > 0 ? hostSuiteIds : workerSuiteIds)
      .push(suiteId);
  }
  requireCondition(
    hostSuiteIds.length > 0 && workerSuiteIds.length > 0,
    "enterprise_audit_shard_empty",
  );
  const hostSet: any = new Set<any>(hostSuiteIds);
  const workerSet: any = new Set<any>(workerSuiteIds);
  requireCondition(
    workerSuiteIds.every((suiteId?: any) : any => !hostSet.has(suiteId)),
    "enterprise_audit_shard_overlap",
  );
  requireCondition(
    new Set<any>([...hostSuiteIds, ...workerSuiteIds]).size === allSuiteIds.length &&
      allSuiteIds.every((suiteId?: any) : any =>
        hostSet.has(suiteId) || workerSet.has(suiteId)),
    "enterprise_audit_shard_incomplete",
  );
  return Object.freeze({
    profile,
    allSuiteIds: Object.freeze([...allSuiteIds]),
    hostSuiteIds: Object.freeze(hostSuiteIds),
    workerSuiteIds: Object.freeze(workerSuiteIds),
  });
}

function auditShardCommand(profile?: any, suiteIds?: any) : any {
  requireCondition(
    typeof profile === "string" &&
      SUITE_ID_PATTERN.test(profile) &&
      Array.isArray(suiteIds) &&
      suiteIds.length > 0 &&
      suiteIds.every((suiteId?: any) : any => SUITE_ID_PATTERN.test(suiteId)),
    "enterprise_audit_shard_command_invalid",
  );
  return [
    "node",
    "tests/run.ts",
    "--profile",
    profile,
    ...suiteIds.flatMap((suiteId?: any) : any => ["--suite", suiteId]),
  ].join(" ");
}

function fullRegressionCommandsFor(shards?: any) : any {
  return Object.freeze([
    auditShardCommand(shards.profile, shards.hostSuiteIds),
    "npm run verify",
    "npm run vitest",
    auditShardCommand(shards.profile, shards.workerSuiteIds),
  ]);
}

function isCanonicalTimestamp(value?: any) : any {
  if (typeof value !== "string" || value.length === 0) return false;
  const milliseconds: any = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value;
}

function validateCommandObservation(observation?: any, command?: any, code?: any) : any {
  requireExactKeys(observation, [
    "command_sha256",
    "exit_code",
    "stdout_sha256",
    "stderr_sha256",
    "stdout_bytes",
    "stderr_bytes",
  ], code);
  requireCondition(
    observation.command_sha256 === sha256(command) &&
      observation.exit_code === 0 &&
      SHA256_PATTERN.test(observation.stdout_sha256) &&
      SHA256_PATTERN.test(observation.stderr_sha256) &&
      Number.isSafeInteger(observation.stdout_bytes) &&
      observation.stdout_bytes >= 0 &&
      Number.isSafeInteger(observation.stderr_bytes) &&
      observation.stderr_bytes >= 0,
    code,
  );
  return Object.freeze({
    type: "command",
    command_sha256: observation.command_sha256,
    exit_code: observation.exit_code,
  });
}

export function validateEnterpriseSingleNodeWorkerSummary({
  summary,
  implementationNodes,
  fullRegressionCommands,
}: Record<string, any> = {}) : any {
  requireExactKeys(summary, [
    "schema_version",
    "status",
    "candidate",
    "implementation_nodes",
    "full_regression",
    "full_regression_commands",
    "recorded_at",
    "privacy_safe",
  ], "ubuntu_delivery_summary_invalid");
  requireCondition(
    summary.schema_version === WORKER_SUMMARY_SCHEMA &&
      summary.status === "passed" &&
      isRecord(summary.candidate) &&
      SHA256_PATTERN.test(String(summary.candidate.candidate_digest || "")) &&
      Array.isArray(summary.implementation_nodes) &&
      Array.isArray(summary.full_regression) &&
      Array.isArray(summary.full_regression_commands) &&
      isCanonicalTimestamp(summary.recorded_at) &&
      summary.privacy_safe === true,
    "ubuntu_delivery_summary_invalid",
  );
  requireCondition(
    Array.isArray(implementationNodes) &&
      implementationNodes.length > 0 &&
      Array.isArray(fullRegressionCommands) &&
      fullRegressionCommands.length > 0 &&
      fullRegressionCommands.every((command?: any) : any =>
        typeof command === "string" && command.length > 0),
    "ubuntu_delivery_summary_contract_invalid",
  );

  const expectedById: any = new Map<any, any>();
  for (const node of implementationNodes) {
    requireCondition(
      isRecord(node) &&
        typeof node.id === "string" &&
        node.id.length > 0 &&
        !expectedById.has(node.id) &&
        Array.isArray(node.regression?.commands) &&
        node.regression.commands.length > 0 &&
        node.regression.commands.every((command?: any) : any =>
          typeof command === "string" && command.length > 0) &&
        Array.isArray(node.acceptance_criteria) &&
        node.acceptance_criteria.length > 0 &&
        Array.isArray(node.regression?.criteria),
      "ubuntu_delivery_implementation_contract_invalid",
    );
    const criteria: any = node.regression.criteria;
    requireCondition(
      new Set<any>(criteria).size === criteria.length &&
        criteria.every((index?: any) : any =>
          Number.isInteger(index) &&
          index >= 0 &&
          index < node.acceptance_criteria.length) &&
        node.acceptance_criteria.every((_?: any, index?: any) : any => criteria.includes(index)),
      "ubuntu_delivery_criterion_coverage_invalid",
    );
    expectedById.set(node.id, node);
  }

  requireCondition(
    summary.implementation_nodes.length === implementationNodes.length,
    "ubuntu_delivery_node_evidence_incomplete",
  );
  const evidenceByNode: any = new Map<any, any>();
  for (const entry of summary.implementation_nodes) {
    requireExactKeys(
      entry,
      ["node_id", "commands"],
      "ubuntu_delivery_node_evidence_invalid",
    );
    const node: any = expectedById.get(entry.node_id);
    requireCondition(
      node && !evidenceByNode.has(entry.node_id) &&
        Array.isArray(entry.commands),
      "ubuntu_delivery_node_evidence_invalid",
    );
    requireCondition(
      entry.commands.length === node.regression.commands.length,
      "ubuntu_delivery_node_command_count_mismatch",
    );
    const refs: any = entry.commands.map((observation?: any, index?: any) : any =>
      validateCommandObservation(
        observation,
        node.regression.commands[index],
        "ubuntu_delivery_node_command_evidence_invalid",
      ));
    evidenceByNode.set(entry.node_id, Object.freeze({
      criteria: Object.freeze([...node.regression.criteria]),
      refs: Object.freeze(refs),
    }));
  }
  requireCondition(
    evidenceByNode.size === expectedById.size,
    "ubuntu_delivery_node_evidence_incomplete",
  );

  requireCondition(
    summary.full_regression.length === fullRegressionCommands.length &&
      summary.full_regression_commands.length === fullRegressionCommands.length,
    "ubuntu_delivery_full_regression_incomplete",
  );
  const expectedCommandDigests: any = fullRegressionCommands.map(sha256);
  requireCondition(
    summary.full_regression_commands.every((digestValue?: any, index?: any) : any =>
      digestValue === expectedCommandDigests[index]),
    "ubuntu_delivery_full_regression_command_mismatch",
  );
  const fullRegressionRefs: any = summary.full_regression.map((observation?: any, index?: any) : any =>
    validateCommandObservation(
      observation,
      fullRegressionCommands[index],
      "ubuntu_delivery_full_regression_evidence_invalid",
    ));

  return Object.freeze({
    recordedAt: summary.recorded_at,
    evidenceByNode,
    fullRegressionRefs: Object.freeze(fullRegressionRefs),
  });
}

function parseArgs(argv?: any) : any {
  const valueAfter: any = (flag?: any) : any => {
    const index: any = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const known: any = new Set<any>([
    "--worker",
    "--worker-execute",
    "--receipt-only",
    "--evidence-root",
    "--source-candidate",
  ]);
  for (let index: any = 0; index < argv.length; index += 1) {
    const value: any = argv[index];
    requireCondition(known.has(value), "enterprise_single_node_argument_invalid");
    if (value === "--evidence-root" || value === "--source-candidate") {
      requireCondition(
        argv[index + 1] && !known.has(argv[index + 1]),
        value === "--evidence-root"
          ? "enterprise_single_node_evidence_root_missing"
          : "enterprise_single_node_source_candidate_missing",
      );
      index += 1;
    }
  }
  return Object.freeze({
    worker: argv.includes("--worker"),
    workerExecute: argv.includes("--worker-execute"),
    receiptOnly: argv.includes("--receipt-only"),
    evidenceRoot: valueAfter("--evidence-root"),
    sourceCandidate: valueAfter("--source-candidate"),
  });
}

export function createEnterpriseSingleNodeExecutionSchedule() : any {
  const phases: any[] = [
    { id: "initialize-plan", dependsOn: [] },
    { id: "ubuntu-delivery", dependsOn: ["initialize-plan"] },
    { id: "delivery-receipt", dependsOn: ["ubuntu-delivery"] },
    { id: "offline-transfer-receipt", dependsOn: ["delivery-receipt"] },
    { id: "platform-acceptance", dependsOn: ["offline-transfer-receipt"] },
  ];
  const seen: any = new Set<any>();
  const valid: any = phases.every((phase?: any) : any => {
    if (seen.has(phase.id) || !phase.dependsOn.every((dependency?: any) : any => seen.has(dependency))) {
      return false;
    }
    seen.add(phase.id);
    return true;
  });
  return Object.freeze({
    valid,
    phases: Object.freeze(phases.map((phase?: any) : any => Object.freeze({
      ...phase,
      dependsOn: Object.freeze([...phase.dependsOn]),
    }))),
  });
}

function absoluteDirectory(value?: any, code?: any) : any {
  requireCondition(typeof value === "string" && path.isAbsolute(value), code);
  return path.resolve(value);
}

export function createUbuntuContainerRequest({ image, candidateRoot, evidenceRoot }: Record<string, any> = {}) : any {
  requireCondition(
    typeof image === "string" && DIGEST_PINNED_IMAGE_PATTERN.test(image),
    "ubuntu_acceptance_image_not_digest_pinned",
  );
  const candidate: any = absoluteDirectory(candidateRoot, "ubuntu_acceptance_candidate_root_invalid");
  const evidence: any = absoluteDirectory(evidenceRoot, "ubuntu_acceptance_evidence_root_invalid");
  return Object.freeze({
    executable: "docker",
    args: Object.freeze([
      "run",
      "--rm",
      "--network",
      "none",
      "--tmpfs",
      "/worker:exec,mode=0700",
      "--mount",
      `type=bind,src=${candidate},dst=/workspace,readonly`,
      "--mount",
      `type=bind,src=${evidence},dst=/evidence`,
      "--workdir",
      "/workspace",
      image,
      "node",
      "tools/server-scripts/verify-enterprise-single-node-ubuntu-container.ts",
      "--worker",
      "--evidence-root",
      "/evidence",
    ]),
    displayCommand:
      "docker run <digest-pinned-ubuntu-image> <read-only-candidate> <isolated-evidence>",
  });
}

async function pathExists(target?: any) : Promise<any> {
  return fs.access(target).then(() : any => true, () : any => false);
}

async function runProcess({
  executable,
  args,
  cwd,
  env = process.env,
  stdoutPath,
  stderrPath,
}: Record<string, any>) : Promise<any> {
  const stdoutHandle: any = stdoutPath ? await fs.open(stdoutPath, "w", 0o600) : null;
  const stderrHandle: any = stderrPath ? await fs.open(stderrPath, "w", 0o600) : null;
  try {
    return await new Promise((resolve?: any, reject?: any) : any => {
      const child: any = spawn(executable, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: [
          "ignore",
          stdoutHandle ? stdoutHandle.fd : "ignore",
          stderrHandle ? stderrHandle.fd : "ignore",
        ],
      });
      child.once("error", reject);
      child.once("close", (exitCode?: any, signal?: any) : any => resolve({
        exitCode: Number.isInteger(exitCode) ? exitCode : 1,
        signal: signal ?? null,
      }));
    });
  } finally {
    await Promise.all([
      stdoutHandle?.close(),
      stderrHandle?.close(),
    ]);
  }
}

async function defaultRunBaseline({ repoRoot }: Record<string, any>) : Promise<any> {
  const result: any = await runProcess({
    executable: process.execPath,
    args: ["tools/plan/rebuild-current-plan-baseline.ts"],
    cwd: repoRoot,
  });
  requireCondition(result.exitCode === 0, "release_plan_initialization_failed");
}

export async function initializePlanWorkspace({
  repoRoot,
  planRoot = path.join(repoRoot, "docs", "plans"),
  runBaseline = defaultRunBaseline,
}: Record<string, any> = {}) : Promise<any> {
  absoluteDirectory(repoRoot, "release_plan_repository_root_invalid");
  absoluteDirectory(planRoot, "release_plan_root_invalid");
  requireCondition(!(await pathExists(planRoot)), "release_plan_already_initialized");
  await runBaseline({ repoRoot, planRoot });
  requireCondition(await pathExists(planRoot), "release_plan_missing_after_initialization");
  return Object.freeze({ initialized: true });
}

export function reduceEnterpriseSingleNodeFailure({ phase }: Record<string, any> = {}) : any {
  return Object.freeze({
    status: "failed",
    phase: typeof phase === "string" && ENTERPRISE_SINGLE_NODE_PHASES.includes(phase)
      ? phase
      : "unknown",
    code: "enterprise_single_node_phase_failed",
  });
}

export async function assertCandidateWorktreeClean(repoRoot?: any) : Promise<any> {
  await assertCanonicalCandidateWorktreeClean({ repoRoot });
}

function safePlanOverlayPath(value?: any) : any {
  const normalized: any = String(value || "").split(path.sep).join("/");
  requireCondition(
    normalized.length > 0 &&
      normalized !== "." &&
      !path.posix.isAbsolute(normalized) &&
      !normalized.split("/").includes(".."),
    "ubuntu_delivery_plan_overlay_path_invalid",
  );
  return normalized;
}

async function collectDirectoryFiles(root?: any, relativeRoot?: any) : Promise<any> {
  const absoluteRoot: any = path.join(root, relativeRoot);
  if (!(await pathExists(absoluteRoot))) return [];
  const files: any[] = [];
  const visit: any = async (relativeDirectory?: any) : Promise<any> => {
    const entries: any = await fs.readdir(path.join(root, relativeDirectory), {
      withFileTypes: true,
    });
    entries.sort((left?: any, right?: any) : any => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath: any = safePlanOverlayPath(
        path.posix.join(
          relativeDirectory.split(path.sep).join(path.posix.sep),
          entry.name,
        ),
      );
      if (entry.isDirectory()) {
        await visit(relativePath);
      } else {
        requireCondition(
          entry.isFile(),
          "ubuntu_delivery_plan_overlay_file_type_unsupported",
        );
        files.push(relativePath);
      }
    }
  };
  await visit(relativeRoot);
  return files;
}

async function copyGeneratedPlanOverlay({ sourceRoot, destinationRoot }: Record<string, any>) : Promise<any> {
  const relativePaths: any = await collectDirectoryFiles(sourceRoot, "docs/plans");
  requireCondition(relativePaths.length > 0, "ubuntu_delivery_plan_overlay_missing");
  for (const relativePath of relativePaths) {
    const sourcePath: any = path.join(sourceRoot, relativePath);
    const sourceStat: any = await fs.lstat(sourcePath);
    requireCondition(
      sourceStat.isFile(),
      "ubuntu_delivery_plan_overlay_file_type_unsupported",
    );
    const destinationPath: any = path.join(destinationRoot, relativePath);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
    await fs.chmod(destinationPath, sourceStat.mode & 0o111 ? 0o700 : 0o600);
  }
}

async function loadOrCreateSourceCandidate({ repoRoot, sourceCandidatePath }: Record<string, any>) : Promise<any> {
  if (!sourceCandidatePath) {
    return validateReleaseCandidateIdentity(
      await createReleaseCandidateIdentity({ repoRoot }),
    );
  }
  const candidate: any = await loadReleaseCandidateIdentity(sourceCandidatePath);
  const localCandidate: any = await createReleaseCandidateIdentity({ repoRoot });
  requireCondition(
    localCandidate.candidate_digest === candidate.candidate_digest,
    "ubuntu_delivery_source_candidate_mismatch",
  );
  return validateReleaseCandidateIdentity(candidate);
}

async function buildAcceptanceImage(repoRoot?: any) : Promise<any> {
  const configured: any = String(process.env.MESHRIX_UBUNTU_ACCEPTANCE_IMAGE || "").trim();
  if (configured) {
    requireCondition(
      DIGEST_PINNED_IMAGE_PATTERN.test(configured),
      "ubuntu_acceptance_image_not_digest_pinned",
    );
    return configured;
  }
  const tag: any = "meshrix-enterprise-single-node-acceptance:local";
  const build: any = await runProcess({
    executable: "docker",
    args: [
      "build",
      "--file",
      ACCEPTANCE_IMAGE_DOCKERFILE,
      "--tag",
      tag,
      ".",
    ],
    cwd: repoRoot,
  });
  requireCondition(build.exitCode === 0, "ubuntu_acceptance_image_build_failed");
  const outputPath: any = path.join(repoRoot, "build", `.acceptance-image-${crypto.randomUUID()}`);
  let imageId: any;
  try {
    const inspect: any = await runProcess({
      executable: "docker",
      args: ["image", "inspect", "--format", "{{.Id}}", tag],
      cwd: repoRoot,
      stdoutPath: outputPath,
    });
    requireCondition(inspect.exitCode === 0, "ubuntu_acceptance_image_identity_unavailable");
    imageId = (await fs.readFile(outputPath, "utf8")).trim();
  } finally {
    await fs.rm(outputPath, { force: true });
  }
  requireCondition(
    DIGEST_PINNED_IMAGE_PATTERN.test(imageId),
    "ubuntu_acceptance_image_identity_invalid",
  );
  return imageId;
}

function acceptanceRunnerIdentity(imageDigest?: any) : any {
  requireCondition(
    DIGEST_PINNED_IMAGE_PATTERN.test(imageDigest),
    "ubuntu_acceptance_image_identity_invalid",
  );
  return Object.freeze({
    schema_version: "v0.0.1:meshrix:ubuntu-acceptance-runner-1",
    image_digest: imageDigest,
    privacy_safe: true,
  });
}

function validateAcceptanceRunnerIdentity(identity?: any) : any {
  requireExactKeys(identity, [
    "schema_version",
    "image_digest",
    "privacy_safe",
  ], "ubuntu_acceptance_runner_identity_invalid");
  requireCondition(
    identity.schema_version ===
      "v0.0.1:meshrix:ubuntu-acceptance-runner-1" &&
      DIGEST_PINNED_IMAGE_PATTERN.test(identity.image_digest) &&
      identity.privacy_safe === true,
    "ubuntu_acceptance_runner_identity_invalid",
  );
  return identity;
}

function commandEvidence(ref?: any, recordedAt?: any) : any {
  return Object.freeze({
    ...ref,
    recorded_at: recordedAt,
  });
}

async function loadAuditShards(repoRoot?: any) : Promise<any> {
  const registry: any = JSON.parse(await fs.readFile(path.join(repoRoot, TEST_REGISTRY), "utf8"));
  return createEnterpriseSingleNodeAuditShards({
    registry,
    profile: AUDIT_PROFILE,
  });
}

async function runWorkerCommand({ command, repoRoot, evidenceRoot, index }: Record<string, any>) : Promise<any> {
  const stdoutPath: any = path.join(evidenceRoot, `.command-${index}.stdout`);
  const stderrPath: any = path.join(evidenceRoot, `.command-${index}.stderr`);
  try {
    const result: any = await runProcess({
      executable: "/bin/sh",
      args: ["-lc", command],
      cwd: repoRoot,
      env: {
        ...process.env,
        MESHRIX_ACCEPTANCE_EVIDENCE_ROOT: evidenceRoot,
      },
      stdoutPath,
      stderrPath,
    });
    requireCondition(result.exitCode === 0, "ubuntu_delivery_command_failed");
    const [stdout, stderr] = await Promise.all([
      fs.readFile(stdoutPath),
      fs.readFile(stderrPath),
    ]);
    return Object.freeze({
      command_sha256: sha256(command),
      exit_code: 0,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: stdout.length,
      stderr_bytes: stderr.length,
    });
  } finally {
    await Promise.all([
      fs.rm(stdoutPath, { force: true }),
      fs.rm(stderrPath, { force: true }),
    ]);
  }
}

async function materializeWorker({ candidateRoot, workerRoot, evidenceRoot }: Record<string, any>) : Promise<any> {
  const candidate: any = await loadReleaseCandidateIdentity(
    path.join(evidenceRoot, SOURCE_CANDIDATE),
  );
  requireCondition(
    (await fs.readdir(workerRoot)).length === 0,
    "ubuntu_delivery_worker_not_empty",
  );
  const clone: any = await runProcess({
    executable: "git",
    args: [
      "-c",
      `safe.directory=${candidateRoot}`,
      "clone",
      "--no-checkout",
      "--no-local",
      candidateRoot,
      workerRoot,
    ],
    cwd: candidateRoot,
  });
  requireCondition(clone.exitCode === 0, "ubuntu_delivery_candidate_clone_failed");
  const checkout: any = await runProcess({
    executable: "git",
    args: ["checkout", "--detach", candidate.source_revision],
    cwd: workerRoot,
  });
  requireCondition(checkout.exitCode === 0, "ubuntu_delivery_candidate_checkout_failed");
  const materializedCandidate: any = await createReleaseCandidateIdentity({
    repoRoot: workerRoot,
  });
  requireCondition(
    materializedCandidate.source_revision === candidate.source_revision &&
      materializedCandidate.repository_tree_digest ===
        candidate.repository_tree_digest &&
      materializedCandidate.package_lock_sha256 ===
        candidate.package_lock_sha256 &&
      materializedCandidate.candidate_digest === candidate.candidate_digest,
    "ubuntu_delivery_candidate_source_mismatch",
  );
  const lockfile: any = await fs.readFile(path.join(workerRoot, "package-lock.json"));
  requireCondition(
    candidate.package_lock_sha256 === `sha256:${sha256(lockfile)}`,
    "ubuntu_delivery_candidate_lockfile_mismatch",
  );
  await copyGeneratedPlanOverlay({
    sourceRoot: candidateRoot,
    destinationRoot: workerRoot,
  });
  requireCondition(
    await pathExists(CONTAINER_DEPENDENCY_ROOT),
    "ubuntu_delivery_admitted_dependencies_missing",
  );
  await fs.cp(CONTAINER_DEPENDENCY_ROOT, path.join(workerRoot, "node_modules"), {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  });
  const result: any = await runProcess({
    executable: process.execPath,
    args: [
      path.join(
        workerRoot,
        "tools/server-scripts/verify-enterprise-single-node-ubuntu-container.ts",
      ),
      "--worker-execute",
      "--evidence-root",
      evidenceRoot,
    ],
    cwd: workerRoot,
    env: process.env,
  });
  requireCondition(result.exitCode === 0, "ubuntu_delivery_worker_execution_failed");
}

function implementationNodes(checkpoints?: any) : any {
  return checkpoints.filter((node?: any) : any => node.role === "implementation");
}

function implementationCriteriaByNode(nodes?: any) : any {
  const criteriaByNode: any = new Map<any, any>();
  for (const node of nodes) {
    requireCondition(
      isRecord(node) &&
        typeof node.id === "string" &&
        node.id.length > 0 &&
        !criteriaByNode.has(node.id) &&
        Array.isArray(node.acceptance_criteria) &&
        node.acceptance_criteria.length > 0 &&
        Array.isArray(node.regression?.criteria),
      "ubuntu_delivery_implementation_contract_invalid",
    );
    const criteria: any = node.regression.criteria;
    requireCondition(
      new Set<any>(criteria).size === criteria.length &&
        criteria.every((index?: any) : any =>
          Number.isInteger(index) &&
          index >= 0 &&
          index < node.acceptance_criteria.length) &&
        node.acceptance_criteria.every((_?: any, index?: any) : any => criteria.includes(index)),
      "ubuntu_delivery_criterion_coverage_invalid",
    );
    criteriaByNode.set(node.id, Object.freeze([...criteria]));
  }
  return criteriaByNode;
}

async function runHostAuditShard({ repoRoot, evidenceRoot, shards }: Record<string, any>) : Promise<any> {
  const command: any = auditShardCommand(shards.profile, shards.hostSuiteIds);
  const observation: any = await runWorkerCommand({
    command,
    repoRoot,
    evidenceRoot,
    index: "host-audit",
  });
  await fs.writeFile(
    path.join(evidenceRoot, HOST_AUDIT_OBSERVATION),
    `${JSON.stringify(observation, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return observation;
}

async function runWorker({ repoRoot, evidenceRoot }: Record<string, any>) : Promise<any> {
  const candidate: any = await loadReleaseCandidateIdentity(
    path.join(evidenceRoot, SOURCE_CANDIDATE),
  );
  const lockfile: any = await fs.readFile(path.join(repoRoot, "package-lock.json"));
  requireCondition(
    candidate.package_lock_sha256 === `sha256:${sha256(lockfile)}`,
    "ubuntu_delivery_candidate_mismatch",
  );
  const checkpointsPath: any = path.join(
    repoRoot,
    "docs",
    "plans",
    DELIVERY_PLAN,
    "Checkpoints.json",
  );
  const checkpoints: any = JSON.parse(await fs.readFile(checkpointsPath, "utf8"));
  const shards: any = await loadAuditShards(repoRoot);
  const fullRegressionCommands: any = fullRegressionCommandsFor(shards);
  const hostAuditObservation: any = JSON.parse(await fs.readFile(
    path.join(evidenceRoot, HOST_AUDIT_OBSERVATION),
    "utf8",
  ));
  validateCommandObservation(
    hostAuditObservation,
    fullRegressionCommands[0],
    "ubuntu_delivery_host_audit_evidence_invalid",
  );
  const observed: any[] = [];
  let commandIndex: any = 0;
  for (const node of implementationNodes(checkpoints)) {
    const commands: any[] = [];
    for (const command of node.regression?.commands ?? []) {
      commands.push(await runWorkerCommand({
        command,
        repoRoot,
        evidenceRoot,
        index: commandIndex,
      }));
      commandIndex += 1;
    }
    observed.push({ node_id: node.id, commands });
  }
  const fullRegression: any[] = [hostAuditObservation];
  for (const command of fullRegressionCommands.slice(1)) {
    fullRegression.push(await runWorkerCommand({
      command,
      repoRoot,
      evidenceRoot,
      index: commandIndex,
    }));
    commandIndex += 1;
  }
  const recordedAt: any = new Date().toISOString();
  const summary: Record<string, any> = {
    schema_version: WORKER_SUMMARY_SCHEMA,
    status: "passed",
    candidate,
    implementation_nodes: observed,
    full_regression: fullRegression,
    full_regression_commands: fullRegressionCommands.map((command?: any) : any => sha256(command)),
    recorded_at: recordedAt,
    privacy_safe: true,
  };
  await fs.writeFile(
    path.join(evidenceRoot, WORKER_SUMMARY),
    `${JSON.stringify(summary, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function recordWorkerEvidence({
  repoRoot,
  evidenceRoot,
  candidate,
  acceptanceRunner,
  hostAuditObservation,
}: Record<string, any>) : Promise<any> {
  const summaryPath: any = path.join(evidenceRoot, WORKER_SUMMARY);
  const summaryBytes: any = await fs.readFile(summaryPath);
  const summary: any = JSON.parse(summaryBytes);
  const summaryCandidate: any = validateReleaseCandidateIdentity(summary.candidate);
  requireCondition(
    summaryCandidate.candidate_digest === candidate.candidate_digest,
    "ubuntu_delivery_summary_candidate_mismatch",
  );
  const acceptanceRunnerPath: any = path.join(evidenceRoot, ACCEPTANCE_RUNNER);
  const acceptanceRunnerBytes: any = await fs.readFile(acceptanceRunnerPath);
  const recordedAcceptanceRunner: any = validateAcceptanceRunnerIdentity(
    JSON.parse(acceptanceRunnerBytes),
  );
  requireCondition(
    canonicalDigest(recordedAcceptanceRunner) ===
      canonicalDigest(acceptanceRunner),
    "ubuntu_acceptance_runner_identity_mismatch",
  );
  const checkpointsPath: any = path.join(
    repoRoot,
    "docs",
    "plans",
    DELIVERY_PLAN,
    "Checkpoints.json",
  );
  const checkpoints: any = JSON.parse(await fs.readFile(checkpointsPath, "utf8"));
  const deliveryImplementationNodes: any = implementationNodes(checkpoints);
  const criteriaByNode: any =
    implementationCriteriaByNode(deliveryImplementationNodes);
  const shards: any = await loadAuditShards(repoRoot);
  const fullRegressionCommands: any = fullRegressionCommandsFor(shards);
  const validation: any = validateEnterpriseSingleNodeWorkerSummary({
    summary,
    implementationNodes: deliveryImplementationNodes,
    fullRegressionCommands,
  });
  requireCondition(
    canonicalDigest(summary.full_regression[0]) ===
      canonicalDigest(hostAuditObservation),
    "ubuntu_delivery_host_audit_evidence_mismatch",
  );
  for (const node of checkpoints) {
    if (node.role !== "implementation") continue;
    const observed: any = validation.evidenceByNode.get(node.id);
    requireCondition(observed, "ubuntu_delivery_node_evidence_missing");
    const refs: any = observed.refs.map((ref?: any) : any =>
      commandEvidence(ref, validation.recordedAt));
    node.status = "completed";
    node.commit = { ...node.commit, delivered: candidate.source_revision };
    const criteria: any = criteriaByNode.get(node.id);
    requireCondition(criteria, "ubuntu_delivery_criterion_evidence_missing");
    node.acceptance_criteria = node.acceptance_criteria.map((criterion?: any, index?: any) : any => {
      requireCondition(
        criteria.includes(index),
        "ubuntu_delivery_criterion_evidence_missing",
      );
      return {
        ...criterion,
        checked: true,
        evidence_refs: refs,
      };
    });
  }
  const finalNode: any = checkpoints.find((node?: any) : any => node.id === DELIVERY_FINAL_NODE);
  requireCondition(finalNode?.role === "final_validation", "delivery_final_node_missing");
  const finalEvidence: any = [
    [summaryPath, summaryBytes],
    [acceptanceRunnerPath, acceptanceRunnerBytes],
  ].map(([evidencePath, evidenceBytes]: any[]) : any => ({
    type: "file",
    path: path.posix.relative(
      repoRoot.split(path.sep).join(path.posix.sep),
      evidencePath.split(path.sep).join(path.posix.sep),
    ),
    sha256: sha256(evidenceBytes),
    recorded_at: validation.recordedAt,
  }));
  finalNode.status = "completed";
  finalNode.candidate_digest = candidate.candidate_digest;
  finalNode.commit = { ...finalNode.commit, delivered: candidate.source_revision };
  finalNode.acceptance_criteria = finalNode.acceptance_criteria.map((criterion?: any) : any => ({
    ...criterion,
    checked: true,
    evidence_refs: finalEvidence,
  }));
  const temporary: any = `${checkpointsPath}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, `${JSON.stringify(checkpoints, null, 2)}\n`, "utf8");
  await fs.rename(temporary, checkpointsPath);
}

async function reduceDeliveryReceipt(repoRoot?: any) : Promise<any> {
  const result: any = await runProcess({
    executable: process.execPath,
    args: [
      "tools/plan/reduce-end-to-end-release-receipt.ts",
      "--plan",
      DELIVERY_PLAN,
      "--final-node",
      DELIVERY_FINAL_NODE,
    ],
    cwd: repoRoot,
  });
  requireCondition(result.exitCode === 0, "delivery_receipt_reduction_failed");
}

async function runHost({ repoRoot, receiptOnly, sourceCandidatePath }: Record<string, any>) : Promise<any> {
  const schedule: any = createEnterpriseSingleNodeExecutionSchedule();
  requireCondition(schedule.valid, "enterprise_single_node_schedule_invalid");
  const planRoot: any = path.join(repoRoot, "docs", "plans");
  await initializePlanWorkspace({ repoRoot, planRoot });
  const candidate: any = await loadOrCreateSourceCandidate({
    repoRoot,
    sourceCandidatePath,
  });
  const evidenceRoot: any = path.join(
    repoRoot,
    "build",
    "reports",
    "enterprise-single-node-ubuntu",
  );
  await fs.rm(evidenceRoot, { recursive: true, force: true });
  await fs.mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const image: any = await buildAcceptanceImage(repoRoot);
  const acceptanceRunner: any = acceptanceRunnerIdentity(image);
  const shards: any = await loadAuditShards(repoRoot);
  await Promise.all([
    fs.writeFile(
      path.join(evidenceRoot, SOURCE_CANDIDATE),
      `${JSON.stringify(candidate, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    ),
    fs.writeFile(
      path.join(evidenceRoot, ACCEPTANCE_RUNNER),
      `${JSON.stringify(acceptanceRunner, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    ),
  ]);
  const hostAuditObservation: any = await runHostAuditShard({
    repoRoot,
    evidenceRoot,
    shards,
  });
  const request: any = createUbuntuContainerRequest({
    image,
    candidateRoot: repoRoot,
    evidenceRoot,
  });
  const containerResult: any = await runProcess({
    executable: request.executable,
    args: request.args,
    cwd: repoRoot,
  });
  requireCondition(containerResult.exitCode === 0, "ubuntu_delivery_failed");
  await recordWorkerEvidence({
    repoRoot,
    evidenceRoot,
    candidate,
    acceptanceRunner,
    hostAuditObservation,
  });
  await reduceDeliveryReceipt(repoRoot);
  const offlineTransfer: any = await runProcess({
    executable: process.execPath,
    args: [
      "tools/server-scripts/verify-cross-system-offline-transfer-evidence.ts",
      "--record-plan-receipt",
    ],
    cwd: repoRoot,
    env: process.env,
  });
  requireCondition(
    offlineTransfer.exitCode === 0,
    "cross_system_offline_transfer_receipt_failed",
  );
  if (!receiptOnly) {
    const acceptance: any = await runProcess({
      executable: process.execPath,
      args: [
        "tools/server-scripts/verify-platform-acceptance.ts",
        "--profile",
        "enterprise-single-node",
      ],
      cwd: repoRoot,
      env: process.env,
    });
    requireCondition(acceptance.exitCode === 0, "platform_acceptance_failed");
  }
  process.stdout.write(`${JSON.stringify({
    status: "passed",
    receipt_ready: true,
    platform_acceptance_executed: !receiptOnly,
    candidate_digest: candidate.candidate_digest,
  })}\n`);
}

async function main() : Promise<any> {
  const args: any = parseArgs(process.argv.slice(2));
  if (args.worker) {
    requireCondition(args.evidenceRoot, "enterprise_single_node_evidence_root_missing");
    await materializeWorker({
      candidateRoot: defaultRepoRoot,
      workerRoot: CONTAINER_WORKER_ROOT,
      evidenceRoot: path.resolve(args.evidenceRoot),
    });
    return;
  }
  if (args.workerExecute) {
    requireCondition(args.evidenceRoot, "enterprise_single_node_evidence_root_missing");
    await runWorker({
      repoRoot: defaultRepoRoot,
      evidenceRoot: path.resolve(args.evidenceRoot),
    });
    return;
  }
  await runHost({
    repoRoot: defaultRepoRoot,
    receiptOnly: args.receiptOnly,
    sourceCandidatePath: args.sourceCandidate
      ? path.resolve(args.sourceCandidate)
      : undefined,
  });
}

const isDirectRun: any = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isDirectRun) {
  main().catch((error?: any) : any => {
    const phase: any = error?.message?.startsWith("release_plan_")
      ? "initialize-plan"
      : error?.message?.startsWith("delivery_receipt_")
        ? "delivery-receipt"
        : error?.message?.startsWith("platform_acceptance_")
          ? "platform-acceptance"
          : "ubuntu-delivery";
    process.stderr.write(`${JSON.stringify(reduceEnterpriseSingleNodeFailure({ phase, error }))}\n`);
    process.exitCode = 1;
  });
}
