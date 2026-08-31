import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { reportPayloadDigest } from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";
import {
  assertCandidateWorktreeClean,
  buildReleaseCandidateIdentity
} from "../../../tools/server-scripts/verify-release-candidate-identity.ts";
import { PLATFORM_ACCEPTANCE_COMMANDS } from "../../../tools/server-scripts/lib/platform-acceptance-command-catalog.ts";
import { PLATFORM_ACCEPTANCE_STATE_MACHINE } from "../../../tools/server-scripts/lib/platform-acceptance-contract.ts";
import { acceptanceCriteria, layerStatus } from "../../../tools/server-scripts/lib/platform-acceptance-reducer.ts";
import {
  PLATFORM_ACCEPTANCE_REQUIREMENTS,
  PLATFORM_ACCEPTANCE_REQUIREMENT_EVIDENCE
} from "../../../tools/server-scripts/lib/platform-acceptance-requirement-evidence.ts";

import {
  ACCEPTANCE_FAILURE_DIAGNOSTIC_ROOT,
  ACCEPTANCE_FAILURE_ENVELOPE_SCHEMA,
  ACCEPTANCE_GENERATION_BUDGETS,
  ACCEPTANCE_GENERATION_POINTER,
  createAcceptanceGenerationWorkspace,
  publishAcceptanceGeneration,
  publishAcceptanceFailureDiagnostic,
  removeAcceptanceGenerationWorkspace,
  resolveCurrentAcceptanceGeneration,
  withAcceptanceExecutionLease
} from "../../../tools/server-scripts/lib/platform-acceptance-generation-store.ts";

const roots: any[] = [];
const RELEASE_EVIDENCE_INVENTORY: readonly any[] = Object.freeze([Object.freeze({
  reportPath: "build/reports/child.json",
  ownerCommandId: "child-verifier",
  producer: "tools/verify-child.ts",
  reportSchemaVersion: "fixture",
  timestampField: "generatedAt",
  reportLeakScanField: "summary.reportLeakScan",
  reducer: "tools/reduce-child.ts#createReadiness",
  provenanceSchemaVersion: "v0.0.1:meshrix:release-evidence-report-provenance-1"
})]);
function candidateIdentity(workspace?: any) : any {
  return buildReleaseCandidateIdentity({
    sourceRevision: String(git(workspace, ["rev-parse", "HEAD"])).trim(),
    repositoryTreeDigest: `sha256:${"1".repeat(64)}`,
    releaseDefinitionSha256: `sha256:${"2".repeat(64)}`,
    packageLockSha256: `sha256:${"3".repeat(64)}`,
    releasePackages: [{
      manifest_path: "package.json",
      name: "meshrix",
      version: "0.0.1",
      manifest_sha256: "4".repeat(64)
    }],
    supportedProfiles: ["enterprise-single-node"],
    reportInventoryDigest: reportPayloadDigest({ inventory: RELEASE_EVIDENCE_INVENTORY })
  });
}

async function fixtureRoot() : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-acceptance-generation-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".gitignore"),
    "/build/\n/local-workflow/\n/node_modules/\n",
    "utf8"
  );
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  git(root, ["init", "--quiet"]);
  git(root, ["add", ".gitignore", "package.json"]);
  git(root, [
    "-c",
    "user.name=Meshrix.js Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "candidate"
  ]);
  return root;
}

function git(repoRoot?: any, args: any[] = [], { binary = false }: Record<string, any> = {}) : any {
  const result: any = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: binary ? "buffer" : "utf8",
    windowsHide: true
  });
  expect(result.status).toBe(0);
  return result.stdout;
}

async function writeWorkerEvidence(workspace?: any, { includeChild = true, accepted = true }: Record<string, any> = {}) : Promise<any> {
  const identity: any = candidateIdentity(workspace);
  await fs.mkdir(path.join(workspace, "build", "reports"), { recursive: true });
  if (includeChild) {
    const child: Record<string, any> = {
      schemaVersion: "fixture",
      verifier: "tools/verify-child.ts",
      generatedAt: "2026-01-01T00:00:00.000Z"
    };
    child.releaseEvidenceProvenance = {
      schemaVersion: "v0.0.1:meshrix:release-evidence-report-provenance-1",
      commandId: "child-verifier",
      producer: "tools/verify-child.ts",
      recordedAt: "2026-01-01T00:00:00.000Z",
      reportPayloadDigest: reportPayloadDigest(child)
    };
    await fs.writeFile(
      path.join(workspace, "build", "reports", "child.json"),
      `${JSON.stringify(child)}\n`,
      "utf8"
    );
  }
  const commandById: any = new Map<any, any>(PLATFORM_ACCEPTANCE_COMMANDS.map((command?: any) : any => [command.id, command]));
  const commandResults: any = PLATFORM_ACCEPTANCE_COMMANDS.map((command?: any) : any => ({
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
  const requirementNodes: any = PLATFORM_ACCEPTANCE_REQUIREMENTS.map((requirement?: any) : any => {
    const evidence: any = PLATFORM_ACCEPTANCE_REQUIREMENT_EVIDENCE[requirement];
    return {
      requirement,
      ready: true,
      commandIds: evidence.commandIds,
      reportPaths: [...new Set<any>(evidence.commandIds.flatMap(
        (commandId?: any) : any => commandById.get(commandId)?.ownedReports || []
      ))].sort(),
      aggregateFacts: evidence.aggregateFacts,
      reasons: []
    };
  });
  const requirementCount: any = PLATFORM_ACCEPTANCE_REQUIREMENTS.length;
  await fs.writeFile(
    path.join(workspace, "build", "reports", "platform-acceptance.json"),
    `${JSON.stringify({
      schemaVersion: "v0.0.1:acceptance:platform-report-3",
      acceptanceStandard: "functional-completeness",
      claim: "functional-complete",
      verifier: "tools/server-scripts/verify-platform-acceptance.ts",
      selectedProfile: "enterprise-single-node",
      sourceRevision: identity.source_revision,
      generatedAt: "2026-01-01T00:00:00.000Z",
      status: accepted ? "accepted" : "failed",
      stateMachine: {
        ...PLATFORM_ACCEPTANCE_STATE_MACHINE,
        currentState: accepted ? "accepted" : "failed",
        event: accepted ? "all_acceptance_criteria_ready" : "command_or_report_failed"
      },
      commandSchedule: { valid: true },
      commands: commandResults,
      acceptanceLayers: PLATFORM_ACCEPTANCE_STATE_MACHINE.parallelRegions.map(
        (layer?: any) : any => layerStatus(layer, commandResults)
      ),
      acceptanceCriteria: acceptanceCriteria([], {}, [], PLATFORM_ACCEPTANCE_COMMANDS)
        .map((criterion?: any) : any => ({ ...criterion, ready: true })),
      requiredReports: ["build/reports/child.json"],
      releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY,
      releaseEvidenceInventoryDigest: reportPayloadDigest({ inventory: RELEASE_EVIDENCE_INVENTORY }),
      candidate_digest: identity.candidate_digest,
      candidateIdentity: identity,
      finalCandidateIdentity: identity,
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
          schemaVersion: "v0.0.1:meshrix:acceptance-evidence-anchor-context-2",
          sourceRevision: identity.source_revision,
          selectedProfile: "enterprise-single-node",
          ownedReportsInventoryDigest: reportPayloadDigest({ inventory: RELEASE_EVIDENCE_INVENTORY }),
          candidateDigest: identity.candidate_digest,
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

function publishFixture(options?: any) : any {
  return publishAcceptanceGeneration({
    ...options,
    verifyLedgerAnchor: async () : Promise<any> => ({ ok: true })
  });
}

function resolveFixture(repoRoot?: any) : any {
  return resolveCurrentAcceptanceGeneration(repoRoot, {
    verifyLedgerAnchor: async () : Promise<any> => ({ ok: true })
  });
}

afterEach(async () : Promise<any> => {
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("platform acceptance generation store", () : any => {
  it("preserves clean Git evidence when the source is a detached worktree", async () : Promise<any> => {
    const fixture: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-acceptance-detached-"));
    roots.push(fixture);
    const repository: any = path.join(fixture, "repository");
    const detached: any = path.join(fixture, "detached");
    await fs.mkdir(path.join(repository, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(repository, ".gitignore"), "/build/\n/node_modules/\n", "utf8");
    await fs.writeFile(path.join(repository, "package.json"), "{}\n", "utf8");
    git(repository, ["init", "--quiet"]);
    git(repository, ["add", ".gitignore", "package.json"]);
    git(repository, [
      "-c",
      "user.name=Meshrix.js Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "candidate"
    ]);
    git(repository, ["worktree", "add", "--quiet", "--detach", detached, "HEAD"]);
    await fs.mkdir(path.join(detached, "node_modules"), { recursive: true });

    const paths: any = await createAcceptanceGenerationWorkspace(detached, {
      id: "detached-candidate"
    });
    try {
      const sourceRevision: any = await assertCandidateWorktreeClean({ repoRoot: paths.workspace });
      expect(sourceRevision).toMatch(/^[a-f0-9]{40}$/u);
      expect(await fs.realpath(String(git(paths.workspace, ["rev-parse", "--show-toplevel"])).trim()))
        .toBe(await fs.realpath(paths.workspace));
      expect(git(paths.workspace, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], { binary: true }).length)
        .toBeGreaterThan(0);

      await fs.mkdir(path.join(paths.workspace, "build", "reports"), { recursive: true });
      await fs.writeFile(path.join(paths.workspace, "build", "reports", "generated.json"), "{}\n", "utf8");
      await expect(assertCandidateWorktreeClean({ repoRoot: paths.workspace })).resolves.toBe(sourceRevision);

      await fs.writeFile(path.join(paths.workspace, "package.json"), "{\"changed\":true}\n", "utf8");
      await expect(assertCandidateWorktreeClean({ repoRoot: paths.workspace }))
        .rejects.toThrow("candidate_worktree_not_clean");
    } finally {
      await removeAcceptanceGenerationWorkspace(paths, { repoRoot: detached });
    }
  });

  it("holds one repository-wide execution lease before generation work", async () : Promise<any> => {
    const repoRoot: any = await fixtureRoot();
    let releaseFirst: any;
    let firstAcquired: any;
    const acquired: any = new Promise((resolve?: any) : any => { firstAcquired = resolve; });
    const hold: any = new Promise((resolve?: any) : any => { releaseFirst = resolve; });
    const first: any = withAcceptanceExecutionLease(repoRoot, async () : Promise<any> => {
      firstAcquired();
      await hold;
      return "first-complete";
    });
    await acquired;
    await expect(withAcceptanceExecutionLease(repoRoot, async () : Promise<any> => "second"))
      .rejects.toMatchObject({ code: "platform_acceptance_execution_lease_held" });
    releaseFirst();
    await expect(first).resolves.toBe("first-complete");
    await expect(withAcceptanceExecutionLease(repoRoot, async () : Promise<any> => "next"))
      .resolves.toBe("next");
  });

  it("publishes an immutable generation and resolves it through one atomic pointer", async () : Promise<any> => {
    const repoRoot: any = await fixtureRoot();
    const paths: any = await createAcceptanceGenerationWorkspace(repoRoot, { id: "accepted-generation" });
    await writeWorkerEvidence(paths.workspace);

    const publication: any = await publishFixture({
      repoRoot,
      paths,
      requiredReports: ["build/reports/child.json"],
      aggregateReportPath: "build/reports/platform-acceptance.json",
      releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY
    });
    await removeAcceptanceGenerationWorkspace(paths);

    expect(publication.manifest.entries.map((entry?: any) : any => entry.path)).toEqual([
      "build/reports/child.json",
      "build/reports/platform-acceptance.json"
    ]);
    const current: any = await resolveFixture(repoRoot);
    expect(current.pointer.generationId).toBe("accepted-generation");
    expect(current.manifest.generationId).toBe("accepted-generation");
    expect(current.manifest.selectedProfile).toBe("enterprise-single-node");
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

  it("preserves the previous generation when a replacement is incomplete or non-ready", async () : Promise<any> => {
    const repoRoot: any = await fixtureRoot();
    await fs.mkdir(path.join(repoRoot, "build", "reports"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "build", "reports", "live-sentinel.json"),
      "{\"preserved\":true}\n",
      "utf8"
    );
    await fs.mkdir(path.join(repoRoot, "local-workflow"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "local-workflow", "state.json"), "[]\n", "utf8");
    const first: any = await createAcceptanceGenerationWorkspace(repoRoot, { id: "first-generation" });
    await expect(fs.readFile(path.join(first.workspace, "build", "reports", "live-sentinel.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(first.workspace, "local-workflow", "state.json"), "utf8"))
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
    const originalPointer: any = await fs.readFile(path.join(repoRoot, ACCEPTANCE_GENERATION_POINTER), "utf8");

    const incomplete: any = await createAcceptanceGenerationWorkspace(repoRoot, { id: "incomplete-generation" });
    await writeWorkerEvidence(incomplete.workspace, { includeChild: false });
    await expect(publishFixture({
      repoRoot,
      paths: incomplete,
      requiredReports: ["build/reports/child.json"],
      aggregateReportPath: "build/reports/platform-acceptance.json",
      releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY
    })).rejects.toThrow();
    await removeAcceptanceGenerationWorkspace(incomplete);

    const failed: any = await createAcceptanceGenerationWorkspace(repoRoot, { id: "failed-generation" });
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
    const current: any = await resolveFixture(repoRoot);
    expect(current.pointer.generationId).toBe("first-generation");
  });

  it("retains a failed aggregate across workspace cleanup without moving the accepted pointer", async () : Promise<any> => {
    const repoRoot: any = await fixtureRoot();
    const accepted: any = await createAcceptanceGenerationWorkspace(repoRoot, { id: "accepted-before-failure" });
    await writeWorkerEvidence(accepted.workspace);
    await publishFixture({
      repoRoot,
      paths: accepted,
      requiredReports: ["build/reports/child.json"],
      aggregateReportPath: "build/reports/platform-acceptance.json",
      releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY
    });
    await removeAcceptanceGenerationWorkspace(accepted);
    const pointerBeforeFailure: any = await fs.readFile(
      path.join(repoRoot, ACCEPTANCE_GENERATION_POINTER),
      "utf8"
    );

    const failed: any = await createAcceptanceGenerationWorkspace(repoRoot, { id: "retained-failure" });
    const failedWorkspace: any = failed.workspace;
    await writeWorkerEvidence(failed.workspace, { accepted: false });
    const diagnostic: any = await publishAcceptanceFailureDiagnostic({
      repoRoot,
      paths: failed,
      aggregateReportPath: "build/reports/platform-acceptance.json",
      workerResult: { exitCode: 1, signal: "" }
    });
    await removeAcceptanceGenerationWorkspace(failed, { repoRoot });

    expect(diagnostic).toEqual({
      generationId: "retained-failure",
      kind: "failure-envelope",
      path: `${ACCEPTANCE_FAILURE_DIAGNOSTIC_ROOT}/retained-failure/failure.json`
    });
    await expect(fs.access(failedWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
    const retained: any = JSON.parse(await fs.readFile(path.join(repoRoot, diagnostic.path), "utf8"));
    expect(retained.status).toBe("failed");
    expect(await fs.readFile(path.join(repoRoot, ACCEPTANCE_GENERATION_POINTER), "utf8"))
      .toBe(pointerBeforeFailure);
    expect((await resolveFixture(repoRoot)).pointer.generationId).toBe("accepted-before-failure");
  });

  it("rejects a privacy-unsafe failed aggregate and still permits workspace cleanup", async () : Promise<any> => {
    const repoRoot: any = await fixtureRoot();
    const failed: any = await createAcceptanceGenerationWorkspace(repoRoot, { id: "privacy-rejected" });
    const failedWorkspace: any = failed.workspace;
    try {
      await writeWorkerEvidence(failed.workspace, { accepted: false });
      const aggregatePath: any = path.join(failed.workspace, "build", "reports", "platform-acceptance.json");
      const aggregate: any = JSON.parse(await fs.readFile(aggregatePath, "utf8"));
      aggregate.summary.missingEvidence = [[
        "https://",
        "operator",
        ":",
        "private-value",
        "@service.example.test/api"
      ].join("")];
      await fs.writeFile(aggregatePath, `${JSON.stringify(aggregate)}\n`, "utf8");

      await expect(publishAcceptanceFailureDiagnostic({
        repoRoot,
        paths: failed,
        aggregateReportPath: "build/reports/platform-acceptance.json",
        workerResult: { exitCode: 1, signal: "" }
      })).rejects.toThrow("contains sensitive data: url_credentials");
      await expect(fs.access(path.join(repoRoot, ACCEPTANCE_FAILURE_DIAGNOSTIC_ROOT, "privacy-rejected")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeAcceptanceGenerationWorkspace(failed, { repoRoot });
    }
    await expect(fs.access(failedWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a schema-closed worker exit receipt and prunes failures deterministically", async () : Promise<any> => {
    const repoRoot: any = await fixtureRoot();
    const ids: any[] = [];
    for (let index: any = 0; index < ACCEPTANCE_GENERATION_BUDGETS.maxRetainedFailures + 2; index += 1) {
      const id: any = `worker-failure-${String(index).padStart(2, "0")}`;
      ids.push(id);
      const failed: any = await createAcceptanceGenerationWorkspace(repoRoot, { id });
      try {
        const diagnostic: any = await publishAcceptanceFailureDiagnostic({
          repoRoot,
          paths: failed,
          aggregateReportPath: "build/reports/platform-acceptance.json",
          workerResult: { exitCode: 17, signal: "SIGTERM" }
        });
        expect(diagnostic.kind).toBe("failure-envelope");
      } finally {
        await removeAcceptanceGenerationWorkspace(failed, { repoRoot });
      }
    }

    const failureRoot: any = path.join(repoRoot, ACCEPTANCE_FAILURE_DIAGNOSTIC_ROOT);
    const retainedIds: any[] = (await fs.readdir(failureRoot, { withFileTypes: true }))
      .filter((entry?: any) : any => entry.isDirectory())
      .map((entry?: any) : any => entry.name)
      .sort();
    expect(retainedIds).toEqual(ids.slice(-ACCEPTANCE_GENERATION_BUDGETS.maxRetainedFailures));

    const receiptPath: any = path.join(failureRoot, ids.at(-1), "failure.json");
    const receiptText: any = await fs.readFile(receiptPath, "utf8");
    const receipt: any = JSON.parse(receiptText);
    expect(Object.keys(receipt).sort()).toEqual([
      "aggregatePresent",
      "candidateDigest",
      "errorCode",
      "exitCode",
      "generationId",
      "phase",
      "schemaVersion",
      "selectedProfile",
      "signal",
      "sourceRevision",
      "status"
    ]);
    expect(receipt).toEqual({
      schemaVersion: ACCEPTANCE_FAILURE_ENVELOPE_SCHEMA,
      generationId: ids.at(-1),
      status: "failed",
      sourceRevision: String(git(repoRoot, ["rev-parse", "HEAD"])).trim(),
      candidateDigest: "",
      selectedProfile: "",
      phase: "worker",
      errorCode: "acceptance_worker_signalled",
      exitCode: 17,
      signal: "SIGTERM",
      aggregatePresent: false
    });
    expect(Buffer.byteLength(receiptText, "utf8")).toBeLessThan(512);
  });

  it("rejects a stale concurrent publisher without replacing the current generation", async () : Promise<any> => {
    const repoRoot: any = await fixtureRoot();
    const first: any = await createAcceptanceGenerationWorkspace(repoRoot, { id: "concurrent-first" });
    const stale: any = await createAcceptanceGenerationWorkspace(repoRoot, { id: "concurrent-stale" });
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

    const current: any = await resolveFixture(repoRoot);
    expect(current.pointer.generationId).toBe("concurrent-first");
    await expect(fs.access(path.join(repoRoot, "build", "acceptance-evidence", "generations", "concurrent-stale")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await Promise.all([removeAcceptanceGenerationWorkspace(first), removeAcceptanceGenerationWorkspace(stale)]);
  });

  it("rejects report provenance tampering at the publication boundary", async () : Promise<any> => {
    const repoRoot: any = await fixtureRoot();
    const paths: any = await createAcceptanceGenerationWorkspace(repoRoot, { id: "tampered-provenance" });
    await writeWorkerEvidence(paths.workspace);
    const childPath: any = path.join(paths.workspace, "build", "reports", "child.json");
    const child: any = JSON.parse(await fs.readFile(childPath, "utf8"));
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

  it("rejects aggregate boolean spoofing and a ledger event that cannot be reverified", async () : Promise<any> => {
    const repoRoot: any = await fixtureRoot();
    const spoofed: any = await createAcceptanceGenerationWorkspace(repoRoot, { id: "spoofed-aggregate" });
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

    const remapped: any = await createAcceptanceGenerationWorkspace(repoRoot, { id: "remapped-requirements" });
    await writeWorkerEvidence(remapped.workspace);
    const aggregatePath: any = path.join(remapped.workspace, "build", "reports", "platform-acceptance.json");
    const aggregate: any = JSON.parse(await fs.readFile(aggregatePath, "utf8"));
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

    const unverifiable: any = await createAcceptanceGenerationWorkspace(repoRoot, { id: "unverifiable-ledger" });
    await writeWorkerEvidence(unverifiable.workspace);
    await expect(publishAcceptanceGeneration({
      repoRoot,
      paths: unverifiable,
      requiredReports: ["build/reports/child.json"],
      aggregateReportPath: "build/reports/platform-acceptance.json",
      releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY,
      verifyLedgerAnchor: async () : Promise<any> => ({ ok: false })
    })).rejects.toThrow("aggregate contract is invalid: ledger-anchor-verification");
    await removeAcceptanceGenerationWorkspace(unverifiable);
  });

  it("detects manifest mutation through the atomic pointer digest", async () : Promise<any> => {
    const repoRoot: any = await fixtureRoot();
    const paths: any = await createAcceptanceGenerationWorkspace(repoRoot, { id: "manifest-digest" });
    await writeWorkerEvidence(paths.workspace);
    await publishFixture({
      repoRoot,
      paths,
      requiredReports: ["build/reports/child.json"],
      aggregateReportPath: "build/reports/platform-acceptance.json",
      releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY
    });
    const current: any = await resolveFixture(repoRoot);
    const manifestPath: any = path.join(current.generationRoot, "manifest.json");
    const manifest: any = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.selectedProfile = "any";
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    await expect(resolveFixture(repoRoot))
      .rejects.toThrow("manifest digest does not match its pointer");
    await removeAcceptanceGenerationWorkspace(paths);
  });

  it("revalidates aggregate semantics even when an attacker rewrites every file digest", async () : Promise<any> => {
    const repoRoot: any = await fixtureRoot();
    const paths: any = await createAcceptanceGenerationWorkspace(repoRoot, { id: "aggregate-revalidation" });
    await writeWorkerEvidence(paths.workspace);
    await publishFixture({
      repoRoot,
      paths,
      requiredReports: ["build/reports/child.json"],
      aggregateReportPath: "build/reports/platform-acceptance.json",
      releaseEvidenceInventory: RELEASE_EVIDENCE_INVENTORY
    });
    const current: any = await resolveFixture(repoRoot);
    const aggregatePath: any = path.join(current.generationRoot, "build", "reports", "platform-acceptance.json");
    const aggregate: any = JSON.parse(await fs.readFile(aggregatePath, "utf8"));
    aggregate.summary.releaseReady = false;
    const aggregateBytes: any = Buffer.from(`${JSON.stringify(aggregate)}\n`);
    await fs.writeFile(aggregatePath, aggregateBytes);

    const manifestPath: any = path.join(current.generationRoot, "manifest.json");
    const manifest: any = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const entry: any = manifest.entries.find((candidate?: any) : any => candidate.path === "build/reports/platform-acceptance.json");
    entry.sha256 = crypto.createHash("sha256").update(aggregateBytes).digest("hex");
    entry.byteLength = aggregateBytes.byteLength;
    const manifestBytes: any = Buffer.from(`${JSON.stringify(manifest)}\n`);
    await fs.writeFile(manifestPath, manifestBytes);

    const pointerPath: any = path.join(repoRoot, ACCEPTANCE_GENERATION_POINTER);
    const pointer: any = JSON.parse(await fs.readFile(pointerPath, "utf8"));
    pointer.manifestSha256 = crypto.createHash("sha256").update(manifestBytes).digest("hex");
    await fs.writeFile(pointerPath, `${JSON.stringify(pointer)}\n`, "utf8");

    await expect(resolveFixture(repoRoot))
      .rejects.toThrow("aggregate contract is invalid: summary-readiness");
    await removeAcceptanceGenerationWorkspace(paths);
  });
});
