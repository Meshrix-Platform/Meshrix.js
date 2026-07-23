export function validateRepoLayout(data) {
  const issues = [];
  if (!Array.isArray(data.entries)) {
    issues.push("repo-layout: entries must be an array");
    return issues;
  }
  const names = new Set();
  const sourceRootNames = new Set();
  for (const entry of data.entries) {
    if (!entry.name) issues.push("repo-layout: entry missing name");
    else if (names.has(entry.name)) issues.push(`repo-layout: duplicate entry "${entry.name}"`);
    else names.add(entry.name);

    if (!entry.kind) issues.push(`repo-layout: entry "${entry.name}" missing kind`);
    if (entry.kind === "source-root") sourceRootNames.add(entry.name);
    if (typeof entry.required !== "boolean") issues.push(`repo-layout: entry "${entry.name}" missing required (boolean)`);
    if (typeof entry.packageIncluded !== "boolean") issues.push(`repo-layout: entry "${entry.name}" missing packageIncluded (boolean)`);
  }

  const rootHygieneRequired = Array.isArray(data.rootHygiene?.requiredEntries)
    ? data.rootHygiene.requiredEntries
    : [];
  if (rootHygieneRequired.length === 0) {
    issues.push("repo-layout: rootHygiene.requiredEntries must be a non-empty array");
  }
  for (const entry of rootHygieneRequired) {
    if (!names.has(entry)) {
      issues.push(`repo-layout: root hygiene required entry "${entry}" is not registered`);
    }
  }

  const audit = data.repoOrganizationAudit || {};
  for (const field of ["ignoredPathParts", "requiredFiles"]) {
    if (!Array.isArray(audit[field])) {
      issues.push(`repo-layout: repoOrganizationAudit.${field} must be an array`);
    }
  }
  const sourceFileOrganization = audit.sourceFileOrganization || {};
  const lineCountGate = sourceFileOrganization.lineCountGate || {};
  if (lineCountGate.status !== "disabled" || lineCountGate.threshold !== null || lineCountGate.releaseBlocking !== false) {
    issues.push("repo-layout: source file organization must keep the numeric line-count gate disabled and non-blocking");
  }
  const canonicalDocument = String(sourceFileOrganization.canonicalDocument || "");
  const canonicalDocumentPath = canonicalDocument.split("#")[0];
  if (!canonicalDocumentPath || !audit.requiredFiles?.includes(canonicalDocumentPath)) {
    issues.push("repo-layout: source file organization canonical document must be a required repository file");
  }
  for (const field of ["decisionBasis", "machineEnforcedRuleIds", "delegatedGateIds", "reviewOnlySignalIds"]) {
    const values = Array.isArray(sourceFileOrganization[field]) ? sourceFileOrganization[field] : [];
    if (values.length === 0 || new Set(values).size !== values.length) {
      issues.push(`repo-layout: sourceFileOrganization.${field} must be a non-empty unique array`);
    }
  }
  const astAdvisory = sourceFileOrganization.astAdvisory || {};
  if (astAdvisory.releaseBlocking !== false) {
    issues.push("repo-layout: source file organization AST analysis must remain advisory and non-blocking");
  }
  for (const analysisRoot of astAdvisory.analysisRoots || []) {
    if (!sourceRootNames.has(analysisRoot)) {
      issues.push(`repo-layout: source organization analysis root "${analysisRoot}" is not a registered source-root`);
    }
  }
  if (!audit.requiredFiles?.includes(astAdvisory.factSourceAuthorityPath)) {
    issues.push("repo-layout: source organization fact-source authority must be a required repository file");
  }
  return issues;
}
