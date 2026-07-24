import { describe, it, expect } from 'vitest';
import { transitionState, validateStateMachineDefinition, isTerminalStatus, listAllowedEvents } from '../../../packages/foundation/src/workflow/state-machine/engine/state-machine-core.mjs';
import { ERROR_CODES } from '../../../packages/foundation/src/workflow/state-machine/engine/state-machine-errors.mjs';

const mockDefinition = {
  machineId: 'test.machine',
  entityType: 'test_entity',
  version: '1.0.0',
  description: 'Unit test state machine fixture.',
  initialState: 'start',
  states: [
    { id: 'start' },
    { id: 'processing' },
    { id: 'done', terminal: true },
    { id: 'failed', terminal: true }
  ],
  events: [
    { id: 'begin' },
    { id: 'finish' },
    { id: 'error' },
    { id: 'retry' }
  ],
  totalMatrix: [
    { from: 'start', event: 'begin', result: 'legal_transition', to: 'processing' },
    { from: 'start', event: 'error', result: 'legal_transition', to: 'failed' },
    { from: 'start', event: 'finish', result: 'illegal_transition', errorCode: 'CANT_FINISH_START' },
    { from: 'start', event: 'retry', result: 'illegal_transition', errorCode: 'CANT_RETRY_START' },

    { from: 'processing', event: 'begin', result: 'ignored_idempotent_event' },
    { from: 'processing', event: 'finish', result: 'legal_transition', to: 'done' },
    { from: 'processing', event: 'error', result: 'legal_transition', to: 'failed' },
    { from: 'processing', event: 'retry', result: 'illegal_transition', errorCode: 'CANT_RETRY_PROC' },

    { from: 'done', event: 'begin', result: 'illegal_transition', errorCode: 'TERMINAL' },
    { from: 'done', event: 'finish', result: 'ignored_idempotent_event' },
    { from: 'done', event: 'error', result: 'illegal_transition', errorCode: 'TERMINAL' },
    { from: 'done', event: 'retry', result: 'illegal_transition', errorCode: 'TERMINAL' },

    { from: 'failed', event: 'begin', result: 'illegal_transition', errorCode: 'TERMINAL' },
    { from: 'failed', event: 'finish', result: 'illegal_transition', errorCode: 'TERMINAL' },
    { from: 'failed', event: 'error', result: 'ignored_idempotent_event' },
    { from: 'failed', event: 'retry', result: 'legal_transition', to: 'processing', allowedReopenTransition: true }
  ],
  invariants: [],
  proofObligations: []
};

describe('State Machine Core', () => {
  it('should validate definition successfully', () => {
    const result = validateStateMachineDefinition(mockDefinition);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('should identify terminal status', () => {
    expect(isTerminalStatus(mockDefinition, 'start')).toBe(false);
    expect(isTerminalStatus(mockDefinition, 'done')).toBe(true);
    expect(isTerminalStatus(mockDefinition, 'failed')).toBe(true);
  });

  it('should transition legally', () => {
    const result = transitionState(mockDefinition, {
      entityId: '123',
      currentStatus: 'start',
      eventType: 'begin',
      now: '2023-01-01'
    });
    expect(result.ok).toBe(true);
    expect(result.toStatus).toBe('processing');
    expect(result.transitionRecord.fromStatus).toBe('start');
  });

  it('should block illegal transition', () => {
    const result = transitionState(mockDefinition, {
      entityId: '123',
      currentStatus: 'start',
      eventType: 'finish',
      now: '2023-01-01'
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('CANT_FINISH_START');
  });

  it('should handle idempotent event', () => {
     const result = transitionState(mockDefinition, {
      entityId: '123',
      currentStatus: 'processing',
      eventType: 'begin',
      now: '2023-01-01'
    });
    expect(result.ok).toBe(true);
    expect(result.toStatus).toBe('processing');
    expect(result.idempotent).toBe(true);
  });

  it('should redact sensitive metadata', () => {
     const result = transitionState(mockDefinition, {
      entityId: '123',
      currentStatus: 'start',
      eventType: 'begin',
      metadata: {
        normalField: 'hello',
        token: 'secret123',
        path: '/tmp/meshrix-redaction-fixture'
      },
      now: '2023-01-01'
    });
    expect(result.ok).toBe(true);
    expect(result.transitionRecord.metadata.normalField).toBe('hello');
    expect(result.transitionRecord.metadata.token.redacted).toBe(true);
    expect(result.transitionRecord.metadata.path.redacted).toBe(true);
  });

  it('should list allowed events', () => {
    const allowed = listAllowedEvents(mockDefinition, 'start');
    expect(allowed).toContain('begin');
    expect(allowed).toContain('error');
    expect(allowed).not.toContain('finish');
  });
});
