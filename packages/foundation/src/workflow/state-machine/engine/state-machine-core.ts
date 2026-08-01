import { ERROR_CODES, StateMachineError } from './state-machine-errors.ts';
import { selectTransitionCell, evaluateTransitionGuardsForValidatedDefinition } from './transition-selector.ts';
import { guardExists, listAllGuardIds, isStaticOnlyGuard, isGuardRuntimeSafe } from '../guards/guard-registry.ts';
import { checkDefinitionSchema } from '../verification/state-machine-definition-schema.ts';
import { validateStateMachineTopology } from '../verification/state-machine-topology.ts';
import crypto from 'node:crypto';
import { canonicalJson } from '@meshrix/contracts/serialization/canonical-json';

export { ERROR_CODES, StateMachineError } from './state-machine-errors.ts';

/**
 * Validates the definition format. Returns structured result.
 */
export function validateStateMachineDefinition(definition?: any) : any {
  const errors: any[] = [];
  if (!definition) return { ok: false, errors: [{ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: 'Definition is null.' }] };
  if (!definition.machineId) errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: 'machineId is required' });
  if (!definition.initialState) errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: 'initialState is required' });
  if (!Array.isArray(definition.states)) errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: 'states array is required' });
  if (!Array.isArray(definition.events)) errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: 'events array is required' });
  if (!Array.isArray(definition.totalMatrix)) errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: 'totalMatrix array is required' });
  if (errors.length > 0) return { ok: false, errors };

  const stateIds: any = definition.states.map((s?: any) : any => s.id);
  const uniqueIds: any = new Set<any>(stateIds);
  if (uniqueIds.size !== stateIds.length) {
    errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: 'Duplicate state IDs found' });
  }
  if (!uniqueIds.has(definition.initialState)) {
    errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: `initialState '${definition.initialState}' is not in states list` });
  }
  for (const s of definition.states) {
    if (s.terminal && !uniqueIds.has(s.id)) {
      errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: `terminal state '${s.id}' is not in states list` });
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Runtime-grade executable validation. Ensures the definition is safe to
 * execute with transitionState(), covering schema, cross-references, and
 * guard registration. Stricter than validateStateMachineDefinition().
 */
export function validateExecutableStateMachineDefinition(definition?: any) : any {
  const errors: any[] = [];

  // Delegate to schema checker
  try {
    checkDefinitionSchema(definition);
  } catch (e: any) {
    errors.push({ errorCode: 'STATE_MACHINE_INVALID_DEFINITION', message: `Schema check failed: ${e.message}` });
  }

  // Run basic structural validation
  const basic: any = validateStateMachineDefinition(definition);
  if (!basic.ok) {
    errors.push(...basic.errors);
  }
  if (errors.length > 0) return { ok: false, errors };

  const eventIds: any = new Set<any>(definition.events.map((e?: any) : any => e.id));
  const registeredGuards: any = new Set<any>(listAllGuardIds());

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

  const topology: any = validateStateMachineTopology(definition);
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
export function assertStateMachineDefinition(definition?: any) : any {
  const result: any = validateExecutableStateMachineDefinition(definition);
  if (!result.ok) {
    throw new StateMachineError(
      ERROR_CODES.STATE_MACHINE_INVALID_DEFINITION,
      result.errors.map((e?: any) : any => e.message).join('; '),
      { errors: result.errors }
    );
  }
}

export function isTerminalStatus(definition?: any, statusId?: any) : any {
  const state: any = definition.states.find((s?: any) : any => s.id === statusId);
  return state ? !!state.terminal : false;
}

export function listAllowedEvents(definition?: any, currentStatus?: any) : any {
  return definition.totalMatrix
    .filter((cell?: any) : any => cell.from === currentStatus && cell.result !== 'illegal_transition')
    .map((cell?: any) : any => cell.event);
}

// ── Recursive metadata redaction ──────────────────────────────────────────

function normalizeKey(key?: any) : any {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

const SAFE_KEYS_NORMALIZED: any = new Set<any>([
  "reasoncode", "operationid", "traceid", "scopeid", "status",
  "machineid", "entityid", "eventtype", "fromstatus", "tostatus",
  "guardid", "ok", "reason", "branch", "commit", "runid",
  "verificationmode", "mode", "labels", "type", "id", "name",
  "count", "total", "version", "schemaversion"
]);

const REDACT_KEY_PATTERNS: any[] = [
  "token", "secret", "password", "cookie", "authorization",
  "apikey", "accesskey", "refreshtoken", "accesstoken",
  "privatepath", "absolutepath", "opaque", "capability",
  "keyhash", "lookupkey", "credential", "signature", "signingkey",
  "clientsecret", "credentialbundle"
];

const REDACT_VALUE_KEY: Record<string, any> = { redacted: true, reason: "sensitive_key" };
const REDACT_VALUE_PATH: Record<string, any> = { redacted: true, reason: "absolute_path" };

function isSensitiveKeyNormalized(key?: any) : any {
  if (SAFE_KEYS_NORMALIZED.has(key)) return false;
  for (const pattern of REDACT_KEY_PATTERNS) {
    if (key.includes(pattern)) return true;
  }
  return false;
}

function isAbsPath(value?: any) : any {
  if (typeof value !== "string") return false;
  const separator: any = String.fromCharCode(47);
  const posixRoots: any[] = ["Users", "home", "root", "tmp", "var", "etc", "opt", "usr"];
  const windowsRoot: any = /^[a-zA-Z]:$/u.test(value.slice(0, 2)) &&
    (value[2] === "\\" || value[2] === separator);
  return windowsRoot || posixRoots.some(
    (root?: any) : any => value.startsWith(`${separator}${root}${separator}`)
  );
}

function containsToken(value?: any) : any {
  if (typeof value !== 'string') return false;
  const lower: any = value.toLowerCase();
  return lower.startsWith('bearer ') || lower.startsWith('basic ') ||
    lower.includes('?token=') || lower.includes('&token=') ||
    lower.includes('&access_token=') || lower.includes('?access_token=') ||
    lower.includes('&refresh_token=') || lower.includes('?refresh_token=') ||
    lower.includes('?api_key=') || lower.includes('&api_key=') ||
    lower.includes('authorization:') || lower.includes('x-api-key:') ||
    lower.includes('client_secret=') || lower.includes('&client_secret=') ||
    lower.includes('authorization = bearer') || lower.includes('authorization=bearer');
}

function isSensitiveStringValue(value?: any) : any {
  if (typeof value !== 'string') return false;
  const lower: any = value.toLowerCase().trim();
  if (lower.startsWith('bearer ') || lower.startsWith('basic ')) return true;
  if (lower.startsWith('sk-') || lower.startsWith('ock_')) return true;
  return false;
}

function redactMetadata(metadata?: any, depth: any = 0) : any {
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
    return metadata.map((item?: any) : any => {
      const redacted: any = redactMetadata(item, depth + 1);
      return redacted !== item ? redacted : item;
    });
  }

  const result: Record<string, any> = {};
  for (const key of Object.keys(metadata)) {
    const normalized: any = normalizeKey(key);
    const value: any = metadata[key];

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
function guardSummary(guardResults?: any) : any {
  if (!guardResults || guardResults.length === 0) return undefined;
  return guardResults.map((r?: any) : any => ({
    guardId: r.guardId,
    ok: r.ok,
    reason: r.reason
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
export function transitionState(definition?: any, input?: any, options: Record<string, any> = {}) : any {
  const skipValidation: any = options.skipExecutableValidation ||
    (options.validatedDefinitionHash && options.validatedDefinitionHash === computeStateMachineDefinitionHash(definition));

  if (!skipValidation) {
    const execResult: any = validateExecutableStateMachineDefinition(definition);
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

  const stateExists: any = definition.states.some((s?: any) : any => s.id === currentStatus);
  if (!stateExists) {
    return {
      ok: false,
      errorCode: ERROR_CODES.STATE_MACHINE_UNKNOWN_STATUS,
      message: `Unknown status: ${currentStatus}`
    };
  }

  const eventExists: any = definition.events.some((e?: any) : any => e.id === eventType);
  if (!eventExists) {
    return {
      ok: false,
      errorCode: ERROR_CODES.STATE_MACHINE_UNKNOWN_EVENT,
      message: `Unknown event: ${eventType}`
    };
  }

  // Use the shared cell selection helper (no definition mutation)
  const selection: any = selectTransitionCell(definition, input, { guardEvaluator: options.guardEvaluator });
  if (!selection.ok) {
    return selection;
  }

  const cell: any = selection.cell;
  const selectedGuardResults: any = selection.guardResults || [];

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

  const requiresPolicy: any = cell.result === 'requires_policy';
  const requiresApproval: any = cell.result === 'requires_approval';
  const requiresExternalReceipt: any = cell.result === 'requires_external_receipt';
  const deferredAsync: any = cell.result === 'deferred_async_transition';

  const toStatus: any = cell.to || currentStatus;

  const guardContext: any = input.guardContext || {};

  // requires_policy: verify allow evidence
  if (requiresPolicy) {
    const pd: any = guardContext.policyDecision;
    const decision: any = pd?.decision || pd?.status;
    if (!(pd?.allowed === true || decision === 'allow')) {
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
    const ar: any = guardContext.approvalRecord;
    if (!ar || ar.status !== 'approved') {
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
    const er: any = guardContext.externalReceipt;
    if (!er || er.status !== 'recorded') {
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
    const hasResumePointer: any = input.resumePointer || input.operationId;
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

  const transitionRecord: Record<string, any> = {
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

export function assertTransitionAllowed(definition?: any, input?: any) : any {
  const result: any = transitionState(definition, input);
  if (!result.ok) {
    throw new StateMachineError(result.errorCode, result.message, {
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
export function compileStateMachineDefinition(definition?: any) : any {
  const validationResult: any = validateExecutableStateMachineDefinition(definition);
  const definitionHash: any = computeStateMachineDefinitionHash(definition);
  return { definition, definitionHash, validationResult, compiled: validationResult.ok };
}

/**
 * Evaluate transition guards with executable validation.
 * Mirrors transitionState() behavior for guard-only evaluation.
 * Import from transition-selector.ts for the raw (unvalidated) version.
 */
export function evaluateTransitionGuards(definition?: any, fromStatus?: any, eventType?: any, context: Record<string, any> = {}, options: Record<string, any> = {}) : any {
  const skipValidation: any = options.skipExecutableValidation ||
    (options.validatedDefinitionHash && options.validatedDefinitionHash === computeStateMachineDefinitionHash(definition));

  if (!skipValidation) {
    const execResult: any = validateExecutableStateMachineDefinition(definition);
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

export function computeStateMachineDefinitionHash(definition?: any) : any {
  const stable: any = canonicalJson(definition);
  return `sha256:${crypto.createHash("sha256").update(stable).digest("hex")}`;
}
