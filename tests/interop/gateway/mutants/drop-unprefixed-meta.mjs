export const id = 'drop-unprefixed-meta';
export const expectedReason = 'unprefixed_metadata_missing';

export function apply(observation) {
  const next = structuredClone(observation);
  delete next.tool.continued._meta['business-id'];
  return next;
}
