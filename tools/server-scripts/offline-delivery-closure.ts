#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeSensitiveReport,
} from "./lib/sensitive-report-scan.ts";
import { writePrivateFileAtomic } from "../../packages/foundation/src/storage/private-file-atomic.ts";
import {
  produceOfflineDeliveryBundle,
} from "./offline-delivery-producer.ts";
import {
  buildDisconnectedLifecyclePlan,
  executeDisconnectedLifecycle,
  transferAndVerifyOfflineDeliveryBundle,
} from "./offline-delivery-disconnected-verifier.ts";
import {
  OFFLINE_DELIVERY_BUNDLE_SCHEMA,
  OFFLINE_DELIVERY_CLOSURE_REPORT_RELATIVE_PATH,
  OFFLINE_DELIVERY_CLOSURE_REPORT_SCHEMA,
  OFFLINE_DELIVERY_CLOSURE_VERIFIER,
  OFFLINE_DELIVERY_DISCONNECTED_VERIFIER,
  OFFLINE_DELIVERY_EXIT,
  OFFLINE_DELIVERY_FIRST_GOVERNED_CALL,
  OFFLINE_DELIVERY_FOCUSED_SUITE,
  OFFLINE_DELIVERY_INSTRUCTIONS_RELATIVE_PATH,
  OFFLINE_DELIVERY_PLATFORMS,
  OFFLINE_DELIVERY_PRODUCER,
  OFFLINE_DELIVERY_SHARED,
  OFFLINE_DELIVERY_VM_TARGET,
  assertOfflineDeliveryVerdictHonest,
  classifyOfflineDeliveryEnvironment,
  failOfflineDelivery,
  isRecord,
  probeContainerEngineAvailability,
} from "./offline-delivery-shared.ts";
import {
  createLinuxVmLifecycleRunner,
  prepareOperatorSecretCustody,
  probeOfflineDeliveryVmEnvironment,
  resolveOfflineDeliveryVmMaterials,
} from "./offline-delivery-vm-target.ts";

const VITEST_RUNNER: any = "./node_modules/vitest/vitest.mjs";
const SOURCE_FILES: readonly any[] = Object.freeze([
  OFFLINE_DELIVERY_CLOSURE_VERIFIER,
  OFFLINE_DELIVERY_PRODUCER,
  OFFLINE_DELIVERY_DISCONNECTED_VERIFIER,
  OFFLINE_DELIVERY_SHARED,
  OFFLINE_DELIVERY_VM_TARGET,
  OFFLINE_DELIVERY_INSTRUCTIONS_RELATIVE_PATH,
]);

function repoRootFromMeta() : any {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

function runFocusedSuite(repoRoot?: any) : any {
  const result: any = spawnSync(process.execPath, [
    "--conditions=source",
    VITEST_RUNNER,
    "run",
    "--config",
    "vitest.config.ts",
    OFFLINE_DELIVERY_FOCUSED_SUITE,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_OPTIONS: "--conditions=source",
    },
  });
  return {
    suite: OFFLINE_DELIVERY_FOCUSED_SUITE,
    passed: result.status === 0,
    exitCode: result.status,
    outputBytes: Buffer.byteLength(`${result.stdout || ""}${result.stderr || ""}`, "utf8"),
  };
}

function publicBundleIdentity(bundle?: any) : any {
  return Object.freeze({
    schemaVersion: OFFLINE_DELIVERY_BUNDLE_SCHEMA,
    candidateDigest: bundle.candidate_digest,
    imageDigest: bundle.image_digest,
    inventoryDigest: bundle.inventory_digest,
    platforms: Object.freeze([...OFFLINE_DELIVERY_PLATFORMS]),
    signatureAlgorithm: bundle.signature?.algorithm,
    signaturePurpose: bundle.signature?.purpose,
    composePullPolicy: bundle.compose?.pull_policy,
    composeBuildAllowed: false,
  });
}

export function buildOfflineDeliveryClosureReport({
  produced,
  transferred,
  environment,
  lifecycle,
  extras = {},
}: Record<string, any> = {}) : any {
  const blocked: any = environment?.blocked === true;
  const lifecycleCompleted: any = lifecycle?.completed === true;
  const acceptanceMet: any = blocked !== true
    && produced?.contractFixtureUsed !== true
    && transferred?.exactBytesVerified === true
    && lifecycleCompleted === true;
  const verdict: any = extras.failed === true
    ? "failed"
    : acceptanceMet
      ? "accepted"
      : blocked
        ? "blocked_by_environment"
        : "failed";
  const report: Record<string, any> = {
    schemaVersion: OFFLINE_DELIVERY_CLOSURE_REPORT_SCHEMA,
    reportKind: "offline-delivery-closure",
    verifier: OFFLINE_DELIVERY_CLOSURE_VERIFIER,
    generatedAt: extras.generatedAt || "1970-01-01T00:00:00.000Z",
    finishedAt: extras.finishedAt || extras.generatedAt || "1970-01-01T00:00:00.000Z",
    node: "EFF-10",
    verdict,
    environmentBlockReason: blocked ? environment.reason : null,
    bundle: publicBundleIdentity(produced.bundle),
    instructions: produced.instructions,
    environment: Object.freeze({
      linuxHost: environment.linuxHost === true,
      linuxVmTargetAvailable: environment.linuxVmTargetAvailable === true,
      blocked: blocked,
      reason: blocked ? environment.reason : null,
      reasons: Object.freeze([...(environment.reasons || [])]),
    }),
    summary: {
      producerContractVerified: true,
      exactBytesVerified: transferred?.exactBytesVerified === true,
      copiedFileCount: Number(transferred?.copiedFileCount || 0),
      platforms: [...OFFLINE_DELIVERY_PLATFORMS],
      hasInventory: produced.hasInventory === true,
      hasSbom: produced.hasSbom === true,
      hasProvenance: produced.hasProvenance === true,
      hasSignatures: produced.hasSignatures === true,
      hasInstructions: produced.hasInstructions === true,
      contractFixtureUsed: produced.contractFixtureUsed === true,
      imported: lifecycle?.imported === true,
      started: lifecycle?.started === true,
      firstGovernedCall: lifecycle?.firstGovernedCall === true,
      firstGovernedCallOperation: OFFLINE_DELIVERY_FIRST_GOVERNED_CALL.operation,
      stopped: lifecycle?.stopped === true,
      cleanedUp: lifecycle?.cleanedUp === true,
      networkUsed: false,
      rebuilt: false,
      disconnectedTargetRan: lifecycleCompleted === true,
      blockedByEnvironment: blocked,
      environmentBlockReason: blocked ? environment.reason : null,
      acceptanceMet,
      capacityCertified: false,
      publicationClaimed: false,
      nativeLinuxSupportClaimed: false,
      focusedSuitePassed: extras.focusedSuitePassed === true,
    },
  };
  assertOfflineDeliveryVerdictHonest(report);
  return report;
}

export async function runOfflineDeliveryClosure({
  repoRoot = repoRootFromMeta(),
  writeReport = true,
  runFocusedTests = false,
  materials,
  commandRunner,
  deployToLinuxVm = false,
  generatedAt = new Date().toISOString(),
}: Record<string, any> = {}) : Promise<any> {
  const engines: any = probeContainerEngineAvailability();
  const vmEnvironment: any = deployToLinuxVm === true
    ? probeOfflineDeliveryVmEnvironment()
    : { linuxVmTargetAvailable: false, dualArchBuilderAvailable: false };
  const ownedRoots: any[] = [];
  const custodyRoot: any = deployToLinuxVm === true
    ? path.join(os.homedir(), ".cache", "meshrix-js", "offline-vm-custody")
    : await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-delivery-custody-"));
  if (deployToLinuxVm === true) {
    await fs.rm(custodyRoot, { recursive: true, force: true });
    await fs.mkdir(custodyRoot, { recursive: true, mode: 0o700 });
  }
  ownedRoots.push(custodyRoot);
  const custody: any = prepareOperatorSecretCustody({ custodyRoot });
  if (isRecord(custody.files)) {
    for (const [filePath, contents] of Object.entries(custody.files)) {
      await fs.writeFile(String(filePath), String(contents), { mode: 0o600 });
    }
  }
  try {
    const sourceRoot: any = await fs.mkdtemp(
      path.join(os.tmpdir(), "meshrix-offline-delivery-source-"),
    );
    const targetRoot: any = await fs.mkdtemp(
      path.join(os.tmpdir(), "meshrix-offline-delivery-target-"),
    );
    const ociRoot: any = await fs.mkdtemp(
      path.join(os.tmpdir(), "meshrix-offline-delivery-oci-"),
    );
    ownedRoots.push(sourceRoot, targetRoot, ociRoot);
    await fs.rm(targetRoot, { recursive: true, force: true });

    let resolvedMaterials: any = materials;
    if (!resolvedMaterials && deployToLinuxVm === true) {
      resolvedMaterials = await resolveOfflineDeliveryVmMaterials({
        repoRoot,
        ociLayoutOutput: ociRoot,
      });
    }
    const environment: any = classifyOfflineDeliveryEnvironment({
      platform: process.platform,
      ...(deployToLinuxVm === true
        ? {
          linuxVmTargetAvailable: vmEnvironment.linuxVmTargetAvailable === true,
          dualArchBuilderAvailable: vmEnvironment.dualArchBuilderAvailable === true
            || Boolean(resolvedMaterials),
        }
        : {}),
      candidateLayoutConfigured: Boolean(resolvedMaterials),
      importerAvailable: engines.importerAvailable,
      engineAvailable: engines.engineAvailable,
      secretCustodyConfigured: custody.configured === true,
    });

    const produced: any = await produceOfflineDeliveryBundle({
      outputRoot: sourceRoot,
      materials: resolvedMaterials,
      allowContractFixture: resolvedMaterials ? false : true,
    });
    const transferred: any = await transferAndVerifyOfflineDeliveryBundle({
      sourceRoot,
      targetRoot,
      trustedPublicKeys: produced.trustedPublicKeys,
    });
    const plan: any = buildDisconnectedLifecyclePlan(transferred.bundle);
    let lifecycle: Record<string, any> = {
      completed: false,
      imported: false,
      started: false,
      firstGovernedCall: false,
      stopped: false,
      cleanedUp: false,
    };
    const resolvedRunner: any = typeof commandRunner === "function"
      ? commandRunner
      : deployToLinuxVm === true && environment.blocked !== true
        ? createLinuxVmLifecycleRunner({
          targetRoot,
          custodyEnv: custody.env,
        })
        : null;
    if (environment.blocked !== true && typeof resolvedRunner === "function") {
      const outcomes: any = await executeDisconnectedLifecycle({
        plan,
        commandRunner: resolvedRunner,
        networkAllowed: false,
      });
      const passed: any = new Set<any>(outcomes.map((entry?: any) : any => entry.id));
      lifecycle = {
        completed: passed.size === plan.steps.length,
        imported: passed.has("import"),
        started: passed.has("start"),
        firstGovernedCall: passed.has("first_governed_call"),
        stopped: passed.has("stop"),
        cleanedUp: passed.has("cleanup"),
      };
    }

    let focusedSuite: any = {
      suite: OFFLINE_DELIVERY_FOCUSED_SUITE,
      passed: runFocusedTests !== true,
      exitCode: 0,
      outputBytes: 0,
    };
    if (runFocusedTests === true) {
      focusedSuite = runFocusedSuite(repoRoot);
      if (focusedSuite.passed !== true) {
        failOfflineDelivery(
          "offline_delivery_focused_suite_failed",
          `Focused suite failed: ${OFFLINE_DELIVERY_FOCUSED_SUITE}`,
        );
      }
    }

    const finishedAt: any = new Date().toISOString();
    const report: any = buildOfflineDeliveryClosureReport({
      produced,
      transferred,
      environment,
      lifecycle,
      extras: {
        generatedAt,
        finishedAt,
        focusedSuitePassed: focusedSuite.passed === true,
      },
    });
    const provenance: Record<string, any> = {
      producer: "meshrix-core-offline-delivery-closure",
      commandId: "offline-delivery-closure",
      sourceRevision: await computeVerifierSourceRevision(repoRoot, SOURCE_FILES),
    };
    const finalized: any = finalizeSensitiveReport(report, { provenance });
    assertNoSensitiveReportLeak(finalized, "offline delivery closure report");
    assertReportProvenance(finalized, provenance);
    assertOfflineDeliveryVerdictHonest(finalized);

    if (writeReport === true) {
      const relativePath: any = OFFLINE_DELIVERY_CLOSURE_REPORT_RELATIVE_PATH;
      await writePrivateFileAtomic(
        path.join(repoRoot, relativePath),
        `${JSON.stringify(finalized, null, 2)}\n`,
      );
    }

    return Object.freeze({
      report: finalized,
      reportPath: OFFLINE_DELIVERY_CLOSURE_REPORT_RELATIVE_PATH,
      exitCode: OFFLINE_DELIVERY_EXIT[finalized.verdict],
      disconnectedTargetRan: finalized.summary.disconnectedTargetRan === true,
    });
  } finally {
    await Promise.all(
      ownedRoots.map((root?: any) : any => fs.rm(root, { recursive: true, force: true })),
    );
  }
}

const invokedDirectly: any = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  (async () : Promise<any> => {
    const result: any = await runOfflineDeliveryClosure({
      writeReport: true,
      runFocusedTests: true,
      deployToLinuxVm: true,
    });
    process.stdout.write(`${JSON.stringify({
      ok: result.report.summary.acceptanceMet === true,
      verdict: result.report.verdict,
      environmentBlockReason: result.report.environmentBlockReason,
      reportPath: result.reportPath,
      disconnectedTargetRan: result.disconnectedTargetRan,
      acceptanceMet: result.report.summary.acceptanceMet,
      capacityCertified: false,
      publicationClaimed: false,
      nativeLinuxSupportClaimed: false,
    })}\n`);
    process.exitCode = result.exitCode;
  })().catch((error?: any) : any => {
    const code: any = error?.code || "offline_delivery_closure_failed";
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
    process.exitCode = OFFLINE_DELIVERY_EXIT.failed;
  });
}
