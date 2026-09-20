import { compareBusinessPayload } from './payload.mjs';
import { checkCandidateMrtrLifecycle, checkToolLifecycle } from './lifecycle.mjs';
import { checkCandidateAuthority, checkContextIsolation, checkSecurityObservation } from './security.mjs';

export const OBSERVATION_PROFILES = Object.freeze(['upstream-observable', 'public-entry']);

function checkSetFor(observation, profile) {
  const resolved = profile ?? observation?.profile ?? 'upstream-observable';
  if (resolved === 'public-entry') {
    return [
      compareBusinessPayload(observation?.tool?.continued),
      checkCandidateMrtrLifecycle(observation),
      checkCandidateAuthority(observation),
      checkContextIsolation(observation)
    ];
  }
  return [
    compareBusinessPayload(observation?.tool?.continued),
    checkToolLifecycle(observation),
    checkSecurityObservation(observation)
  ];
}

export function evaluateObservation(observation, profile) {
  const failed = checkSetFor(observation, profile).find(check => !check.ok);
  return failed ?? { ok: true };
}

/**
 * Applies one bad proxy to a real observation and reports whether the oracle caught it
 * for the exact declared reason.
 *
 * A candidate that produced no usable observation must not crash the runner: the
 * adjudicator returns an explicit non-rejection instead, so the case fails honestly and
 * the report still carries all eight rows. Cascading a `TypeError` out of here previously
 * turned a candidate observation gap into a runner-level `not_run` for the whole run.
 */
export function evaluateMutant(observation, mutant, profile) {
  const base = {
    id: mutant.id,
    expectedReason: mutant.expectedReason,
    actualReason: undefined,
    rejected: false,
    ok: false
  };
  if (!observation || typeof observation !== 'object' || !observation.tool) {
    return { ...base, actualReason: 'observation_missing' };
  }
  // A mutation is only attributable if the benign control passes first: if the base
  // observation is already broken, an oracle's rejection says nothing about the mutation,
  // so it is reported as such instead of being counted as a caught bad proxy.
  if (evaluateObservation(observation, profile).ok !== true) {
    return { ...base, actualReason: 'observation_not_intact' };
  }
  let mutated;
  try {
    mutated = mutant.apply(observation);
  } catch {
    return { ...base, actualReason: 'mutant_application_failed' };
  }
  const result = evaluateObservation(mutated, profile);
  return {
    id: mutant.id,
    expectedReason: mutant.expectedReason,
    actualReason: result.reason,
    rejected: result.ok === false,
    ok: result.ok === false && result.reason === mutant.expectedReason
  };
}
