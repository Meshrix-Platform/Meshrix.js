import { deepEqual } from './payload.mjs';

export function checkSecurityObservation(observation) {
  const denied = observation?.unauthorized;
  const authorized = observation?.authorized;
  if (denied?.resultType !== 'denied' || denied.denialCode !== 'authorization_required') {
    return reject('authorization_bypassed');
  }
  if ((observation?.unauthorizedEffects ?? []).length !== 0) return reject('authorization_bypassed');
  if (authorized?.resultType !== 'complete') return reject('authorized_call_failed');
  if ((observation?.authorizedEffects ?? []).length !== 1) return reject('effect_count_changed');
  return accept();
}

export function checkContextIsolation(observation) {
  const contexts = observation?.contexts;
  if (!Array.isArray(contexts) || contexts.length !== 2) return reject('context_observation_missing');
  if (deepEqual(contexts[0], contexts[1])) return reject('business_context_mixed');
  if (contexts[0]?.principal === contexts[1]?.principal) return reject('principal_context_mixed');
  return accept();
}

function accept() {
  return { ok: true };
}

function reject(reason) {
  return { ok: false, reason };
}
