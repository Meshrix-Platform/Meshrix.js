export const id = 'context-mixing';
export const expectedReason = 'business_context_mixed';

export function apply(observation) {
  const next = structuredClone(observation);
  next.tool.continued.structuredContent.traceId = 'other-context-trace';
  return next;
}
