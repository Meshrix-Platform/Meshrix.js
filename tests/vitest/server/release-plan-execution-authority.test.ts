import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import * as enterpriseSingleNodeVerifier from
  "../../../tools/server-scripts/verify-enterprise-single-node-ubuntu-container.ts";

const {
  ENTERPRISE_SINGLE_NODE_PHASES,
  assertCandidateWorktreeClean,
  createEnterpriseSingleNodeExecutionSchedule,
  createUbuntuContainerRequest,
  initializePlanWorkspace,
  reduceEnterpriseSingleNodeFailure,
} = enterpriseSingleNodeVerifier;

const PINNED_UBUNTU_IMAGE: any =
  "ubuntu:24.04@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FIXTURE_CANDIDATE_DIGEST: any =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPO_ROOT: any = path.resolve(import.meta.dirname, "../../..");
const BASELINE_SCRIPT: any = path.join(
  REPO_ROOT,
  "tools/plan/rebuild-current-plan-baseline.ts",
);
const TEST_REGISTRY: any = path.join(
  REPO_ROOT,
  "tools/registry/tests.registry.json",
);
const SUMMARY_IMPLEMENTATION_NODES: readonly any[] = Object.freeze([
  Object.freeze({
    id: "implementation-alpha",
    acceptance_criteria: Object.freeze([
      Object.freeze({ checked: false, text: "Alpha acceptance." }),
    ]),
    regression: Object.freeze({
      commands: Object.freeze(["npm run focused:alpha"]),
      criteria: Object.freeze([0]),
    }),
  }),
  Object.freeze({
    id: "implementation-beta",
    acceptance_criteria: Object.freeze([
      Object.freeze({ checked: false, text: "Beta acceptance." }),
    ]),
    regression: Object.freeze({
      commands: Object.freeze(["npm run focused:beta"]),
      criteria: Object.freeze([0]),
    }),
  }),
]);
const SUMMARY_FULL_REGRESSION_COMMANDS: readonly any[] = Object.freeze([
  "npm run verify",
  "npm run vitest",
  "node tests/run.ts --suite self-contained-audit",
]);

function run(executable?: any, args?: any, cwd?: any) : any {
  return spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
}

function workflowJob(workflow?: any, jobId?: any) : any {
  const marker: any = `  ${jobId}:\n`;
  const start: any = workflow.indexOf(marker);
  if (start < 0) throw new Error(`workflow_job_missing:${jobId}`);
  const remainder: any = workflow.slice(start + marker.length);
  const nextJob: any = remainder.search(/\n  [a-z][a-z0-9-]*:\n/u);
  return workflow.slice(start, nextJob < 0 ? workflow.length : start + marker.length + nextJob);
}

function sha256(value?: any) : any {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function resolveRegistryProfileSuiteIds(registry?: any, profileName?: any, active: any = new Set<any>()) : any {
  if (active.has(profileName)) {
    throw new Error(`test_registry_profile_cycle:${profileName}`);
  }
  const profile: any = registry.profiles?.[profileName];
  if (!profile) throw new Error(`test_registry_profile_missing:${profileName}`);
  const nextActive: any = new Set<any>(active).add(profileName);
  const inherited: any = profile.extends
    ? resolveRegistryProfileSuiteIds(registry, profile.extends, nextActive)
    : [];
  return [...new Set<any>([...inherited, ...(profile.suites ?? [])])];
}

function workerCommandObservation(command?: any, exitCode: any = 0) : any {
  const emptyDigest: any = sha256("");
  return {
    command_sha256: sha256(command),
    exit_code: exitCode,
    stdout_sha256: emptyDigest,
    stderr_sha256: emptyDigest,
    stdout_bytes: 0,
    stderr_bytes: 0,
  };
}

function completeWorkerSummary() : any {
  return {
    schema_version: "v0.0.1:meshrix:enterprise-single-node-ubuntu-evidence-1",
    status: "passed",
    candidate: { candidate_digest: FIXTURE_CANDIDATE_DIGEST },
    implementation_nodes: SUMMARY_IMPLEMENTATION_NODES.map((node?: any) : any => ({
      node_id: node.id,
      commands: node.regression.commands.map((command?: any) : any =>
        workerCommandObservation(command)),
    })),
    full_regression: SUMMARY_FULL_REGRESSION_COMMANDS.map((command?: any) : any =>
      workerCommandObservation(command)),
    full_regression_commands: SUMMARY_FULL_REGRESSION_COMMANDS.map(sha256),
    recorded_at: "2026-01-01T00:00:00.000Z",
    privacy_safe: true,
  };
}

function plannedWorkerSummaryValidator() : any {
  const validator: any =
    enterpriseSingleNodeVerifier.validateEnterpriseSingleNodeWorkerSummary;
  if (typeof validator !== "function") {
    throw new Error(
      "planned_export_missing:validateEnterpriseSingleNodeWorkerSummary",
    );
  }
  return validator;
}

function validateWorkerSummary(summary?: any) : any {
  return plannedWorkerSummaryValidator()({
    summary,
    implementationNodes: SUMMARY_IMPLEMENTATION_NODES,
    fullRegressionCommands: SUMMARY_FULL_REGRESSION_COMMANDS,
  });
}

describe("enterprise single-node release Plan execution authority", () : any => {
  it("initializes an isolated Plan workspace exactly once without replacing evidence", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plan-authority-"));
    const planRoot: any = path.join(root, "docs", "plans");
    const runBaseline: any = vi.fn(async () : Promise<any> => {
      await fs.mkdir(path.join(planRoot, "end-to-end-release"), { recursive: true });
      await fs.writeFile(
        path.join(planRoot, "end-to-end-release", "Checkpoints.json"),
        JSON.stringify([{ status: "pending" }]),
      );
    });
    try {
      await initializePlanWorkspace({ repoRoot: root, planRoot, runBaseline });
      const checkpoint: any = path.join(planRoot, "end-to-end-release", "Checkpoints.json");
      await fs.writeFile(checkpoint, JSON.stringify([{ status: "completed", receipt: "sentinel" }]));
      await expect(initializePlanWorkspace({ repoRoot: root, planRoot, runBaseline }))
        .rejects.toThrow("release_plan_already_initialized");
      expect(runBaseline).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(checkpoint, "utf8"))
        .toBe(JSON.stringify([{ status: "completed", receipt: "sentinel" }]));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("generates one self-contained Core plan without detachable repair prerequisites", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plan-baseline-"));
    try {
      await fs.writeFile(path.join(root, "README.md"), "synthetic candidate\n");
      expect(run("git", ["init", "--quiet"], root).status).toBe(0);
      expect(run("git", ["add", "README.md"], root).status).toBe(0);
      expect(run("git", [
        "-c",
        "user.name=Meshrix Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "synthetic candidate",
      ], root).status).toBe(0);

      const generated: any = run(process.execPath, [BASELINE_SCRIPT, root], REPO_ROOT);
      expect(generated.status, generated.stderr).toBe(0);

      const planRoot: any = path.join(root, "docs/plans");
      const manifest: any = JSON.parse(await fs.readFile(
        path.join(planRoot, "Manifest.json"),
        "utf8",
      ));
      expect(manifest.map((entry?: any) : any => entry.directory)).toEqual([
        "end-to-end-release",
        "end-to-end-release/enterprise-single-node",
        "end-to-end-release/cross-system-offline-transfer",
        "end-to-end-release/native-linux-x64",
        "end-to-end-release/native-linux-arm64",
        "end-to-end-release/native-macos-arm64",
        "end-to-end-release/native-windows-x64",
        "end-to-end-release/public-cloud-single-node",
        "end-to-end-release/clean-host-recovery",
        "end-to-end-release/functional-release-acceptance",
      ]);
      for (const entry of manifest) {
        await expect(fs.access(path.join(planRoot, entry.checkpoints))).resolves.toBeUndefined();
        for (const sourceFile of entry.source_files) {
          const relative: any = sourceFile.replace(/^docs\/plans\//u, "");
          await expect(fs.access(path.join(planRoot, relative))).resolves.toBeUndefined();
        }
      }

      const dependencyMap: any = JSON.parse(await fs.readFile(
        path.join(planRoot, "end-to-end-release/DependencyMap.json"),
        "utf8",
      ));
      expect(dependencyMap.plans.map((entry?: any) : any => entry.directory)).toEqual([
        "end-to-end-release",
        "end-to-end-release/enterprise-single-node",
        "end-to-end-release/cross-system-offline-transfer",
        "end-to-end-release/functional-release-acceptance",
      ]);
      expect(dependencyMap.plans[1].prerequisite_receipts).toEqual([]);
      expect(dependencyMap.plans.at(-1).prerequisite_receipts.map((receipt?: any) : any => receipt.plan))
        .toEqual([
          "end-to-end-release/enterprise-single-node",
          "end-to-end-release/cross-system-offline-transfer",
        ]);
      expect(JSON.stringify(dependencyMap)).not.toContain("repair");

      const delivery: any = JSON.parse(await fs.readFile(
        path.join(planRoot, "end-to-end-release/enterprise-single-node/Checkpoints.json"),
        "utf8",
      ));
      const security: any = delivery.find((node?: any) : any =>
        node.requirements.includes("REQ-ENT-E2"));
      expect(security.regression.commands).toContain(
        "node tools/server-scripts/verify-trusted-forwarding-invariants.ts",
      );
      const currentPlan: any = await fs.readFile(
        path.join(planRoot, "end-to-end-release/CurrentPlan.md"),
        "utf8",
      );
      expect(currentPlan).toContain(
        "Authenticated forward-server delegation and concrete third-party adapter support.",
      );

      const repeated: any = run(process.execPath, [BASELINE_SCRIPT, root], REPO_ROOT);
      expect(repeated.status).not.toBe(0);
      expect(repeated.stderr).toContain("refusing to replace checkpoints or receipts");

      const checkpointPath: any = path.join(
        planRoot,
        "end-to-end-release/enterprise-single-node/Checkpoints.json",
      );
      const checkpointSentinel: any = Buffer.from(
        `${JSON.stringify([{ sentinel: "immutable-existing-evidence" }])}\n`,
      );
      await fs.writeFile(checkpointPath, checkpointSentinel);
      const replaceAttempt: any = run(
        process.execPath,
        [BASELINE_SCRIPT, root, "--replace"],
        REPO_ROOT,
      );
      const checkpointAfterReplaceAttempt: any = await fs.readFile(checkpointPath);
      expect({
        refused: replaceAttempt.status !== 0,
        reportedNonDestructiveBoundary:
          replaceAttempt.stderr.includes("refusing to replace checkpoints or receipts"),
        preservedExactCheckpointBytes:
          checkpointAfterReplaceAttempt.equals(checkpointSentinel),
      }).toEqual({
        refused: true,
        reportedNonDestructiveBoundary: true,
        preservedExactCheckpointBytes: true,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects both tracked changes and untracked source from an immutable candidate", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-candidate-clean-"));
    try {
      await fs.writeFile(path.join(root, ".gitignore"), "/build/\n");
      await fs.writeFile(path.join(root, "README.md"), "candidate\n");
      expect(run("git", ["init", "--quiet"], root).status).toBe(0);
      expect(run("git", ["add", ".gitignore", "README.md"], root).status).toBe(0);
      expect(run("git", [
        "-c",
        "user.name=Meshrix Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "candidate",
      ], root).status).toBe(0);

      await expect(assertCandidateWorktreeClean(root)).resolves.toBeUndefined();
      await fs.writeFile(path.join(root, "untracked.ts"), "export default true;\n");
      await expect(assertCandidateWorktreeClean(root))
        .rejects.toThrow("candidate_worktree_not_clean");
      await fs.rm(path.join(root, "untracked.ts"));
      await fs.writeFile(path.join(root, "README.md"), "modified candidate\n");
      await expect(assertCandidateWorktreeClean(root))
        .rejects.toThrow("candidate_worktree_not_clean");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reduces a delivery receipt before any platform acceptance consumer", () : any => {
    const schedule: any = createEnterpriseSingleNodeExecutionSchedule();
    expect(schedule.valid).toBe(true);
    expect(schedule.phases.map((phase?: any) : any => phase.id)).toEqual(ENTERPRISE_SINGLE_NODE_PHASES);
    expect(schedule.phases.find((phase?: any) : any => phase.id === "delivery-receipt")?.dependsOn)
      .toEqual(["ubuntu-delivery"]);
    expect(schedule.phases.find((phase?: any) : any => phase.id === "offline-transfer-receipt")?.dependsOn)
      .toEqual(["delivery-receipt"]);
    expect(schedule.phases.find((phase?: any) : any => phase.id === "platform-acceptance")?.dependsOn)
      .toEqual(["offline-transfer-receipt"]);
    expect(schedule.phases.filter((phase?: any) : any => phase.id === "initialize-plan")).toHaveLength(1);
    expect(schedule.phases.at(-1)?.id).toBe("platform-acceptance");
  });

  it("constructs a digest-pinned, read-only, network-isolated Ubuntu verification request", () : any => {
    const request: any = createUbuntuContainerRequest({
      image: PINNED_UBUNTU_IMAGE,
      candidateRoot: "/synthetic/candidate",
      evidenceRoot: "/synthetic/evidence",
    });
    expect(request).toEqual({
      executable: "docker",
      args: [
        "run",
        "--rm",
        "--network",
        "none",
        "--tmpfs",
        "/worker:exec,mode=0700",
        "--mount",
        "type=bind,src=/synthetic/candidate,dst=/workspace,readonly",
        "--mount",
        "type=bind,src=/synthetic/evidence,dst=/evidence",
        "--workdir",
        "/workspace",
        PINNED_UBUNTU_IMAGE,
        "node",
        "tools/server-scripts/verify-enterprise-single-node-ubuntu-container.ts",
        "--worker",
        "--evidence-root",
        "/evidence",
      ],
      displayCommand: "docker run <digest-pinned-ubuntu-image> <read-only-candidate> <isolated-evidence>",
    });
    expect(() : any => createUbuntuContainerRequest({
      image: "ubuntu:24.04",
      candidateRoot: "/synthetic/candidate",
      evidenceRoot: "/synthetic/evidence",
    })).toThrow("ubuntu_acceptance_image_not_digest_pinned");
  });

  it("partitions the exact audit-public closure outside and inside the network-none worker", async () : Promise<any> => {
    const registry: any = JSON.parse(await fs.readFile(TEST_REGISTRY, "utf8"));
    const closureIds: any = resolveRegistryProfileSuiteIds(registry, "audit-public");
    const suitesById: any = new Map<any, any>(
      registry.suites.map((suite?: any) : any => [suite.id, suite]),
    );
    expect(closureIds.every((id?: any) : any => suitesById.has(id))).toBe(true);

    const dockerRequiredIds: any = closureIds.filter((id?: any) : any =>
      suitesById.get(id).requiredServices?.includes("docker"));
    expect(dockerRequiredIds.length).toBeGreaterThan(0);

    const createShards: any =
      enterpriseSingleNodeVerifier.createEnterpriseSingleNodeAuditShards;
    expect(
      createShards,
      "planned export createEnterpriseSingleNodeAuditShards must derive both shards from the registry",
    ).toBeTypeOf("function");
    const shards: any = createShards({ registry, profile: "audit-public" });
    const hostIds: any = shards.hostSuiteIds;
    const workerIds: any = shards.workerSuiteIds;
    expect(shards.allSuiteIds).toEqual(closureIds);
    expect(Array.isArray(hostIds)).toBe(true);
    expect(Array.isArray(workerIds)).toBe(true);

    const hostSet: any = new Set<any>(hostIds);
    const workerSet: any = new Set<any>(workerIds);
    expect(hostSet.size).toBe(hostIds.length);
    expect(workerSet.size).toBe(workerIds.length);
    expect(hostIds.every((id?: any) : any =>
      (suitesById.get(id)?.requiredServices?.length ?? 0) > 0)).toBe(true);
    expect(workerIds.every((id?: any) : any =>
      (suitesById.get(id)?.requiredServices?.length ?? 0) === 0)).toBe(true);
    expect(dockerRequiredIds.every((id?: any) : any => hostSet.has(id))).toBe(true);
    expect(workerIds.filter((id?: any) : any => hostSet.has(id))).toEqual([]);
    expect([...new Set<any>([...hostIds, ...workerIds])].sort())
      .toEqual([...closureIds].sort());
  });

  it("accepts only a complete, exact worker summary through the planned pure validator", () : any => {
    const validation: any = validateWorkerSummary(completeWorkerSummary());
    expect(validation.recordedAt).toBe("2026-01-01T00:00:00.000Z");
    expect([...validation.evidenceByNode.keys()])
      .toEqual(SUMMARY_IMPLEMENTATION_NODES.map((node?: any) : any => node.id));
    expect(validation.fullRegressionRefs)
      .toHaveLength(SUMMARY_FULL_REGRESSION_COMMANDS.length);
  });

  it.each([
    {
      name: "empty implementation evidence",
      code: "ubuntu_delivery_node_evidence_incomplete",
      mutate(summary?: any) : any {
        summary.implementation_nodes = [];
      },
    },
    {
      name: "empty full-regression evidence",
      code: "ubuntu_delivery_full_regression_incomplete",
      mutate(summary?: any) : any {
        summary.full_regression = [];
      },
    },
    {
      name: "duplicate implementation node",
      code: "ubuntu_delivery_node_evidence_invalid",
      mutate(summary?: any) : any {
        summary.implementation_nodes[1].node_id =
          summary.implementation_nodes[0].node_id;
      },
    },
    {
      name: "unknown implementation node",
      code: "ubuntu_delivery_node_evidence_invalid",
      mutate(summary?: any) : any {
        summary.implementation_nodes[0].node_id = "implementation-unknown";
      },
    },
    {
      name: "implementation command count mismatch",
      code: "ubuntu_delivery_node_command_count_mismatch",
      mutate(summary?: any) : any {
        summary.implementation_nodes[0].commands = [];
      },
    },
    {
      name: "implementation command hash mismatch",
      code: "ubuntu_delivery_node_command_evidence_invalid",
      mutate(summary?: any) : any {
        summary.implementation_nodes[0].commands[0].command_sha256 =
          sha256("npm run unrelated");
      },
    },
    {
      name: "non-zero command exit",
      code: "ubuntu_delivery_full_regression_evidence_invalid",
      mutate(summary?: any) : any {
        summary.full_regression[0].exit_code = 1;
      },
    },
    {
      name: "full-regression command count mismatch",
      code: "ubuntu_delivery_full_regression_incomplete",
      mutate(summary?: any) : any {
        summary.full_regression.pop();
      },
    },
    {
      name: "declared full-regression hash mismatch",
      code: "ubuntu_delivery_full_regression_command_mismatch",
      mutate(summary?: any) : any {
        summary.full_regression_commands[0] = sha256("npm run unrelated");
      },
    },
  ])("rejects passed summaries with $name", ({ code, mutate }: Record<string, any>) : any => {
    const summary: any = completeWorkerSummary();
    mutate(summary);
    expect(() : any => validateWorkerSummary(summary)).toThrow(code);
  });

  it("admits dependencies before the network-isolated run and executes from a writable worker", async () : Promise<any> => {
    const [dockerfile, verifier] = await Promise.all([
      fs.readFile(
        path.join(
          REPO_ROOT,
          "tools/containers/enterprise-single-node-acceptance.Dockerfile",
        ),
        "utf8",
      ),
      fs.readFile(
        path.join(
          REPO_ROOT,
          "tools/server-scripts/verify-enterprise-single-node-ubuntu-container.ts",
        ),
        "utf8",
      ),
    ]);
    expect(dockerfile).toContain("RUN npm ci");
    expect(dockerfile.indexOf("RUN npm ci")).toBeLessThan(
      dockerfile.indexOf("RUN mkdir -p /workspace /worker /evidence"),
    );
    expect(verifier).toContain('const SOURCE_CANDIDATE: any = "SOURCE_CANDIDATE.json"');
    expect(verifier).toContain('const ACCEPTANCE_RUNNER: any = "acceptance-runner.json"');
    expect(verifier).toContain("loadReleaseCandidateIdentity");
    expect(verifier).not.toContain("source_manifest_sha256");
    expect(verifier).not.toContain("container_image_digest");
    expect(verifier).toContain("await materializeWorker({");
    expect(verifier).toContain('"--worker-execute"');
  });

  it("reduces child failures to a stable privacy-safe result", () : any => {
    const failure: any = reduceEnterpriseSingleNodeFailure({
      phase: "ubuntu-delivery",
      error: Object.assign(new Error("private child output"), {
        stdout: "raw stdout",
        stderr: "raw stderr",
        env: { SECRET: "value" },
      }),
    });
    expect(failure).toEqual({
      status: "failed",
      phase: "ubuntu-delivery",
      code: "enterprise_single_node_phase_failed",
    });
    expect(JSON.stringify(failure)).not.toContain("private child output");
    expect(JSON.stringify(failure)).not.toContain("raw stdout");
    expect(JSON.stringify(failure)).not.toContain("SECRET");
  });

  it("makes CI and tag acceptance consume the Ubuntu closure without a direct Plan reset", async () : Promise<any> => {
    for (const relativePath of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
      const workflow: any = await fs.readFile(path.join(REPO_ROOT, relativePath), "utf8");
      const acceptance: any = workflowJob(workflow, "functional-completeness");
      const closure: any = acceptance.indexOf("npm run verify:enterprise-single-node:ubuntu-container");
      const consumer: any = acceptance.indexOf("verify-platform-acceptance.ts");
      expect(closure, `${relativePath}: missing Ubuntu closure`).toBeGreaterThan(0);
      expect(consumer, `${relativePath}: missing platform acceptance consumer`).toBeGreaterThan(closure);
      expect(acceptance).not.toContain("rebuild-current-plan-baseline.ts");
      expect(acceptance).not.toContain("--replace");
    }
  });
});
