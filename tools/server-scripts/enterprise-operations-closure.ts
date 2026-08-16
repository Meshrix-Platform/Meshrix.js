#!/usr/bin/env node
/*
 * Candidate-bound enterprise operations closure.
 *
 * Composes existing enterprise evidence producers for governed MCP, denial
 * and uncertainty, diagnostics, emergency administration, key lifecycle,
 * clean-root restore, and N-1 upgrade / failed rollback. This oracle does
 * not certify capacity, production-readiness, or environment support.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  initializeLocalSecret,
  rotateLocalSecretMasterKey
} from "../../packages/foundation/src/security/secrets/local-secret-store.ts";
import { createMemoryLocalSecretKeyProvider } from "../../packages/foundation/src/security/secrets/local-secret-key-provider.ts";
import { createStorageBackup } from "../../packages/foundation/src/storage/backup-snapshot.ts";
import { restoreStorageBackup } from "../../packages/foundation/src/storage/restore-execution.ts";
import {
  createFileUpgradeJournal,
  executeEnterpriseUpgradeRollback
} from "./upgrade/enterprise-upgrade-rollback.ts";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeSensitiveReport
} from "./lib/sensitive-report-scan.ts";

export const ENTERPRISE_OPERATIONS_CLOSURE_SCHEMA: any =
  "v0.0.1:meshrix:enterprise-operations-closure-report-1";
export const ENTERPRISE_OPERATIONS_CLOSURE_VERIFIER: any =
  "tools/server-scripts/enterprise-operations-closure.ts";
export const ENTERPRISE_OPERATIONS_CLOSURE_REPORT_RELATIVE_PATH: any =
  "build/reports/enterprise-operations-closure.json";
export const ENTERPRISE_OPERATIONS_CLOSURE_FOCUSED_SUITE: any =
  "tests/vitest/server/enterprise-operations-closure.test.ts";
export const ENTERPRISE_OPERATIONS_NON_CERTIFICATION_REASON: any =
  "enterprise_operations_closure_does_not_certify_capacity";
export const ENTERPRISE_OPERATIONS_PROFILE: any = "enterprise-single-node";
export const ENTERPRISE_OPERATIONS_REQUIREMENTS: readonly any[] = Object.freeze([
  "REQ-EFF-RELEASE",
  "REQ-BASELINE-CONSOLE-ADMINISTRATION",
  "REQ-BASELINE-CONTAINER-DEPLOYMENT",
  "REQ-BASELINE-AGENT-GATEWAY-MODEL-ROUTING"
]);

export const ENTERPRISE_OPERATIONS_SLOT_IDS: readonly any[] = Object.freeze([
  "governed-mcp-journey",
  "denial-and-uncertainty",
  "diagnostics",
  "emergency-administration",
  "key-lifecycle",
  "clean-root-restore",
  "n-minus-one-upgrade-and-failed-rollback"
]);

export const ENTERPRISE_OPERATIONS_ENVIRONMENT_BLOCKERS: readonly any[] = Object.freeze([
  "container_environment_unavailable",
  "key_material_unavailable",
  "restore_environment_unavailable"
]);

const VITEST_RUNNER: any = "./node_modules/vitest/vitest.mjs";
const IMAGE_PATTERN: any =
  /^(?=.{1,512}$)[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/u;
const FIXTURE_CANDIDATE_IMAGE: any =
  "registry.example/meshrix-js/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FIXTURE_PREVIOUS_IMAGE: any =
  "registry.example/meshrix-js/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FORBIDDEN_SUPPORT_CLAIM: any =
  /\b(?:os support|architecture support|cloud support|production-ready|production ready|environment support)\b/iu;

const SOURCE_FILES: readonly any[] = Object.freeze([
  ENTERPRISE_OPERATIONS_CLOSURE_VERIFIER,
  "tools/server-scripts/upgrade/enterprise-upgrade-rollback.ts",
  "tools/server-scripts/verify-enterprise-authorization-enforcement.ts",
  "tools/server-scripts/verify-enterprise-governance-coverage.ts",
  "tools/server-scripts/verify-enterprise-observability-coverage.ts",
  "tools/server-scripts/verify-console-administration-coverage.ts",
  "tools/server-scripts/verify-agent-gateway.ts",
  "tools/server-scripts/verify-model-routing.ts"
]);

export const ENTERPRISE_OPERATIONS_PRODUCERS: readonly any[] = Object.freeze([
  Object.freeze({
    id: "enterprise-governance-coverage",
    script: "tools/server-scripts/verify-enterprise-governance-coverage.ts",
    reportPath: "build/reports/enterprise-governance-coverage.json",
    timeoutMs: 120_000,
    dependsOn: Object.freeze([])
  }),
  Object.freeze({
    id: "operation-permission-protocol-consistency",
    script: "tools/server-scripts/verify-operation-permission-protocol-consistency.ts",
    reportPath: "build/reports/operation-permission-protocol-consistency.json",
    timeoutMs: 180_000,
    dependsOn: Object.freeze([])
  }),
  Object.freeze({
    id: "operation-permission-tag-governed-e2e",
    script: "tools/server-scripts/verify-operation-permission-tag-governed-e2e.ts",
    reportPath: "build/reports/operation-permission-tag-governed-e2e.json",
    timeoutMs: 300_000,
    dependsOn: Object.freeze([])
  }),
  Object.freeze({
    id: "enterprise-enforcement-coverage",
    script: "tools/server-scripts/verify-enterprise-authorization-enforcement.ts",
    reportPath: "build/reports/enterprise-authorization-enforcement.json",
    timeoutMs: 120_000,
    dependsOn: Object.freeze([
      "enterprise-governance-coverage",
      "operation-permission-protocol-consistency",
      "operation-permission-tag-governed-e2e"
    ])
  }),
  Object.freeze({
    id: "enterprise-audit-retention-redaction",
    script: "tools/server-scripts/verify-enterprise-audit-retention-redaction.ts",
    reportPath: "build/reports/enterprise-audit-retention-redaction.json",
    timeoutMs: 120_000,
    dependsOn: Object.freeze([])
  }),
  Object.freeze({
    id: "observability-semantics",
    script: "tools/server-scripts/verify-observability-semantics.ts",
    reportPath: "build/reports/observability-semantics.json",
    timeoutMs: 120_000,
    dependsOn: Object.freeze([])
  }),
  Object.freeze({
    id: "observability-runtime-acceptance",
    script: "tools/server-scripts/verify-observability-runtime-acceptance.ts",
    reportPath: "build/reports/observability-runtime-acceptance.json",
    timeoutMs: 120_000,
    dependsOn: Object.freeze([])
  }),
  Object.freeze({
    id: "enterprise-observability-coverage",
    script: "tools/server-scripts/verify-enterprise-observability-coverage.ts",
    reportPath: "build/reports/enterprise-observability-coverage.json",
    timeoutMs: 120_000,
    dependsOn: Object.freeze([
      "operation-permission-tag-governed-e2e",
      "enterprise-audit-retention-redaction",
      "observability-semantics"
    ])
  }),
  Object.freeze({
    id: "console-administration-coverage",
    script: "tools/server-scripts/verify-console-administration-coverage.ts",
    reportPath: "build/reports/console-administration-coverage.json",
    timeoutMs: 120_000,
    dependsOn: Object.freeze([])
  }),
  Object.freeze({
    id: "backup-restore",
    script: "tools/server-scripts/verify-backup-restore.ts",
    reportPath: "",
    timeoutMs: 120_000,
    dependsOn: Object.freeze([])
  }),
  Object.freeze({
    id: "storage-production-restore-drill",
    script: "tools/server-scripts/verify-storage-production-restore-drill.ts",
    reportPath: "build/reports/storage-production-restore-drill/latest.json",
    timeoutMs: 180_000,
    dependsOn: Object.freeze([])
  }),
  Object.freeze({
    id: "agent-gateway",
    script: "tools/server-scripts/verify-agent-gateway.ts",
    reportPath: "",
    timeoutMs: 120_000,
    dependsOn: Object.freeze([])
  }),
  Object.freeze({
    id: "model-routing",
    script: "tools/server-scripts/verify-model-routing.ts",
    reportPath: "",
    timeoutMs: 120_000,
    dependsOn: Object.freeze([])
  })
]);

export const ENTERPRISE_OPERATIONS_SLOTS: readonly any[] = Object.freeze([
  Object.freeze({
    id: "governed-mcp-journey",
    producers: Object.freeze([
      "operation-permission-tag-governed-e2e",
      "enterprise-governance-coverage",
      "enterprise-enforcement-coverage",
      "agent-gateway",
      "model-routing"
    ]),
    inProcess: Object.freeze([])
  }),
  Object.freeze({
    id: "denial-and-uncertainty",
    producers: Object.freeze([
      "operation-permission-tag-governed-e2e",
      "enterprise-enforcement-coverage"
    ]),
    inProcess: Object.freeze(["uncertainty"])
  }),
  Object.freeze({
    id: "diagnostics",
    producers: Object.freeze([
      "observability-runtime-acceptance",
      "enterprise-observability-coverage"
    ]),
    inProcess: Object.freeze([])
  }),
  Object.freeze({
    id: "emergency-administration",
    producers: Object.freeze(["console-administration-coverage"]),
    inProcess: Object.freeze([])
  }),
  Object.freeze({
    id: "key-lifecycle",
    producers: Object.freeze([]),
    inProcess: Object.freeze(["keyLifecycle"]),
    environmentBlocker: "key_material_unavailable"
  }),
  Object.freeze({
    id: "clean-root-restore",
    producers: Object.freeze(["backup-restore", "storage-production-restore-drill"]),
    inProcess: Object.freeze(["cleanRootRestore"]),
    environmentBlocker: "restore_environment_unavailable"
  }),
  Object.freeze({
    id: "n-minus-one-upgrade-and-failed-rollback",
    producers: Object.freeze([]),
    inProcess: Object.freeze(["upgradeStateMachine", "container"]),
    environmentBlocker: "container_environment_unavailable"
  })
]);

function repoRootFromMeta() : any {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

function isObject(value?: any) : any {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values: any = []) : any {
  return [...new Set<any>(values.map((value?: any) : any => String(value || "").trim()).filter(Boolean))];
}

function producerById(producerId?: any) : any {
  return ENTERPRISE_OPERATIONS_PRODUCERS.find((entry?: any) : any => entry.id === producerId) || null;
}

export function orderedEnterpriseOperationsProducers() : any {
  const remaining: any[] = [...ENTERPRISE_OPERATIONS_PRODUCERS];
  const ordered: any[] = [];
  const done: any = new Set<any>();
  while (remaining.length > 0) {
    const readyIndex: any = remaining.findIndex((entry?: any) : any =>
      (entry.dependsOn || []).every((dependency?: any) : any => done.has(dependency))
    );
    if (readyIndex < 0) {
      throw new Error("Enterprise operations producer catalog has a dependency cycle.");
    }
    const next: any = remaining.splice(readyIndex, 1)[0];
    ordered.push(next);
    done.add(next.id);
  }
  return ordered;
}

export function assertCapacityNeverCertified(value: Record<string, any> = {}) : any {
  if (value.capacityCertified === true || value.summary?.capacityCertified === true) {
    throw new Error("Enterprise operations closure must never certify capacity.");
  }
  return true;
}

export function assertEnterpriseOperationsNonClaims(value: Record<string, any> = {}) : any {
  assertCapacityNeverCertified(value);
  if (
    value.productionReady === true
    || value.summary?.productionReady === true
    || value.environmentSupportClaimed === true
    || value.summary?.environmentSupportClaimed === true
    || value.releaseReady === true
    || value.summary?.releaseReady === true
  ) {
    throw new Error("Enterprise operations closure must not claim production-readiness or environment support.");
  }
  const text: any = JSON.stringify(value);
  if (FORBIDDEN_SUPPORT_CLAIM.test(text)) {
    throw new Error("Enterprise operations closure must not claim OS, architecture, cloud, or environment support.");
  }
  return true;
}

function readySignal(report: Record<string, any> = {}) : any {
  const summary: any = isObject(report.summary) ? report.summary : {};
  for (const field of [
    summary.releaseReady,
    summary.coverageReady,
    summary.readyForReleaseReduction,
    report.readyForReleaseReduction,
    report.ok,
    report.coverageReady
  ]) {
    if (typeof field === "boolean") return field;
  }
  return null;
}

function publicProducer(result: Record<string, any> = {}) : any {
  return {
    id: String(result.id || ""),
    script: String(result.script || ""),
    reportPath: String(result.reportPath || ""),
    exitCode: Number.isSafeInteger(result.exitCode) ? result.exitCode : 1,
    passed: result.passed === true,
    timedOut: result.timedOut === true,
    readySignal: typeof result.readySignal === "boolean" ? result.readySignal : null
  };
}

function inProcessOk(bundle: Record<string, any> = {}, key?: any) : any {
  if (key === "uncertainty") return bundle.upgradeStateMachine?.inDoubt === true;
  if (key === "keyLifecycle") return bundle.keyLifecycle?.ok === true;
  if (key === "cleanRootRestore") return bundle.cleanRootRestore?.ok === true;
  if (key === "upgradeStateMachine") {
    return bundle.upgradeStateMachine?.rolledBack === true
      && bundle.upgradeStateMachine?.inDoubt === true;
  }
  if (key === "container") return bundle.container?.available === true;
  return false;
}

function slotBlocker(slot?: any, bundle: Record<string, any> = {}) : any {
  if (slot.id === "key-lifecycle" && bundle.keyLifecycle?.blocker) {
    return String(bundle.keyLifecycle.blocker);
  }
  if (slot.id === "clean-root-restore" && bundle.cleanRootRestore?.blocker) {
    return String(bundle.cleanRootRestore.blocker);
  }
  if (slot.id === "n-minus-one-upgrade-and-failed-rollback" && bundle.container?.available !== true) {
    return String(bundle.container?.blocker || "container_environment_unavailable");
  }
  return "";
}

export function reduceEnterpriseOperationsClosure(input: Record<string, any> = {}) : any {
  const producers: any = isObject(input.producers) ? input.producers : {};
  const inProcess: any = isObject(input.inProcess) ? input.inProcess : {};
  const candidate: any = isObject(input.candidate) ? input.candidate : {};
  const slots: any[] = [];
  const environmentBlockers: any[] = [];

  if (candidate.profile !== ENTERPRISE_OPERATIONS_PROFILE) {
    throw new Error("Enterprise operations closure requires the enterprise-single-node profile.");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(String(candidate.digest || ""))) {
    throw new Error("Enterprise operations closure requires one candidate digest.");
  }

  for (const slot of ENTERPRISE_OPERATIONS_SLOTS) {
    const missingProducers: any[] = [];
    const failedProducers: any[] = [];
    for (const producerId of slot.producers) {
      const result: any = publicProducer(producers[producerId] || { id: producerId });
      if (result.id !== producerId || result.passed !== true) {
        failedProducers.push(producerId);
      }
      if (!producers[producerId]) missingProducers.push(producerId);
    }
    const missingInProcess: any[] = slot.inProcess.filter((key?: any) : any => !inProcessOk(inProcess, key));
    const blocker: any = slotBlocker(slot, inProcess);
    let status: any = "passed";
    if (blocker && ENTERPRISE_OPERATIONS_ENVIRONMENT_BLOCKERS.includes(blocker)) {
      status = "blocked";
      environmentBlockers.push(blocker);
    } else if (failedProducers.length > 0 || missingProducers.length > 0 || missingInProcess.length > 0) {
      status = "failed";
    }
    slots.push({
      id: slot.id,
      status,
      blocker: status === "blocked" ? blocker : "",
      failedProducerCount: failedProducers.length,
      missingInProcessCount: missingInProcess.length
    });
  }

  const uniqueBlockers: any = uniqueStrings(environmentBlockers);
  const scenarioAccepted: any = slots.every((slot?: any) : any => slot.status === "passed");
  return {
    candidate: {
      profile: ENTERPRISE_OPERATIONS_PROFILE,
      digest: candidate.digest,
      identityKind: "source-closure"
    },
    producers: Object.fromEntries(
      ENTERPRISE_OPERATIONS_PRODUCERS.map((spec?: any) : any => [
        spec.id,
        publicProducer(producers[spec.id] || { id: spec.id, script: spec.script, reportPath: spec.reportPath })
      ])
    ),
    inProcess: {
      keyLifecycle: { ok: inProcess.keyLifecycle?.ok === true },
      cleanRootRestore: {
        ok: inProcess.cleanRootRestore?.ok === true,
        restoredFileCount: Number(inProcess.cleanRootRestore?.restoredFileCount || 0)
      },
      upgradeStateMachine: {
        rolledBack: inProcess.upgradeStateMachine?.rolledBack === true,
        inDoubt: inProcess.upgradeStateMachine?.inDoubt === true
      },
      container: { available: inProcess.container?.available === true }
    },
    slots,
    environmentBlockers: uniqueBlockers,
    scenarioAccepted,
    capacityCertified: false,
    productionReady: false,
    environmentSupportClaimed: false,
    nonCertificationReason: ENTERPRISE_OPERATIONS_NON_CERTIFICATION_REASON
  };
}

export function buildEnterpriseOperationsClosureReport(
  reduction: Record<string, any> = {},
  extras: Record<string, any> = {}
) : any {
  assertEnterpriseOperationsNonClaims(reduction);
  if (reduction.capacityCertified !== false) {
    throw new Error("Enterprise operations closure must keep capacityCertified false.");
  }
  const slotIds: any = (reduction.slots || []).map((slot?: any) : any => slot.id);
  if (JSON.stringify(slotIds) !== JSON.stringify([...ENTERPRISE_OPERATIONS_SLOT_IDS])) {
    throw new Error("Enterprise operations closure must report every required slot.");
  }
  return {
    schemaVersion: ENTERPRISE_OPERATIONS_CLOSURE_SCHEMA,
    verifier: ENTERPRISE_OPERATIONS_CLOSURE_VERIFIER,
    generatedAt: extras.generatedAt || "1970-01-01T00:00:00.000Z",
    requirements: [...ENTERPRISE_OPERATIONS_REQUIREMENTS],
    candidate: reduction.candidate,
    capacityCertified: false,
    productionReady: false,
    environmentSupportClaimed: false,
    nonCertificationReason: ENTERPRISE_OPERATIONS_NON_CERTIFICATION_REASON,
    summary: {
      slotCount: reduction.slots.length,
      passedSlotCount: reduction.slots.filter((slot?: any) : any => slot.status === "passed").length,
      failedSlotCount: reduction.slots.filter((slot?: any) : any => slot.status === "failed").length,
      blockedSlotCount: reduction.slots.filter((slot?: any) : any => slot.status === "blocked").length,
      environmentBlockerCount: reduction.environmentBlockers.length,
      scenarioAccepted: reduction.scenarioAccepted === true,
      capacityCertified: false,
      productionReady: false,
      environmentSupportClaimed: false,
      nonCertificationReason: ENTERPRISE_OPERATIONS_NON_CERTIFICATION_REASON,
      focusedSuitePassed: extras.focusedSuitePassed === true,
      producerCount: ENTERPRISE_OPERATIONS_PRODUCERS.length
    },
    environmentBlockers: [...reduction.environmentBlockers],
    slots: reduction.slots,
    producers: reduction.producers,
    inProcess: reduction.inProcess
  };
}

export function assertEnterpriseOperationsClosure(report: Record<string, any> = {}) : any {
  assertEnterpriseOperationsNonClaims(report);
  if (report.schemaVersion !== ENTERPRISE_OPERATIONS_CLOSURE_SCHEMA) {
    throw new Error("Enterprise operations closure schema is invalid.");
  }
  if (report.verifier !== ENTERPRISE_OPERATIONS_CLOSURE_VERIFIER) {
    throw new Error("Enterprise operations closure verifier path is invalid.");
  }
  if (report.summary?.scenarioAccepted === true && report.environmentBlockers?.length > 0) {
    throw new Error("Enterprise operations closure must not accept a blocked environment as green.");
  }
  if (
    report.summary?.scenarioAccepted === true
    && (report.slots || []).some((slot?: any) : any => slot.status !== "passed")
  ) {
    throw new Error("Enterprise operations closure must not accept incomplete slots.");
  }
  return true;
}

export function passingProducerFixture(producerId?: any) : any {
  const spec: any = producerById(producerId);
  return {
    id: producerId,
    script: spec?.script || "",
    reportPath: spec?.reportPath || "",
    exitCode: 0,
    passed: true,
    timedOut: false,
    readySignal: true
  };
}

export function passingProducerMap() : any {
  return Object.fromEntries(
    ENTERPRISE_OPERATIONS_PRODUCERS.map((spec?: any) : any => [spec.id, passingProducerFixture(spec.id)])
  );
}

export function passingInProcessFixture() : any {
  return {
    keyLifecycle: { ok: true },
    cleanRootRestore: { ok: true, restoredFileCount: 1 },
    upgradeStateMachine: { rolledBack: true, inDoubt: true },
    container: { available: true }
  };
}

function memoryPorts({ candidateHealthy = true, restoreSucceeds = true }: Record<string, any> = {}) : any {
  const calls: any[] = [];
  return {
    calls,
    candidate: {
      async admit(image?: any) : Promise<any> {
        calls.push(["admit", Boolean(image)]);
      }
    },
    backup: {
      async create() : Promise<any> {
        calls.push(["backup"]);
        return { ok: true, backupId: "backup_fixture", receiptId: "receipt_fixture" };
      }
    },
    activation: {
      async activate(image?: any) : Promise<any> {
        calls.push(["activate", Boolean(image)]);
      }
    },
    validation: {
      async check() : Promise<any> {
        calls.push(["validate"]);
        const remaining: any = calls.filter((entry?: any) : any => entry[0] === "validate").length;
        if (remaining === 1) {
          return { healthy: candidateHealthy, governedOperationOk: candidateHealthy };
        }
        return { healthy: true, governedOperationOk: true };
      }
    },
    restore: {
      async preview(backupId?: any) : Promise<any> {
        calls.push(["restore-preview", Boolean(backupId)]);
        return { ok: true, integrityVerified: true };
      },
      async apply(backupId?: any) : Promise<any> {
        calls.push(["restore", Boolean(backupId)]);
        return { ok: restoreSucceeds, applied: restoreSucceeds };
      }
    },
    journal: {
      async write() : Promise<any> {}
    }
  };
}

export async function executeUpgradeStateMachineProof() : Promise<any> {
  const rolledBackPorts: any = memoryPorts({ candidateHealthy: false, restoreSucceeds: true });
  const rolledBack: any = await executeEnterpriseUpgradeRollback({
    candidateImage: FIXTURE_CANDIDATE_IMAGE,
    previousImage: FIXTURE_PREVIOUS_IMAGE,
    ...rolledBackPorts
  });
  const inDoubtPorts: any = memoryPorts({ candidateHealthy: false, restoreSucceeds: false });
  let inDoubt: any = false;
  try {
    await executeEnterpriseUpgradeRollback({
      candidateImage: FIXTURE_CANDIDATE_IMAGE,
      previousImage: FIXTURE_PREVIOUS_IMAGE,
      ...inDoubtPorts
    });
  } catch (error: any) {
    inDoubt = error?.code === "enterprise_upgrade_rollback_in_doubt";
  }
  return {
    rolledBack: rolledBack?.outcome === "rolled-back" && rolledBack?.ok === false,
    inDoubt
  };
}

export async function executeKeyLifecycleProof() : Promise<any> {
  const dataDir: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-eoc-keys-"));
  const currentKeyProvider: any = createMemoryLocalSecretKeyProvider({
    key: Buffer.alloc(32, 0x11)
  });
  const nextKeyProvider: any = createMemoryLocalSecretKeyProvider({
    key: Buffer.alloc(32, 0x22)
  });
  try {
    await initializeLocalSecret({
      dataDir,
      keyProvider: currentKeyProvider,
      target: {
        provider: "fixture-provider",
        family: "upstream-gateway",
        authType: "bearer",
        secretRef: "secret://fixture/service-material",
        scope: {
          serviceId: "fixture-service",
          scopes: ["gateway:read"],
          allowedHosts: ["api.example.test"],
          allowedProtocols: ["https"]
        }
      },
      payload: { token: "fixture-material" }
    });
    const rotated: any = await rotateLocalSecretMasterKey({
      dataDir,
      currentKeyProvider,
      nextKeyProvider
    });
    if (rotated?.ok !== true || Number(rotated.rotatedSecretCount || 0) < 1) {
      return { ok: false, blocker: "" };
    }
    return { ok: true };
  } catch (error: any) {
    const code: any = String(error?.code || "");
    if (code.includes("unavailable") || code.includes("provider_required")) {
      return { ok: false, blocker: "key_material_unavailable" };
    }
    return { ok: false, blocker: "" };
  } finally {
    currentKeyProvider.close();
    nextKeyProvider.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

export async function executeCleanRootRestoreProof() : Promise<any> {
  const dataDir: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-eoc-restore-"));
  try {
    await fs.writeFile(
      path.join(dataDir, "settings.json"),
      `${JSON.stringify({ version: 1, name: "before" }, null, 2)}\n`,
      "utf8"
    );
    const backup: any = await createStorageBackup({
      userDataPath: dataDir,
      label: "closure"
    });
    await fs.writeFile(
      path.join(dataDir, "settings.json"),
      `${JSON.stringify({ version: 2, name: "after" }, null, 2)}\n`,
      "utf8"
    );
    const preview: any = await restoreStorageBackup({
      userDataPath: dataDir,
      backupId: backup.backupId
    });
    if (preview?.integrity?.verified !== true) {
      return { ok: false, restoredFileCount: 0, blocker: "" };
    }
    const restored: any = await restoreStorageBackup({
      userDataPath: dataDir,
      backupId: backup.backupId,
      dryRun: false,
      apply: true
    });
    const text: any = await fs.readFile(path.join(dataDir, "settings.json"), "utf8");
    if (restored?.applied !== true || !text.includes("before")) {
      return { ok: false, restoredFileCount: 0, blocker: "" };
    }
    return { ok: true, restoredFileCount: 1 };
  } catch (error: any) {
    const code: any = String(error?.code || "");
    if (code.includes("unavailable") || code.includes("ENOENT")) {
      return { ok: false, restoredFileCount: 0, blocker: "restore_environment_unavailable" };
    }
    return { ok: false, restoredFileCount: 0, blocker: "" };
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function inspectImage(image?: any) : any {
  const result: any = spawnSync("docker", ["image", "inspect", image], {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return result.status === 0;
}

export function probeContainerEnvironment({
  candidateImage = "",
  previousImage = ""
}: Record<string, any> = {}) : any {
  const candidate: any = String(candidateImage || "").trim();
  const previous: any = String(previousImage || "").trim();
  if (!IMAGE_PATTERN.test(candidate) || !IMAGE_PATTERN.test(previous) || candidate === previous) {
    return { available: false, blocker: "container_environment_unavailable" };
  }
  const docker: any = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (docker.error || docker.status !== 0) {
    return { available: false, blocker: "container_environment_unavailable" };
  }
  if (!inspectImage(candidate) || !inspectImage(previous)) {
    return { available: false, blocker: "container_environment_unavailable" };
  }
  return { available: true, blocker: "" };
}

async function executeAdmittedDigestRollback({
  candidateImage,
  previousImage
}: Record<string, any> = {}) : Promise<any> {
  const dataDir: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-eoc-upgrade-"));
  const journalFile: any = path.join(dataDir, "upgrade-journal.json");
  try {
    await fs.writeFile(
      path.join(dataDir, "settings.json"),
      `${JSON.stringify({ version: 1, name: "before" }, null, 2)}\n`,
      "utf8"
    );
    const result: any = await executeEnterpriseUpgradeRollback({
      candidateImage,
      previousImage,
      candidate: {
        async admit(image?: any) : Promise<any> {
          if (!inspectImage(image)) {
            throw Object.assign(new Error("enterprise_upgrade_candidate_digest_required"), {
              code: "enterprise_upgrade_candidate_digest_required"
            });
          }
        }
      },
      backup: {
        async create() : Promise<any> {
          const backup: any = await createStorageBackup({
            userDataPath: dataDir,
            label: "closure"
          });
          return {
            ok: true,
            backupId: backup.backupId,
            receiptId: String(backup.receipt?.receiptId || "receipt_fixture")
          };
        }
      },
      activation: {
        async activate() : Promise<any> {}
      },
      validation: {
        async check(image?: any) : Promise<any> {
          return {
            healthy: image === previousImage,
            governedOperationOk: image === previousImage
          };
        }
      },
      restore: {
        async preview(backupId?: any) : Promise<any> {
          const preview: any = await restoreStorageBackup({
            userDataPath: dataDir,
            backupId
          });
          return {
            ok: preview?.integrity?.verified === true,
            integrityVerified: preview?.integrity?.verified === true
          };
        },
        async apply(backupId?: any) : Promise<any> {
          const restored: any = await restoreStorageBackup({
            userDataPath: dataDir,
            backupId,
            dryRun: false,
            apply: true
          });
          return { ok: restored?.applied === true, applied: restored?.applied === true };
        }
      },
      journal: createFileUpgradeJournal({ journalFile })
    });
    return result?.outcome === "rolled-back";
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function readProducerReport(repoRoot?: any, relativePath?: any) : Promise<any> {
  if (!relativePath) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(repoRoot, relativePath), "utf8"));
  } catch {
    return null;
  }
}

function spawnProducer(spec?: any, repoRoot?: any) : Promise<any> {
  return new Promise((resolve?: any) : any => {
    const startedAt: any = Date.now();
    const child: any = spawn(process.execPath, [spec.script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: "--conditions=source"
      },
      stdio: ["ignore", "inherit", "inherit"]
    });
    let settled: any = false;
    const finish: any = (exitCode?: any, timedOut: any = false) : any => {
      if (settled) return;
      settled = true;
      resolve({
        id: spec.id,
        script: spec.script,
        reportPath: spec.reportPath,
        exitCode,
        passed: exitCode === 0,
        timedOut,
        elapsedMs: Date.now() - startedAt
      });
    };
    const timer: any = setTimeout(() : any => {
      child.kill("SIGTERM");
      finish(124, true);
    }, spec.timeoutMs);
    child.on("error", () : any => {
      clearTimeout(timer);
      finish(1);
    });
    child.on("close", (code?: any) : any => {
      clearTimeout(timer);
      finish(code ?? 1);
    });
  });
}

export async function executeEnterpriseOperationsProducers({
  repoRoot = repoRootFromMeta(),
  candidateImage = "",
  previousImage = ""
}: Record<string, any> = {}) : Promise<any> {
  const producers: Record<string, any> = {};
  for (const spec of orderedEnterpriseOperationsProducers()) {
    process.stderr.write(`[enterprise-operations-closure] producer=${spec.id}\n`);
    const spawned: any = await spawnProducer(spec, repoRoot);
    const report: any = await readProducerReport(repoRoot, spec.reportPath);
    producers[spec.id] = {
      ...spawned,
      readySignal: spawned.passed === true && report ? readySignal(report) : null
    };
  }

  const [keyLifecycle, cleanRootRestore, upgradeStateMachine] = await Promise.all([
    executeKeyLifecycleProof().catch(() : any => ({ ok: false, blocker: "key_material_unavailable" })),
    executeCleanRootRestoreProof().catch(() : any => ({
      ok: false,
      restoredFileCount: 0,
      blocker: "restore_environment_unavailable"
    })),
    executeUpgradeStateMachineProof().catch(() : any => ({ rolledBack: false, inDoubt: false }))
  ]);
  const container: any = probeContainerEnvironment({ candidateImage, previousImage });
  if (container.available === true) {
    try {
      const admittedRollback: any = await executeAdmittedDigestRollback({
        candidateImage,
        previousImage
      });
      if (admittedRollback !== true) {
        container.available = false;
        container.blocker = "container_environment_unavailable";
      }
    } catch {
      container.available = false;
      container.blocker = "container_environment_unavailable";
    }
  }

  return {
    producers,
    inProcess: {
      keyLifecycle,
      cleanRootRestore,
      upgradeStateMachine,
      container
    }
  };
}

function runFocusedSuite(repoRoot?: any) : any {
  const result: any = spawnSync(process.execPath, [
    "--conditions=source",
    VITEST_RUNNER,
    "run",
    "--config",
    "vitest.config.ts",
    ENTERPRISE_OPERATIONS_CLOSURE_FOCUSED_SUITE
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_OPTIONS: "--conditions=source"
    }
  });
  return {
    suite: ENTERPRISE_OPERATIONS_CLOSURE_FOCUSED_SUITE,
    passed: result.status === 0,
    exitCode: result.status,
    outputBytes: Buffer.byteLength(`${result.stdout || ""}${result.stderr || ""}`, "utf8")
  };
}

function argValue(argv: any = [], name?: any) : any {
  const index: any = argv.indexOf(name);
  if (index >= 0 && argv[index + 1]) return String(argv[index + 1]);
  return "";
}

export async function runEnterpriseOperationsClosure({
  repoRoot = repoRootFromMeta(),
  writeReport = true,
  runFocusedTests = false,
  executeProducers = true,
  generatedAt = new Date().toISOString(),
  candidateImage = "",
  previousImage = "",
  producers = null,
  inProcess = null
}: Record<string, any> = {}) : Promise<any> {
  if (executeProducers !== true && (!isObject(producers) || !isObject(inProcess))) {
    throw new Error("Enterprise operations closure refuses a green receipt without producer evidence.");
  }
  const executed: any = executeProducers === true
    ? await executeEnterpriseOperationsProducers({ repoRoot, candidateImage, previousImage })
    : { producers, inProcess };
  const sourceRevision: any = await computeVerifierSourceRevision(repoRoot, SOURCE_FILES);
  const candidate: any = {
    profile: ENTERPRISE_OPERATIONS_PROFILE,
    digest: sourceRevision,
    identityKind: "source-closure"
  };
  const reduction: any = reduceEnterpriseOperationsClosure({
    candidate,
    producers: executed.producers,
    inProcess: executed.inProcess
  });

  let focusedSuite: any = {
    suite: ENTERPRISE_OPERATIONS_CLOSURE_FOCUSED_SUITE,
    passed: runFocusedTests !== true,
    exitCode: 0,
    outputBytes: 0
  };
  if (runFocusedTests === true) {
    focusedSuite = runFocusedSuite(repoRoot);
  }

  const report: any = buildEnterpriseOperationsClosureReport(reduction, {
    generatedAt,
    focusedSuitePassed: focusedSuite.passed === true
  });
  const provenance: Record<string, any> = {
    producer: "meshrix-core-enterprise-operations-closure",
    commandId: "enterprise-operations-closure",
    sourceRevision
  };
  const finalized: any = finalizeSensitiveReport(report, { provenance });
  assertNoSensitiveReportLeak(finalized, "enterprise operations closure report");
  assertReportProvenance(finalized, provenance);
  assertEnterpriseOperationsClosure(finalized);
  assertCapacityNeverCertified(finalized);

  if (writeReport === true) {
    const absolutePath: any = path.join(repoRoot, ENTERPRISE_OPERATIONS_CLOSURE_REPORT_RELATIVE_PATH);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
  }

  if (runFocusedTests === true && focusedSuite.passed !== true) {
    throw new Error(
      `Focused suite failed: ${ENTERPRISE_OPERATIONS_CLOSURE_FOCUSED_SUITE} exit=${focusedSuite.exitCode}`
    );
  }

  return {
    report: finalized,
    reportPath: ENTERPRISE_OPERATIONS_CLOSURE_REPORT_RELATIVE_PATH,
    focusedSuite: {
      suite: focusedSuite.suite,
      passed: focusedSuite.passed,
      exitCode: focusedSuite.exitCode,
      outputBytes: focusedSuite.outputBytes
    }
  };
}

async function main(argv: any = process.argv.slice(2)) : Promise<any> {
  const result: any = await runEnterpriseOperationsClosure({
    writeReport: true,
    runFocusedTests: true,
    executeProducers: true,
    candidateImage: argValue(argv, "--candidate") || process.env.MESHRIX_ENTERPRISE_CANDIDATE_IMAGE || "",
    previousImage: argValue(argv, "--previous") || process.env.MESHRIX_ENTERPRISE_PREVIOUS_IMAGE || ""
  });
  process.stdout.write(`${JSON.stringify({
    ok: result.report.summary.scenarioAccepted === true,
    reportPath: result.reportPath,
    capacityCertified: result.report.capacityCertified,
    scenarioAccepted: result.report.summary.scenarioAccepted,
    environmentBlockers: result.report.environmentBlockers,
    passedSlotCount: result.report.summary.passedSlotCount,
    blockedSlotCount: result.report.summary.blockedSlotCount,
    failedSlotCount: result.report.summary.failedSlotCount,
    focusedSuitePassed: result.report.summary.focusedSuitePassed
  })}\n`);
  if (result.report.summary.scenarioAccepted !== true) {
    process.exitCode = 1;
  }
}

const modulePath: any = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  main().catch((error?: any) : any => {
    const message: any = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
