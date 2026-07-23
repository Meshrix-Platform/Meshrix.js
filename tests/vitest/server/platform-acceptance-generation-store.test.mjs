import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { reportPayloadDigest } from "../../../packages/foundation/src/observability/sensitive-report-scan.mjs";
import { PLATFORM_ACCEPTANCE_COMMANDS } from "../../../tools/server-scripts/lib/platform-acceptance-command-catalog.mjs";
import { PLATFORM_ACCEPTANCE_STATE_MACHINE } from "../../../tools/server-scripts/lib/platform-acceptance-contract.mjs";
import { acceptanceCriteria, layerStatus } from "../../../tools/server-scripts/lib/platform-acceptance-reducer.mjs";
import {
  PLATFORM_ACCEPTANCE_REQUIREMENTS,
  PLATFORM_ACCEPTANCE_REQUIREMENT_EVIDENCE
} from "../../../tools/server-scripts/lib/platform-acceptance-requirement-evidence.mjs";

import {
  ACCEPTANCE_GENERATION_POINTER,
  createAcceptanceGenerationWorkspace,
  publishAcceptanceGeneration,
  removeAcceptanceGenerationWorkspace,
  resolveCurrentAcceptanceGeneration,
  withAcceptanceExecutionLease
} from "../../../tools/server-scripts/lib/platform-acceptance-generation-store.mjs";

const roots = [];
const RELEASE_EVIDENCE_INVENTORY = Object.freeze([Object.freeze({
  reportPath: "build/reports/child.json",
  ownerCommandId: "child-verifier",
  producer: "tools/verify-child.mjs",
  reportSchemaVersion: "fixture",
  timestampField: "generatedAt",
  reportLeakScanField: "summary.reportLeakScan",
  reducer: "tools/reduce-child.mjs#createReadiness",
  provenanceSchemaVersion: "licomesh.release-evidence.report-provenance.v1"
})]);

async function fixtureRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lico-acceptance-generation-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  return root;
}

async function writeWorkerEvidence(workspace, { includeChild = true, accepted = true } = {}) {
  await fs.mkdir(path.join(workspace, "build", "reports"), { recursive: true });
  if (includeChild) {
    const child = {
      schemaVersion: "fixture",
      verifier: "tools/verify-child.mjs",
      generatedAt: "2026-01-01T00:00:00.000Z"
    };
    child.releaseEvidenceProvenance = {
      schemaVersion: "licomesh.release-evidence.report-provenance.v1",
      commandId: "child-verifier",
      producer: "tools/verify-child.mjs",
      recordedAt: "2026-01-01T00:00:00.000Z",
      reportPayloadDigest: reportPayloadDigest(child)
    };
    await fs.writeFile(
      path.join(workspace, "build", "reports", "child.json"),
      `${JSON.stringify(child)}\n`,
      "utf8"
    );
  }
  const commandById = new Map(PLATFORM_ACCEPTANCE_COMMANDS.map((command) => [command.id, command]));
  const commandResults = PLATFORM_ACCEPTANCE_COMMANDS.map((command) => ({
    id: command.id,
    label: command.label,
    acceptanceLayer: command.acceptanceLayer,
    status: "passed",
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    report: command.report,
    dependsOn: command.dependsOn,
    resourceLocks: command.resourceLocks,
    blockedExitCodes: command.blockedExitCodes,
    exclusive: command.exclusive
  }));
  const requirementNodes = PLATFORM_ACCEPTANCE_REQUIREMENTS.map((requirement) => {
    const evidence = PLATFORM_ACCEPTANCE_REQUIREMENT_EVIDENCE[requirement];
    return {
      requirement,
      ready: true,
      commandIds: evidence.commandIds,
      reportPaths: [...new Set(evidence.commandIds.flatMap(
        (commandId) => commandById.get(commandId)?.ownedReports || []
      ))].sort(),
      aggregateFacts: evidence.aggregateFacts,
      reasons: []
    };
  });
  const requirementCount = PLATFORM_ACCEPTANCE_REQUIREMENTS.length;
  await fs.writeFile(
    path.join(workspace, "build", "reports", "platform-acceptance.json"),
    `${JSON.stringify({
      schemaVersion: "v0.0.1:acceptance:platform-report-2",
      verifier: "tools/server-scripts/verify-platform-acceptance.mjs",
      selectedProfile: "core",
      status: accepted ? "accepted" : "failed",
      stateMachine: {
        ...PLATFORM_ACCEPTANCE_STATE_MACHINE,
        currentState: accepted ? "accepted" : "failed",
        event: accepted ? "all_acceptance_criteria_ready" : "command_or_report_failed"
      },
      commandSchedule: { valid: true },
      commands: commandResults,
      acceptanceLayers: PLATFORM_ACCEPTANCE_STATE_MACHINE.parallelRegions.map(
        (layer) => layerStatus(layer, commandResults)
      ),
      acceptanceCriteria: acceptanceCriteria([], {}, [], PLATFORM_ACCEPTANCE_COMMANDS)
        .map((criterion) => ({ ...criterion, ready: true })),
      requiredReports: ["build/reports/child.json"],
      releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY,
      releaseEvidenceInventoryDigest: reportPayloadDigest({ inventory: RELEASE_EVIDENCE_INVENTORY }),
      planReceiptPreflight: {
        selectedProfile: "core",
        requiredReceiptCount: 1,
        bindings: [{}],
        planReceiptSetDigest: `sha256:${"b".repeat(64)}`
      },
      finalPlanReceiptPreflight: {
        selectedProfile: "core",
        requiredReceiptCount: 1,
        bindings: [{}],
        planReceiptSetDigest: `sha256:${"b".repeat(64)}`
      },
      reportEvidence: {
        "build/reports/child.json": {
          releaseReady: true,
          validationPassed: true,
          reportLeakScan: true
        }
      },
      capabilityEvidenceExecution: { ready: true },
      requirementEvidence: {
        ready: true,
        requirementCount,
        readyCount: requirementCount,
        nodes: requirementNodes
      },
      blockedCommandValidation: {
        validBlockedCommandIds: [],
        invalidBlockedCommandIds: []
      },
      ledgerAnchor: {
        ledgerEventId: "ledger-event",
        envelopeId: "envelope",
        workspaceId: "release:fixture",
        reportDigestCount: 1,
        reportDigests: [{
          path: "build/reports/child.json",
          schemaVersion: "fixture",
          contentHash: `sha256:${"c".repeat(64)}`
        }],
        evidenceContext: {
          selectedProfile: "core",
          ownedReportsInventoryDigest: reportPayloadDigest({ inventory: RELEASE_EVIDENCE_INVENTORY }),
          planReceiptSetDigest: `sha256:${"b".repeat(64)}`,
          privacySafe: true
        },
        error: "",
        skipped: false,
        verification: { ok: true }
      },
      summary: {
        releaseReady: accepted,
        reportLeakScan: true,
        allCommandsExecuted: true,
        ledgerAnchorReady: true,
        capabilityEvidenceExecutionReady: true,
        requirementEvidenceReady: true,
        failedCommandCount: 0,
        blockedCommandCount: 0,
        capabilityEvidenceExecutionFailureCount: 0,
        missingReportCount: 0,
        invalidReportCount: 0,
        missingEvidenceCount: 0,
        commandCount: commandResults.length,
        executedCommandCount: commandResults.length,
        requiredReportCount: 1
      }
    })}\n`,
    "utf8"
  );
}

function publishFixture(options) {
  return publishAcceptanceGeneration({
    ...options,
    verifyLedgerAnchor: async () => ({ ok: true })
  });
}

function resolveFixture(repoRoot) {
  return resolveCurrentAcceptanceGeneration(repoRoot, {
    verifyLedgerAnchor: async () => ({ ok: true })
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("platform acceptance generation store", () => {
  it("holds one repository-wide execution lease before generation work", async () => {
    const repoRoot = await fixtureRoot();
    let releaseFirst;
    let firstAcquired;
    const acquired = new Promise((resolve) => { firstAcquired = resolve; });
    const hold = new Promise((resolve) => { releaseFirst = resolve; });
    const first = withAcceptanceExecutionLease(repoRoot, async () => {
      firstAcquired();
      await hold;
      return "first-complete";
    });
    await acquired;
    await expect(withAcceptanceExecutionLease(repoRoot, async () => "second"))
      .rejects.toMatchObject({ code: "platform_acceptance_execution_lease_held" });
    releaseFirst();
    await expect(first).resolves.toBe("first-complete");
    await expect(withAcceptanceExecutionLease(repoRoot, async () => "next"))
      .resolves.toBe("next");
  });

  it("publishes an immutable generation and resolves it through one atomic pointer", async () => {
    const repoRoot = await fixtureRoot();
    const paths = await createAcceptanceGenerationWorkspace(repoRoot, { id: "accepted-generation" });
    await writeWorkerEvidence(paths.workspace);

    const publication = await publishFixture({
      repoRoot,
      paths,
      requiredReports: ["build/reports/child.json"],
      aggregateReportPath: "build/reports/platform-acceptance.json",
      releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY
    });
    await removeAcceptanceGenerationWorkspace(paths);

    expect(publication.manifest.entries.map((entry) => entry.path)).toEqual([
      "build/reports/child.json",
      "build/reports/platform-acceptance.json"
    ]);
    const current = await resolveFixture(repoRoot);
    expect(current.pointer.generationId).toBe("accepted-generation");
    expect(current.manifest.generationId).toBe("accepted-generation");
    expect(current.manifest.selectedProfile).toBe("core");
    expect(current.pointer.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(fs.readFile(path.join(repoRoot, "build", "reports", "child.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    await fs.writeFile(
      path.join(current.generationRoot, "build", "reports", "child.json"),
      "{\"tampered\":true}\n",
      "utf8"
    );
    await expect(resolveFixture(repoRoot))
      .rejects.toThrow("Acceptance generation entry digest mismatch");
  });

  it("preserves the previous generation when a replacement is incomplete or non-ready", async () => {
    const repoRoot = await fixtureRoot();
    await fs.mkdir(path.join(repoRoot, "build", "reports"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "build", "reports", "live-sentinel.json"),
      "{\"preserved\":true}\n",
      "utf8"
    );
    const first = await createAcceptanceGenerationWorkspace(repoRoot, { id: "first-generation" });
    await expect(fs.readFile(path.join(first.workspace, "build", "reports", "live-sentinel.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await writeWorkerEvidence(first.workspace);
    await publishFixture({
      repoRoot,
      paths: first,
      requiredReports: ["build/reports/child.json"],
      aggregateReportPath: "build/reports/platform-acceptance.json",
      releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY
    });
    await removeAcceptanceGenerationWorkspace(first);
    const originalPointer = await fs.readFile(path.join(repoRoot, ACCEPTANCE_GENERATION_POINTER), "utf8");

    const incomplete = await createAcceptanceGenerationWorkspace(repoRoot, { id: "incomplete-generation" });
    await writeWorkerEvidence(incomplete.workspace, { includeChild: false });
    await expect(publishFixture({
      repoRoot,
      paths: incomplete,
      requiredReports: ["build/reports/child.json"],
      aggregateReportPath: "build/reports/platform-acceptance.json",
      releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY
    })).rejects.toThrow();
    await removeAcceptanceGenerationWorkspace(incomplete);

    const failed = await createAcceptanceGenerationWorkspace(repoRoot, { id: "failed-generation" });
    await writeWorkerEvidence(failed.workspace, { accepted: false });
    await expect(publishFixture({
      repoRoot,
      paths: failed,
      requiredReports: ["build/reports/child.json"],
      aggregateReportPath: "build/reports/platform-acceptance.json",
      releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY
    })).rejects.toThrow("aggregate contract is invalid: status");
    await removeAcceptanceGenerationWorkspace(failed);

    expect(await fs.readFile(path.join(repoRoot, ACCEPTANCE_GENERATION_POINTER), "utf8"))
      .toBe(originalPointer);
    expect(await fs.readFile(path.join(repoRoot, "build", "reports", "live-sentinel.json"), "utf8"))
      .toBe("{\"preserved\":true}\n");
    const current = await resolveFixture(repoRoot);
    expect(current.pointer.generationId).toBe("first-generation");
  });

  it("rejects a stale concurrent publisher without replacing the current generation", async () => {
    const repoRoot = await fixtureRoot();
    const first = await createAcceptanceGenerationWorkspace(repoRoot, { id: "concurrent-first" });
    const stale = await createAcceptanceGenerationWorkspace(repoRoot, { id: "concurrent-stale" });
    await Promise.all([writeWorkerEvidence(first.workspace), writeWorkerEvidence(stale.workspace)]);

    await publishFixture({
      repoRoot,
      paths: first,
      requiredReports: ["build/reports/child.json"],
      aggregateReportPath: "build/reports/platform-acceptance.json",
      releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY
    });
    await expect(publishFixture({
      repoRoot,
      paths: stale,
      requiredReports: ["build/reports/child.json"],
      aggregateReportPath: "build/reports/platform-acceptance.json",
      releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY
    })).rejects.toThrow("publication fence rejected a stale run");

    const current = await resolveFixture(repoRoot);
    expect(current.pointer.generationId).toBe("concurrent-first");
    await expect(fs.access(path.join(repoRoot, "build", "acceptance-evidence", "generations", "concurrent-stale")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await Promise.all([removeAcceptanceGenerationWorkspace(first), removeAcceptanceGenerationWorkspace(stale)]);
  });

  it("rejects report provenance tampering at the publication boundary", async () => {
    const repoRoot = await fixtureRoot();
    const paths = await createAcceptanceGenerationWorkspace(repoRoot, { id: "tampered-provenance" });
    await writeWorkerEvidence(paths.workspace);
    const childPath = path.join(paths.workspace, "build", "reports", "child.json");
    const child = JSON.parse(await fs.readFile(childPath, "utf8"));
    child.releaseEvidenceProvenance.commandId = "different-owner";
    await fs.writeFile(childPath, `${JSON.stringify(child)}\n`, "utf8");

    await expect(publishFixture({
      repoRoot,
      paths,
      requiredReports: ["build/reports/child.json"],
      aggregateReportPath: "build/reports/platform-acceptance.json",
      releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY
    })).rejects.toThrow("report provenance is invalid");
    await removeAcceptanceGenerationWorkspace(paths);
  });

  it("rejects aggregate boolean spoofing and a ledger event that cannot be reverified", async () => {
    const repoRoot = await fixtureRoot();
    const spoofed = await createAcceptanceGenerationWorkspace(repoRoot, { id: "spoofed-aggregate" });
    await fs.mkdir(path.join(spoofed.workspace, "build", "reports"), { recursive: true });
    await fs.writeFile(
      path.join(spoofed.workspace, "build", "reports", "platform-acceptance.json"),
      `${JSON.stringify({ status: "accepted", summary: { releaseReady: true } })}\n`,
      "utf8"
    );
    await expect(publishFixture({
      repoRoot,
      paths: spoofed,
      requiredReports: ["build/reports/child.json"],
      aggregateReportPath: "build/reports/platform-acceptance.json",
      releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY
    })).rejects.toThrow("aggregate contract is invalid: schema");
    await removeAcceptanceGenerationWorkspace(spoofed);

    const remapped = await createAcceptanceGenerationWorkspace(repoRoot, { id: "remapped-requirements" });
    await writeWorkerEvidence(remapped.workspace);
    const aggregatePath = path.join(remapped.workspace, "build", "reports", "platform-acceptance.json");
    const aggregate = JSON.parse(await fs.readFile(aggregatePath, "utf8"));
    aggregate.requirementEvidence.nodes[0].requirement = "REQ-SYNTHETIC-001";
    await fs.writeFile(aggregatePath, `${JSON.stringify(aggregate)}\n`, "utf8");
    await expect(publishFixture({
      repoRoot,
      paths: remapped,
      requiredReports: ["build/reports/child.json"],
      aggregateReportPath: "build/reports/platform-acceptance.json",
      releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY
    })).rejects.toThrow("aggregate contract is invalid: requirement-label-binding");
    await removeAcceptanceGenerationWorkspace(remapped);

    const unverifiable = await createAcceptanceGenerationWorkspace(repoRoot, { id: "unverifiable-ledger" });
    await writeWorkerEvidence(unverifiable.workspace);
    await expect(publishAcceptanceGeneration({
      repoRoot,
      paths: unverifiable,
      requiredReports: ["build/reports/child.json"],
      aggregateReportPath: "build/reports/platform-acceptance.json",
      releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY,
      verifyLedgerAnchor: async () => ({ ok: false })
    })).rejects.toThrow("aggregate contract is invalid: ledger-anchor-verification");
    await removeAcceptanceGenerationWorkspace(unverifiable);
  });

  it("detects manifest mutation through the atomic pointer digest", async () => {
    const repoRoot = await fixtureRoot();
    const paths = await createAcceptanceGenerationWorkspace(repoRoot, { id: "manifest-digest" });
    await writeWorkerEvidence(paths.workspace);
    await publishFixture({
      repoRoot,
      paths,
      requiredReports: ["build/reports/child.json"],
      aggregateReportPath: "build/reports/platform-acceptance.json",
      releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY
    });
    const current = await resolveFixture(repoRoot);
    const manifestPath = path.join(current.generationRoot, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.selectedProfile = "any";
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    await expect(resolveFixture(repoRoot))
      .rejects.toThrow("manifest digest does not match its pointer");
    await removeAcceptanceGenerationWorkspace(paths);
  });

  it("revalidates aggregate semantics even when an attacker rewrites every file digest", async () => {
    const repoRoot = await fixtureRoot();
    const paths = await createAcceptanceGenerationWorkspace(repoRoot, { id: "aggregate-revalidation" });
    await writeWorkerEvidence(paths.workspace);
    await publishFixture({
      repoRoot,
      paths,
      requiredReports: ["build/reports/child.json"],
      aggregateReportPath: "build/reports/platform-acceptance.json",
      releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY
    });
    const current = await resolveFixture(repoRoot);
    const aggregatePath = path.join(current.generationRoot, "build", "reports", "platform-acceptance.json");
    const aggregate = JSON.parse(await fs.readFile(aggregatePath, "utf8"));
    aggregate.summary.releaseReady = false;
    const aggregateBytes = Buffer.from(`${JSON.stringify(aggregate)}\n`);
    await fs.writeFile(aggregatePath, aggregateBytes);

    const manifestPath = path.join(current.generationRoot, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const entry = manifest.entries.find((candidate) => candidate.path === "build/reports/platform-acceptance.json");
    entry.sha256 = crypto.createHash("sha256").update(aggregateBytes).digest("hex");
    entry.byteLength = aggregateBytes.byteLength;
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    await fs.writeFile(manifestPath, manifestBytes);

    const pointerPath = path.join(repoRoot, ACCEPTANCE_GENERATION_POINTER);
    const pointer = JSON.parse(await fs.readFile(pointerPath, "utf8"));
    pointer.manifestSha256 = crypto.createHash("sha256").update(manifestBytes).digest("hex");
    await fs.writeFile(pointerPath, `${JSON.stringify(pointer)}\n`, "utf8");

    await expect(resolveFixture(repoRoot))
      .rejects.toThrow("aggregate contract is invalid: summary-readiness");
    await removeAcceptanceGenerationWorkspace(paths);
  });
});
