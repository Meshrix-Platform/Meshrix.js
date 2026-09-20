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

/**
 * Authority for a candidate observed only through its public entry.
 *
 * The neutral fixture's `denialCode` vocabulary is not asserted here, because a
 * candidate is free to refuse with its own stable code. What is asserted is the
 * invariant that actually matters: the same call completes under an authorized context
 * and is refused under a revoked one, and the refused call records no effect. The
 * authorized clause is the control that stops a blanket-failing candidate from looking
 * secure.
 */
export function checkCandidateAuthority(observation) {
  const authorized = observation?.authorized ?? observation?.tool?.continued;
  const denied = observation?.unauthorized;
  if (authorized?.resultType !== 'complete') return reject('authorized_call_failed');
  if ((observation?.authorizedEffects ?? []).length !== 1) return reject('effect_count_changed');
  if (denied?.resultType === 'complete') return reject('authorization_bypassed');
  if (typeof denied?.denialCode !== 'string' || denied.denialCode.length === 0) {
    return reject('authorization_refusal_not_observed');
  }
  if ((observation?.unauthorizedEffects ?? []).length !== 0) return reject('authorization_bypassed');
  return accept();
}

export function checkRoute(observation) {
  if (observation?.route !== 'route.demo') return reject('route_changed');
  return accept();
}

function accept() {
  return { ok: true };
}

function reject(reason) {
  return { ok: false, reason };
}
