import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  createProcessCommandRunner,
  createRealMachineValidationWorkflow,
  REAL_MACHINE_OPERATIONAL_PHASES,
  REAL_MACHINE_TARGET_COMMAND_MANIFESTS,
  validateFunctionalPlatformAcceptanceReport,
  validateRealMachineTarget,
} from "../../../tools/server-scripts/lib/real-machine-validation-workflow.ts";

const CANDIDATE: any = `sha256:${"a".repeat(64)}`;
const SOURCE_REVISION: any = "1".repeat(40);
const repoRoot: any = path.resolve(import.meta.dirname, "../../..");

async function fixture() : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-real-machine-"));
  const stateRoot: any = path.join(root, "state");
  const functionalReportPath: any = path.join(root, "functional.json");
  await fs.writeFile(functionalReportPath, `${JSON.stringify({
    schemaVersion: "v0.0.1:acceptance:platform-report-4",
    acceptanceStandard: "functional-completeness",
    claim: "functional-complete",
    status: "accepted",
    selectedProfile: "enterprise-single-node",
    sourceRevision: SOURCE_REVISION,
    summary: {
      releaseReady: true,
      reportLeakScan: true,
    },
  })}\n`, { mode: 0o600 });
  return {
    root,
    stateRoot,
    functionalReportPath,
    close: () : any => fs.rm(root, { recursive: true, force: true }),
  };
}

function workflowOptions(fx?: any, commandRunner?: any, overrides: Record<string, any> = {}) : any {
  return {
    stateRoot: fx.stateRoot,
    runId: "run-001",
    environmentId: "linux-x64-fixture",
    target: "native-linux-x64",
    architecture: "x64",
    candidateDigest: CANDIDATE,
    functionalAcceptanceReportPath: fx.functionalReportPath,
    currentSourceRevision: SOURCE_REVISION,
    runtimePlatform: "linux",
    runtimeArchitecture: "x64",
    commandRunner,
    ...overrides,
  };
}

describe("real machine validation workflow", () : any => {
  it("uses one prefixed TLS certificate digest contract from preflight to target probe", () : any => {
    const script: any = path.join(
      repoRoot,
      "tools/server-scripts/verify-real-machine-workflow-inputs.ts",
    );
    const commonEnv: Record<string, any> = {
      ...process.env,
      MESHRIX_REAL_MACHINE_TARGET: "public-cloud-single-node",
      MESHRIX_PUBLIC_BASE_URL: "https://meshrix.invalid",
      MESHRIX_TRUSTED_PROXIES: "192.0.2.0/24",
      MESHRIX_PUBLIC_AGENT_MCP_URL: "https://meshrix.invalid/mcp",
      MESHRIX_PUBLIC_UPSTREAM_HTTP_URL: "https://meshrix.invalid/upstream",
      MESHRIX_PUBLIC_UPSTREAM_MCP_URL: "https://meshrix.invalid/upstream/mcp",
      MESHRIX_PUBLIC_FAULT_URL: "https://meshrix.invalid/fault",
      MESHRIX_CAPACITY_REQUESTS: "20",
    };
    const accepted: any = spawnSync(process.execPath, [script], {
      cwd: repoRoot,
      env: {
        ...commonEnv,
        MESHRIX_EXPECTED_CERT_SHA256: `sha256:${"a".repeat(64)}`,
      },
      encoding: "utf8",
    });
    expect(accepted.status).toBe(0);

    const rejected: any = spawnSync(process.execPath, [script], {
      cwd: repoRoot,
      env: {
        ...commonEnv,
        MESHRIX_EXPECTED_CERT_SHA256: "a".repeat(64),
      },
      encoding: "utf8",
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(
      "real_machine_workflow_certificate_digest_invalid",
    );
  });

  it("provides a complete repository-controlled command manifest for every target", async () : Promise<any> => {
    expect(Object.keys(REAL_MACHINE_TARGET_COMMAND_MANIFESTS)).toEqual([
      "native-linux-x64",
      "native-linux-arm64",
      "native-macos-arm64",
      "native-windows-x64",
      "public-cloud-single-node",
      "clean-host-recovery",
    ]);
    for (const [target, relativePath] of (Object.entries(
      REAL_MACHINE_TARGET_COMMAND_MANIFESTS,
    ) as [string, any][])) {
      const manifest: any = JSON.parse(await fs.readFile(
        path.resolve(relativePath),
        "utf8",
      ));
      expect(Object.keys(manifest)).toEqual(REAL_MACHINE_OPERATIONAL_PHASES);
      for (const phase of REAL_MACHINE_OPERATIONAL_PHASES) {
        expect(manifest[phase]).toMatchObject({
          executable: "node",
          args: [
            "tools/server-scripts/real-machine-target-phase.ts",
            phase,
            target,
          ],
        });
      }
    }
  });

  it("fails closed before a target phase when exact candidate inputs are absent", () : any => {
    const result: any = spawnSync(process.execPath, [
      "tools/server-scripts/real-machine-target-phase.ts",
      "prepare",
      "native-linux-x64",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH || "",
        MESHRIX_REAL_MACHINE_TARGET: "native-linux-x64",
        MESHRIX_REAL_MACHINE_PLATFORM: "linux",
        MESHRIX_REAL_MACHINE_ARCHITECTURE: "x64",
        MESHRIX_REAL_MACHINE_CANDIDATE_DIGEST: CANDIDATE,
        MESHRIX_REAL_MACHINE_SOURCE_REVISION: SOURCE_REVISION,
        MESHRIX_REAL_MACHINE_RUN_ID: "run-001",
        MESHRIX_REAL_MACHINE_ENVIRONMENT_ID: "linux-fixture",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "real_machine_candidate_image_mismatch",
    );
  });

  it("keeps every target probe repository-owned and executable from the driver", async () : Promise<any> => {
    const source: any = await fs.readFile(
      "tools/server-scripts/real-machine-target-phase.ts",
      "utf8",
    );
    for (const forbiddenExternalProbe of [
      "MESHRIX_REAL_MACHINE_PORTABLE_PROBE",
      "MESHRIX_REAL_MACHINE_PUBLIC_CLOUD_PROBE",
      "MESHRIX_REAL_MACHINE_CLEAN_HOST_RESTORE_PROBE",
    ]) {
      expect(source).not.toContain(forbiddenExternalProbe);
    }
    for (const requiredBuiltIn of [
      "verify-mcp-final-release-asset.ts",
      "verify-mcp-windows-process-identity-credential-store.ts",
      "verify-npm-package-installability.ts",
      "restoreStorageBackup",
      "publicCloudProbe",
      "docker",
      "candidateEntryExecuted",
      "stoppedGracefully",
    ]) {
      expect(source).toContain(requiredBuiltIn);
    }
  });

  it("runs a portable candidate through prepare, start, stop, and cleanup", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-portable-life-"));
    const sourceRoot: any = path.join(root, "source", "fixture");
    const artifact: any = path.join(root, "candidate.tar.gz");
    const targetRoot: any = path.join(root, "target");
    await fs.mkdir(sourceRoot, { recursive: true });
    const entry: any = path.join(sourceRoot, "meshrix-mcp");
    await fs.writeFile(entry, [
      "#!/usr/bin/env sh",
      "if [ \"$1\" = \"version\" ] && [ \"$2\" = \"--json\" ]; then",
      "  printf '%s\\n' '{\"packageName\":\"fixture\",\"packageVersion\":\"1.0.0\"}'",
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"), { mode: 0o700 });
    expect(spawnSync("tar", [
      "-czf",
      artifact,
      "-C",
      path.join(root, "source"),
      "fixture",
    ]).status).toBe(0);
    const digest: any = `sha256:${crypto.createHash("sha256")
      .update(await fs.readFile(artifact))
      .digest("hex")}`;
    const env: Record<string, any> = {
      ...process.env,
      MESHRIX_REAL_MACHINE_TARGET: "native-macos-arm64",
      MESHRIX_REAL_MACHINE_PLATFORM: "darwin",
      MESHRIX_REAL_MACHINE_ARCHITECTURE: "arm64",
      MESHRIX_REAL_MACHINE_CANDIDATE_DIGEST: digest,
      MESHRIX_REAL_MACHINE_SOURCE_REVISION: SOURCE_REVISION,
      MESHRIX_REAL_MACHINE_CANDIDATE_ARTIFACT: artifact,
      MESHRIX_REAL_MACHINE_RUN_ID: "portable-life",
      MESHRIX_REAL_MACHINE_ENVIRONMENT_ID: "portable-fixture",
      MESHRIX_REAL_MACHINE_TARGET_ROOT: targetRoot,
    };
    const invoke: any = (phase?: any) : any => spawnSync(process.execPath, [
      "tools/server-scripts/real-machine-target-phase.ts",
      phase,
      "native-macos-arm64",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
      timeout: 70_000,
    });
    try {
      for (const phase of ["prepare", "start", "stop", "cleanup"]) {
        const result: any = invoke(phase);
        expect(result.status, `${phase}: ${result.stderr}`).toBe(0);
      }
      await expect(fs.access(path.join(
        targetRoot,
        "native-macos-arm64-portable-life",
      ))).rejects.toThrow();
      expect(invoke("cleanup").status).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  it("requires an accepted functional report bound to the candidate", async () : Promise<any> => {
    const fx: any = await fixture();
    try {
      await expect(validateFunctionalPlatformAcceptanceReport(
        fx.functionalReportPath,
        {
          candidateDigest: CANDIDATE,
          currentSourceRevision: SOURCE_REVISION,
        },
      )).resolves.toMatchObject({
        reportDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      });
      const report: any = JSON.parse(await fs.readFile(fx.functionalReportPath, "utf8"));
      report.summary.releaseReady = false;
      await fs.writeFile(fx.functionalReportPath, JSON.stringify(report));
      await expect(validateFunctionalPlatformAcceptanceReport(
        fx.functionalReportPath,
        {
          candidateDigest: CANDIDATE,
          currentSourceRevision: SOURCE_REVISION,
        },
      )).rejects.toThrow("real_machine_functional_acceptance_required");

      report.summary.releaseReady = true;
      report.sourceRevision = "2".repeat(40);
      await fs.writeFile(fx.functionalReportPath, JSON.stringify(report));
      await expect(validateFunctionalPlatformAcceptanceReport(
        fx.functionalReportPath,
        {
          candidateDigest: CANDIDATE,
          currentSourceRevision: SOURCE_REVISION,
        },
      )).rejects.toThrow("real_machine_functional_source_revision_mismatch");

    } finally {
      await fx.close();
    }
  });

  it("rejects target, architecture, and runtime mismatches", () : any => {
    expect(() : any => validateRealMachineTarget({
      target: "native-linux-arm64",
      architecture: "x64",
      runtimePlatform: "linux",
      runtimeArchitecture: "x64",
    })).toThrow("real_machine_architecture_invalid");
    expect(() : any => validateRealMachineTarget({
      target: "native-linux-x64",
      architecture: "x64",
      runtimePlatform: "darwin",
      runtimeArchitecture: "x64",
    })).toThrow("real_machine_runtime_platform_mismatch");
    expect(validateRealMachineTarget({
      target: "native-macos-arm64",
      architecture: "arm64",
      runtimePlatform: "darwin",
      runtimeArchitecture: "arm64",
    })).toEqual({
      target: "native-macos-arm64",
      platform: "darwin",
      architecture: "arm64",
    });
    expect(validateRealMachineTarget({
      target: "native-windows-x64",
      architecture: "x64",
      runtimePlatform: "win32",
      runtimeArchitecture: "x64",
    })).toEqual({
      target: "native-windows-x64",
      platform: "win32",
      architecture: "x64",
    });
  });

  it("runs every phase, atomically persists receipts, and reduces offline", async () : Promise<any> => {
    const fx: any = await fixture();
    const calls: any[] = [];
    const runner: any = async ({ phase }: Record<string, any>) : Promise<any> => {
      calls.push(phase);
      return {
        exitCode: 0,
        durationMs: 3,
        checks: { phasePassed: true },
      };
    };
    try {
      const workflow: any = createRealMachineValidationWorkflow(
        workflowOptions(fx, runner),
      );
      const completed: any = await workflow.run();
      expect(calls).toEqual(REAL_MACHINE_OPERATIONAL_PHASES);
      expect(completed.receipt).toMatchObject({
        acceptanceStandard: "real-machine-validation",
        claim: "real-machine-verified",
        status: "accepted",
        target: "native-linux-x64",
        architecture: "x64",
        candidateDigest: CANDIDATE,
        functionalCompletenessRequired: true,
        optionalForFunctionalRelease: true,
        privacySafe: true,
        reportLeakScan: true,
      });
      expect(completed.receipt).not.toHaveProperty("runId");
      expect(completed.receipt).not.toHaveProperty("environmentId");

      const offlineWorkflow: any = createRealMachineValidationWorkflow(
        workflowOptions(fx, async () : Promise<any> => {
          throw new Error("reduce must not execute a command");
        }),
      );
      const repeated: any = await offlineWorkflow.reduce();
      expect(repeated.idempotent).toBe(true);
      expect(calls).toEqual(REAL_MACHINE_OPERATIONAL_PHASES);
      const state: any = JSON.parse(await fs.readFile(
        path.join(fx.stateRoot, "run-001", "state.json"),
        "utf8",
      ));
      expect(state.phases.reduce.status).toBe("passed");
    } finally {
      await fx.close();
    }
  });

  it("makes stop and cleanup idempotent without rerunning commands", async () : Promise<any> => {
    const fx: any = await fixture();
    const calls: any[] = [];
    const workflow: any = createRealMachineValidationWorkflow(workflowOptions(
      fx,
      async ({ phase }: Record<string, any>) : Promise<any> => {
        calls.push(phase);
        return { exitCode: 0, checks: { ok: true } };
      },
    ));
    try {
      await workflow.prepare();
      await workflow.start();
      await workflow.verify();
      await workflow.stop();
      await workflow.stop();
      await workflow.cleanup();
      await workflow.cleanup();
      expect(calls.filter((phase?: any) : any => phase === "stop")).toHaveLength(1);
      expect(calls.filter((phase?: any) : any => phase === "cleanup")).toHaveLength(1);
    } finally {
      await fx.close();
    }
  });

  it.each([
    ["candidateDigest", `sha256:${"b".repeat(64)}`],
    ["functionalAcceptanceDigest", `sha256:${"c".repeat(64)}`],
    ["sourceRevision", "3".repeat(40)],
  ])("rejects replacement of the bound %s during offline reduction", async (
    field?: any,
    replacement?: any,
  ) : Promise<any> => {
    const fx: any = await fixture();
    const workflow: any = createRealMachineValidationWorkflow(workflowOptions(
      fx,
      async () : Promise<any> => ({ exitCode: 0, checks: { accepted: true } }),
    ));
    try {
      for (const phase of REAL_MACHINE_OPERATIONAL_PHASES) {
        await workflow.execute(phase);
      }
      const statePath: any = path.join(fx.stateRoot, "run-001", "state.json");
      const state: any = JSON.parse(await fs.readFile(statePath, "utf8"));
      state[field] = replacement;
      await fs.writeFile(statePath, JSON.stringify(state));
      await expect(workflow.reduce()).rejects.toThrow(
        "real_machine_phase_receipt_invalid",
      );
    } finally {
      await fx.close();
    }
  });

  it("fences concurrent mutation with one run lock", async () : Promise<any> => {
    const fx: any = await fixture();
    let release: any;
    const held: any = new Promise((resolve?: any) : any => {
      release = resolve;
    });
    let entered: any;
    const started: any = new Promise((resolve?: any) : any => {
      entered = resolve;
    });
    const first: any = createRealMachineValidationWorkflow(workflowOptions(
      fx,
      async () : Promise<any> => {
        entered();
        await held;
        return { exitCode: 0, checks: { prepared: true } };
      },
    ));
    const second: any = createRealMachineValidationWorkflow(workflowOptions(
      fx,
      async () : Promise<any> => ({ exitCode: 0, checks: { prepared: true } }),
    ));
    try {
      const firstRun: any = first.prepare();
      await started;
      await expect(second.prepare()).rejects.toThrow(
        "real_machine_run_lock_held",
      );
      release();
      await firstRun;
    } finally {
      release?.();
      await fx.close();
    }
  });

  it("attempts idempotent teardown after a failed verification", async () : Promise<any> => {
    const fx: any = await fixture();
    const calls: any[] = [];
    const workflow: any = createRealMachineValidationWorkflow(workflowOptions(
      fx,
      async ({ phase }: Record<string, any>) : Promise<any> => {
        calls.push(phase);
        return {
          exitCode: phase === "verify" ? 7 : 0,
          checks: { bounded: phase !== "verify" },
        };
      },
    ));
    try {
      await expect(workflow.run()).rejects.toThrow(
        "real_machine_verify_failed",
      );
      expect(calls).toEqual(["prepare", "start", "verify", "stop", "cleanup"]);
      await expect(workflow.reduce()).rejects.toThrow(
        "real_machine_reduction_phase_missing",
      );
    } finally {
      await fx.close();
    }
  });

  it("attempts stop after a start command reports failure", async () : Promise<any> => {
    const fx: any = await fixture();
    const calls: any[] = [];
    const workflow: any = createRealMachineValidationWorkflow(workflowOptions(
      fx,
      async ({ phase }: Record<string, any>) : Promise<any> => {
        calls.push(phase);
        return {
          exitCode: phase === "start" ? 9 : 0,
          checks: { bounded: phase !== "start" },
        };
      },
    ));
    try {
      await expect(workflow.run()).rejects.toThrow("real_machine_start_failed");
      expect(calls).toEqual(["prepare", "start", "stop", "cleanup"]);
    } finally {
      await fx.close();
    }
  });

  it("passes only the bounded validation context to process commands", async () : Promise<any> => {
    const runner: any = createProcessCommandRunner({
      commands: {
        verify: {
          executable: process.execPath,
          args: [
            "-e",
            [
              "const required=['TARGET','PLATFORM','ARCHITECTURE','CANDIDATE_DIGEST','SOURCE_REVISION','RUN_ID','ENVIRONMENT_ID'];",
              "for (const key of required) if (!process.env[`MESHRIX_REAL_MACHINE_${key}`]) process.exit(9);",
            ].join(""),
          ],
        },
      },
    });
    await expect(runner({
      phase: "verify",
      context: {
        target: "native-windows-x64",
        platform: "win32",
        architecture: "x64",
        candidateDigest: CANDIDATE,
        sourceRevision: SOURCE_REVISION,
        runId: "run-001",
        environmentId: "windows-fixture",
      },
    })).resolves.toMatchObject({
      exitCode: 0,
    });
  });
});
