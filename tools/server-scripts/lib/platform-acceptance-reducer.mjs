/**
 * Pure platform-acceptance status, blocked-command, capability-evidence,
 * layer, criteria, and child leak-scan reducers.
 */

import {
  ACCEPTANCE_REQUIRED_REPORTS,
  PLATFORM_ACCEPTANCE_COMMANDS
} from "./platform-acceptance-command-catalog.mjs";

export const RELEASE_EVIDENCE_STATES = Object.freeze([
  "current",
  "pending",
  "blocked",
  "failed",
  "skipped",
  "stale",
  "missing",
  "privacy-unsafe"
]);

const DEPENDENCY_STATE = Object.freeze({
  "privacy-unsafe": "privacy-unsafe",
  missing: "missing",
  stale: "stale",
  failed: "skipped",
  blocked: "blocked",
  skipped: "skipped",
  pending: "pending"
});

function uniqueText(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function directCommandEvidenceState(command, result, reportEvidence) {
  if (!result) return { state: "pending", reasons: [`command-pending:${command.id}`] };
  if (result.status === "blocked") return { state: "blocked", reasons: result.reasonChain || [`command-blocked:${command.id}`] };
  if (result.status === "failed") return { state: "failed", reasons: result.reasonChain || [`command-failed:${command.id}`] };
  if (result.status === "skipped") return { state: "skipped", reasons: result.reasonChain || [`command-skipped:${command.id}`] };
  if (result.status !== "passed") return { state: "pending", reasons: [`command-status-unknown:${command.id}`] };

  for (const reportPath of command.ownedReports || []) {
    const evidence = reportEvidence[reportPath];
    if (!evidence) return { state: "missing", reasons: [`report-missing:${reportPath}`] };
    if (evidence.reportLeakScan !== true) {
      return { state: "privacy-unsafe", reasons: [`report-privacy-unsafe:${reportPath}`, ...(evidence.reasons || [])] };
    }
    if ((evidence.reasons || []).some((reason) => /stale|timestamp-too-old/u.test(reason))) {
      return { state: "stale", reasons: [`report-stale:${reportPath}`, ...(evidence.reasons || [])] };
    }
    if (evidence.liveStatus === "blocked") {
      return { state: "blocked", reasons: [`report-blocked:${reportPath}`, ...(evidence.reasons || [])] };
    }
    // Named reducer facts (factsReady) own readiness; child releaseReady is transitional only.
    const factsReady = evidence.factsReady === true || evidence.releaseReady === true;
    if (evidence.validationPassed !== true || !factsReady) {
      return { state: "failed", reasons: [`report-invalid:${reportPath}`, ...(evidence.reasons || [])] };
    }
  }
  return { state: "current", reasons: [] };
}

export function reduceReleaseEvidenceStates({
  commands = PLATFORM_ACCEPTANCE_COMMANDS,
  results = [],
  reportEvidence = {}
} = {}) {
  const commandById = new Map(commands.map((command) => [command.id, command]));
  const resultById = new Map(results.map((result) => [result.id, result]));
  const reducedById = new Map();
  const visiting = new Set();

  function reduce(commandId) {
    if (reducedById.has(commandId)) return reducedById.get(commandId);
    if (visiting.has(commandId)) throw new Error(`Release evidence reducer cycle: ${commandId}`);
    const command = commandById.get(commandId);
    if (!command) throw new Error(`Release evidence reducer unknown command: ${commandId}`);
    visiting.add(commandId);
    const dependencies = (command.dependsOn || []).map(reduce);
    const direct = directCommandEvidenceState(command, resultById.get(commandId), reportEvidence);
    const nonCurrentDependency = dependencies.find((dependency) => dependency.state !== "current");
    const state = nonCurrentDependency
      ? DEPENDENCY_STATE[nonCurrentDependency.state] || "failed"
      : direct.state;
    const reasons = nonCurrentDependency
      ? uniqueText([
          `dependency-state:${nonCurrentDependency.commandId}:${nonCurrentDependency.state}`,
          ...nonCurrentDependency.reasons,
          ...direct.reasons
        ])
      : uniqueText(direct.reasons);
    const ownerChain = uniqueText([
      commandId,
      ...dependencies.flatMap((dependency) => dependency.ownerChain || [])
    ]);
    const reduced = Object.freeze({
      commandId,
      state,
      reasons,
      ownerChain
    });
    visiting.delete(commandId);
    reducedById.set(commandId, reduced);
    return reduced;
  }

  const nodes = commands.map((command) => reduce(command.id));
  const stateCounts = Object.fromEntries(
    RELEASE_EVIDENCE_STATES.map((state) => [state, nodes.filter((node) => node.state === state).length])
  );
  return Object.freeze({
    schemaVersion: "v0.0.1:meshrix:release-evidence-state-reduction-1",
    states: RELEASE_EVIDENCE_STATES,
    nodes,
    stateCounts,
    current: nodes.every((node) => node.state === "current")
  });
}

export function layerStatus(layer, results = []) {
  const layerResults = results.filter((result) =>
    String(result?.acceptanceLayer || result?.layer || "").includes(layer)
  );
  if (layerResults.length === 0) {
    return { layer, status: "not_applicable", commandCount: 0, failedCommands: [], blockedCommands: [] };
  }
  const failedCommands = layerResults
    .filter((result) => !["passed", "blocked"].includes(result.status))
    .map((result) => result.id);
  const blockedCommands = layerResults
    .filter((result) => result.status === "blocked")
    .map((result) => result.id);
  return {
    layer,
    status: failedCommands.length > 0 ? "failed" : blockedCommands.length > 0 ? "blocked" : "passed",
    commandCount: layerResults.length,
    failedCommands,
    blockedCommands
  };
}

export function classifyFinalState({ failedCommands = [], missingEvidence = [] } = {}) {
  if (failedCommands.length > 0) return "failed";
  if (missingEvidence.length > 0) return "blocked";
  return "accepted";
}

export function failedEvidenceStateCommandIds(reduction = {}) {
  return uniqueText((Array.isArray(reduction?.nodes) ? reduction.nodes : [])
    .filter((node) => ["failed", "privacy-unsafe"].includes(node?.state))
    .map((node) => `evidence-state:${node.commandId}:${node.state}`));
}

export function validateBlockedCommandResults(
  results = [],
  reportEvidence = {},
  commands = PLATFORM_ACCEPTANCE_COMMANDS
) {
  const resultById = new Map(results.map((result) => [result.id, result]));
  const commandById = new Map(commands.map((command) => [command.id, command]));
  const reasons = [];
  const validBlockedCommandIds = [];
  const invalidBlockedCommandIds = [];
  for (const result of results) {
    const command = commandById.get(result.id);
    const directResult = Boolean(result.startedAt);
    if (
      directResult &&
      result.status === "passed" &&
      command?.blockedExitCodes?.includes(2) === true &&
      (
        !command.report ||
        reportEvidence[command.report]?.validationPassed !== true ||
        reportEvidence[command.report]?.liveStatus !== "passed"
      )
    ) {
      invalidBlockedCommandIds.push(result.id);
      reasons.push(`command-blocked-result-invalid:${result.id}`);
      continue;
    }
    if (result.status !== "blocked") continue;
    let valid = Boolean(command) && result.exitCode === 2 && result.timedOut !== true;
    if (directResult) {
      valid = valid && command.blockedExitCodes?.includes(2) === true && Boolean(command.report) &&
        reportEvidence[command.report]?.validationPassed === true &&
        reportEvidence[command.report]?.liveStatus === "blocked";
    } else {
      const dependencies = Array.isArray(result.dependsOn) ? result.dependsOn : [];
      const dependencyStatuses = dependencies.map((dependencyId) => resultById.get(dependencyId)?.status);
      valid = valid && dependencies.length > 0 &&
        dependencyStatuses.some((status) => status === "blocked") &&
        dependencyStatuses.every((status) => status === "passed" || status === "blocked");
    }
    if (valid) {
      validBlockedCommandIds.push(result.id);
    } else {
      invalidBlockedCommandIds.push(result.id);
      reasons.push(`command-blocked-result-invalid:${result.id}`);
    }
  }
  return {
    valid: invalidBlockedCommandIds.length === 0,
    validBlockedCommandIds,
    invalidBlockedCommandIds,
    reasons
  };
}

export function reduceCapabilityEvidenceExecution({
  bindings = [],
  commands = PLATFORM_ACCEPTANCE_COMMANDS,
  validBlockedCommandIds = [],
  reportEvidence = {},
  results = []
} = {}) {
  const commandById = new Map(commands.map((command) => [command.id, command]));
  const resultById = new Map(results.map((result) => [result.id, result]));
  const validBlockedCommandIdSet = new Set(validBlockedCommandIds);
  const reasons = [];
  if (!Array.isArray(bindings) || bindings.length === 0) {
    reasons.push("capability-evidence-bindings-empty");
  }
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    const commandId = String(binding?.acceptanceCommandId || "").trim();
    const reportPath = String(binding?.report || "").trim();
    const command = commandById.get(commandId);
    const result = resultById.get(commandId);
    if (!command) {
      reasons.push(`capability-evidence-command-unknown:${commandId || "missing"}`);
      continue;
    }
    const commandCompleted = result?.status === "passed" ||
      (result?.status === "blocked" && validBlockedCommandIdSet.has(commandId));
    if (!commandCompleted) {
      reasons.push(`capability-evidence-command-not-passed:${commandId}:${result?.status || "missing"}`);
    }
    if (reportPath) {
      if (!(command.ownedReports || []).includes(reportPath)) {
        reasons.push(`capability-evidence-report-not-owned:${commandId}:${reportPath}`);
        continue;
      }
      const evidence = reportEvidence[reportPath];
      if (evidence?.validationPassed !== true) {
        reasons.push(`capability-evidence-report-invalid:${commandId}:${reportPath}`);
      }
      if (evidence?.reportLeakScan !== true) {
        reasons.push(`capability-evidence-report-leak-scan-missing:${commandId}:${reportPath}`);
      }
      const reportReady = evidence?.factsReady === true || evidence?.releaseReady === true || (
        validBlockedCommandIdSet.has(commandId) &&
        evidence?.coverageReady === true &&
        evidence?.liveStatus === "blocked"
      );
      if (!reportReady) {
        reasons.push(`capability-evidence-report-not-ready:${commandId}:${reportPath}`);
      }
    }
  }
  return {
    sourceOfTruth: "tools/server-scripts/verify-platform-acceptance.mjs#reduceCapabilityEvidenceExecution",
    bindingCount: Array.isArray(bindings) ? bindings.length : 0,
    ready: reasons.length === 0,
    reasons: [...new Set(reasons)]
  };
}

export function acceptanceCriteria(
  results = [],
  reportEvidence = {},
  missingReports = [],
  commands = PLATFORM_ACCEPTANCE_COMMANDS
) {
  const resultById = new Map(results.map((result) => [result.id, result]));
  const commandsByLayer = new Map();
  for (const command of commands) {
    const layer = String(command.acceptanceLayer || command.layer || "unclassified")
      .replace(/^acceptance\./u, "");
    if (!commandsByLayer.has(layer)) commandsByLayer.set(layer, []);
    commandsByLayer.get(layer).push(command);
  }
  const layerCriteria = [...commandsByLayer.entries()].map(([layer, layerCommands]) => ({
    id: layer,
    label: `Canonical ${layer} command and owned-report reduction`,
    ready: layerCommands.every((command) => {
      const status = resultById.get(command.id)?.status;
      // Valid objective blockers remain blocked; they must not collapse criteria to failed.
      if (status === "blocked") return true;
      if (status !== "passed") return false;
      return (command.ownedReports || []).every((reportPath) => {
        const evidence = reportEvidence[reportPath];
        return evidence?.validationPassed === true &&
          evidence?.reportLeakScan === true &&
          (
            evidence?.factsReady === true ||
            evidence?.releaseReady === true
          );
      });
    })
  }));
  return [
    ...layerCriteria,
    {
      id: "required-reports",
      label: "Every acceptance-required report exists and reduces named facts",
      ready: missingReports.length === 0 &&
        ACCEPTANCE_REQUIRED_REPORTS.every((reportPath) => {
          const evidence = reportEvidence[reportPath];
          return evidence?.validationPassed === true &&
            evidence?.reportLeakScan === true &&
            (evidence?.factsReady === true || evidence?.releaseReady === true);
        })
    }
  ];
}

export function aggregateChildReportLeakScan(
  { requiredReports = [], reportEvidence = {}, missingReports = [] } = {}
) {
  return requiredReports.length > 0 &&
    missingReports.length === 0 &&
    requiredReports.every((reportPath) =>
      reportEvidence[reportPath]?.validationPassed === true &&
      reportEvidence[reportPath]?.reportLeakScan === true
    );
}

export {
  anchorAcceptanceEvidence,
  verifyAcceptanceEvidenceAnchor
} from "./platform-acceptance-ledger-anchor.mjs";
