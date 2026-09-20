import { deepEqual } from './payload.mjs';

export const EXPECTED_TOOL_STATE = 'opaque-fixture-state-1';
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
  const continuationRequest = upstream.find(request => request.method === 'tools/call');
  if (!continuationRequest || continuationRequest.requestState !== EXPECTED_TOOL_STATE) {
    return reject('upstream_state_not_restored');
  }
  if (!deepEqual(continuationRequest.inputResponses, {
    'confirm-name': { action: 'accept', content: { label: 'demo' } }
  })) {
    return reject('input_responses_changed');
  }
  if (effects.length !== 1) return reject('effect_replayed');
  if (effects[0]?.operationKey !== 'effect-key-1') return reject('effect_key_changed');
  return accept();
}

/**
 * Multi-round-trip lifecycle for a candidate driven only through its public entry.
 *
 * The neutral fixture's literal state tokens are not available here, so the asserted
 * properties are the ones that hold for any correct candidate: an input-required round
 * is issued with an opaque token, presenting that token back completes the call, and a
 * tampered token must NOT complete. The last clause is what stops this from being a
 * status-code recital - a candidate that ignored `requestState` would complete the
 * tampered call too and fail here.
 */
export function checkCandidateMrtrLifecycle(observation) {
  const initial = observation?.tool?.initial;
  const continued = observation?.tool?.continued;
  const mrt = observation?.mrt;
  const effects = observation?.tool?.effects ?? [];
  if (initial?.resultType !== 'input_required') {
    return reject(observation?.tool?.initialReason ?? 'result_type_coerced_to_complete');
  }
  if (typeof initial.requestState !== 'string' || initial.requestState.length < 8) {
    return reject('request_state_not_issued');
  }
  if (continued?.resultType !== 'complete') {
    return reject(observation?.tool?.continuedReason ?? 'continuation_not_completed');
  }
  if (!mrt || mrt.statePresentedBack !== true) return reject('upstream_state_not_restored');
  if (mrt.tamperedRefused !== true) return reject('continuation_state_not_enforced');
  if (effects.length === 0) return reject('effect_not_observed');
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
