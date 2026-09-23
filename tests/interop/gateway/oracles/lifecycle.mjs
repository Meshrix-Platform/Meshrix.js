import { deepEqual } from './payload.mjs';

export const EXPECTED_TOOL_STATE = 'b3BhcXVlLWZpeHR1cmUtc3RhdGUtMQ';
export const EXPECTED_RESOURCE_STATE = 'opaque-resource-state-1';
export const EXPECTED_PROMPT_STATE = 'opaque-prompt-state-1';

export function checkToolLifecycle(observation) {
  const initial = observation?.tool?.initial;
  const continued = observation?.tool?.continued;
  const upstream = observation?.tool?.upstreamRequests ?? [];
  const effects = observation?.tool?.effects ?? [];
  if (initial?.resultType !== 'input_required' || initial.requestState !== EXPECTED_TOOL_STATE) {
    return reject('result_type_coerced_to_complete');
  }
  if (continued?.resultType !== 'complete') return reject('continuation_not_completed');
  const continuationRequest = upstream.find(request => request.method === 'tools/call' && request.operationKey === 'effect-key-1' && request.inputResponses?.['confirm-name']);
  if (!continuationRequest && upstream.some(request => request.method === 'tools/call' && request.operationKey === 'effect-key-1' && request.requestState === EXPECTED_TOOL_STATE)) {
    return reject('input_responses_changed');
  }
  if (!continuationRequest || continuationRequest.requestState !== EXPECTED_TOOL_STATE) {
    return reject('upstream_state_not_restored');
  }
  const expectedNonce = initial.inputRequests?.['confirm-name']?.params?.message?.split(': ').at(-1);
  if (!/^[0-9a-f]{32}$/.test(expectedNonce ?? '') || !deepEqual(continuationRequest.inputResponses, {
    'confirm-name': { action: 'accept', content: { label: 'demo', nonce: expectedNonce } }
  })) {
    return reject('input_responses_changed');
  }
  if (effects.length !== 1) return reject('effect_replayed');
  if (effects[0]?.operationKey !== 'effect-key-1') return reject('effect_key_changed');
  return accept();
}

export function checkResourceLifecycle(observation) {
  const initial = observation?.initial;
  const continued = observation?.continued;
  const request = observation?.upstreamRequests?.find(item => item.method === 'resources/read');
  if (initial?.resultType !== 'input_required' || initial.requestState !== EXPECTED_RESOURCE_STATE) return reject('resource_state_not_requested');
  if (continued?.resultType !== 'complete') return reject('resource_continuation_not_completed');
  if (request?.requestState !== EXPECTED_RESOURCE_STATE) return reject('upstream_state_not_restored');
  return accept();
}

export function checkPromptLifecycle(observation) {
  const initial = observation?.initial;
  const continued = observation?.continued;
  const request = observation?.upstreamRequests?.find(item => item.method === 'prompts/get');
  if (initial?.resultType !== 'input_required' || initial.requestState !== EXPECTED_PROMPT_STATE) return reject('prompt_state_not_requested');
  if (continued?.resultType !== 'complete') return reject('prompt_continuation_not_completed');
  if (request?.requestState !== EXPECTED_PROMPT_STATE) return reject('upstream_state_not_restored');
  return accept();
}

/**
 * A slow-but-benign round trip must be accepted as a benign observation, and a timeout,
 * a startup failure or a synthetic conclusion must not be counted as one.
 *
 * `observed` is required so that a caller cannot satisfy this oracle by handing it a
 * hand-written status: it must carry the timing of a round trip that really happened.
 */
export function checkNoFalseMutationTimeout(observation = {}) {
  if (observation.status === 'not_run' || observation.status === 'timeout') {
    return reject(observation.reason ?? 'mutation_not_observed');
  }
  if (observation.observed !== true) return reject('slow_path_not_observed');
  if (observation.status !== 'pass') return reject(observation.reason ?? 'slow_path_observation_invalid');
  if (!Number.isFinite(observation.elapsedMs)) return reject('slow_path_timing_missing');
  if (Number.isFinite(observation.minimumDelayMs) && observation.elapsedMs < observation.minimumDelayMs) {
    return reject('slow_path_not_actually_slow');
  }
  return accept();
}

function accept() {
  return { ok: true };
}

function reject(reason) {
  return { ok: false, reason };
}
