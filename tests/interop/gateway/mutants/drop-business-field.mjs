export const id = 'drop-business-field';
export const expectedReason = 'business_field_missing';

export function apply(observation) {
  const next = structuredClone(observation);
  delete next.tool.continued.structuredContent.auditId;
  return next;
}
