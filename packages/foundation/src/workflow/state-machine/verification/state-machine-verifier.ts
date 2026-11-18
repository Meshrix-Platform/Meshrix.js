import { validateStateMachineDefinition } from "../engine/state-machine-core.ts";
import { checkDefinitionSchema } from "./state-machine-definition-schema.ts";
import type { ProofMapping, StateMachineDefinition } from "./state-machine-definition-schema.ts";
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
export interface MachineVerificationOptions { relativePath?: string; throwOnError?: boolean; }
export interface VerificationCheck { id: string; status: "passed" | "failed"; error?: string; }
export interface MachineVerificationReport {
  machineId: string; version: string; ok: boolean; completenessLevel: "C3";
  stateCount: number; eventCount: number; matrixCellCount: number; checks: VerificationCheck[];
}

interface CoreValidationError { message: string; }
interface CoreValidationResult { ok: boolean; errors: CoreValidationError[]; }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeCoreValidationResult(value: unknown): CoreValidationResult {
  if (!value || typeof value !== "object") {
    return { ok: false, errors: [{ message: "Core validator returned an invalid result" }] };
  }
  const candidate = value as { ok?: unknown; errors?: unknown };
  const errors = Array.isArray(candidate.errors)
    ? candidate.errors.map((entry) => {
        if (entry && typeof entry === "object" && "message" in entry && typeof entry.message === "string") {
          return { message: entry.message };
        }
        return { message: String(entry) };
      })
    : [];
  return { ok: candidate.ok === true, errors };
}

export function verifyMachineDefinition(def: unknown, options: MachineVerificationOptions = {}): MachineVerificationReport {
  const relativePath = options.relativePath || "unknown";
  const throwOnError = options.throwOnError !== false;

  const checks: VerificationCheck[] = [];

  const addCheck = (id: string, checkFn: () => void): boolean => {
    try {
      checkFn();
      checks.push({ id, status: "passed" });
      return true;
    } catch (err: unknown) {
      const message = errorMessage(err);
      checks.push({ id, status: "failed", error: message });
      if (throwOnError) {
        throw new Error(`[${relativePath}] Check '${id}' failed: ${message}`);
      }
      return false;
    }
  };

  // 1. Schema check
  let definition: StateMachineDefinition | undefined;
  const schemaOk = addCheck("C1-schema-validation", () => {
    if (!checkDefinitionSchema(def)) throw new Error("definition schema validation failed");
    definition = def as StateMachineDefinition;
  });
  if (!schemaOk || !definition) {
    return {
      machineId: "", version: "", ok: false, completenessLevel: "C3",
      stateCount: 0, eventCount: 0, matrixCellCount: 0, checks
    };
  }
  const machineDefinition = definition;

  // 2. Core validation
  addCheck("C2-core-validation", () => {
    const result = normalizeCoreValidationResult(validateStateMachineDefinition(machineDefinition));
    if (!result.ok) {
      throw new Error(`Core validation failed: ${result.errors.map((error) => error.message).join('; ')}`);
    }
  });

  const { machineId, states, events, totalMatrix, invariants, proofObligations } = machineDefinition;
  // 3. Matrix Totality check
  addCheck("C2-matrix-totality", () => assertMatrixTotality(machineDefinition));

  // 4. Reachability check (BFS)
  addCheck("C3-reachability", () => assertReachability(machineDefinition));

  // 5. Non-terminal outgoing transition check
  addCheck("C3-non-terminal-transitions", () => assertNonTerminalTransitions(machineDefinition));

  // 6. Terminal check (outgoing transitions rules)
  addCheck("C3-terminal-statuses", () => assertTerminalSemantics(machineDefinition));

  // 7. Illegal transition errorCode check
  addCheck("C2-illegal-transition-error-codes", () => assertIllegalTransitionErrorCodes(machineDefinition));

  // 8. High-risk transition check
  addCheck("C3-high-risk-guards", () => {
    for (const cell of totalMatrix) {
      const eventDef = events.find((event) => event.id === cell.event);
      if (eventDef?.riskLevel === "high" && cell.result !== "illegal_transition" && cell.result !== "ignored_idempotent_event") {
        const hasGuard =
          HIGH_RISK_PROTECTION_RESULTS.some((result) => result === cell.result) ||
          (cell.guards && cell.guards.length > 0) ||
          (cell.requiredGuards && cell.requiredGuards.length > 0);
        if (!hasGuard) {
          throw new Error(`High-risk event '${cell.event}' in transition from '${cell.from}' must define a guard (guards/requiredGuards), policy/approval/external_receipt/deferred_async result`);
        }
        // requires_external_receipt must have receipt-related sideEffects or proofObligations
        if (cell.result === "requires_external_receipt") {
          const hasReceiptEvidence =
            (cell.sideEffects || []).some((item) => item.includes("receipt") || item.includes("external") || item.includes("proof")) ||
            (cell.proofObligations || []).some((item) => item.includes("receipt") || item.includes("external") || item.includes("proof"));
          if (!hasReceiptEvidence) {
            throw new Error(`High-risk event '${cell.event}' with requires_external_receipt must define receipt-related sideEffects or proofObligations`);
          }
        }
        // deferred_async_transition must have async-related sideEffects or proofObligations
        if (cell.result === "deferred_async_transition") {
          const hasAsyncEvidence =
            (cell.sideEffects || []).some((item) => item.includes("async") || item.includes("resume") || item.includes("deferred")) ||
            (cell.proofObligations || []).some((item) => item.includes("async") || item.includes("resume") || item.includes("deferred"));
          if (!hasAsyncEvidence) {
            throw new Error(`High-risk event '${cell.event}' with deferred_async_transition must define async/resume-related sideEffects or proofObligations`);
          }
        }
        // Verify no staticOnly guards on high-risk transitions
        const allGuards = [...(cell.guards || []), ...(cell.requiredGuards || [])];
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
  addCheck("C3-guard-registry", () => {
    const allGuardIds = new Set(listAllGuardIds());
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
  addCheck("C3-guard-staticOnly-isolation", () => {
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
  addCheck("C3-guard-proof-obligation", () => {
    const guardObligations = machineDefinition.proofObligations.filter((obligation) => obligation.startsWith("PO-READY-"));
    if (guardObligations.length === 0) return;
    for (const guardId of (machineDefinition.guardRegistryRefs || [])) {
      const hasMapping = (machineDefinition.proofMappings || []).some(
        (mapping) => mapping.method === "guard_validation_by_risk" && mapping.params?.guardId === guardId
      );
      if (!hasMapping) {
        throw new Error(`Guard '${guardId}' referenced in guardRegistryRefs has no proof obligation mapping in 'proofMappings'.`);
      }
    }
  });

  // 8d. Cell reference validity: from/to must reference known states, event must reference known events
  addCheck("C3-cell-reference-validity", () => assertCellReferences(machineDefinition));

  // 8e. Duplicate cell guard disambiguation check
  addCheck("C3-cell-disambiguation", () => assertMatrixTotality(machineDefinition));

  // 8f. requires_external_receipt must have sideEffects or proofObligations referencing receipt
  addCheck("C3-external-receipt-evidence", () => {
    for (const cell of totalMatrix) {
      if (cell.result === "requires_external_receipt") {
        const hasReceiptSideEffect = (cell.sideEffects || []).some((item) =>
          item.includes("receipt") || item.includes("external") || item.includes("proof")
        );
        const hasReceiptProof = (cell.proofObligations || []).some((item) =>
          item.includes("receipt") || item.includes("external") || item.includes("proof")
        );
        if (!hasReceiptSideEffect && !hasReceiptProof) {
          throw new Error(`Cell with 'requires_external_receipt' from '${cell.from}' on '${cell.event}' must define receipt-related sideEffects or proofObligations.`);
        }
      }
    }
  });

  // 8g. deferred_async_transition must have sideEffects referencing async or resume
  addCheck("C3-deferred-async-evidence", () => {
    for (const cell of totalMatrix) {
      if (cell.result === "deferred_async_transition") {
        const hasAsyncEvidence = (cell.sideEffects || []).some((item) =>
          item.includes("async") || item.includes("resume") || item.includes("deferred")
        ) || (cell.proofObligations || []).some((item) =>
          item.includes("async") || item.includes("resume") || item.includes("deferred")
        );
        if (!hasAsyncEvidence) {
          throw new Error(`Cell with 'deferred_async_transition' from '${cell.from}' on '${cell.event}' must define async/resume-related sideEffects or proofObligations.`);
        }
      }
    }
  });

  // 9. Invariants check
  addCheck("C3-invariants-identification", () => {
    const machinePrefix = machineId.split(".")[0].toUpperCase();
    for (const inv of invariants) {
      if (!inv.startsWith("SM-GOV-") && !inv.startsWith(`SM-${machinePrefix}-`)) {
        throw new Error(`Invariant '${inv}' does not conform to naming specification 'SM-GOV-xxx' or 'SM-${machinePrefix}-xxx'`);
      }
    }
  });

  // 10. Proof obligations and mappings check
  addCheck("C3-proof-obligations-mapping", () => {
    const mappings: ProofMapping[] = machineDefinition.proofMappings || [];
    for (const po of proofObligations) {
      const hasMapping = mappings.some((mapping) => mapping.obligationId === po);
      if (!hasMapping) {
        throw new Error(`Proof obligation '${po}' is missing mapping details in 'proofMappings'`);
      }
    }
  });

  // 11. Secret-like scan and absolute path scan
  addCheck("C3-secret-hygiene-scan", () => {
    const authorizationPattern = /Authorization/i;
    const forbiddenPatterns: RegExp[] = [
      /api_key/i,
      /secret/i,
      /token/i,
      /cookie/i,
      authorizationPattern,
      /Bearer/i,
      /AKIA/i,
      /-----BEGIN/i
    ];

    const absolutePathPatterns: RegExp[] = [
      /\/Users\//i,
      /\/home\//i,
      /[a-zA-Z]:\\/i
    ];

    function isStructuralReferencePath(path: string = ""): boolean {
      return path.endsWith(".machineId") ||
        path.endsWith(".entityType") ||
        path.endsWith(".version") ||
        path.endsWith(".id") ||
        path.endsWith(".from") ||
        path.endsWith(".to") ||
        path.endsWith(".event") ||
        path.endsWith(".errorCode") ||
        path.endsWith(".obligationId") ||
        path.endsWith(".method") ||
        path.endsWith(".capabilityId") ||
        path.endsWith(".planPath") ||
        path.endsWith(".checkpointPath") ||
        path.endsWith(".reportPath") ||
        path.endsWith(".verifier") ||
        path.endsWith(".platformReducerCommand") ||
        /\.invariants\.\d+$/u.test(path) ||
        /\.proofObligations\.\d+$/u.test(path);
    }

    function scanSensitive(obj: unknown, path: string = "root"): void {
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
      } else if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const record = obj as Record<string, unknown>;
        for (const key of Object.keys(record)) {
          scanSensitive(record[key], `${path}.${key}`);
        }
      } else if (Array.isArray(obj)) {
        obj.forEach((value, index) => scanSensitive(value, `${path}.${index}`));
      }
    }
    scanSensitive(machineDefinition);
  });

  const ok = checks.every((check) => check.status === "passed");

  return {
    machineId: machineDefinition.machineId,
    version: machineDefinition.version,
    ok,
    completenessLevel: "C3",
    stateCount: states?.length || 0,
    eventCount: events?.length || 0,
    matrixCellCount: totalMatrix?.length || 0,
    checks
  };
}
