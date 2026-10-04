export const id = 'route-change';
export const expectedReason = 'route_changed';

export function apply(observation) {
  const next = structuredClone(observation);
  next.tool.continued.structuredContent.route = 'route.other';
  return next;
}
