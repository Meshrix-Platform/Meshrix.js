export const id = 'replay-effect';
export const expectedReason = 'effect_replayed';

export function apply(observation) {
  const next = structuredClone(observation);
  next.tool.effects.push(structuredClone(next.tool.effects[0]));
  return next;
}
