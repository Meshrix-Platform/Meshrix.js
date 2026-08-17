import { VALID_TRANSITION_RESULTS } from "../engine/state-machine-result-types.ts";

export interface StateDefinition { id: string; terminal?: boolean; externalEntryState?: boolean; waitingStateWithTimeout?: boolean; passiveState?: boolean; }
export interface EventDefinition { id: string; idempotent?: boolean; riskLevel?: "low" | "medium" | "high"; }
export interface MatrixCell {
  from: string; event: string; result: string; to?: string; errorCode?: string;
  allowedReopenTransition?: boolean; guards?: string[]; requiredGuards?: string[];
  sideEffects?: string[]; proofObligations?: string[];
}
export interface ProofMapping { obligationId: string; method: string; params?: Record<string, unknown>; }
export interface StateMachineDefinition {
  machineId: string; entityType: string; version: string; description: string; initialState: string;
  states: StateDefinition[]; events: EventDefinition[]; totalMatrix: MatrixCell[];
  invariants: string[]; proofObligations: string[]; proofMappings?: ProofMapping[];
  guardRegistryRefs?: string[]; allowedTerminalEvents?: string[]; acceptance?: Record<string, unknown>;
  [key: string]: unknown;
}

interface AcceptanceProofContract { method: string; params: readonly string[]; role?: string; }

const ACCEPTANCE_PROOF_CONTRACTS: Readonly<Record<string, AcceptanceProofContract>> = Object.freeze({
  "PO-ACCEPTANCE-REGISTRY-LINK": Object.freeze({
    method: "registry_entry_matches_machine",
    params: Object.freeze(["registryPath", "capabilityId", "machineId"])
  }),
  "PO-ACCEPTANCE-CHECKPOINT-IMPLEMENTATION": Object.freeze({
    method: "checkpoint_role_exists",
    params: Object.freeze(["checkpointPath", "role"]),
    role: "implementation"
  }),
  "PO-ACCEPTANCE-FINAL-VALIDATION": Object.freeze({
    method: "checkpoint_role_exists",
    params: Object.freeze(["checkpointPath", "role"]),
    role: "final_validation"
  }),
  "PO-ACCEPTANCE-PLATFORM-REDUCER-BOUNDARY": Object.freeze({
    method: "external_platform_reducer_reference",
    params: Object.freeze(["platformReducerCommand", "capabilityReportPath"])
  }),
  "PO-ACCEPTANCE-PRIVACY-SAFE-EVIDENCE": Object.freeze({
    method: "report_leak_scan",
    params: Object.freeze(["reportPath"])
  })
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
}

function requireExactString(record: Record<string, unknown>, key: string, expected: string | null = null): void {
  if (typeof record?.[key] !== "string" || !record[key].trim()) {
    throw new Error(`capability acceptance field '${key}' must be a non-empty string`);
  }
  if (expected !== null && record[key] !== expected) {
    throw new Error(`capability acceptance field '${key}' must equal '${expected}'`);
  }
}

function checkCapabilityAcceptanceDefinition(def: StateMachineDefinition): void {
  const acceptance = def.acceptance;
  if (!isRecord(acceptance)) {
    throw new Error("capability acceptance definition requires acceptance metadata");
  }
  requireExactString(acceptance, "capabilityId");
  requireExactString(acceptance, "registryPath", "tools/registry/capability-acceptance.registry.json");
  requireExactString(acceptance, "checkpointPath", `tools/registry/capability-acceptance-checkpoints/${acceptance.capabilityId}.json`);
  requireExactString(acceptance, "platformReducerCommand", "npm run verify:acceptance");
  requireExactString(acceptance, "verifier", "tools/server-scripts/verify-capability-acceptance-machines.ts");
  requireExactString(acceptance, "reportPath", "build/reports/capability-acceptance-machines.json");
  if (def.machineId !== `acceptance.${acceptance.capabilityId}`) {
    throw new Error("capability acceptance machineId must match acceptance.capabilityId");
  }

  const obligations = new Set(def.proofObligations);
  const mappings = new Map<string, ProofMapping>();
  for (const mapping of def.proofMappings || []) {
    if (mappings.has(mapping.obligationId)) {
      throw new Error(`duplicate proof mapping for '${mapping.obligationId}'`);
    }
    mappings.set(mapping.obligationId, mapping);
  }
  for (const [obligationId, contract] of Object.entries(ACCEPTANCE_PROOF_CONTRACTS)) {
    if (!obligations.has(obligationId)) {
      throw new Error(`capability acceptance proof obligation '${obligationId}' is required`);
    }
    const mapping = mappings.get(obligationId);
    if (!mapping || mapping.method !== contract.method) {
      throw new Error(`proof obligation '${obligationId}' must use method '${contract.method}'`);
    }
    const params = mapping.params || {};
    const actualKeys = Object.keys(params).sort();
    const expectedKeys = [...contract.params].sort();
    if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
      throw new Error(`proof method '${contract.method}' must declare exactly: ${expectedKeys.join(", ")}`);
    }
    for (const key of expectedKeys) requireExactString(params, key);
    if (contract.role && params.role !== contract.role) {
      throw new Error(`proof obligation '${obligationId}' must bind role '${contract.role}'`);
    }
  }
  if (mappings.size !== obligations.size || mappings.size !== Object.keys(ACCEPTANCE_PROOF_CONTRACTS).length) {
    throw new Error("capability acceptance proof obligations and mappings must match the canonical contract exactly");
  }

  const expectedParams: Record<string, Record<string, unknown>> = {
    "PO-ACCEPTANCE-REGISTRY-LINK": {
      registryPath: acceptance.registryPath,
      capabilityId: acceptance.capabilityId,
      machineId: def.machineId
    },
    "PO-ACCEPTANCE-CHECKPOINT-IMPLEMENTATION": {
      checkpointPath: acceptance.checkpointPath,
      role: "implementation"
    },
    "PO-ACCEPTANCE-FINAL-VALIDATION": {
      checkpointPath: acceptance.checkpointPath,
      role: "final_validation"
    },
    "PO-ACCEPTANCE-PLATFORM-REDUCER-BOUNDARY": {
      platformReducerCommand: acceptance.platformReducerCommand,
      capabilityReportPath: acceptance.reportPath
    },
    "PO-ACCEPTANCE-PRIVACY-SAFE-EVIDENCE": { reportPath: acceptance.reportPath }
  };
  for (const [obligationId, params] of Object.entries(expectedParams)) {
    if (JSON.stringify(mappings.get(obligationId)?.params) !== JSON.stringify(params)) {
      throw new Error(`proof obligation '${obligationId}' parameters do not match acceptance metadata`);
    }
  }

  const verificationEvent = def.events.find((event) => event.id === "capability_verifiers_pass");
  if (verificationEvent?.riskLevel !== "high") {
    throw new Error("capability_verifiers_pass must be classified as high risk");
  }
  const verificationCell = def.totalMatrix.find((cell) =>
    cell.from === "implemented" && cell.event === "capability_verifiers_pass"
  );
  if (verificationCell?.result !== "requires_external_receipt" ||
      !(verificationCell.sideEffects || []).some((item) => item.includes("receipt"))) {
    throw new Error("implemented capability verification must require a verification receipt");
  }
}

export function checkDefinitionSchema(def: unknown): boolean {
  if (!isRecord(def)) {
    throw new Error("definition must be a JSON object");
  }

  const requiredStringFields = ["machineId", "entityType", "version", "description", "initialState"] as const;
  for (const field of requiredStringFields) {
    if (typeof def[field] !== "string" || !def[field].trim()) {
      throw new Error(`definition field '${field}' must be a non-empty string`);
    }
  }

  // states validation
  if (!Array.isArray(def.states)) {
    throw new Error("definition field 'states' must be an array");
  }
  for (const state of def.states) {
    if (typeof state !== "object" || Array.isArray(state) || !state) {
      throw new Error("state item must be a JSON object");
    }
    if (typeof state.id !== "string" || !state.id.trim()) {
      throw new Error("state item 'id' must be a non-empty string");
    }
    if (state.terminal !== undefined && typeof state.terminal !== "boolean") {
      throw new Error(`state '${state.id}' field 'terminal' must be a boolean`);
    }
    if (state.externalEntryState !== undefined && typeof state.externalEntryState !== "boolean") {
      throw new Error(`state '${state.id}' field 'externalEntryState' must be a boolean`);
    }
    if (state.waitingStateWithTimeout !== undefined && typeof state.waitingStateWithTimeout !== "boolean") {
      throw new Error(`state '${state.id}' field 'waitingStateWithTimeout' must be a boolean`);
    }
    if (state.passiveState !== undefined && typeof state.passiveState !== "boolean") {
      throw new Error(`state '${state.id}' field 'passiveState' must be a boolean`);
    }
  }

  // events validation
  if (!Array.isArray(def.events)) {
    throw new Error("definition field 'events' must be an array");
  }
  for (const event of def.events) {
    if (typeof event !== "object" || Array.isArray(event) || !event) {
      throw new Error("event item must be a JSON object");
    }
    if (typeof event.id !== "string" || !event.id.trim()) {
      throw new Error("event item 'id' must be a non-empty string");
    }
    if (event.idempotent !== undefined && typeof event.idempotent !== "boolean") {
      throw new Error(`event '${event.id}' field 'idempotent' must be a boolean`);
    }
    if (event.riskLevel !== undefined && !["low", "medium", "high"].includes(event.riskLevel)) {
      throw new Error(`event '${event.id}' field 'riskLevel' must be 'low', 'medium', or 'high'`);
    }
  }

  // totalMatrix validation
  if (!Array.isArray(def.totalMatrix)) {
    throw new Error("definition field 'totalMatrix' must be an array");
  }
  const validResults = VALID_TRANSITION_RESULTS;
  for (const cell of def.totalMatrix) {
    if (typeof cell !== "object" || Array.isArray(cell) || !cell) {
      throw new Error("matrix cell must be a JSON object");
    }
    if (typeof cell.from !== "string" || !cell.from.trim()) {
      throw new Error("matrix cell 'from' must be a non-empty string");
    }
    if (typeof cell.event !== "string" || !cell.event.trim()) {
      throw new Error("matrix cell 'event' must be a non-empty string");
    }
    if (!validResults.includes(cell.result)) {
      throw new Error(`matrix cell from '${cell.from}' on '${cell.event}' has invalid result: '${cell.result}'`);
    }
    if (cell.to !== undefined && typeof cell.to !== "string") {
      throw new Error("matrix cell 'to' must be a string");
    }
    if (cell.errorCode !== undefined && typeof cell.errorCode !== "string") {
      throw new Error("matrix cell 'errorCode' must be a string");
    }
    if (cell.allowedReopenTransition !== undefined && typeof cell.allowedReopenTransition !== "boolean") {
      throw new Error("matrix cell 'allowedReopenTransition' must be a boolean");
    }
    if (cell.guards !== undefined) {
      if (!Array.isArray(cell.guards)) {
        throw new Error("matrix cell 'guards' must be an array of strings");
      }
      for (const g of cell.guards) {
        if (typeof g !== "string" || !g.trim()) {
          throw new Error("guards list items must be non-empty strings");
        }
      }
    }
    if (cell.requiredGuards !== undefined) {
      if (!Array.isArray(cell.requiredGuards)) {
        throw new Error("matrix cell 'requiredGuards' must be an array of strings");
      }
      for (const rg of cell.requiredGuards) {
        if (typeof rg !== "string" || !rg.trim()) {
          throw new Error("requiredGuards list items must be non-empty strings");
        }
      }
    }
    if (cell.sideEffects !== undefined) {
      requireStringArray(cell.sideEffects, "matrix cell 'sideEffects'");
    }
    if (cell.proofObligations !== undefined) {
      requireStringArray(cell.proofObligations, "matrix cell 'proofObligations'");
    }
  }

  // invariants validation
  if (!Array.isArray(def.invariants)) {
    throw new Error("definition field 'invariants' must be an array");
  }
  for (const inv of def.invariants) {
    if (typeof inv !== "string" || !inv.trim()) {
      throw new Error("invariant list items must be non-empty strings");
    }
  }

  // proofObligations validation
  if (!Array.isArray(def.proofObligations)) {
    throw new Error("definition field 'proofObligations' must be an array");
  }
  for (const po of def.proofObligations) {
    if (typeof po !== "string" || !po.trim()) {
      throw new Error("proofObligations list items must be non-empty strings");
    }
  }

  // proofMappings validation if present
  if (def.proofMappings !== undefined) {
    if (!Array.isArray(def.proofMappings)) {
      throw new Error("definition field 'proofMappings' must be an array");
    }
    for (const mapping of def.proofMappings) {
      if (typeof mapping !== "object" || Array.isArray(mapping) || !mapping) {
        throw new Error("proofMapping item must be a JSON object");
      }
      if (typeof mapping.obligationId !== "string" || !mapping.obligationId.trim()) {
        throw new Error("proofMapping 'obligationId' must be a non-empty string");
      }
      if (typeof mapping.method !== "string" || !mapping.method.trim()) {
        throw new Error("proofMapping 'method' must be a non-empty string");
      }
      if (mapping.params !== undefined && !isRecord(mapping.params)) {
        throw new Error("proofMapping 'params' must be an object");
      }
    }
  }

  if (def.guardRegistryRefs !== undefined) {
    requireStringArray(def.guardRegistryRefs, "definition field 'guardRegistryRefs'");
  }
  if (def.allowedTerminalEvents !== undefined) {
    requireStringArray(def.allowedTerminalEvents, "definition field 'allowedTerminalEvents'");
  }

  if (def.entityType === "capability_acceptance") {
    checkCapabilityAcceptanceDefinition(def as StateMachineDefinition);
  }

  return true;
}
