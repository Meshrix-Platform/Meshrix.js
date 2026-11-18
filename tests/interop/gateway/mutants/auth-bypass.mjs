const canned1 = 'effect-key-unauthorized';


export const id = 'auth-bypass';
export const expectedReason = 'authorization_bypassed';

export function apply(observation) {
  const next = structuredClone(observation);
  next.unauthorized = structuredClone(next.authorized);
  next.unauthorizedEffects = [{ operationKey: canned1, route: 'route.demo' }];
  return next;
}
