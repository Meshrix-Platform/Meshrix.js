// Validate the received JSON-RPC envelope and method shape before extracting or
// canonicalizing business fields. A syntactically valid HTTP 200 is not evidence.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reject = reason => ({ ok: false, reason });

export function validateRawWire(message, id, method, { allowError = false, protocolVersion = '2026-07-28' } = {}) {
  if (!object(message) || message.jsonrpc !== '2.0' || message.id !== id ||
      (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))) return reject('jsonrpc_envelope_invalid');
  if (Object.hasOwn(message, 'error')) {
    if (!object(message.error) || !Number.isInteger(message.error.code) || typeof message.error.message !== 'string') return reject('jsonrpc_error_invalid');
    return allowError ? { ok: true, error: message.error } : reject('jsonrpc_remote_error');
  }
  const result = message.result;
  if (!object(result)) return reject('result_shape_invalid');
  if (method === 'initialize') {
    return typeof result.protocolVersion === 'string' && object(result.capabilities) && object(result.serverInfo)
      ? { ok: true } : reject('initialize_shape_invalid');
  }
  if (method === 'server/discover') {
    return result.resultType === 'complete' && Array.isArray(result.supportedVersions) &&
      result.supportedVersions.includes(protocolVersion) && object(result.capabilities)
      ? { ok: true } : reject('discover_shape_invalid');
  }
  if (method === 'ping') return { ok: true };
  const listField = { 'tools/list': 'tools', 'resources/list': 'resources', 'prompts/list': 'prompts' }[method];
  if (listField) {
    if (protocolVersion === '2026-07-28' && result.resultType !== 'complete') return reject('result_type_missing_or_invalid');
    if (!Array.isArray(result[listField])) return reject(`${listField}_list_shape_invalid`);
    if (listField === 'tools' && result.tools.some(tool => !object(tool.inputSchema) ||
      (Object.hasOwn(tool, 'outputSchema') && !object(tool.outputSchema)))) return reject('tool_schema_missing');
    return { ok: true };
  }
  if (['tools/call', 'resources/read', 'prompts/get'].includes(method)) {
    if (result.resultType === 'input_required') {
      if (Object.hasOwn(result, 'requestState') && typeof result.requestState !== 'string') return reject('request_state_invalid');
      return result.inputRequests === undefined || object(result.inputRequests) ? { ok: true } : reject('input_requests_invalid');
    }
    if (protocolVersion !== '2026-07-28' && result.resultType === 'denied') return { ok: true };
    if (protocolVersion === '2026-07-28' && result.resultType !== 'complete') return reject('result_type_missing_or_invalid');
    if (protocolVersion !== '2026-07-28' && result.resultType !== undefined && result.resultType !== 'complete') return reject('result_type_missing_or_invalid');
    if (method === 'resources/read' && !Array.isArray(result.contents)) return reject('resource_result_shape_invalid');
    if (Object.hasOwn(result, 'value')) return reject('unnegotiated_value_wrapper');
    if (method === 'tools/call' && (!Array.isArray(result.content) ||
        (result.structuredContent !== undefined && !object(result.structuredContent)))) return reject('tool_result_shape_invalid');
    if (method === 'prompts/get' && !Array.isArray(result.messages)) return reject('prompt_result_shape_invalid');
    return { ok: true };
  }
  return { ok: true };
}

export function validateUpstreamMeta(params, headers) {
  const meta = params?._meta;
  if (!object(meta) || meta['io.modelcontextprotocol/protocolVersion'] !== headers['mcp-protocol-version'] ||
      !object(meta['io.modelcontextprotocol/clientInfo']) || !object(meta['io.modelcontextprotocol/clientCapabilities'])) {
    return reject('upstream_meta_missing_or_misplaced');
  }
  return { ok: true };
}
