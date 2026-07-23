import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { verifyMachineDefinition } from "../../../packages/foundation/src/workflow/state-machine/verification/state-machine-verifier.mjs";
import { reduceCapabilityCheckpoints as reduceCapabilityCheckpointsRaw } from "../../../tools/server-scripts/capability-acceptance-checkpoint-reducer.mjs";
import {
  CAPABILITY_EVIDENCE_COMMAND_AUTHORITY,
  capabilityAcceptanceExitCode,
  finalizeCapabilityAcceptanceReport,
  reduceCapabilityBlockers
} from "../../../tools/server-scripts/verify-capability-acceptance-machines.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const FIXTURE_EVIDENCE_COMMAND_AUTHORITY = new Map([
  ...CAPABILITY_EVIDENCE_COMMAND_AUTHORITY,
  ["fixture-command", { ownedReports: [] }],
  // Approval governance terminals are verified outside the platform DAG catalog in unit fixtures.
  ["approval-governance", { ownedReports: ["build/reports/approval-governance.json"] }]
]);

function reduceCapabilityCheckpoints(checkpoints, options = {}) {
  return reduceCapabilityCheckpointsRaw(checkpoints, {
    evidenceCommandAuthority: FIXTURE_EVIDENCE_COMMAND_AUTHORITY,
    ...options
  });
}

function criterion(checked = true, text = "Fixture acceptance criterion") {
  return {
    checked,
    text,
    ...(checked ? { evidence: [{ acceptanceCommandId: "fixture-command" }] } : {})
  };
}

function externalBlocker() {
  return {
    kind: "external-evidence",
    code: "supported-platform-receipt-missing",
    description: "A supported platform receipt must be produced outside this local verifier.",
    requiredEvidence: ["A schema-valid supported-platform receipt"],
    verificationCommand: "node tools/server-scripts/verify-supported-platform-receipt.mjs"
  };
}

function completedCheckpoints() {
  return [
    {
      id: "implementation",
      role: "implementation",
      status: "completed",
      prerequisites: [],
      acceptance_criteria: [criterion()]
    },
    {
      id: "final-validation",
      role: "final_validation",
      status: "completed",
      prerequisites: ["implementation"],
      acceptance_criteria: [criterion()]
    }
  ];
}

describe("reduceCapabilityCheckpoints", () => {
  it("marks a complete and valid checkpoint graph ready for release reduction", () => {
    const result = reduceCapabilityCheckpoints(completedCheckpoints());

    expect(result).toMatchObject({
      currentState: "verified",
      readyForReleaseReduction: true,
      blocked: false,
      failureKind: "",
      checkpointCount: 2,
      completedCheckpointCount: 2,
      openCheckpoints: [],
      uncheckedCriteria: [],
      reasons: [],
      findings: []
    });
    expect(result).not.toHaveProperty("releaseReady");
  });

  it("treats pending local work as failed and not as an external blocker", () => {
    const checkpoints = completedCheckpoints().map((checkpoint) => ({
      ...checkpoint,
      status: "pending",
      acceptance_criteria: [criterion(false)]
    }));

    const result = reduceCapabilityCheckpoints(checkpoints);

    expect(result.currentState).toBe("failed");
    expect(result.readyForReleaseReduction).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.failureKind).toBe("local-checkpoint-incomplete");
    expect(result.openCheckpoints).toHaveLength(2);
    expect(result.uncheckedCriteria).toHaveLength(2);
    expect(result.findings.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "checkpoint-not-completed",
      "checkpoint-acceptance-criterion-unchecked"
    ]));
  });

  it("fails closed on an unsupported checkpoint status", () => {
    const checkpoints = completedCheckpoints();
    checkpoints[0].status = "accepted";

    const result = reduceCapabilityCheckpoints(checkpoints);

    expect(result.currentState).toBe("failed");
    expect(result.readyForReleaseReduction).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "checkpoint-status-invalid",
        checkpointId: "implementation"
      }),
      expect.objectContaining({
        code: "checkpoint-not-completed",
        checkpointId: "implementation"
      })
    ]));
  });

  it("fails closed when a criterion is unchecked or malformed", () => {
    const checkpoints = completedCheckpoints();
    checkpoints[0].acceptance_criteria = [criterion(false)];
    checkpoints[1].acceptance_criteria = [{ checked: true, text: "" }];

    const result = reduceCapabilityCheckpoints(checkpoints);

    expect(result.readyForReleaseReduction).toBe(false);
    expect(result.uncheckedCriteria).toEqual([
      expect.objectContaining({
        checkpointId: "implementation",
        role: "implementation",
        criterionIndex: 0,
        reason: "criterion-not-checked"
      }),
      expect.objectContaining({
        checkpointId: "final-validation",
        role: "final_validation",
        criterionIndex: 0,
        reason: "criterion-invalid"
      })
    ]);
    expect(result.findings.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "checkpoint-acceptance-criterion-unchecked",
      "checkpoint-acceptance-criterion-invalid"
    ]));
  });

  it("requires reproducible evidence for completed implementation and validation criteria", () => {
    const checkpoints = completedCheckpoints();
    checkpoints[0].acceptance_criteria = [{ checked: true, text: "Claim without evidence" }];

    const result = reduceCapabilityCheckpoints(checkpoints);

    expect(result.readyForReleaseReduction).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "checkpoint-criterion-evidence-missing",
        checkpointId: "implementation"
      })
    ]));
  });

  it("rejects unknown command ids instead of accepting arbitrary command claims", () => {
    const checkpoints = completedCheckpoints();
    checkpoints[1].acceptance_criteria = [{
      checked: true,
      text: "Unknown command result",
      evidence: [{ acceptanceCommandId: "unknown-command" }]
    }];

    const result = reduceCapabilityCheckpoints(checkpoints);

    expect(result.readyForReleaseReduction).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "checkpoint-criterion-evidence-command-id-unknown",
        checkpointId: "final-validation"
      })
    ]));
  });

  it("distinguishes a structured external evidence blocker from local incomplete work", () => {
    const checkpoints = completedCheckpoints();
    checkpoints[0].status = "blocked";
    checkpoints[0].acceptance_criteria = [{
      checked: false,
      text: "Supported platform receipt exists",
      blocker: externalBlocker()
    }];
    checkpoints[1].status = "blocked";
    checkpoints[1].acceptance_criteria = [{
      checked: false,
      text: "Supported platform receipt is reduced",
      blocker: externalBlocker()
    }];

    const result = reduceCapabilityCheckpoints(checkpoints);

    expect(result).toMatchObject({
      currentState: "blocked",
      readyForReleaseReduction: false,
      blocked: true,
      failureKind: "external-evidence-missing",
      findings: []
    });
    expect(result.blockers).toHaveLength(2);
    expect(result.uncheckedCriteria).toEqual([
      expect.objectContaining({ reason: "external-evidence-missing" }),
      expect.objectContaining({ reason: "external-evidence-missing" })
    ]);
  });

  it("fails closed when blocked status has no valid external evidence blocker", () => {
    const checkpoints = completedCheckpoints();
    checkpoints[0].status = "blocked";
    checkpoints[0].acceptance_criteria = [criterion(false)];
    checkpoints[1].status = "blocked";
    checkpoints[1].acceptance_criteria = [criterion(false)];

    const result = reduceCapabilityCheckpoints(checkpoints);

    expect(result.currentState).toBe("failed");
    expect(result.blocked).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "checkpoint-blocked-without-external-evidence" })
    ]));
  });

  it("rejects missing prerequisites and impossible completion order", () => {
    const checkpoints = completedCheckpoints();
    checkpoints[0].status = "pending";
    checkpoints[1].prerequisites = ["implementation", "missing-checkpoint"];

    const result = reduceCapabilityCheckpoints(checkpoints);

    expect(result.readyForReleaseReduction).toBe(false);
    expect(result.failureKind).toBe("invalid-checkpoint-graph");
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "checkpoint-prerequisite-missing",
        checkpointId: "final-validation",
        prerequisiteId: "missing-checkpoint"
      }),
      expect.objectContaining({
        code: "checkpoint-completed-before-prerequisite",
        checkpointId: "final-validation",
        prerequisiteId: "implementation"
      })
    ]));
  });

  it("rejects prerequisite cycles", () => {
    const checkpoints = completedCheckpoints();
    checkpoints[0].prerequisites = ["final-validation"];

    const result = reduceCapabilityCheckpoints(checkpoints);

    expect(result.readyForReleaseReduction).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "checkpoint-prerequisite-cycle" })
    ]));
  });

  it("requires implementation and final-validation roles", () => {
    const result = reduceCapabilityCheckpoints([
      {
        id: "evidence",
        role: "evidence",
        status: "completed",
        prerequisites: [],
        acceptance_criteria: [criterion()]
      }
    ]);

    expect(result.readyForReleaseReduction).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "required-checkpoint-role-missing",
        role: "implementation"
      }),
      expect.objectContaining({
        code: "required-checkpoint-role-missing",
        role: "final_validation"
      })
    ]));
  });

  it("requires exactly one implementation and final-validation role", () => {
    const checkpoints = completedCheckpoints();
    checkpoints.push({
      ...checkpoints[1],
      id: "second-final-validation"
    });

    const result = reduceCapabilityCheckpoints(checkpoints);

    expect(result.readyForReleaseReduction).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "required-checkpoint-role-duplicate",
        role: "final_validation"
      })
    ]));
  });

  it("requires final validation to transitively depend on implementation", () => {
    const checkpoints = completedCheckpoints();
    checkpoints[1].prerequisites = [];

    const result = reduceCapabilityCheckpoints(checkpoints);

    expect(result.readyForReleaseReduction).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "final-validation-missing-implementation-dependency",
        checkpointId: "final-validation",
        prerequisiteId: "implementation"
      })
    ]));
  });

  it("allows callers to inject a different required-role fixture", () => {
    const result = reduceCapabilityCheckpoints([
      {
        id: "evidence",
        role: "evidence",
        status: "completed",
        prerequisites: [],
        acceptance_criteria: [criterion()]
      }
    ], {
      requiredRoles: ["evidence"]
    });

    expect(result.readyForReleaseReduction).toBe(true);
  });
});

describe("capability acceptance authority and report safety", () => {
  it("rejects unknown proof methods, incomplete parameters, and unprotected verification edges", () => {
    const definition = JSON.parse(fs.readFileSync(
      path.join(ROOT, "packages/foundation/src/workflow/state-machine/definitions/acceptance/state-machine-governance.json"),
      "utf8"
    ));

    const unknownMethod = structuredClone(definition);
    unknownMethod.proofMappings[0].method = "not_a_real_verifier";
    expect(verifyMachineDefinition(unknownMethod, { throwOnError: false }).ok).toBe(false);

    const missingParams = structuredClone(definition);
    missingParams.proofMappings[0].params = {};
    expect(verifyMachineDefinition(missingParams, { throwOnError: false }).ok).toBe(false);

    const unprotected = structuredClone(definition);
    const event = unprotected.events.find((item) => item.id === "capability_verifiers_pass");
    event.riskLevel = "medium";
    const cell = unprotected.totalMatrix.find((item) =>
      item.from === "implemented" && item.event === "capability_verifiers_pass"
    );
    cell.result = "legal_transition";
    delete cell.sideEffects;
    expect(verifyMachineDefinition(unprotected, { throwOnError: false }).ok).toBe(false);
  });

  it("uses only tracked checkpoint authorities, not ignored local plan files", () => {
    const registry = JSON.parse(fs.readFileSync(
      path.join(ROOT, "tools/registry/capability-acceptance.registry.json"),
      "utf8"
    ));

    expect(registry.entries.length).toBeGreaterThan(0);
    for (const entry of registry.entries) {
      expect(entry).not.toHaveProperty("planPath");
      expect(entry.platformReducerCommand).toBe("npm run verify:acceptance");
      expect(entry.checkpointPath).toMatch(
        /^tools\/registry\/capability-acceptance-checkpoints\/[a-z0-9-]+\.json$/u
      );
      expect(fs.existsSync(path.join(ROOT, entry.checkpointPath))).toBe(true);

      const definition = JSON.parse(fs.readFileSync(path.join(ROOT, entry.definitionPath), "utf8"));
      expect(definition.states.map(({ id }) => id)).toEqual([
        "planned",
        "implemented",
        "verified",
        "blocked",
        "failed"
      ]);
      expect(definition.states.find(({ id }) => id === "verified")?.terminal).toBe(true);
      expect(definition.acceptance.platformReducerCommand).toBe("npm run verify:acceptance");
    }

    for (const relativePath of [
      "tools/generators/generate-capability-acceptance-definitions.mjs",
      "tools/server-scripts/verify-capability-acceptance-machines.mjs"
    ]) {
      const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
      expect(source).not.toContain("planPath");
    }
  });

  it("sets reportLeakScan only after the report has actually been scanned", () => {
    const observedFlags = [];
    const report = { summary: { reportLeakScan: true } };

    const finalized = finalizeCapabilityAcceptanceReport(report, (candidate) => {
      observedFlags.push(candidate.summary.reportLeakScan);
    });

    expect(observedFlags).toEqual([false, true]);
    expect(finalized.summary.reportLeakScan).toBe(true);
  });

  it("uses exit code 2 only for a structurally legal blocked report", () => {
    expect(capabilityAcceptanceExitCode({
      currentState: "blocked",
      blocked: true,
      findings: [],
      blockers: [{ kind: "owner-decision" }],
      summary: { failedCapabilityCount: 0 }
    })).toBe(1);
    expect(capabilityAcceptanceExitCode({
      currentState: "blocked",
      blocked: true,
      findings: [],
      blockers: [{ kind: "local-implementation" }],
      summary: { failedCapabilityCount: 0 }
    })).toBe(1);
    expect(capabilityAcceptanceExitCode({
      currentState: "failed",
      blocked: false,
      findings: [],
      blockers: [],
      summary: { failedCapabilityCount: 1 }
    })).toBe(1);
  });

  it("deduplicates one external blocker referenced by implementation and validation checkpoints", () => {
    const shared = externalBlocker();
    const blockers = reduceCapabilityBlockers([{
      capabilityId: "fixture-capability",
      blockers: [
        { ...shared, checkpointId: "implementation", role: "implementation", criterionIndex: 0 },
        { ...shared, checkpointId: "validation", role: "final_validation", criterionIndex: 0 }
      ]
    }]);

    expect(blockers).toEqual([
      expect.objectContaining({
        capabilityId: "fixture-capability",
        code: shared.code,
        checkpointRefs: [
          { checkpointId: "implementation", role: "implementation", criterionIndex: 0 },
          { checkpointId: "validation", role: "final_validation", criterionIndex: 0 }
        ]
      })
    ]);
  });
});
