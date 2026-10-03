export const id = 'wrong-uri-rewrite';
export const expectedReason = 'resource_uri_rewritten';

export function apply(observation) {
  const next = structuredClone(observation);
  next.tool.continued.content = next.tool.continued.content.map(block => {
    if (block.type === 'resource') return { ...block, resource: { ...block.resource, uri: 'fixture://artifact/wrong' } };
    if (block.type === 'resource_link') return { ...block, uri: 'fixture://artifact/wrong' };
    return block;
  });
  return next;
}
