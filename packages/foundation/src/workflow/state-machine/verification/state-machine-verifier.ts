import { validateStateMachineDefinition } from "../engine/state-machine-core.ts";
import { checkDefinitionSchema } from "./state-machine-definition-schema.ts";
import {
  assertCellReferences,
  assertIllegalTransitionErrorCodes,
  assertMatrixTotality,
  assertNonTerminalTransitions,
  assertReachability,
  assertTerminalSemantics
} from "./state-machine-topology.ts";
import { guardExists, listAllGuardIds, isStaticOnlyGuard, isGuardRuntimeSafe } from "../guards/guard-registry.ts";
import { HIGH_RISK_PROTECTION_RESULTS } from "../engine/state-machine-result-types.ts";

/**
 * Pure function to verify a state machine definition against complete C3 level specifications.
 * Does not read or write from files or network.
 *
 * @param {Object} def The state machine definition object to verify
 * @param {Object} options Configuration options
 * @param {string} options.relativePath Path or identifier to display in error messages
 * @param {boolean} options.throwOnError If true, throws an Error on first check failure
 * @returns {Object} Verification report structure
 */
export function verifyMachineDefinition(def?: any, options: Record<string, any> = {}) : any {
  const relativePath: any = options.relativePath || "unknown";
  const throwOnError: any = options.throwOnError !== false;

  const checks: any[] = [];

  const addCheck: any = (id?: any, checkFn?: any) : any => {
    try {
      checkFn();
      checks.push({ id, status: "passed" });
      return true;
    } catch (err: any) {
      checks.push({ id, status: "failed", error: err.message });
      if (throwOnError) {
        throw new Error(`[${relativePath}] Check '${id}' failed: ${err.message}`);
      }
      return false;
    }
  };

  // 1. Schema check
  const schemaOk: any = addCheck("C1-schema-validation", () : any => {
    checkDefinitionSchema(def);
  });
  if (!schemaOk && throwOnError) return; // Stop if schema fails and throwing

  // 2. Core validation
  const coreOk: any = addCheck("C2-core-validation", () : any => {
    const result: any = validateStateMachineDefinition(def);
    if (!result.ok) {
      throw new Error(`Core validation failed: ${result.errors.map((e?: any) : any => e.message).join('; ')}`);
    }
  });
  if (!coreOk && throwOnError) return;

  const { machineId, version, initialState, states, events, totalMatrix, invariants, proofObligations } = def;
  // 3. Matrix Totality check
  addCheck("C2-matrix-totality", () : any => assertMatrixTotality(def));

  // 4. Reachability check (BFS)
  addCheck("C3-reachability", () : any => assertReachability(def));

  // 5. Non-terminal outgoing transition check
  addCheck("C3-non-terminal-transitions", () : any => assertNonTerminalTransitions(def));

  // 6. Terminal check (outgoing transitions rules)
  addCheck("C3-terminal-statuses", () : any => assertTerminalSemantics(def));

  // 7. Illegal transition errorCode check
  addCheck("C2-illegal-transition-error-codes", () : any => assertIllegalTransitionErrorCodes(def));

  // 8. High-risk transition check
  addCheck("C3-high-risk-guards", () : any => {
    for (const cell of totalMatrix) {
      const eventDef: any = events.find((e?: any) : any => e.id === cell.event);
      if (eventDef?.riskLevel === "high" && cell.result !== "illegal_transition" && cell.result !== "ignored_idempotent_event") {
        const hasGuard: any =
          HIGH_RISK_PROTECTION_RESULTS.includes(cell.result) ||
          (cell.guards && cell.guards.length > 0) ||
          (cell.requiredGuards && cell.requiredGuards.length > 0);
        if (!hasGuard) {
          throw new Error(`High-risk event '${cell.event}' in transition from '${cell.from}' must define a guard (guards/requiredGuards), policy/approval/external_receipt/deferred_async result`);
        }
        // requires_external_receipt must have receipt-related sideEffects or proofObligations
        if (cell.result === "requires_external_receipt") {
          const hasReceiptEvidence: any =
            (cell.sideEffects || []).some((se?: any) : any => se.includes("receipt") || se.includes("external") || se.includes("proof")) ||
            (cell.proofObligations || []).some((po?: any) : any => po.includes("receipt") || po.includes("external") || po.includes("proof"));
          if (!hasReceiptEvidence) {
            throw new Error(`High-risk event '${cell.event}' with requires_external_receipt must define receipt-related sideEffects or proofObligations`);
          }
        }
        // deferred_async_transition must have async-related sideEffects or proofObligations
        if (cell.result === "deferred_async_transition") {
          const hasAsyncEvidence: any =
            (cell.sideEffects || []).some((se?: any) : any => se.includes("async") || se.includes("resume") || se.includes("deferred")) ||
            (cell.proofObligations || []).some((po?: any) : any => po.includes("async") || po.includes("resume") || po.includes("deferred"));
          if (!hasAsyncEvidence) {
            throw new Error(`High-risk event '${cell.event}' with deferred_async_transition must define async/resume-related sideEffects or proofObligations`);
          }
        }
        // Verify no staticOnly guards on high-risk transitions
        const allGuards: any[] = [...(cell.guards || []), ...(cell.requiredGuards || [])];
        for (const g of allGuards) {
          if (isStaticOnlyGuard(g)) {
            throw new Error(`High-risk event '${cell.event}' cannot use staticOnly guard '${g}'. staticOnly guards may not gate high-risk runtime transitions.`);
          }
          if (!isGuardRuntimeSafe(g) && guardExists(g)) {
            throw new Error(`Guard '${g}' on high-risk event '${cell.event}' has no runtime predicate. Ensure guards have runtime implementations or use riskLevel=low/medium.`);
          }
        }
      }
    }
  });

  // 8b. Guard registry validation (guards AND requiredGuards)
  addCheck("C3-guard-registry", () : any => {
    const allGuardIds: any = new Set<any>(listAllGuardIds());
    for (const cell of totalMatrix) {
      for (const guardId of (cell.guards || [])) {
        if (!allGuardIds.has(guardId)) {
          throw new Error(`Guard '${guardId}' in transition from '${cell.from}' on '${cell.event}' is not registered. Known guards: ${listAllGuardIds().join(', ')}`);
        }
      }
      for (const guardId of (cell.requiredGuards || [])) {
        if (!allGuardIds.has(guardId)) {
          throw new Error(`requiredGuard '${guardId}' in transition from '${cell.from}' on '${cell.event}' is not registered. Known guards: ${listAllGuardIds().join(', ')}`);
        }
      }
    }
  });

  // 8b2. staticOnly guards must not appear in runtime guard fields
  addCheck("C3-guard-staticOnly-isolation", () : any => {
    for (const cell of totalMatrix) {
      for (const guardId of (cell.guards || [])) {
        if (isStaticOnlyGuard(guardId)) {
          throw new Error(`staticOnly guard '${guardId}' is not allowed in cell.guards for transition from '${cell.from}' on '${cell.event}'. staticOnly guards must only be used in staticAnnotations/proofAnnotations.`);
        }
      }
      for (const guardId of (cell.requiredGuards || [])) {
        if (isStaticOnlyGuard(guardId)) {
          throw new Error(`staticOnly guard '${guardId}' is not allowed in cell.requiredGuards for transition from '${cell.from}' on '${cell.event}'. staticOnly guards must only be used in staticAnnotations/proofAnnotations.`);
        }
      }
    }
  });

  // 8c. Guard proof obligation coverage for high-risk events
  addCheck("C3-guard-proof-obligation", () : any => {
    const guardObligations: any = (def.proofObligations || []).filter((po?: any) : any => po.startsWith("PO-READY-"));
    if (guardObligations.length === 0) return;
    for (const guardId of (def.guardRegistryRefs || [])) {
      const hasMapping: any = (def.proofMappings || []).some(
        (m?: any) : any => m.method === "guard_validation_by_risk" && m.params.guardId === guardId
      );
      if (!hasMapping) {
        throw new Error(`Guard '${guardId}' referenced in guardRegistryRefs has no proof obligation mapping in 'proofMappings'.`);
      }
    }
  });

  // 8d. Cell reference validity: from/to must reference known states, event must reference known events
  addCheck("C3-cell-reference-validity", () : any => assertCellReferences(def));

  // 8e. Duplicate cell guard disambiguation check
  addCheck("C3-cell-disambiguation", () : any => assertMatrixTotality(def));

  // 8f. requires_external_receipt must have sideEffects or proofObligations referencing receipt
  addCheck("C3-external-receipt-evidence", () : any => {
    for (const cell of totalMatrix) {
      if (cell.result === "requires_external_receipt") {
        const hasReceiptSideEffect: any = (cell.sideEffects || []).some((se?: any) : any =>
          se.includes("receipt") || se.includes("external") || se.includes("proof")
        );
        const hasReceiptProof: any = (cell.proofObligations || []).some((po?: any) : any =>
          po.includes("receipt") || po.includes("external") || po.includes("proof")
        );
        if (!hasReceiptSideEffect && !hasReceiptProof) {
          throw new Error(`Cell with 'requires_external_receipt' from '${cell.from}' on '${cell.event}' must define receipt-related sideEffects or proofObligations.`);
        }
      }
    }
  });

  // 8g. deferred_async_transition must have sideEffects referencing async or resume
  addCheck("C3-deferred-async-evidence", () : any => {
    for (const cell of totalMatrix) {
      if (cell.result === "deferred_async_transition") {
        const hasAsyncEvidence: any = (cell.sideEffects || []).some((se?: any) : any =>
          se.includes("async") || se.includes("resume") || se.includes("deferred")
        ) || (cell.proofObligations || []).some((po?: any) : any =>
          po.includes("async") || po.includes("resume") || po.includes("deferred")
        );
        if (!hasAsyncEvidence) {
          throw new Error(`Cell with 'deferred_async_transition' from '${cell.from}' on '${cell.event}' must define async/resume-related sideEffects or proofObligations.`);
        }
      }
    }
  });

  // 9. Invariants check
  addCheck("C3-invariants-identification", () : any => {
    const machinePrefix: any = machineId.split(".")[0].toUpperCase();
    for (const inv of invariants) {
      if (!inv.startsWith("SM-GOV-") && !inv.startsWith(`SM-${machinePrefix}-`)) {
        throw new Error(`Invariant '${inv}' does not conform to naming specification 'SM-GOV-xxx' or 'SM-${machinePrefix}-xxx'`);
      }
    }
  });

  // 10. Proof obligations and mappings check
  addCheck("C3-proof-obligations-mapping", () : any => {
    const mappings: any = def.proofMappings || [];
    for (const po of proofObligations) {
      const hasMapping: any = mappings.some((m?: any) : any => m.obligationId === po);
      if (!hasMapping) {
        throw new Error(`Proof obligation '${po}' is missing mapping details in 'proofMappings'`);
      }
    }
  });

  // 11. Secret-like scan and absolute path scan
  addCheck("C3-secret-hygiene-scan", () : any => {
    const authorizationPattern: any = /Authorization/i;
    const forbiddenPatterns: any[] = [
      /api_key/i,
      /secret/i,
      /token/i,
      /cookie/i,
      authorizationPattern,
      /Bearer/i,
      /AKIA/i,
      /-----BEGIN/i
    ];

    const absolutePathPatterns: any[] = [
      /\/Users\//i,
      /\/home\//i,
      /[a-zA-Z]:\\/i
    ];

    function isStructuralReferencePath(path: any = "") : any {
      return /\.machineId$/u.test(path) ||
        /\.entityType$/u.test(path) ||
        /\.version$/u.test(path) ||
        /\.id$/u.test(path) ||
        /\.from$/u.test(path) ||
        /\.to$/u.test(path) ||
        /\.event$/u.test(path) ||
        /\.errorCode$/u.test(path) ||
        /\.obligationId$/u.test(path) ||
        /\.method$/u.test(path) ||
        /\.capabilityId$/u.test(path) ||
        /\.planPath$/u.test(path) ||
        /\.checkpointPath$/u.test(path) ||
        /\.reportPath$/u.test(path) ||
        /\.verifier$/u.test(path) ||
        /\.platformReducerCommand$/u.test(path) ||
        /\.invariants\.\d+$/u.test(path) ||
        /\.proofObligations\.\d+$/u.test(path);
    }

    function scanSensitive(obj?: any, path: any = "root") : any {
      if (typeof obj === "string") {
        for (const pattern of absolutePathPatterns) {
          if (pattern.test(obj)) {
            throw new Error(`Absolute path matched: value '${obj}' at '${path}' contains absolute local paths.`);
          }
        }
        if (obj.startsWith("<redacted-") || obj.startsWith("redacted-") || obj === "UNREVIEWED" || obj === "sensitive_key") {
          return;
        }
        for (const pattern of forbiddenPatterns) {
          if (pattern.test(obj)) {
            if (path.includes("description") || path.includes("label")) {
              continue;
            }
            if (pattern === authorizationPattern && isStructuralReferencePath(path)) {
              continue;
            }
            throw new Error(`Sensitive pattern matched: value '${obj}' at '${path}' contains secret-like content.`);
          }
        }
      } else if (obj && typeof obj === "object") {
        for (const key of Object.keys(obj)) {
          scanSensitive(obj[key], `${path}.${key}`);
        }
      }
    }
    scanSensitive(def);
  });

  const ok: any = checks.every((c?: any) : any => c.status === "passed");

  return {
    machineId: def.machineId,
    version: def.version,
    ok,
    completenessLevel: "C3",
    stateCount: states?.length || 0,
    eventCount: events?.length || 0,
    matrixCellCount: totalMatrix?.length || 0,
    checks
  };
}
