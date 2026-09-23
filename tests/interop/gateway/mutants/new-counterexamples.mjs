const change = (id, expectedReason, apply) => ({ id, expectedReason, apply: observation => {
  const copy = structuredClone(observation);
  apply(copy);
  return copy;
} });

function frame(observation, method, predicate = () => true) {
  const found = observation.rawWire.find(item => item.method === method && predicate(item.response?.result));
  if (!found) throw new Error('wire_frame_missing');
  return found;
}

export const COUNTEREXAMPLES = Object.freeze([
  change('encoding-alias-replay', 'effect_replayed', o => o.tool.effects.push(structuredClone(o.tool.effects[0]))),
  change('empty-route-set', 'empty_permission_granted', o => { o.authority.routes = []; o.authority.authorized = true; }),
  change('empty-approval', 'empty_approval_granted', o => { o.authority.approvals = []; o.authority.destructiveApproved = true; }),
  change('drop-dynamic-answer', 'input_responses_changed', o => {
    o.tool.upstreamRequests.find(r => r.method === 'tools/call' && r.operationKey === 'effect-key-1' && r.inputResponses?.['confirm-name']).inputResponses = {};
  }),
  change('misplaced-upstream-meta', 'upstream_meta_missing_or_misplaced', o => {
    const request = frame(o, 'tools/call');
    request.clientInfo = request.params._meta['io.modelcontextprotocol/clientInfo'];
    delete request.params._meta['io.modelcontextprotocol/clientInfo'];
  }),
  change('resource-tool-wrapper', 'resource_result_shape_invalid', o => {
    const request = frame(o, 'resources/read', result => result?.resultType === 'complete');
    request.response.result = { resultType: 'complete', structuredContent: { contents: request.response.result.contents } };
  }),
  change('unknown-extension-accepted', 'result_type_missing_or_invalid', o => {
    const request = frame(o, 'tools/call', result => result?.resultType === 'complete');
    request.response.result = { resultType: 'unknown-extension', value: request.response.result };
  }),
  change('global-catalog-cross-talk', 'catalog_subject_leak', o => {
    o.catalog.subjects[1].routes.push('route.demo');
  }),
  change('unnegotiated-value-wrapper', 'unnegotiated_value_wrapper', o => {
    const request = frame(o, 'tools/call', result => result?.resultType === 'complete');
    request.response.result.value = { content: request.response.result.content };
  }),
  change('output-schema-dropped', 'output_schema_missing', o => {
    delete o.catalog.tools.tools[0].outputSchema;
    delete frame(o, 'tools/list').response.result.tools[0].outputSchema;
  })
]);
