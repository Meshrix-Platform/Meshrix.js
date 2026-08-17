import { ERROR_CODES, StateMachineError } from './state-machine-errors.ts';
import { selectTransitionCell, evaluateTransitionGuardsForValidatedDefinition } from './transition-selector.ts';
import { guardExists, listAllGuardIds, isStaticOnlyGuard, isGuardRuntimeSafe } from '../guards/guard-registry.ts';
import { checkDefinitionSchema } from '../verification/state-machine-definition-schema.ts';
import { validateStateMachineTopology } from '../verification/state-machine-topology.ts';
import crypto from 'node:crypto';
import { canonicalJson } from '@meshrix/contracts/serialization/canonical-json';
import type {
  GuardEvaluator, GuardResult, JsonRecord, StateMachineDefinition, TransitionInput, ValidationIssue, ValidationResult
} from './state-machine-result-types.ts';

export { ERROR_CODES, StateMachineError } from './state-machine-errors.ts';

/**
 * Validates the definition format. Returns structured result.
 */
function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function executableDefinition(value: unknown): StateMachineDefinition | null {
  const definition = record(value);
  if (!definition || typeof definition.machineId !== 'string' || typeof definition.initialState !== 'string' ||
      !Array.isArray(definition.states) || !Array.isArray(definition.events) || !Array.isArray(definition.totalMatrix)) return null;
  return definition as unknown as StateMachineDefinition;
}

function transitionInput(value: unknown): TransitionInput | null {
  const input = record(value);
  if (!input || typeof input.currentStatus !== 'string' || typeof input.eventType !== 'string') return null;
  return input as unknown as TransitionInput;
}

export function validateStateMachineDefinition(definitionValue?: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const definition = record(definitionValue);
  if (!definition) return { ok: false, errors: [{ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: 'Definition is null.' }] };
  if (!definition.machineId) errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: 'machineId is required' });
  if (!definition.initialState) errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: 'initialState is required' });
  if (!Array.isArray(definition.states)) errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: 'states array is required' });
  if (!Array.isArray(definition.events)) errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: 'events array is required' });
  if (!Array.isArray(definition.totalMatrix)) errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: 'totalMatrix array is required' });
  if (errors.length > 0) return { ok: false, errors };

  const states = definition.states as unknown[];
  const stateIds = states.map((state) => String(record(state)?.id || ''));
  const uniqueIds = new Set(stateIds);
  if (uniqueIds.size !== stateIds.length) {
    errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: 'Duplicate state IDs found' });
  }
  if (!uniqueIds.has(String(definition.initialState || ''))) {
    errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: `initialState '${definition.initialState}' is not in states list` });
  }
  for (const value of states) {
    const state = record(value) || {};
    if (state.terminal && !uniqueIds.has(String(state.id || ''))) {
      errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: `terminal state '${state.id}' is not in states list` });
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Runtime-grade executable validation. Ensures the definition is safe to
 * execute with transitionState(), covering schema, cross-references, and
 * guard registration. Stricter than validateStateMachineDefinition().
 */
export function validateExecutableStateMachineDefinition(definitionValue?: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];

  // Delegate to schema checker
  try {
    checkDefinitionSchema(definitionValue);
  } catch (error: unknown) {
    errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: `Schema check failed: ${error instanceof Error ? error.message : String(error)}` });
  }

  // Run basic structural validation
  const basic = validateStateMachineDefinition(definitionValue);
  if (!basic.ok) {
    errors.push(...basic.errors);
  }
  if (errors.length > 0) return { ok: false, errors };
  const definition = executableDefinition(definitionValue);
  if (!definition) return { ok: false, errors: [{ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: 'Definition structure is invalid.' }] };

  const eventIds = new Set(definition.events.map((event) => event.id));
  const registeredGuards = new Set(listAllGuardIds());

  // Check event ID uniqueness
  if (definition.events.length !== eventIds.size) {
    errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: 'Duplicate event IDs found' });
  }

  for (const cell of definition.totalMatrix) {
    // guards must be non-empty strings
    for (const g of (cell.guards || [])) {
      if (typeof g !== 'string' || !g.trim()) {
        errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: `Matrix cell guards contain empty or non-string item` });
      } else if (!registeredGuards.has(g)) {
        errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: `Guard '${g}' is not registered in guard registry` });
      }
    }
    // requiredGuards must be non-empty strings
    for (const g of (cell.requiredGuards || [])) {
      if (typeof g !== 'string' || !g.trim()) {
        errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: `Matrix cell requiredGuards contain empty or non-string item` });
      } else if (!registeredGuards.has(g)) {
        errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: `requiredGuard '${g}' is not registered in guard registry` });
      }
    }
  }

  const topology = validateStateMachineTopology(definition);
  for (const message of topology.errors) {
    errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message });
  }

  // staticOnly and non-runtime-safe guards must not appear in runtime guard fields
  // This rule applies to ALL risk levels, not just high-risk.
  for (const cell of definition.totalMatrix) {
    for (const guardId of (cell.guards || [])) {
      if (isStaticOnlyGuard(guardId)) {
        errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: `staticOnly guard '${guardId}' in cell.guards for ${cell.from}->${cell.event} is not allowed. staticOnly guards cannot gate runtime transitions.` });
      } else if (!isGuardRuntimeSafe(guardId) && guardExists(guardId)) {
        errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: `Guard '${guardId}' in cell.guards for ${cell.from}->${cell.event} is not runtime-safe and cannot gate runtime transitions.` });
      }
    }
    for (const guardId of (cell.requiredGuards || [])) {
      if (isStaticOnlyGuard(guardId)) {
        errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: `staticOnly guard '${guardId}' in cell.requiredGuards for ${cell.from}->${cell.event} is not allowed. staticOnly guards cannot gate runtime transitions.` });
      } else if (!isGuardRuntimeSafe(guardId) && guardExists(guardId)) {
        errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: `Guard '${guardId}' in cell.requiredGuards for ${cell.from}->${cell.event} is not runtime-safe and cannot gate runtime transitions.` });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Assert-style wrapper that throws on invalid definition.
 */
export function assertStateMachineDefinition(definition?: unknown): asserts definition is StateMachineDefinition {
  const result = validateExecutableStateMachineDefinition(definition);
  if (!result.ok) {
    throw new StateMachineError(
      ERROR_CODES.STATE_MACHINE_INVALID_DEFINITION,
      result.errors.map((error) => error.message).join('; '),
      { errors: result.errors }
    );
  }
}

export function isTerminalStatus(definitionValue?: unknown, statusId?: unknown): boolean {
  const definition = executableDefinition(definitionValue);
  if (!definition) return false;
  const state = definition.states.find((state) => state.id === statusId);
  return state ? !!state.terminal : false;
}

export function listAllowedEvents(definitionValue?: unknown, currentStatus?: unknown): string[] {
  const definition = executableDefinition(definitionValue);
  if (!definition) return [];
  return definition.totalMatrix
    .filter((cell) => cell.from === currentStatus && cell.result !== 'illegal_transition')
    .map((cell) => cell.event);
}

// ── Recursive metadata redaction ──────────────────────────────────────────

function normalizeKey(key?: unknown): string {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

const SAFE_KEYS_NORMALIZED = new Set<string>([
  "reasoncode", "operationid", "traceid", "scopeid", "status",
  "machineid", "entityid", "eventtype", "fromstatus", "tostatus",
  "guardid", "ok", "reason", "branch", "commit", "runid",
  "verificationmode", "mode", "labels", "type", "id", "name",
  "count", "total", "version", "schemaversion"
]);

const REDACT_KEY_PATTERNS: string[] = [
  "token", "secret", "password", "cookie", "authorization",
  "apikey", "accesskey", "refreshtoken", "accesstoken",
  "privatepath", "absolutepath", "opaque", "capability",
  "keyhash", "lookupkey", "credential", "signature", "signingkey",
  "clientsecret", "credentialbundle"
];

const REDACT_VALUE_KEY: JsonRecord = { redacted: true, reason: "sensitive_key" };
const REDACT_VALUE_PATH: JsonRecord = { redacted: true, reason: "absolute_path" };

function isSensitiveKeyNormalized(key: string): boolean {
  if (SAFE_KEYS_NORMALIZED.has(key)) return false;
  for (const pattern of REDACT_KEY_PATTERNS) {
    if (key.includes(pattern)) return true;
  }
  return false;
}

function isAbsPath(value?: unknown): boolean {
  if (typeof value !== "string") return false;
  const separator = String.fromCharCode(47);
  const posixRoots = ["Users", "home", "root", "tmp", "var", "etc", "opt", "usr"];
  const windowsRoot = /^[a-zA-Z]:$/u.test(value.slice(0, 2)) &&
    (value[2] === "\\" || value[2] === separator);
  return windowsRoot || posixRoots.some(
    (root) => value.startsWith(`${separator}${root}${separator}`)
  );
}

function containsToken(value?: unknown): boolean {
  if (typeof value !== 'string') return false;
  const lower = value.toLowerCase();
  return lower.startsWith('bearer ') || lower.startsWith('basic ') ||
    lower.includes('?token=') || lower.includes('&token=') ||
    lower.includes('&access_token=') || lower.includes('?access_token=') ||
    lower.includes('&refresh_token=') || lower.includes('?refresh_token=') ||
    lower.includes('?api_key=') || lower.includes('&api_key=') ||
    lower.includes('authorization:') || lower.includes('x-api-key:') ||
    lower.includes('client_secret=') || lower.includes('&client_secret=') ||
    lower.includes('authorization = bearer') || lower.includes('authorization=bearer');
}

function isSensitiveStringValue(value?: unknown): boolean {
  if (typeof value !== 'string') return false;
  const lower = value.toLowerCase().trim();
  if (lower.startsWith('bearer ') || lower.startsWith('basic ')) return true;
  if (lower.startsWith('sk-') || lower.startsWith('ock_')) return true;
  return false;
}

function redactMetadata(metadata?: unknown, depth = 0): unknown {
  if (depth > 10) return { redacted: true, reason: "max_depth_exceeded" };
  if (metadata === null || metadata === undefined) return metadata;
  if (typeof metadata !== 'object') {
    if (typeof metadata === 'string') {
      if (isAbsPath(metadata)) return REDACT_VALUE_PATH;
      if (containsToken(metadata)) return REDACT_VALUE_KEY;
      if (isSensitiveStringValue(metadata)) return REDACT_VALUE_KEY;
    }
    return metadata;
  }

  if (Array.isArray(metadata)) {
    return metadata.map((item) => {
      const redacted = redactMetadata(item, depth + 1);
      return redacted !== item ? redacted : item;
    });
  }

  const source = record(metadata) || {};
  const result: JsonRecord = {};
  for (const key of Object.keys(source)) {
    const normalized = normalizeKey(key);
    const value = source[key];

    if (isSensitiveKeyNormalized(normalized)) {
      // Only blanket-redact if the value is a primitive; recurse into objects
      if (typeof value === 'object' && value !== null) {
        result[key] = redactMetadata(value, depth + 1);
      } else {
        result[key] = REDACT_VALUE_KEY;
      }
      continue;
    }

    if (typeof value === 'string') {
      if (isAbsPath(value)) {
        result[key] = REDACT_VALUE_PATH;
      } else if (containsToken(value)) {
        result[key] = REDACT_VALUE_KEY;
      } else if (isSensitiveStringValue(value)) {
        result[key] = REDACT_VALUE_KEY;
      } else if (isSensitiveKeyNormalized(normalizeKey(value))) {
        // Detect sensitive-key-like string values (e.g., "Authorization", "api_key")
        result[key] = REDACT_VALUE_KEY;
      } else {
        result[key] = value;
      }
    } else if (typeof value === 'object') {
      result[key] = redactMetadata(value, depth + 1);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Map guard results to a safe guard summary for transition records.
 */
function guardSummary(guardResults: GuardResult[] = []): Array<{ guardId: string; ok: boolean; reason?: string }> | undefined {
  if (!guardResults || guardResults.length === 0) return undefined;
  return guardResults.map((result) => ({
    guardId: result.guardId,
    ok: result.ok,
    reason: result.reason
  }));
}

// ── Main transition function ──────────────────────────────────────────────

/**
 * Execute a state transition on the definition.
 *
 * @param {object} definition - state machine definition
 * @param {object} input - transition input
 * @param {object} [options] - { skipExecutableValidation?: boolean, guardEvaluator?: function, validatedDefinitionHash?: string }
 * @returns {object} transition result
 */
interface TransitionOptions { skipExecutableValidation?: boolean; guardEvaluator?: GuardEvaluator; validatedDefinitionHash?: string }

export function transitionState(definitionValue?: unknown, inputValue?: unknown, options: TransitionOptions = {}) {
  const definition = executableDefinition(definitionValue);
  const input = transitionInput(inputValue);
  if (!definition || !input) {
    return { ok: false, errorCode: ERROR_CODES.STATE_MACHINE_INVALID_INPUT, message: 'Definition or transition input is invalid.' };
  }
  const skipValidation = options.skipExecutableValidation ||
    (options.validatedDefinitionHash && options.validatedDefinitionHash === computeStateMachineDefinitionHash(definition));

  if (!skipValidation) {
    const execResult = validateExecutableStateMachineDefinition(definition);
    if (!execResult.ok) {
      return {
        ok: false,
        errorCode: ERROR_CODES.STATE_MACHINE_INVALID_DEFINITION,
        message: 'Definition is not executable.',
        details: execResult.errors
      };
    }
  }

  const { entityId, currentStatus, eventType, actor, reason, metadata, operationId, traceId, auditId, checkpointNodeId, policyDecisionId, approvalId, now } = input;

  // Reject external guard evaluator injection via input envelope
  if (input.guardEvaluator !== undefined) {
    return {
      ok: false,
      errorCode: ERROR_CODES.STATE_MACHINE_GUARD_INJECTION_REJECTED,
      message: 'Guard evaluator injection via input is not allowed. Use internal options path only.'
    };
  }

  const stateExists = definition.states.some((state) => state.id === currentStatus);
  if (!stateExists) {
    return {
      ok: false,
      errorCode: ERROR_CODES.STATE_MACHINE_UNKNOWN_STATUS,
      message: `Unknown status: ${currentStatus}`
    };
  }

  const eventExists = definition.events.some((event) => event.id === eventType);
  if (!eventExists) {
    return {
      ok: false,
      errorCode: ERROR_CODES.STATE_MACHINE_UNKNOWN_EVENT,
      message: `Unknown event: ${eventType}`
    };
  }

  // Use the shared cell selection helper (no definition mutation)
  const selection = selectTransitionCell(definition, input, { guardEvaluator: options.guardEvaluator });
  if (!selection.ok) {
    return selection;
  }

  const cell = selection.cell;
  if (!cell) return { ok: false, errorCode: ERROR_CODES.STATE_MACHINE_TRANSITION_NOT_ALLOWED, message: 'Transition selection returned no cell.' };
  const selectedGuardResults = selection.guardResults || [];

  if (cell.result === 'illegal_transition') {
    return {
      ok: false,
      errorCode: cell.errorCode || ERROR_CODES.STATE_MACHINE_TRANSITION_NOT_ALLOWED,
      message: `Transition illegal: ${currentStatus} -> ${eventType}`,
      allowedEvents: listAllowedEvents(definition, currentStatus)
    };
  }

  if (cell.result === 'ignored_idempotent_event') {
    return {
      ok: true,
      machineId: definition.machineId,
      entityId,
      entityType: definition.entityType,
      fromStatus: currentStatus,
      toStatus: currentStatus,
      eventType,
      idempotent: true,
      transitionRecord: {
        entityId, entityType: definition.entityType, fromStatus: currentStatus, toStatus: currentStatus, eventType, operationId, timestamp: now, actor, reason, metadata: redactMetadata(metadata),
        guardResults: guardSummary(selectedGuardResults)
      },
      requiredEffects: { policy: false, approval: false, externalReceipt: false, async: false, ledger: false, checkpoint: false, audit: false }
    };
  }

  const requiresPolicy = cell.result === 'requires_policy';
  const requiresApproval = cell.result === 'requires_approval';
  const requiresExternalReceipt = cell.result === 'requires_external_receipt';
  const deferredAsync = cell.result === 'deferred_async_transition';

  const toStatus = cell.to || currentStatus;

  const guardContext = input.guardContext || {};

  // requires_policy: verify allow evidence
  if (requiresPolicy) {
    const policyDecision = record(guardContext.policyDecision);
    const decision = policyDecision?.decision || policyDecision?.status;
    if (!(policyDecision?.allowed === true || decision === 'allow')) {
      return {
        ok: false,
        errorCode: ERROR_CODES.STATE_MACHINE_GUARD_BLOCKED,
        message: 'Transition requires policy approval but no allow evidence found.',
        blockedBy: "policy",
        allowedEvents: listAllowedEvents(definition, currentStatus)
      };
    }
  }

  // requires_approval: verify approved evidence
  if (requiresApproval) {
    const approvalRecord = record(guardContext.approvalRecord);
    if (!approvalRecord || approvalRecord.status !== 'approved') {
      return {
        ok: false,
        errorCode: ERROR_CODES.STATE_MACHINE_GUARD_BLOCKED,
        message: 'Transition requires approval but no approved evidence found.',
        blockedBy: "approval",
        allowedEvents: listAllowedEvents(definition, currentStatus)
      };
    }
  }

  // requires_external_receipt: verify receipt evidence at runtime
  if (requiresExternalReceipt) {
    const externalReceipt = record(guardContext.externalReceipt);
    if (!externalReceipt || externalReceipt.status !== 'recorded') {
      return {
        ok: false,
        errorCode: ERROR_CODES.STATE_MACHINE_GUARD_BLOCKED,
        message: 'Transition requires external receipt but no recorded evidence found.',
        blockedBy: "externalReceipt",
        allowedEvents: listAllowedEvents(definition, currentStatus)
      };
    }
  }

  // deferred_async_transition: verify async infrastructure exists
  if (deferredAsync) {
    const hasResumePointer = input.resumePointer || input.operationId;
    if (!hasResumePointer) {
      return {
        ok: false,
        errorCode: ERROR_CODES.STATE_MACHINE_GUARD_BLOCKED,
        message: 'Deferred async transition requires resumePointer or operationId.',
        blockedBy: "async",
        allowedEvents: listAllowedEvents(definition, currentStatus)
      };
    }
  }

  const transitionRecord: JsonRecord = {
    entityId,
    entityType: definition.entityType,
    fromStatus: currentStatus,
    toStatus,
    eventType,
    operationId,
    timestamp: now,
    actor,
    reason,
    metadata: redactMetadata(metadata),
    traceId,
    auditId,
    checkpointNodeId,
    policyDecisionId,
    approvalId,
    guardResults: guardSummary(selectedGuardResults)
  };

  return {
    ok: true,
    machineId: definition.machineId,
    entityId,
    entityType: definition.entityType,
    fromStatus: currentStatus,
    toStatus,
    eventType,
    transitionRecord,
    requiredEffects: {
      policy: requiresPolicy,
      approval: requiresApproval,
      externalReceipt: requiresExternalReceipt,
      async: deferredAsync,
      ledger: true,
      checkpoint: !!cell.sideEffects?.includes('checkpoint'),
      audit: !!cell.sideEffects?.includes('audit')
    },
    ...(deferredAsync ? {
      asyncTransition: {
        required: true,
        resumePointer: input.resumePointer || null,
        operationId: input.operationId || null,
        traceId: input.traceId || null
      }
    } : {})
  };
}

export function assertTransitionAllowed(definitionValue?: unknown, inputValue?: unknown) {
  const result = transitionState(definitionValue, inputValue);
  if (!result.ok) {
    const definition = record(definitionValue) || {};
    const input = record(inputValue) || {};
    throw new StateMachineError(String(result.errorCode || ERROR_CODES.STATE_MACHINE_TRANSITION_NOT_ALLOWED), String(result.message || 'Transition not allowed.'), {
      machineId: definition.machineId,
      entityId: input.entityId,
      currentStatus: input.currentStatus,
      eventType: input.eventType,
      allowedEvents: result.allowedEvents,
      guardResults: result.guardResults,
      blockedBy: result.blockedBy,
      failedGuards: result.failedGuards
    });
  }
  return result;
}

/**
 * Pre-validate and cache a state machine definition for repeated use.
 * Validation is performed once; subsequent transitionState() calls can use
 * the returned definitionHash to skip re-validation.
 *
 * @param {object} definition - state machine definition
 * @returns {{ definition, definitionHash, validationResult }}
 */
export function compileStateMachineDefinition(definition: unknown) {
  const validationResult = validateExecutableStateMachineDefinition(definition);
  const definitionHash = computeStateMachineDefinitionHash(definition);
  return { definition, definitionHash, validationResult, compiled: validationResult.ok };
}

/**
 * Evaluate transition guards with executable validation.
 * Mirrors transitionState() behavior for guard-only evaluation.
 * Import from transition-selector.ts for the raw (unvalidated) version.
 */
export function evaluateTransitionGuards(definition: unknown, fromStatus: unknown, eventType: unknown, context: JsonRecord = {}, options: TransitionOptions = {}) {
  const skipValidation = options.skipExecutableValidation ||
    (options.validatedDefinitionHash && options.validatedDefinitionHash === computeStateMachineDefinitionHash(definition));

  if (!skipValidation) {
    const execResult = validateExecutableStateMachineDefinition(definition);
    if (!execResult.ok) {
      return {
        ok: false,
        reason: "invalid_definition",
        errorCode: ERROR_CODES.STATE_MACHINE_INVALID_DEFINITION,
        message: "Definition is not executable.",
        details: execResult.errors
      };
    }
  }
  return evaluateTransitionGuardsForValidatedDefinition(definition, fromStatus, eventType, context);
}

export function computeStateMachineDefinitionHash(definition?: unknown): string {
  const stable = canonicalJson(definition);
  return `sha256:${crypto.createHash("sha256").update(stable).digest("hex")}`;
}
