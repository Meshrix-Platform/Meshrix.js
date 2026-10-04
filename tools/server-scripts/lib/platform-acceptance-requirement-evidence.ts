// Requirements of the npm product acceptance claim. Optional deployments,
// services and performance claims are owned by their separately invoked tools.
const mapping: Record<string, any> = {
  "core-engineering": { commandIds: ["foundation-tests"] },
  "npm-artifacts": { commandIds: ["npm-package-prepare", "npm-package-installability"] },
  "core-publishing-security": { commandIds: ["upstream-service-publishing"] },
  "standard-mcp": { commandIds: ["upstream-mcp-gateway"] },
  "console-operation": { commandIds: ["console-admin-browser-visual"] },
  "storage-recovery": { commandIds: ["storage-restore"] },
  "candidate-evidence": { commandIds: [], aggregateFacts: ["ledgerAnchorReady", "candidateIdentityReady", "commandDagReady", "inventoryReady", "privacyReady"] }
};

export const PLATFORM_ACCEPTANCE_REQUIREMENTS: readonly string[] = Object.freeze(Object.keys(mapping));

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
  runId = "",
  candidateDigest = "",
  aggregateFacts = {}
}: Record<string, any> = {}) : any {
  const commandById: any = new Map<any, any>(commands.map((command?: any) : any => [String(command?.id || ""), command]));
  const resultById: any = new Map<any, any>(results.map((result?: any) : any => [String(result?.id || ""), result]));
  const nodes: any = PLATFORM_ACCEPTANCE_REQUIREMENTS.map((requirement?: any) : any => {
    const binding: any = PLATFORM_ACCEPTANCE_REQUIREMENT_EVIDENCE[requirement];
    const reasons: any[] = [];
    const reportPaths: any[] = [];
    if (!String(runId).trim() || !String(candidateDigest).trim()) reasons.push("acceptance-run-unbound");
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
        if (evidence?.validationPassed !== true || evidence?.factsReady !== true ||
            evidence?.reportLeakScan !== true || !String(evidence?.reducerSourceOfTruth || "").trim() ||
            evidence?.runId !== runId || evidence?.candidateDigest !== candidateDigest || evidence?.commandId !== commandId) {
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
    schemaVersion: "v0.0.1:meshrix:platform-acceptance-requirement-evidence-2",
    sourceOfTruth: "tools/server-scripts/lib/platform-acceptance-requirement-evidence.ts",
    requirementCount: nodes.length,
    readyCount: nodes.filter((node?: any) : any => node.ready).length,
    ready: nodes.every((node?: any) : any => node.ready),
    nodes: Object.freeze(nodes)
  });
}
