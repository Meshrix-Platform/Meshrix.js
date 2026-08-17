import type { JsonRecord } from "./state-machine-result-types.ts";

export const ERROR_CODES = {
  STATE_MACHINE_INVALID_DEFINITION: 'STATE_MACHINE_INVALID_DEFINITION',
  STATE_MACHINE_UNKNOWN_STATUS: 'STATE_MACHINE_UNKNOWN_STATUS',
  STATE_MACHINE_UNKNOWN_EVENT: 'STATE_MACHINE_UNKNOWN_EVENT',
  STATE_MACHINE_TERMINAL_STATUS: 'STATE_MACHINE_TERMINAL_STATUS',
  STATE_MACHINE_TRANSITION_NOT_ALLOWED: 'STATE_MACHINE_TRANSITION_NOT_ALLOWED',
  STATE_MACHINE_GUARD_NOT_SATISFIED: 'STATE_MACHINE_GUARD_NOT_SATISFIED',
  STATE_MACHINE_GUARD_BLOCKED: 'STATE_MACHINE_GUARD_BLOCKED',
  STATE_MACHINE_GUARD_UNKNOWN: 'STATE_MACHINE_GUARD_UNKNOWN',
  STATE_MACHINE_GUARD_CONTEXT_MISSING: 'STATE_MACHINE_GUARD_CONTEXT_MISSING',
  STATE_MACHINE_AMBIGUOUS_TRANSITION: 'STATE_MACHINE_AMBIGUOUS_TRANSITION',
  STATE_MACHINE_INVALID_INPUT: 'STATE_MACHINE_INVALID_INPUT',
  STATE_MACHINE_GUARD_INJECTION_REJECTED: 'STATE_MACHINE_GUARD_INJECTION_REJECTED'
} as const;

export type StateMachineErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

export class StateMachineError extends Error {
  code: StateMachineErrorCode | string;
  details: JsonRecord & { ok: false };
  errorCode: StateMachineErrorCode | string;
  override name = "StateMachineError";
  constructor(errorCode: StateMachineErrorCode | string, message: string, details: JsonRecord = {}) {
    super(message);
    this.code = errorCode;
    this.errorCode = errorCode;
    this.details = { ok: false, ...details };
  }
}
