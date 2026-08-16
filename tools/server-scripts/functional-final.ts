#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePrivateFileAtomic } from "../../packages/foundation/src/storage/private-file-atomic.ts";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeSensitiveReport,
  reportPayloadDigest,
} from "./lib/sensitive-report-scan.ts";

export const FUNCTIONAL_FINAL_VERIFIER: any = "tools/server-scripts/functional-final.ts";
export const FUNCTIONAL_FINAL_REPORT_RELATIVE_PATH: any = "build/reports/functional-final.json";
export const FUNCTIONAL_FINAL_REPORT_SCHEMA: any = "v0.0.1:meshrix:functional-final-receipt-1";
export const FUNCTIONAL_FINAL_FOCUSED_SUITE: any = "tests/vitest/server/functional-acceptance-receipt.test.ts";
export const FUNCTIONAL_FINAL_PROFILE: any = "enterprise-single-node";
export const FUNCTIONAL_FINAL_NODE: any = "EFF-FINAL";
export const FUNCTIONAL_FINAL_PREFERRED_VM_FAMILY: any = "ubuntu";
export const FUNCTIONAL_FINAL_VM_FAMILIES: readonly any[] = Object.freeze(["ubuntu", "debian"]);
export const FUNCTIONAL_FINAL_EVIDENCE_PATHS: Readonly<Record<string, any>> = Object.freeze({
  efficiency: "build/reports/agent-service-efficiency-profile.json",
  pluginIsolation: "build/reports/plugin-console-isolation.json",
  enterpriseOperations: "build/reports/enterprise-operations-closure.json",
  offlineDelivery: "build/reports/offline-delivery-closure.json",
});
export const FUNCTIONAL_FINAL_EXIT: Readonly<Record<string, any>> = Object.freeze({
  accepted: 0,
  failed: 1,
  blocked_by_environment: 2,
});

const VITEST_RUNNER: any = "./node_modules/vitest/vitest.mjs";
const SOURCE_FILES: readonly any[] = Object.freeze([
  FUNCTIONAL_FINAL_VERIFIER,
  FUNCTIONAL_FINAL_FOCUSED_SUITE,
]);

function repoRootFromMeta() : any {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

export function failFunctionalFinal(code?: any, message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  throw error;
}

function isRecord(value?: any) : any {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function digestMatches(report?: any) : any {
  return isRecord(report)
    && typeof report.payloadDigest === "string"
    && report.payloadDigest === reportPayloadDigest(report);
}

export function acceptedLinuxVmFamily(value?: any) : any {
  const family: any = String(value || "").trim().toLowerCase();
  return FUNCTIONAL_FINAL_VM_FAMILIES.includes(family) ? family : "";
}

export function probeLinuxVmFamily({
  image = "local.example/meshrix-js/runtime-ui:offline-arm64",
  commandRunner,
}: Record<string, any> = {}) : any {
  const runner: any = typeof commandRunner === "function"
    ? commandRunner
    : (args?: any) : any => spawnSync("docker", args.map(String), {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const result: any = runner([
    "run",
    "--rm",
    "--network",
    "none",
    "--entrypoint",
    "cat",
    image,
    "/etc/os-release",
  ]);
  const text: any = String(result?.stdout || "");
  const family: any = acceptedLinuxVmFamily((text.match(/^ID="?([^"\n]+)"?/mu) || [])[1]);
  return Object.freeze({
    available: result?.status === 0 && Boolean(family),
    family,
    preferredFamily: FUNCTIONAL_FINAL_PREFERRED_VM_FAMILY,
    versionId: (text.match(/^VERSION_ID="?([^"\n]+)"?/mu) || [])[1] || "",
  });
}

export function inspectFunctionalFinalEvidence(reports: Record<string, any> = {}) : any {
  const efficiency: any = reports.efficiency;
  const plugin: any = reports.pluginIsolation;
  const operations: any = reports.enterpriseOperations;
  const offline: any = reports.offlineDelivery;
  if (!isRecord(efficiency) || !isRecord(plugin) || !isRecord(operations) || !isRecord(offline)) {
    failFunctionalFinal(
      "functional_final_evidence_missing",
      "Functional final requires the exact current evidence set.",
    );
  }
  if (!digestMatches(efficiency) || !digestMatches(plugin) || !digestMatches(operations) || !digestMatches(offline)) {
    failFunctionalFinal(
      "functional_final_evidence_substituted",
      "Functional final rejected a substituted or rebuilt evidence report.",
    );
  }

  const efficiencyOk: any = efficiency.summary?.completenessPassed === true
    && efficiency.summary?.privacyPassed === true
    && efficiency.summary?.safetyPassed === true
    && efficiency.summary?.recoveryPassed === true
    && efficiency.summary?.warmThresholdsPassed === true
    && efficiency.summary?.ownerProfile === FUNCTIONAL_FINAL_PROFILE;
  if (efficiencyOk !== true) {
    failFunctionalFinal(
      "functional_final_efficiency_failed",
      "Named efficiency evidence is not current.",
    );
  }

  if (plugin.summary?.acceptancePassed !== true) {
    failFunctionalFinal(
      "functional_final_plugin_failed",
      "Plugin Console isolation evidence is not current.",
    );
  }

  if (
    operations.summary?.scenarioAccepted !== true
    || operations.summary?.environmentSupportClaimed === true
    || operations.summary?.productionReady === true
    || operations.environmentSupportClaimed === true
    || operations.productionReady === true
  ) {
    failFunctionalFinal(
      "functional_final_operations_failed",
      "Enterprise operations evidence is not current or inflates claims.",
    );
  }

  if (offline.summary?.contractFixtureUsed === true || offline.bundle?.contractFixtureUsed === true) {
    failFunctionalFinal(
      "functional_final_offline_fixture_used",
      "Contract-fixture offline bytes cannot close functional final.",
    );
  }
  if (
    offline.verdict !== "accepted"
    || offline.summary?.acceptanceMet !== true
    || offline.summary?.rebuilt === true
    || offline.summary?.nativeLinuxSupportClaimed === true
    || offline.summary?.publicationClaimed === true
    || offline.environment?.linuxVmTargetAvailable !== true
    || offline.environment?.linuxHost === true && offline.summary?.nativeLinuxSupportClaimed === true
  ) {
    failFunctionalFinal(
      "functional_final_offline_failed",
      "Offline Linux VM evidence is not current.",
    );
  }

  return Object.freeze({
    efficiency: Object.freeze({
      path: FUNCTIONAL_FINAL_EVIDENCE_PATHS.efficiency,
      schemaVersion: efficiency.schemaVersion,
      payloadDigest: efficiency.payloadDigest,
      namedProfileCapacityCertified: efficiency.summary?.capacityCertified === true,
    }),
    pluginIsolation: Object.freeze({
      path: FUNCTIONAL_FINAL_EVIDENCE_PATHS.pluginIsolation,
      schemaVersion: plugin.schemaVersion,
      payloadDigest: plugin.payloadDigest,
      acceptancePassed: true,
    }),
    enterpriseOperations: Object.freeze({
      path: FUNCTIONAL_FINAL_EVIDENCE_PATHS.enterpriseOperations,
      schemaVersion: operations.schemaVersion,
      payloadDigest: operations.payloadDigest,
      scenarioAccepted: true,
    }),
    offlineDelivery: Object.freeze({
      path: FUNCTIONAL_FINAL_EVIDENCE_PATHS.offlineDelivery,
      schemaVersion: offline.schemaVersion,
      payloadDigest: offline.payloadDigest,
      acceptanceMet: true,
      linuxVmTargetAvailable: true,
      contractFixtureUsed: false,
    }),
  });
}

export function reduceFunctionalFinal({
  reports = {},
  environment = {},
  extras = {},
}: Record<string, any> = {}) : any {
  const evidence: any = inspectFunctionalFinalEvidence(reports);
  const linuxVmTargetAvailable: any = environment.linuxVmTargetAvailable === true
    || reports.offlineDelivery?.environment?.linuxVmTargetAvailable === true;
  const linuxVmFamily: any = acceptedLinuxVmFamily(
    environment.linuxVmFamily || environment.family || environment.debianFamily,
  );
  const linuxVmFamilyAccepted: any = Boolean(linuxVmFamily);
  if (linuxVmTargetAvailable !== true) {
    failFunctionalFinal(
      "functional_final_linux_vm_unavailable",
      "Functional final requires a reachable Linux virtual machine.",
    );
  }
  if (linuxVmFamilyAccepted !== true) {
    failFunctionalFinal(
      "functional_final_linux_vm_family_unsupported",
      "Functional final accepts Ubuntu or Debian inside the Linux VM; Ubuntu is preferred.",
    );
  }
  if (
    extras.publicationClaimed === true
    || extras.productionReady === true
    || extras.environmentSupportClaimed === true
    || extras.nativeLinuxSupportClaimed === true
    || extras.debianSupportClaimed === true
    || extras.ubuntuSupportClaimed === true
    || extras.projectLevelFunctionalAcceptance === true
    || extras.capacityCertified === true
  ) {
    failFunctionalFinal(
      "functional_final_claim_inflation",
      "Functional final cannot create publication, production-readiness, or support claims.",
    );
  }

  const acceptanceMet: any = extras.failed !== true
    && extras.focusedSuitePassed !== false
    && linuxVmTargetAvailable === true;
  return Object.freeze({
    schemaVersion: FUNCTIONAL_FINAL_REPORT_SCHEMA,
    reportKind: "functional-final",
    verifier: FUNCTIONAL_FINAL_VERIFIER,
    node: FUNCTIONAL_FINAL_NODE,
    profile: FUNCTIONAL_FINAL_PROFILE,
    verdict: acceptanceMet ? "accepted" : "failed",
    environment: Object.freeze({
      operatorPlatform: environment.operatorPlatform || "darwin",
      linuxHost: environment.linuxHost === true,
      linuxVmTargetAvailable,
      linuxVmFamily,
      linuxVmFamilyAccepted,
      preferredLinuxVmFamily: FUNCTIONAL_FINAL_PREFERRED_VM_FAMILY,
      nativeLinuxHostRequired: false,
    }),
    evidence,
    claims: Object.freeze({
      planCandidateAccepted: acceptanceMet === true,
      projectLevelFunctionalAcceptance: false,
      publication: false,
      productionReady: false,
      environmentSupport: false,
      nativeLinuxSupport: false,
      ubuntuSupport: false,
      debianSupport: false,
      capacityCertified: false,
    }),
    summary: Object.freeze({
      acceptanceMet,
      evidenceCount: 4,
      linuxVmTargetAvailable,
      linuxVmFamily,
      linuxVmFamilyAccepted,
      preferredLinuxVmFamily: FUNCTIONAL_FINAL_PREFERRED_VM_FAMILY,
      contractFixtureUsed: false,
      rebuilt: false,
      focusedSuitePassed: extras.focusedSuitePassed !== false,
      planCandidateAccepted: acceptanceMet === true,
      projectLevelFunctionalAcceptance: false,
      publicationClaimed: false,
      productionReady: false,
      environmentSupportClaimed: false,
      nativeLinuxSupportClaimed: false,
      ubuntuSupportClaimed: false,
      debianSupportClaimed: false,
      capacityCertified: false,
    }),
  });
}

async function readJsonReport(repoRoot?: any, relativePath?: any) : Promise<any> {
  try {
    return JSON.parse(await fs.readFile(path.join(repoRoot, relativePath), "utf8"));
  } catch {
    failFunctionalFinal(
      "functional_final_evidence_missing",
      "Functional final requires the exact current evidence set.",
    );
  }
}

function runFocusedSuite(repoRoot?: any) : any {
  const result: any = spawnSync(process.execPath, [
    "--conditions=source",
    VITEST_RUNNER,
    "run",
    "--config",
    "vitest.config.ts",
    FUNCTIONAL_FINAL_FOCUSED_SUITE,
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
    suite: FUNCTIONAL_FINAL_FOCUSED_SUITE,
    passed: result.status === 0,
    exitCode: result.status,
  };
}

export async function runFunctionalFinal({
  repoRoot = repoRootFromMeta(),
  writeReport = true,
  runFocusedTests = false,
  linuxVmProbe,
  generatedAt = new Date().toISOString(),
}: Record<string, any> = {}) : Promise<any> {
  const reports: any = {
    efficiency: await readJsonReport(repoRoot, FUNCTIONAL_FINAL_EVIDENCE_PATHS.efficiency),
    pluginIsolation: await readJsonReport(repoRoot, FUNCTIONAL_FINAL_EVIDENCE_PATHS.pluginIsolation),
    enterpriseOperations: await readJsonReport(repoRoot, FUNCTIONAL_FINAL_EVIDENCE_PATHS.enterpriseOperations),
    offlineDelivery: await readJsonReport(repoRoot, FUNCTIONAL_FINAL_EVIDENCE_PATHS.offlineDelivery),
  };
  const linuxVm: any = typeof linuxVmProbe === "function"
    ? linuxVmProbe()
    : probeLinuxVmFamily();
  let focusedSuite: any = { passed: true, exitCode: 0, suite: FUNCTIONAL_FINAL_FOCUSED_SUITE };
  if (runFocusedTests === true) {
    focusedSuite = runFocusedSuite(repoRoot);
    if (focusedSuite.passed !== true) {
      failFunctionalFinal(
        "functional_final_focused_suite_failed",
        `Focused suite failed: ${FUNCTIONAL_FINAL_FOCUSED_SUITE}`,
      );
    }
  }
  const report: any = reduceFunctionalFinal({
    reports,
    environment: {
      operatorPlatform: process.platform,
      linuxHost: process.platform === "linux",
      linuxVmTargetAvailable: reports.offlineDelivery?.environment?.linuxVmTargetAvailable === true
        || linuxVm.available === true,
      linuxVmFamily: linuxVm.family,
    },
    extras: {
      generatedAt,
      focusedSuitePassed: focusedSuite.passed === true,
    },
  });
  const provenance: Record<string, any> = {
    producer: "meshrix-core-functional-final",
    commandId: "functional-final",
    sourceRevision: await computeVerifierSourceRevision(repoRoot, SOURCE_FILES),
  };
  const finalized: any = finalizeSensitiveReport({
    ...report,
    generatedAt,
    finishedAt: new Date().toISOString(),
  }, { provenance });
  assertNoSensitiveReportLeak(finalized, "functional final receipt");
  assertReportProvenance(finalized, provenance);
  if (finalized.summary.acceptanceMet !== true) {
    failFunctionalFinal(
      "functional_final_failed",
      "Functional final did not accept the current evidence set.",
    );
  }
  if (writeReport === true) {
    await writePrivateFileAtomic(
      path.join(repoRoot, FUNCTIONAL_FINAL_REPORT_RELATIVE_PATH),
      `${JSON.stringify(finalized, null, 2)}\n`,
    );
  }
  return Object.freeze({
    report: finalized,
    reportPath: FUNCTIONAL_FINAL_REPORT_RELATIVE_PATH,
    exitCode: FUNCTIONAL_FINAL_EXIT[finalized.verdict],
  });
}

const invokedDirectly: any = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  (async () : Promise<any> => {
    const result: any = await runFunctionalFinal({
      writeReport: true,
      runFocusedTests: true,
    });
    process.stdout.write(`${JSON.stringify({
      ok: result.report.summary.acceptanceMet === true,
      verdict: result.report.verdict,
      reportPath: result.reportPath,
      acceptanceMet: result.report.summary.acceptanceMet,
      linuxVmFamily: result.report.summary.linuxVmFamily,
      linuxVmFamilyAccepted: result.report.summary.linuxVmFamilyAccepted,
      preferredLinuxVmFamily: result.report.summary.preferredLinuxVmFamily,
      projectLevelFunctionalAcceptance: false,
      capacityCertified: false,
      publicationClaimed: false,
      nativeLinuxSupportClaimed: false,
      ubuntuSupportClaimed: false,
      debianSupportClaimed: false,
    })}\n`);
    process.exitCode = result.exitCode;
  })().catch((error?: any) : any => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code || "functional_final_failed",
    })}\n`);
    process.exitCode = FUNCTIONAL_FINAL_EXIT.failed;
  });
}
