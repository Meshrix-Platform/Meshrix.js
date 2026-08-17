const rel: any = (number?: any) : any => `REQ-REL-${String(number).padStart(3, "0")}`;
const usp: any = (number?: any) : any => `REQ-USP-${String(number).padStart(3, "0")}`;

export const PLATFORM_ACCEPTANCE_REQUIREMENTS: readonly any[] = Object.freeze([
  ...Array.from({ length: 30 }, (_?: any, index?: any) : any => rel(index + 1)),
  ...Array.from({ length: 13 }, (_?: any, index?: any) : any => usp(index + 1))
]);

const mapping: Record<string, any> = {
  [rel(1)]: { commandIds: ["capability-acceptance-machines", "surface-convergence"] },
  [rel(2)]: { commandIds: ["protocol-boundary", "repo-organization"] },
  [rel(3)]: { commandIds: ["state-machines", "capability-acceptance-machines"] },
  [rel(4)]: { commandIds: ["plugin-runtime", "deployment-container-flow"] },
  [rel(5)]: { commandIds: ["operation-permission-domain-model", "operation-permission-protocol-consistency", "operation-permission-tag-governed-e2e", "authorization-enforcement"] },
  [rel(6)]: { commandIds: ["approval-governance", "operation-permission-tag-governed-e2e"] },
  [rel(7)]: { commandIds: [], aggregateFacts: ["ledgerAnchorReady"] },
  [rel(8)]: { commandIds: ["storage-restore"] },
  [rel(9)]: { commandIds: ["job-work-queue", "job-work-queue-ceiling-conformance", "work-queue-conformance", "work-queue-process-restart"] },
  [rel(10)]: { commandIds: ["audit-retention-redaction", "observability-semantics", "observability-runtime", "observability-coverage"] },
  [rel(11)]: { commandIds: ["better-plan", "foundation-tests"], aggregateFacts: ["receiptPreflightReady", "commandDagReady", "inventoryReady", "privacyReady"] },
  [rel(12)]: { commandIds: ["downstream-mcp-audit", "mcp-installer-convergence", "operation-permission-protocol-consistency"] },
  [rel(13)]: { commandIds: ["mcp-installer-convergence", "mcp-release-target-scope", "operation-permission-protocol-consistency"] },
  [rel(14)]: { commandIds: ["upstream-mcp-gateway", "upstream-gateway-e2e"] },
  [rel(15)]: { commandIds: ["console-administration", "console-admin-browser-visual", "console-gateway-mcp"] },
  [rel(16)]: { commandIds: ["plugin-runtime", "controlled-execution-sandbox"] },
  [rel(17)]: { commandIds: ["workspace-asset-management", "upload-workspace-materialization"] },
  [rel(18)]: { commandIds: ["plugin-runtime", "composition-source-package"] },
  [rel(19)]: { commandIds: ["production-readiness-gates"] },
  [rel(20)]: { commandIds: ["plugin-runtime", "protocol-boundary"] },
  [rel(21)]: { commandIds: ["strategy-management"] },
  [rel(22)]: { commandIds: ["agent-self-maintenance-plugin"] },
  [rel(23)]: { commandIds: ["deployment-container-flow", "npm-package-installability"] },
  [rel(24)]: { commandIds: ["foundation-tests", "documentation-convergence", "repo-organization"] },
  [rel(25)]: { commandIds: ["job-work-queue-ceiling-conformance", "mcp-gateway-load", "gateway-platform-profile", "production-readiness-gates"] },
  [rel(26)]: { commandIds: ["controlled-execution-sandbox", "controlled-execution-convergence-final"] },
  [rel(27)]: { commandIds: ["plugin-runtime", "npm-package-installability", "composition-source-package"] },
  [rel(28)]: { commandIds: ["model-gateway-service", "model-gateway-adapter", "gateway-boundary-final", "external-gateway-plugin", "surface-convergence"] },
  [rel(29)]: { commandIds: ["workspace-asset-management", "upload-workspace-materialization"] },
  [rel(30)]: { commandIds: ["better-plan", "repo-organization", "documentation-convergence"] },
  ...Object.fromEntries(Array.from({ length: 13 }, (_?: any, index?: any) : any => [
    usp(index + 1),
    {
      commandIds: [
        "upstream-service-publishing",
        ...([8].includes(index + 1) ? ["downstream-mcp-audit"] : []),
        ...([9, 10].includes(index + 1) ? ["upstream-fixture-transit", "upstream-gateway-e2e"] : []),
        ...(index + 1 === 11 ? ["surface-convergence"] : []),
        ...(index + 1 === 13 ? ["gateway-platform-profile", "observability-runtime"] : [])
      ]
    }
  ]))
};

export const PLATFORM_ACCEPTANCE_REQUIREMENT_EVIDENCE: any = Object.freeze(
  Object.fromEntries(PLATFORM_ACCEPTANCE_REQUIREMENTS.map((requirement?: any) : any => [
    requirement,
    Object.freeze({
      commandIds: Object.freeze([...(mapping[requirement]?.commandIds || [])]),
      aggregateFacts: Object.freeze([...(mapping[requirement]?.aggregateFacts || [])])
    })
  ]))
);

export function validatePlatformAcceptanceRequirementEvidence({ commands = [] }: Record<string, any> = {}) : any {
  const commandById: any = new Map<any, any>(commands.map((command?: any) : any => [String(command?.id || ""), command]));
  const reasons: any[] = [];
  const labels: any = Object.keys(PLATFORM_ACCEPTANCE_REQUIREMENT_EVIDENCE);
  if (JSON.stringify(labels) !== JSON.stringify(PLATFORM_ACCEPTANCE_REQUIREMENTS)) {
    reasons.push("requirement-label-set-mismatch");
  }
  for (const requirement of PLATFORM_ACCEPTANCE_REQUIREMENTS) {
    const evidence: any = PLATFORM_ACCEPTANCE_REQUIREMENT_EVIDENCE[requirement];
    if (evidence.commandIds.length === 0 && evidence.aggregateFacts.length === 0) {
      reasons.push(`requirement-evidence-empty:${requirement}`);
    }
    for (const commandId of evidence.commandIds) {
      if (!commandById.has(commandId)) reasons.push(`requirement-command-unknown:${requirement}:${commandId}`);
    }
  }
  return Object.freeze({
    valid: reasons.length === 0,
    requirementCount: PLATFORM_ACCEPTANCE_REQUIREMENTS.length,
    reasons: Object.freeze(reasons)
  });
}

export function reducePlatformAcceptanceRequirementEvidence({
  commands = [],
  results = [],
  reportEvidence = {},
  aggregateFacts = {}
}: Record<string, any> = {}) : any {
  const commandById: any = new Map<any, any>(commands.map((command?: any) : any => [String(command?.id || ""), command]));
  const resultById: any = new Map<any, any>(results.map((result?: any) : any => [String(result?.id || ""), result]));
  const nodes: any = PLATFORM_ACCEPTANCE_REQUIREMENTS.map((requirement?: any) : any => {
    const binding: any = PLATFORM_ACCEPTANCE_REQUIREMENT_EVIDENCE[requirement];
    const reasons: any[] = [];
    const reportPaths: any[] = [];
    for (const commandId of binding.commandIds) {
      const command: any = commandById.get(commandId);
      const status: any = resultById.get(commandId)?.status;
      if (status === "blocked") {
        // Objective blockers keep the requirement incomplete without converting to failed.
        reasons.push(`command-blocked:${commandId}`);
      } else if (status !== "passed") {
        reasons.push(`command-not-passed:${commandId}`);
      }
      for (const reportPath of command?.ownedReports || []) {
        reportPaths.push(reportPath);
        const evidence: any = reportEvidence[reportPath];
        const factsReady: any = evidence?.factsReady === true || evidence?.releaseReady === true;
        if (evidence?.validationPassed !== true || !factsReady ||
            evidence?.reportLeakScan !== true || !String(evidence?.reducerSourceOfTruth || "").trim()) {
          reasons.push(`report-evidence-not-ready:${reportPath}`);
        }
      }
    }
    for (const fact of binding.aggregateFacts) {
      if (aggregateFacts?.[fact] !== true) reasons.push(`aggregate-fact-not-ready:${fact}`);
    }
    return Object.freeze({
      requirement,
      ready: reasons.length === 0,
      commandIds: binding.commandIds,
      reportPaths: Object.freeze([...new Set<any>(reportPaths)].sort()),
      aggregateFacts: binding.aggregateFacts,
      reasons: Object.freeze(reasons)
    });
  });
  return Object.freeze({
    schemaVersion: "v0.0.1:meshrix:platform-acceptance-requirement-evidence-1",
    sourceOfTruth: "tools/server-scripts/lib/platform-acceptance-requirement-evidence.ts",
    requirementCount: nodes.length,
    readyCount: nodes.filter((node?: any) : any => node.ready).length,
    ready: nodes.every((node?: any) : any => node.ready),
    nodes: Object.freeze(nodes)
  });
}
