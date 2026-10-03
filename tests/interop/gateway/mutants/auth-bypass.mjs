export const id = 'auth-bypass';
export const expectedReason = 'authorization_bypassed';

export function apply(observation) {
  const next = structuredClone(observation);
  next.unauthorized = structuredClone(next.authorized);
  next.unauthorizedEffects = [{ operationKey: 'effect-key-unauthorized', route: 'route.demo' }];
  return next;
}
