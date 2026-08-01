import {
  resolvePluginRuntimeModuleUrl,
  resolvePluginVerifierHookSourceUrl
} from "../../../packages/foundation/src/module-system/plugin-registry.ts";

export const PLUGIN_RUNTIME_REPORT_PATH: any = "build/reports/plugin-runtime.json";
export const PLUGIN_RUNTIME_EXTERNAL_EVIDENCE_REASON: any = "plugin-runtime-external-evidence-incomplete";
export const PLUGIN_RUNTIME_CAPABILITY_BINDING_SOURCE: any =
  "tools/server-scripts/lib/plugin-runtime-capability-bindings.ts#reducePluginRuntimeCapabilityBindings";

function asRecord(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value?: any) : any {
  return String(value || "").trim();
}

function uniqueStrings(values: any = []) : any {
  return [...new Set<any>(values.map(text).filter(Boolean))];
}

function normalizePluginOwnershipFailure(blocker: Record<string, any> = {}) : any {
  const pluginId: any = text(blocker.pluginId);
  const pluginIds: any = uniqueStrings([
    pluginId,
    ...(Array.isArray(blocker.pluginIds) ? blocker.pluginIds : [])
  ]);
  const kind: any = ["external-evidence", "local-implementation"]
    .includes(text(blocker.kind))
    ? text(blocker.kind)
    : "local-implementation";
  return {
    code: text(blocker.code) || text(blocker.id) ||
      `plugin-${pluginIds[0] || "unknown"}-runtime-ownership-incomplete`,
    kind,
    sourceReport: PLUGIN_RUNTIME_REPORT_PATH,
    pluginIds,
    reasonCodes: uniqueStrings(blocker.reasonCodes),
    evidence: uniqueStrings(blocker.evidence),
    requiredClosure: uniqueStrings(blocker.requiredClosure)
  };
}

function aggregatePluginOwnershipFailure(blockers: any = []) : any {
  const normalized: any = blockers.map(normalizePluginOwnershipFailure);
  const kind: any = normalized.some((blocker?: any) : any => blocker.kind === "local-implementation")
    ? "local-implementation"
    : "external-evidence";
  return {
    code: "plugin-runtime-ownership-incomplete",
    kind,
    sourceReport: PLUGIN_RUNTIME_REPORT_PATH,
    pluginIds: uniqueStrings(normalized.flatMap((blocker?: any) : any => blocker.pluginIds)).sort(),
    reasonCodes: uniqueStrings(normalized.flatMap((blocker?: any) : any => blocker.reasonCodes)).sort(),
    evidence: uniqueStrings(normalized.flatMap((blocker?: any) : any => blocker.evidence)).sort(),
    requiredClosure: uniqueStrings(normalized.flatMap((blocker?: any) : any => blocker.requiredClosure))
  };
}

function bindingFinding(code?: any, message?: any, { capabilityId = "", pluginId = "" }: Record<string, any> = {}) : any {
  return {
    code,
    message,
    category: "plugin-runtime-capability-binding",
    capabilityId,
    pluginId
  };
}

export async function collectPluginRuntimeOwnershipFailures(registry?: any, _options?: any) : Promise<any> {
  const blockers: any[] = [];
  for (const plugin of registry.listPlugins()) {
    const activeEvidence: any[] = [];
    const reasons: any[] = [];
    if (!plugin.runtime) {
      reasons.push("runtime_module_missing");
    } else {
      try {
        await resolvePluginRuntimeModuleUrl(plugin);
      } catch {
        reasons.push("runtime_module_unavailable");
      }
    }
    for (const hook of plugin.verifierHooks || []) {
      try {
        await resolvePluginVerifierHookSourceUrl(plugin, hook.id);
      } catch {
        reasons.push("verifier_configured_workload_source_unavailable");
        activeEvidence.push(`plugins/${plugin.id}/plugin.json`);
        break;
      }
    }
    if (reasons.length === 0) continue;
    blockers.push({
      id: `plugin-${plugin.id}-runtime-ownership-incomplete`,
      status: "failed",
      kind: "local-implementation",
      pluginId: plugin.id,
      reasonCodes: reasons,
      evidence: activeEvidence,
      requiredClosure: [
        "Move the complete operation, route, MCP tool, console, state-machine, and lifecycle implementation into the plugin directory.",
        "Make explicit plugin selection the only registration authority and remove the core or feature-manifest composition path.",
        "Add plugin-owned load, disabled-start, removal-start, and lifecycle verification.",
        "Declare verifier hooks only as dedicated configured workloads and accept only terminal controlled-sandbox receipt references."
      ]
    });
  }
  return blockers;
}

export function reducePluginRuntimeCapabilityBindings({
  pluginIds = [],
  blockers = [],
  capabilityEntries = []
}: Record<string, any> = {}) : any {
  const findings: any[] = [];
  const knownPluginIds: any = uniqueStrings(pluginIds).sort();
  const knownPluginIdSet: any = new Set<any>(knownPluginIds);
  const ownersByPluginId: any = new Map<any, any>();
  const aggregateCapabilityIds: any[] = [];
  const blockersByCapability: Record<string, any> = {};

  for (const rawEntry of capabilityEntries) {
    const entry: any = asRecord(rawEntry);
    const capabilityId: any = text(entry.capabilityId);
    const binding: any = asRecord(entry.pluginRuntime);
    const pluginIds: any = uniqueStrings(binding.pluginIds);
    const aggregate: any = binding.aggregate === true;
    if (!aggregate && pluginIds.length === 0) continue;
    if (!capabilityId) {
      findings.push(bindingFinding(
        "plugin-runtime-capability-id-missing",
        "A plugin runtime capability binding is missing its capability id."
      ));
      continue;
    }
    if (aggregate) {
      aggregateCapabilityIds.push(capabilityId);
      if (pluginIds.length > 0) {
        findings.push(bindingFinding(
          "plugin-runtime-aggregate-has-plugin-ids",
          "The aggregate plugin runtime capability cannot also own individual plugin ids.",
          { capabilityId }
        ));
      }
      continue;
    }
    for (const pluginId of pluginIds) {
      if (!knownPluginIdSet.has(pluginId)) {
        findings.push(bindingFinding(
          "plugin-runtime-capability-plugin-unknown",
          `Capability ${capabilityId} maps an unknown plugin id.`,
          { capabilityId, pluginId }
        ));
      }
      const owners: any = ownersByPluginId.get(pluginId) || [];
      owners.push(capabilityId);
      ownersByPluginId.set(pluginId, owners);
    }
  }

  if (aggregateCapabilityIds.length !== 1) {
    findings.push(bindingFinding(
      "plugin-runtime-aggregate-capability-count-invalid",
      "Exactly one capability must aggregate plugin runtime ownership state."
    ));
  }

  for (const pluginId of knownPluginIds) {
    const owners: any = uniqueStrings(ownersByPluginId.get(pluginId) || []);
    if (owners.length === 0) {
      findings.push(bindingFinding(
        "plugin-runtime-plugin-capability-unmapped",
        "A plugin has no owning capability acceptance binding.",
        { pluginId }
      ));
    } else if (owners.length > 1) {
      findings.push(bindingFinding(
        "plugin-runtime-plugin-capability-ambiguous",
        "A plugin is mapped to more than one owning capability.",
        { pluginId }
      ));
    }
  }

  for (const blocker of blockers) {
    const pluginId: any = text(blocker?.pluginId);
    if (!knownPluginIdSet.has(pluginId)) {
      findings.push(bindingFinding(
        "plugin-runtime-blocker-plugin-unknown",
        "The plugin runtime ownership report contains an unknown plugin failure.",
        { pluginId }
      ));
      continue;
    }
    const owners: any = uniqueStrings(ownersByPluginId.get(pluginId) || []);
    if (owners.length === 1) {
      blockersByCapability[owners[0]] ||= [];
      blockersByCapability[owners[0]].push(normalizePluginOwnershipFailure(blocker));
    }
  }

  if (blockers.length > 0 && aggregateCapabilityIds.length === 1) {
    blockersByCapability[aggregateCapabilityIds[0]] = [aggregatePluginOwnershipFailure(blockers)];
  }

  return {
    sourceOfTruth: PLUGIN_RUNTIME_CAPABILITY_BINDING_SOURCE,
    pluginIds: knownPluginIds,
    unownedPluginIds: uniqueStrings(blockers.map((blocker?: any) : any => blocker?.pluginId)).sort(),
    blockersByCapability,
    findings
  };
}

function criterionUsesPluginRuntimeReport(criterion: Record<string, any> = {}) : any {
  return Array.isArray(criterion.evidence) && criterion.evidence.some((rawEvidence?: any) : any => {
    const evidence: any = asRecord(rawEvidence);
    return text(evidence.report) === PLUGIN_RUNTIME_REPORT_PATH ||
      /(?:^|\s)npm\s+run\s+verify:plugin-runtime(?:\s|$)/u.test(text(evidence.command));
  });
}

export function pluginRuntimeCheckpointRefs(checkpoints: any = []) : any {
  const refs: any[] = [];
  for (const checkpoint of Array.isArray(checkpoints) ? checkpoints : []) {
    const checkpointId: any = text(checkpoint?.id);
    const role: any = text(checkpoint?.role);
    if (!checkpointId || !["implementation", "final_validation"].includes(role)) continue;
    for (const [criterionIndex, criterion] of (checkpoint.acceptance_criteria || []).entries()) {
      if (!criterionUsesPluginRuntimeReport(criterion)) continue;
      refs.push({
        checkpointId,
        role,
        criterionIndex,
        text: text(criterion?.text)
      });
    }
  }
  if (refs.some((ref?: any) : any => ref.role === "implementation") && !refs.some((ref?: any) : any => ref.role === "final_validation")) {
    const finalValidation: any = (Array.isArray(checkpoints) ? checkpoints : [])
      .find((checkpoint?: any) : any => text(checkpoint?.role) === "final_validation");
    const aggregateCriterion: any = finalValidation?.acceptance_criteria?.[0];
    if (text(finalValidation?.id) && text(aggregateCriterion?.text)) {
      refs.push({
        checkpointId: text(finalValidation.id),
        role: "final_validation",
        criterionIndex: 0,
        text: text(aggregateCriterion.text)
      });
    }
  }
  return refs;
}

function refKey(ref: Record<string, any> = {}) : any {
  return `${text(ref.checkpointId)}:${Number.isInteger(ref.criterionIndex) ? ref.criterionIndex : ""}`;
}

function uncheckedKey(criterion: Record<string, any> = {}) : any {
  return `${refKey(criterion)}:${text(criterion.reason)}`;
}

export function applyPluginRuntimeCapabilityFailures(
  checkpointReduction?: any,
  checkpoints?: any,
  pluginRuntimeBlockers: any = []
) : any {
  if (!Array.isArray(pluginRuntimeBlockers) || pluginRuntimeBlockers.length === 0) {
    return checkpointReduction;
  }
  const refs: any = pluginRuntimeCheckpointRefs(checkpoints);
  if (refs.length === 0) {
    return {
      ...checkpointReduction,
      currentState: "failed",
      readyForReleaseReduction: false,
      blocked: false,
      failureKind: "plugin-runtime-checkpoint-evidence-missing",
      findings: [
        ...(checkpointReduction.findings || []),
        {
          code: "plugin-runtime-checkpoint-evidence-missing",
          message: "A plugin-bound capability has no implementation or final-validation criterion tied to the plugin runtime report.",
          category: "checkpoint-evidence",
          checkpointId: "",
          role: "",
          prerequisiteId: "",
          criterionIndex: null,
          criterionText: ""
        }
      ]
    };
  }

  const normalizedPluginRuntimeBlockers: any = pluginRuntimeBlockers.map(normalizePluginOwnershipFailure);
  const affectedCheckpointIds: any = new Set<any>(refs.map((ref?: any) : any => ref.checkpointId));
  const hasLocalImplementationBlocker: any = normalizedPluginRuntimeBlockers.some(
    (blocker?: any) : any => blocker.kind === "local-implementation"
  );
  const overlayReason: any = hasLocalImplementationBlocker
    ? "plugin-runtime-local-implementation-incomplete"
    : PLUGIN_RUNTIME_EXTERNAL_EVIDENCE_REASON;
  const rawCheckpoints: any = Array.isArray(checkpoints) ? checkpoints : [];
  const rawCheckpointById: any = new Map<any, any>(rawCheckpoints.map((checkpoint?: any) : any => [text(checkpoint?.id), checkpoint]));
  const openCheckpointById: any = new Map<any, any>((checkpointReduction.openCheckpoints || [])
    .map((checkpoint?: any) : any => [text(checkpoint.id), { ...checkpoint }]));
  for (const checkpointId of affectedCheckpointIds) {
    const raw: any = asRecord(rawCheckpointById.get(checkpointId));
    openCheckpointById.set(checkpointId, {
      id: checkpointId,
      role: text(raw.role),
      status: hasLocalImplementationBlocker ? "pending" : "blocked",
      sourceStatus: text(raw.status),
      reason: overlayReason
    });
  }

  const uncheckedByKey: any = new Map<any, any>((checkpointReduction.uncheckedCriteria || [])
    .map((criterion?: any) : any => [uncheckedKey(criterion), { ...criterion }]));
  for (const ref of refs) {
    const unchecked: Record<string, any> = {
      ...ref,
      reason: overlayReason
    };
    uncheckedByKey.set(uncheckedKey(unchecked), unchecked);
  }

  const blockers: any = normalizedPluginRuntimeBlockers.map((blocker?: any) : any => ({
    ...blocker,
    checkpointRefs: refs.map(({ checkpointId, role, criterionIndex }: Record<string, any>) : any => ({
      checkpointId,
      role,
      criterionIndex
    }))
  }));
  const completedCheckpointCount: any = rawCheckpoints.filter((checkpoint?: any) : any =>
    text(checkpoint?.status) === "completed" && !affectedCheckpointIds.has(text(checkpoint?.id))
  ).length;
  const baseBlocked: any = checkpointReduction.blocked === true ||
    (checkpointReduction.blockers || []).length > 0;
  const hasFindings: any = (checkpointReduction.findings || []).length > 0;
  const reasons: any = uniqueStrings([
    ...(checkpointReduction.reasons || []),
    ...blockers.map((blocker?: any) : any => `${blocker.code}:${PLUGIN_RUNTIME_EXTERNAL_EVIDENCE_REASON}`)
  ]);

  return {
    ...checkpointReduction,
    currentState: hasFindings || hasLocalImplementationBlocker ? "failed" : "blocked",
    readyForReleaseReduction: false,
    blocked: !hasFindings && !hasLocalImplementationBlocker,
    failureKind: hasFindings
      ? checkpointReduction.failureKind
      : hasLocalImplementationBlocker
        ? "plugin-runtime-local-implementation-incomplete"
      : baseBlocked
        ? "multiple-blockers"
        : PLUGIN_RUNTIME_EXTERNAL_EVIDENCE_REASON,
    completedCheckpointCount,
    openCheckpoints: [...openCheckpointById.values()],
    uncheckedCriteria: [...uncheckedByKey.values()],
    blockers: [...(checkpointReduction.blockers || []), ...blockers],
    reasons,
    pluginRuntimeReductionSourceOfTruth: PLUGIN_RUNTIME_CAPABILITY_BINDING_SOURCE,
    pluginRuntimeBlockerCount: blockers.length
  };
}
