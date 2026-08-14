import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { containsSensitiveReportData } from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";
import { verifyEnterpriseOfflineBundle } from "../../../tools/server-scripts/enterprise-single-node-offline-bundle.ts";
import {
  buildOfflineDeliveryClosureReport,
  runOfflineDeliveryClosure,
} from "../../../tools/server-scripts/offline-delivery-closure.ts";
import {
  buildDisconnectedLifecyclePlan,
  executeDisconnectedLifecycle,
  transferAndVerifyOfflineDeliveryBundle,
} from "../../../tools/server-scripts/offline-delivery-disconnected-verifier.ts";
import {
  produceOfflineDeliveryBundle,
} from "../../../tools/server-scripts/offline-delivery-producer.ts";
import {
  OFFLINE_DELIVERY_CLOSURE_REPORT_RELATIVE_PATH,
  OFFLINE_DELIVERY_CLOSURE_VERIFIER,
  OFFLINE_DELIVERY_ENVIRONMENT_BLOCK_REASONS,
  OFFLINE_DELIVERY_FIRST_GOVERNED_CALL,
  OFFLINE_DELIVERY_INSTRUCTIONS_RELATIVE_PATH,
  OFFLINE_DELIVERY_PLATFORMS,
  assertLifecycleCommandOffline,
  assertOfflineDeliveryVerdictHonest,
  classifyOfflineDeliveryEnvironment,
  probeLinuxVmTarget,
} from "../../../tools/server-scripts/offline-delivery-shared.ts";

const TMP_ROOTS: any[] = [];
const ABSOLUTE_PATH_PATTERN: any = /(?:\/(?:Users|home|private|var\/folders|root)\/|[A-Za-z]:\\)/u;

async function trackedTempRoot(prefix?: any) : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  TMP_ROOTS.push(root);
  return root;
}

afterEach(async () : Promise<any> => {
  await Promise.all(TMP_ROOTS.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("offline delivery closure", () : any => {
  it("produces a dual-arch signed bundle with inventory, SBOM, provenance, signatures, and instructions", async () : Promise<any> => {
    const outputRoot: any = await trackedTempRoot("meshrix-offline-delivery-produce-");
    const produced: any = await produceOfflineDeliveryBundle({
      outputRoot,
      allowContractFixture: true,
    });
    expect(produced.platforms).toEqual([...OFFLINE_DELIVERY_PLATFORMS]);
    expect(produced.hasInventory).toBe(true);
    expect(produced.hasSbom).toBe(true);
    expect(produced.hasProvenance).toBe(true);
    expect(produced.hasSignatures).toBe(true);
    expect(produced.hasInstructions).toBe(true);
    expect(produced.contractFixtureUsed).toBe(true);
    expect(produced.bundle.compose.pull_policy).toBe("never");
    expect(produced.bundle.compose.args).toEqual(expect.arrayContaining(["--no-build", "never"]));
    expect(produced.instructions.activation.buildAllowed).toBe(false);
    expect(produced.instructions.activation.networkRequired).toBe(false);
    expect(produced.instructions.firstGovernedCall).toEqual(OFFLINE_DELIVERY_FIRST_GOVERNED_CALL);
    expect(produced.instructions.instructionSheet).toBe(OFFLINE_DELIVERY_INSTRUCTIONS_RELATIVE_PATH);
    expect(produced.instructions.claims).toEqual({
      nativeLinuxSupport: false,
      capacityCertified: false,
      publication: false,
    });
    await expect(fs.readFile(path.join(outputRoot, "evidence", "sbom.json"), "utf8"))
      .resolves.toMatch(/SPDX/);
    await expect(fs.readFile(path.join(outputRoot, "evidence", "provenance.json"), "utf8"))
      .resolves.toMatch(/buildType/);
    await expect(fs.readFile(path.join(outputRoot, "signature", "signature.json"), "utf8"))
      .resolves.toMatch(/ed25519/);
  });

  it("transfers exact bytes into a disconnected clean target and rejects mutation", async () : Promise<any> => {
    const sourceRoot: any = await trackedTempRoot("meshrix-offline-delivery-source-");
    const targetRoot: any = await trackedTempRoot("meshrix-offline-delivery-target-");
    await fs.rm(targetRoot, { recursive: true, force: true });
    const produced: any = await produceOfflineDeliveryBundle({
      outputRoot: sourceRoot,
      allowContractFixture: true,
    });
    const transferred: any = await transferAndVerifyOfflineDeliveryBundle({
      sourceRoot,
      targetRoot,
      trustedPublicKeys: produced.trustedPublicKeys,
    });
    expect(transferred.exactBytesVerified).toBe(true);
    expect(transferred.candidateDigest).toBe(produced.bundle.candidate_digest);
    expect(transferred.inventoryDigest).toBe(produced.bundle.inventory_digest);
    expect(transferred.platforms).toEqual([...OFFLINE_DELIVERY_PLATFORMS]);

    await fs.appendFile(path.join(targetRoot, "compose", "compose.yaml"), "\n# mutated\n");
    await expect(verifyEnterpriseOfflineBundle({
      bundleRoot: targetRoot,
      trustedPublicKeys: produced.trustedPublicKeys,
    })).rejects.toMatchObject({
      code: "enterprise_offline_bundle_output_metadata_mismatch",
    });
  });

  it("keeps the disconnected lifecycle offline and refuses rebuild or pull", async () : Promise<any> => {
    const outputRoot: any = await trackedTempRoot("meshrix-offline-delivery-lifecycle-");
    const produced: any = await produceOfflineDeliveryBundle({
      outputRoot,
      allowContractFixture: true,
    });
    const plan: any = buildDisconnectedLifecyclePlan(produced.bundle);
    expect(plan.networkRequired).toBe(false);
    expect(plan.rebuild).toBe(false);
    expect(plan.steps.map((step?: any) : any => step.id)).toEqual([
      "import",
      "start",
      "first_governed_call",
      "stop",
      "cleanup",
    ]);
    for (const step of plan.steps) {
      expect(assertLifecycleCommandOffline(step)).toBe(true);
    }
    const outcomes: any = await executeDisconnectedLifecycle({
      plan,
      commandRunner: async () : Promise<any> => ({ ok: true }),
    });
    expect(outcomes).toHaveLength(5);
    expect(() : any => assertLifecycleCommandOffline({
      id: "start",
      executable: "docker",
      args: ["compose", "up", "--build"],
      networkRequired: false,
      rebuild: false,
    })).toThrow(/must not rebuild/);
    expect(() : any => assertLifecycleCommandOffline({
      id: "import",
      executable: "docker",
      args: ["pull", "example/image"],
      networkRequired: false,
      rebuild: false,
    })).toThrow(/must not pull/);
    await expect(executeDisconnectedLifecycle({
      plan,
      commandRunner: async () : Promise<any> => ({ ok: true }),
      networkAllowed: true,
    })).rejects.toMatchObject({ code: "offline_delivery_network_forbidden" });
  });

  it("fails closed with a finite environment reason and rejects mock acceptance", async () : Promise<any> => {
    const darwin: any = classifyOfflineDeliveryEnvironment({
      platform: "darwin",
      candidateLayoutConfigured: false,
    });
    expect(darwin.blocked).toBe(true);
    expect(OFFLINE_DELIVERY_ENVIRONMENT_BLOCK_REASONS).toContain(darwin.reason);
    expect(darwin.reason).toBe("linux_vm_target_unavailable");
    expect(darwin.linuxVmTargetAvailable).toBe(false);
    expect(darwin.nativeLinuxSupportClaimed).toBe(false);
    expect(classifyOfflineDeliveryEnvironment({
      platform: "darwin",
      linuxVmTargetAvailable: true,
      candidateLayoutConfigured: true,
      importerAvailable: true,
      engineAvailable: true,
      secretCustodyConfigured: true,
    })).toMatchObject({
      blocked: false,
      reason: null,
      linuxVmTargetAvailable: true,
      linuxHost: false,
      nativeLinuxSupportClaimed: false,
    });
    expect(classifyOfflineDeliveryEnvironment({
      platform: "linux",
      candidateLayoutConfigured: true,
      importerAvailable: true,
      engineAvailable: true,
      secretCustodyConfigured: true,
    })).toMatchObject({ blocked: false, reason: null, linuxVmTargetAvailable: true });
    await expect(produceOfflineDeliveryBundle({
      outputRoot: await trackedTempRoot("meshrix-offline-delivery-missing-"),
    })).rejects.toMatchObject({ code: "offline_delivery_candidate_materials_missing" });

    const result: any = await runOfflineDeliveryClosure({
      writeReport: false,
      runFocusedTests: false,
    });
    expect(result.report.verdict).toBe("blocked_by_environment");
    expect(result.report.summary.acceptanceMet).toBe(false);
    expect(result.report.summary.contractFixtureUsed).toBe(true);
    expect(result.report.summary.exactBytesVerified).toBe(true);
    expect(result.report.summary.disconnectedTargetRan).toBe(false);
    expect(result.report.summary.capacityCertified).toBe(false);
    expect(result.report.summary.publicationClaimed).toBe(false);
    expect(result.report.summary.nativeLinuxSupportClaimed).toBe(false);
    expect(result.disconnectedTargetRan).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.reportPath).toBe(OFFLINE_DELIVERY_CLOSURE_REPORT_RELATIVE_PATH);
    expect(result.report.verifier).toBe(OFFLINE_DELIVERY_CLOSURE_VERIFIER);
    expect(containsSensitiveReportData(result.report)).toBe(false);
    expect(JSON.stringify(result.report)).not.toMatch(ABSOLUTE_PATH_PATTERN);
    expect(assertOfflineDeliveryVerdictHonest(result.report)).toBe(true);

    expect(probeLinuxVmTarget({
      platform: "darwin",
      spawn: () : any => ({ status: 1, stdout: "", stderr: "" }),
    })).toMatchObject({ available: false, kind: null });
    expect(probeLinuxVmTarget({
      platform: "darwin",
      spawn: (executable?: any) : any => (
        executable === "docker"
          ? { status: 0, stdout: "linux\n", stderr: "" }
          : { status: 1, stdout: "", stderr: "" }
      ),
    })).toMatchObject({ available: true, kind: "linux_vm_container_engine" });

    expect(() : any => assertOfflineDeliveryVerdictHonest({
      verdict: "accepted",
      environmentBlockReason: null,
      summary: {
        contractFixtureUsed: true,
        exactBytesVerified: true,
        disconnectedTargetRan: true,
        imported: true,
        started: true,
        firstGovernedCall: true,
        stopped: true,
        cleanedUp: true,
        networkUsed: false,
        rebuilt: false,
        acceptanceMet: true,
        capacityCertified: false,
        publicationClaimed: false,
        nativeLinuxSupportClaimed: false,
      },
    })).toThrow(/fixture bytes cannot satisfy/);
  });

  it("does not accept a blocked environment even when a lifecycle runner is injected", async () : Promise<any> => {
    const result: any = await runOfflineDeliveryClosure({
      writeReport: false,
      runFocusedTests: false,
      commandRunner: async () : Promise<any> => ({ ok: true }),
    });
    expect(result.report.verdict).toBe("blocked_by_environment");
    expect(result.report.summary.imported).toBe(false);
    expect(result.report.summary.started).toBe(false);
    expect(result.report.summary.firstGovernedCall).toBe(false);
    expect(result.report.summary.disconnectedTargetRan).toBe(false);
    expect(result.report.summary.acceptanceMet).toBe(false);
  });

  it("builds a privacy-safe blocked report from producer and transfer evidence", async () : Promise<any> => {
    const outputRoot: any = await trackedTempRoot("meshrix-offline-delivery-report-");
    const produced: any = await produceOfflineDeliveryBundle({
      outputRoot,
      allowContractFixture: true,
    });
    const transferred: any = {
      exactBytesVerified: true,
      copiedFileCount: produced.bundle.files.length,
    };
    const report: any = buildOfflineDeliveryClosureReport({
      produced,
      transferred,
      environment: classifyOfflineDeliveryEnvironment({ platform: "darwin" }),
      lifecycle: { completed: false },
      extras: { generatedAt: "2026-08-14T00:00:00.000Z", finishedAt: "2026-08-14T00:00:00.000Z" },
    });
    expect(report.verdict).toBe("blocked_by_environment");
    expect(report.summary.hasInventory).toBe(true);
    expect(report.summary.hasSbom).toBe(true);
    expect(report.summary.hasProvenance).toBe(true);
    expect(report.summary.hasSignatures).toBe(true);
    expect(report.summary.hasInstructions).toBe(true);
    expect(containsSensitiveReportData(report)).toBe(false);
  });
});
