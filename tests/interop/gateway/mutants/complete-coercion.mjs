export const id = 'complete-coercion';
export const expectedReason = 'result_type_coerced_to_complete';

export function apply(observation) {
  const next = structuredClone(observation);
  next.tool.initial.resultType = 'complete';
  delete next.tool.initial.inputRequests;
  return next;
}
