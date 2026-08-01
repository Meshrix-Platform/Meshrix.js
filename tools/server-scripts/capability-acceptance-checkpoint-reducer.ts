const DEFAULT_REQUIRED_ROLES: readonly any[] = Object.freeze([
  "implementation",
  "final_validation"
]);

const DEFAULT_ALLOWED_STATUSES: readonly any[] = Object.freeze([
  "completed",
  "pending",
  "blocked"
]);

const EXTERNAL_BLOCKER_KIND: any = "external-evidence";
const BLOCKED_STATUS: any = "blocked";

function asRecord(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value?: any) : any {
  return String(value || "").trim();
}

function finding(code?: any, message?: any, details: Record<string, any> = {}) : any {
  return {
    code,
    message,
    category: details.category || "checkpoint-structure",
    checkpointId: details.checkpointId || "",
    role: details.role || "",
    prerequisiteId: details.prerequisiteId || "",
    criterionIndex: Number.isInteger(details.criterionIndex) ? details.criterionIndex : null,
    criterionText: details.criterionText || ""
  };
}

function reasonForFinding(item: Record<string, any> = {}) : any {
  return [
    item.code,
    item.checkpointId,
    item.prerequisiteId,
    Number.isInteger(item.criterionIndex) ? `criterion-${item.criterionIndex}` : ""
  ].filter(Boolean).join(":");
}

function uniqueStrings(values: any = []) : any {
  return [...new Set<any>(values.map(text).filter(Boolean))];
}

function isSelfReferentialEvidenceCommand(command?: any) : any {
  return /^npm\s+run\s+verify:acceptance(?:\s|$)/u.test(command) ||
    /^npm\s+run\s+verify:capability-acceptance-machines(?:\s|$)/u.test(command) ||
    /(?:^|\s)tools\/server-scripts\/verify-capability-acceptance-machines\.ts(?:\s|$)/u.test(command);
}

function evidenceAuthorityEntry(authority?: any, acceptanceCommandId?: any) : any {
  if (authority instanceof Map) {
    return authority.get(acceptanceCommandId);
  }
  return asRecord(authority)[acceptanceCommandId];
}

function validateEvidenceEntries(evidence?: any, details?: any, evidenceCommandAuthority?: any) : any {
  const findings: any[] = [];
  const bindings: any[] = [];
  if (!Array.isArray(evidence) || evidence.length === 0) {
    findings.push(finding(
      "checkpoint-criterion-evidence-missing",
      `Checkpoint ${details.checkpointId} acceptance criterion ${details.criterionIndex} must cite at least one reproducible command.`,
      { ...details, category: "checkpoint-evidence" }
    ));
    return { findings, bindings };
  }

  for (const [evidenceIndex, rawEvidence] of evidence.entries()) {
    const item: any = asRecord(rawEvidence);
    const acceptanceCommandId: any = typeof item.acceptanceCommandId === "string"
      ? text(item.acceptanceCommandId)
      : "";
    const report: any = item.report === undefined
      ? ""
      : typeof item.report === "string" ? text(item.report) : "";
    if (Object.hasOwn(item, "command")) {
      findings.push(finding(
        "checkpoint-criterion-evidence-command-forbidden",
        `Checkpoint ${details.checkpointId} acceptance criterion ${details.criterionIndex} evidence ${evidenceIndex} must use acceptanceCommandId instead of an arbitrary command string.`,
        { ...details, category: "checkpoint-authority" }
      ));
    }
    if (!acceptanceCommandId) {
      findings.push(finding(
        "checkpoint-criterion-evidence-command-id-invalid",
        `Checkpoint ${details.checkpointId} acceptance criterion ${details.criterionIndex} evidence ${evidenceIndex} must declare a non-empty acceptanceCommandId.`,
        { ...details, category: "checkpoint-evidence" }
      ));
      continue;
    }
    const authorityEntry: any = evidenceAuthorityEntry(evidenceCommandAuthority, acceptanceCommandId);
    if (!authorityEntry) {
      findings.push(finding(
        "checkpoint-criterion-evidence-command-id-unknown",
        `Checkpoint ${details.checkpointId} acceptance criterion ${details.criterionIndex} evidence ${evidenceIndex} references an unknown platform acceptance command.`,
        { ...details, category: "checkpoint-authority" }
      ));
    }
    if (item.report !== undefined && !/^build\/reports\/[A-Za-z0-9._/-]+\.json$/u.test(report)) {
      findings.push(finding(
        "checkpoint-criterion-evidence-report-invalid",
        `Checkpoint ${details.checkpointId} acceptance criterion ${details.criterionIndex} evidence ${evidenceIndex} report must be a repository-relative JSON report under build/reports.`,
        { ...details, category: "checkpoint-evidence" }
      ));
    } else if (report && authorityEntry) {
      const ownedReports: any = new Set<any>(Array.isArray(authorityEntry.ownedReports)
        ? authorityEntry.ownedReports.map(text).filter(Boolean)
        : []);
      if (!ownedReports.has(report)) {
        findings.push(finding(
          "checkpoint-criterion-evidence-report-not-owned",
          `Checkpoint ${details.checkpointId} acceptance criterion ${details.criterionIndex} evidence ${evidenceIndex} cites a report not owned by its platform acceptance command.`,
          { ...details, category: "checkpoint-authority" }
        ));
      }
    }
    bindings.push({
      acceptanceCommandId,
      report,
      checkpointId: details.checkpointId,
      role: details.role,
      criterionIndex: details.criterionIndex,
      evidenceIndex
    });
  }
  return { findings, bindings };
}

function validateExternalBlocker(rawBlocker?: any, details?: any) : any {
  const blocker: any = asRecord(rawBlocker);
  const code: any = typeof blocker.code === "string" ? text(blocker.code) : "";
  const description: any = typeof blocker.description === "string" ? text(blocker.description) : "";
  const verificationCommand: any = typeof blocker.verificationCommand === "string"
    ? text(blocker.verificationCommand)
    : "";
  const requiredEvidence: any = Array.isArray(blocker.requiredEvidence)
    ? uniqueStrings(blocker.requiredEvidence.filter((value?: any) : any => typeof value === "string"))
    : [];
  const valid: any = blocker.kind === EXTERNAL_BLOCKER_KIND &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(code) &&
    description.length > 0 &&
    verificationCommand.length > 0 &&
    !isSelfReferentialEvidenceCommand(verificationCommand) &&
    requiredEvidence.length > 0;
  if (!valid) {
    return {
      blocker: null,
      finding: finding(
        "checkpoint-external-blocker-invalid",
        `Checkpoint ${details.checkpointId} acceptance criterion ${details.criterionIndex} has an invalid external evidence blocker.`,
        { ...details, category: "checkpoint-blocker" }
      )
    };
  }
  return {
    blocker: {
      code,
      kind: EXTERNAL_BLOCKER_KIND,
      description,
      requiredEvidence,
      verificationCommand,
      checkpointId: details.checkpointId,
      role: details.role,
      criterionIndex: details.criterionIndex
    },
    finding: null
  };
}

function cycleFindings(checkpointsById?: any) : any {
  const findings: any[] = [];
  const visiting: any = new Set<any>();
  const visited: any = new Set<any>();
  const reported: any = new Set<any>();

  function visit(checkpointId?: any, ancestry: any = []) : any {
    if (visited.has(checkpointId)) return;
    if (visiting.has(checkpointId)) {
      const cycleStart: any = ancestry.indexOf(checkpointId);
      const cycle: any[] = [...ancestry.slice(Math.max(0, cycleStart)), checkpointId];
      const key: any = [...new Set<any>(cycle.slice(0, -1))].sort().join("|");
      if (!reported.has(key)) {
        reported.add(key);
        findings.push(finding(
          "checkpoint-prerequisite-cycle",
          `Checkpoint prerequisite graph contains a cycle: ${cycle.join(" -> ")}.`,
          { checkpointId, category: "checkpoint-graph" }
        ));
      }
      return;
    }

    const checkpoint: any = checkpointsById.get(checkpointId);
    if (!checkpoint) return;
    visiting.add(checkpointId);
    for (const prerequisiteId of checkpoint.prerequisites) {
      if (checkpointsById.has(prerequisiteId)) {
        visit(prerequisiteId, [...ancestry, checkpointId]);
      }
    }
    visiting.delete(checkpointId);
    visited.add(checkpointId);
  }

  for (const checkpointId of checkpointsById.keys()) {
    visit(checkpointId);
  }
  return findings;
}

/**
 * Reduces source-controlled capability checkpoints into local verification
 * readiness. This reducer deliberately has no filesystem access so tests and
 * other callers can inject checkpoint fixtures without mutating plan files.
 *
 * It never declares aggregate acceptance. A successful result means only that
 * the capability is verified and ready for the platform release reducer.
 */
export function reduceCapabilityCheckpoints(checkpoints?: any, {
  requiredRoles = DEFAULT_REQUIRED_ROLES,
  allowedStatuses = DEFAULT_ALLOWED_STATUSES,
  completedStatus = "completed",
  evidenceCommandAuthority = new Map<any, any>()
}: Record<string, any> = {}) : any {
  const findings: any[] = [];
  const openCheckpoints: any[] = [];
  const uncheckedCriteria: any[] = [];
  const blockers: any[] = [];
  const evidenceBindings: any[] = [];
  const normalized: any[] = [];
  const requiredRoleList: any = uniqueStrings(requiredRoles);
  const allowedStatusSet: any = new Set<any>(uniqueStrings(allowedStatuses));

  if (!Array.isArray(checkpoints)) {
    findings.push(finding(
      "checkpoints-not-array",
      "Capability checkpoints must be an array."
    ));
  } else if (checkpoints.length === 0) {
    findings.push(finding(
      "checkpoints-empty",
      "Capability checkpoints must not be empty."
    ));
  }

  for (const [index, rawValue] of (Array.isArray(checkpoints) ? checkpoints : []).entries()) {
    const raw: any = asRecord(rawValue);
    const declaredId: any = text(raw.id);
    const checkpointId: any = declaredId || `checkpoint-index-${index}`;
    const role: any = text(raw.role);
    const status: any = text(raw.status);
    const prerequisitesValid: any = Array.isArray(raw.prerequisites);
    const prerequisites: any = prerequisitesValid
      ? raw.prerequisites
        .filter((value?: any) : any => typeof value === "string")
        .map(text)
        .filter(Boolean)
      : [];
    const criteriaValid: any = Array.isArray(raw.acceptance_criteria);
    const criteria: any = criteriaValid ? raw.acceptance_criteria : [];
    let checkpointBlockerCount: any = 0;

    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
      findings.push(finding(
        "checkpoint-not-object",
        `Checkpoint at index ${index} must be an object.`,
        { checkpointId }
      ));
    }
    if (!declaredId) {
      findings.push(finding(
        "checkpoint-id-missing",
        `Checkpoint at index ${index} is missing an id.`,
        { checkpointId }
      ));
    }
    if (!role) {
      findings.push(finding(
        "checkpoint-role-missing",
        `Checkpoint ${checkpointId} is missing a role.`,
        { checkpointId }
      ));
    }
    if (!allowedStatusSet.has(status)) {
      findings.push(finding(
        "checkpoint-status-invalid",
        `Checkpoint ${checkpointId} has unsupported status ${status || "(missing)"}.`,
        { checkpointId, role, category: "checkpoint-status" }
      ));
    }
    if (!prerequisitesValid) {
      findings.push(finding(
        "checkpoint-prerequisites-not-array",
        `Checkpoint ${checkpointId} prerequisites must be an array.`,
        { checkpointId, role, category: "checkpoint-graph" }
      ));
    } else {
      for (const [prerequisiteIndex, prerequisiteValue] of raw.prerequisites.entries()) {
        if (typeof prerequisiteValue !== "string" || !text(prerequisiteValue)) {
          findings.push(finding(
            "checkpoint-prerequisite-id-invalid",
            `Checkpoint ${checkpointId} prerequisite ${prerequisiteIndex} must be a non-empty string.`,
            { checkpointId, role, category: "checkpoint-graph" }
          ));
        }
      }
    }
    if (new Set<any>(prerequisites).size !== prerequisites.length) {
      findings.push(finding(
        "checkpoint-prerequisite-duplicate",
        `Checkpoint ${checkpointId} has duplicate prerequisites.`,
        { checkpointId, role, category: "checkpoint-graph" }
      ));
    }
    if (!criteriaValid || criteria.length === 0) {
      findings.push(finding(
        "checkpoint-acceptance-criteria-missing",
        `Checkpoint ${checkpointId} must declare at least one acceptance criterion.`,
        { checkpointId, role, category: "checkpoint-criteria" }
      ));
      uncheckedCriteria.push({
        checkpointId,
        role,
        criterionIndex: null,
        reason: "acceptance-criteria-missing"
      });
    }

    for (const [criterionIndex, criterionValue] of criteria.entries()) {
      const criterion: any = asRecord(criterionValue);
      const criterionText: any = typeof criterion.text === "string" ? text(criterion.text) : "";
      const criterionIsValid: any = criterionValue &&
        typeof criterionValue === "object" &&
        !Array.isArray(criterionValue) &&
        criterionText.length > 0;
      const criterionDetails: Record<string, any> = { checkpointId, role, criterionIndex, criterionText };
      if (!criterionIsValid) {
        uncheckedCriteria.push({
          checkpointId,
          role,
          criterionIndex,
          reason: "criterion-invalid"
        });
        findings.push(finding(
          "checkpoint-acceptance-criterion-invalid",
          `Checkpoint ${checkpointId} acceptance criterion ${criterionIndex} must be an object with non-empty text.`,
          { checkpointId, role, criterionIndex, category: "checkpoint-criteria" }
        ));
      } else if (criterion.checked === true) {
        if (criterion.blocker !== undefined) {
          findings.push(finding(
            "checkpoint-checked-criterion-has-blocker",
            `Checkpoint ${checkpointId} acceptance criterion ${criterionIndex} cannot be checked and blocked at the same time.`,
            { ...criterionDetails, category: "checkpoint-blocker" }
          ));
        }
        if (requiredRoleList.includes(role)) {
          const evidenceValidation: any = validateEvidenceEntries(
            criterion.evidence,
            criterionDetails,
            evidenceCommandAuthority
          );
          findings.push(...evidenceValidation.findings);
          evidenceBindings.push(...evidenceValidation.bindings);
        }
      } else if (criterion.blocker !== undefined) {
        const blockerResult: any = validateExternalBlocker(criterion.blocker, criterionDetails);
        if (blockerResult.finding) {
          findings.push(blockerResult.finding);
        } else {
          blockers.push(blockerResult.blocker);
          checkpointBlockerCount += 1;
        }
        uncheckedCriteria.push({
          checkpointId,
          role,
          criterionIndex,
          reason: blockerResult.blocker ? "external-evidence-missing" : "invalid-external-blocker",
          text: criterionText
        });
        if (status === completedStatus) {
          findings.push(finding(
            "checkpoint-completed-with-blocked-criterion",
            `Completed checkpoint ${checkpointId} cannot contain an externally blocked criterion.`,
            { ...criterionDetails, category: "checkpoint-status" }
          ));
        }
      } else {
        uncheckedCriteria.push({
          checkpointId,
          role,
          criterionIndex,
          reason: "criterion-not-checked",
          text: criterionText
        });
        findings.push(finding(
          "checkpoint-acceptance-criterion-unchecked",
          `Checkpoint ${checkpointId} acceptance criterion ${criterionIndex} is not checked.`,
          { checkpointId, role, criterionIndex, category: "checkpoint-criteria" }
        ));
      }
    }

    if (status !== completedStatus) {
      openCheckpoints.push({
        id: checkpointId,
        role,
        status: status || "invalid"
      });
      if (status !== BLOCKED_STATUS) {
        findings.push(finding(
          "checkpoint-not-completed",
          `Checkpoint ${checkpointId} (${role || "missing-role"}) is not completed.`,
          { checkpointId, role, category: "checkpoint-status" }
        ));
      } else if (checkpointBlockerCount === 0) {
        findings.push(finding(
          "checkpoint-blocked-without-external-evidence",
          `Blocked checkpoint ${checkpointId} must identify at least one valid external evidence blocker.`,
          { checkpointId, role, category: "checkpoint-blocker" }
        ));
      }
    }

    normalized.push({
      id: checkpointId,
      declaredId,
      role,
      status,
      prerequisites: uniqueStrings(prerequisites),
      index
    });
  }

  const idCounts: any = new Map<any, any>();
  for (const checkpoint of normalized) {
    if (!checkpoint.declaredId) continue;
    idCounts.set(checkpoint.id, (idCounts.get(checkpoint.id) || 0) + 1);
  }
  for (const [checkpointId, count] of idCounts) {
    if (count > 1) {
      findings.push(finding(
        "checkpoint-id-duplicate",
        `Checkpoint id ${checkpointId} is declared ${count} times.`,
        { checkpointId }
      ));
    }
  }

  const checkpointsById: any = new Map<any, any>();
  for (const checkpoint of normalized) {
    if (checkpoint.declaredId && !checkpointsById.has(checkpoint.id)) {
      checkpointsById.set(checkpoint.id, checkpoint);
    }
  }

  for (const checkpoint of normalized) {
    for (const prerequisiteId of checkpoint.prerequisites) {
      const prerequisite: any = checkpointsById.get(prerequisiteId);
      if (!prerequisite) {
        findings.push(finding(
          "checkpoint-prerequisite-missing",
          `Checkpoint ${checkpoint.id} references missing prerequisite ${prerequisiteId}.`,
          {
            checkpointId: checkpoint.id,
            role: checkpoint.role,
            prerequisiteId,
            category: "checkpoint-graph"
          }
        ));
        continue;
      }
      if (prerequisiteId === checkpoint.id) {
        findings.push(finding(
          "checkpoint-prerequisite-self-reference",
          `Checkpoint ${checkpoint.id} cannot depend on itself.`,
          {
            checkpointId: checkpoint.id,
            role: checkpoint.role,
            prerequisiteId,
            category: "checkpoint-graph"
          }
        ));
      }
      if (checkpoint.status === completedStatus && prerequisite.status !== completedStatus) {
        findings.push(finding(
          "checkpoint-completed-before-prerequisite",
          `Completed checkpoint ${checkpoint.id} depends on incomplete prerequisite ${prerequisiteId}.`,
          {
            checkpointId: checkpoint.id,
            role: checkpoint.role,
            prerequisiteId,
            category: "checkpoint-graph"
          }
        ));
      }
    }
  }
  findings.push(...cycleFindings(checkpointsById));

  const roleCounts: any = new Map<any, any>();
  for (const checkpoint of normalized) {
    if (checkpoint.role) roleCounts.set(checkpoint.role, (roleCounts.get(checkpoint.role) || 0) + 1);
  }
  for (const requiredRole of requiredRoleList) {
    const count: any = roleCounts.get(requiredRole) || 0;
    if (count === 0) {
      findings.push(finding(
        "required-checkpoint-role-missing",
        `Capability checkpoints are missing required role ${requiredRole}.`,
        { role: requiredRole, category: "checkpoint-role" }
      ));
    } else if (count !== 1) {
      findings.push(finding(
        "required-checkpoint-role-duplicate",
        `Capability checkpoints must declare exactly one ${requiredRole} role; found ${count}.`,
        { role: requiredRole, category: "checkpoint-role" }
      ));
    }
  }

  const implementation: any = normalized.filter((checkpoint?: any) : any => checkpoint.role === "implementation");
  const finalValidation: any = normalized.filter((checkpoint?: any) : any => checkpoint.role === "final_validation");
  if (implementation.length === 1 && finalValidation.length === 1) {
    const targetId: any = implementation[0].id;
    const visited: any = new Set<any>();
    const stack: any[] = [...finalValidation[0].prerequisites];
    let dependsOnImplementation: any = false;
    while (stack.length > 0) {
      const prerequisiteId: any = stack.pop();
      if (prerequisiteId === targetId) {
        dependsOnImplementation = true;
        break;
      }
      if (visited.has(prerequisiteId)) continue;
      visited.add(prerequisiteId);
      const prerequisite: any = checkpointsById.get(prerequisiteId);
      if (prerequisite) stack.push(...prerequisite.prerequisites);
    }
    if (!dependsOnImplementation) {
      findings.push(finding(
        "final-validation-missing-implementation-dependency",
        "The final validation checkpoint must transitively depend on the implementation checkpoint.",
        {
          checkpointId: finalValidation[0].id,
          role: "final_validation",
          prerequisiteId: targetId,
          category: "checkpoint-graph"
        }
      ));
    }
  }

  const readyForReleaseReduction: any = findings.length === 0 &&
    openCheckpoints.length === 0 &&
    blockers.length === 0;
  const blocked: any = !readyForReleaseReduction &&
    findings.length === 0 &&
    blockers.length > 0 &&
    openCheckpoints.length > 0 &&
    openCheckpoints.every((checkpoint?: any) : any => checkpoint.status === BLOCKED_STATUS);
  const reasons: any[] = [...new Set<any>([
    ...findings.map(reasonForFinding),
    ...blockers.map((item?: any) : any => `${item.code}:${item.checkpointId}:criterion-${item.criterionIndex}`)
  ])];
  return {
    sourceOfTruth: "tools/server-scripts/capability-acceptance-checkpoint-reducer.ts#reduceCapabilityCheckpoints",
    currentState: readyForReleaseReduction ? "verified" : blocked ? "blocked" : "failed",
    readyForReleaseReduction,
    blocked,
    failureKind: readyForReleaseReduction
      ? ""
      : findings.some((item?: any) : any => item.category === "checkpoint-graph" || item.category === "checkpoint-structure")
        ? "invalid-checkpoint-graph"
        : blocked
          ? "external-evidence-missing"
          : "local-checkpoint-incomplete",
    checkpointCount: normalized.length,
    completedCheckpointCount: normalized.filter((checkpoint?: any) : any => checkpoint.status === completedStatus).length,
    requiredRoles: requiredRoleList,
    openCheckpoints,
    uncheckedCriteria,
    blockers,
    evidenceBindings,
    reasons,
    findings
  };
}

export const CAPABILITY_ACCEPTANCE_REQUIRED_CHECKPOINT_ROLES: any = DEFAULT_REQUIRED_ROLES;
