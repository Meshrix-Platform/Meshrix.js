#!/usr/bin/env node
// Framework-owned network proxy, never a product conformance candidate.
import { createServer } from 'node:http';

const upstream = process.env.MESHRIX_INTEROP_PEER_ENDPOINT;
if (!upstream?.startsWith('http://127.0.0.1:')) throw new Error('synthetic_peer_required');
const variant = process.env.MESHRIX_INTEROP_CANDIDATE_VARIANT ?? 'conformant';
const publicUri = 'fixture://gateway/public-artifact';
const redeemed = new Set();
const server = createServer(async (request, response) => {
  try {
    if (variant === 'stall' && request.method === 'POST') {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const parsed = body.length ? JSON.parse(body.toString()) : undefined;
    if (variant === 'public-uri-map' && parsed?.method === 'resources/read' && parsed.params?.uri === publicUri) {
      parsed.params.uri = 'fixture://artifact/order-demo';
    }
    const replyDenied = reason => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: -32003, message: reason } }));
    };
    if (parsed?.method === 'tools/call' && parsed.id !== undefined) {
      const meta = parsed.params?._meta ?? {};
      if (variant !== 'empty-permission-bypass' && Array.isArray(meta['interop-permissions']) && meta['interop-permissions'].length === 0) {
        replyDenied('empty_permission'); return;
      }
      if (variant !== 'empty-approval-bypass' && meta['interop-destructive'] === true && Array.isArray(meta['interop-approvals']) && meta['interop-approvals'].length === 0) {
        replyDenied('empty_approval'); return;
      }
      const state = parsed.params?.requestState;
      const key = `${parsed.params?.arguments?.operationKey ?? ''}:${state?.replace(/=+$/, '')}`;
      if (state && parsed.params?.inputResponses && redeemed.has(key) && variant !== 'encoding-alias-replay') {
        replyDenied('replayed_continuation'); return;
      }
      if (state && variant === 'encoding-alias-replay') parsed.params.requestState = state.replace(/=+$/, '');
    }
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      'mcp-protocol-version': request.headers['mcp-protocol-version'] ?? '2026-07-28',
      authorization: request.headers.authorization ?? '',
      ...(request.headers['mcp-session-id'] ? { 'mcp-session-id': request.headers['mcp-session-id'] } : {})
    };
    if (variant === 'misplaced-meta' && parsed?.params?._meta) {
      parsed.clientInfo = parsed.params._meta['io.modelcontextprotocol/clientInfo'];
      delete parsed.params._meta['io.modelcontextprotocol/clientInfo'];
    }
    if (variant === 'drop-answer' && parsed?.params?.inputResponses) delete parsed.params.inputResponses;
    const returned = await fetch(upstream, { method: request.method, headers, body: request.method === 'POST' ? JSON.stringify(parsed) : undefined });
    let text = await returned.text();
    if (text && parsed?.id !== undefined) {
      const packet = JSON.parse(text);
      if (packet.result) {
        if (variant === 'public-uri-map') {
          if (parsed.method === 'resources/list') packet.result.resources[0].uri = publicUri;
          if (parsed.method === 'resources/read' && packet.result.contents) packet.result.contents[0].uri = publicUri;
          if (parsed.method === 'tools/call' && packet.result.content) {
            for (const block of packet.result.content) {
              if (block.type === 'resource') block.resource.uri = publicUri;
              if (block.type === 'resource_link') block.uri = publicUri;
            }
          }
        }
        if (parsed.method === 'tools/call' && parsed.params?.requestState && parsed.params?.inputResponses && packet.result.resultType === 'complete') {
          redeemed.add(`${parsed.params.arguments?.operationKey ?? ''}:${parsed.params.requestState.replace(/=+$/, '')}`);
        }
        if (variant === 'value-resource' && parsed.method === 'resources/read' && packet.result.resultType === 'complete') packet.result = { resultType: 'complete', value: { contents: packet.result.contents } };
        if (variant === 'missing-meta' && parsed.method === 'tools/call' && packet.result.resultType === 'complete') delete packet.result._meta;
        if (variant === 'unknown-extension' && parsed.method === 'tools/call' && packet.result.resultType === 'complete') packet.result = { resultType: 'unregistered', value: packet.result };
        if (variant === 'drop-output-schema' && parsed.method === 'tools/list') delete packet.result.tools?.[0]?.outputSchema;
        if (variant === 'drop-business-field' && parsed.method === 'tools/call' && packet.result.structuredContent) delete packet.result.structuredContent.auditId;
        text = JSON.stringify(packet);
      }
    }
    response.writeHead(returned.status, {
      'content-type': 'application/json',
      ...(returned.headers.get('mcp-session-id') ? { 'mcp-session-id': returned.headers.get('mcp-session-id') } : {}),
      ...(returned.headers.get('mcp-protocol-version') ? { 'mcp-protocol-version': returned.headers.get('mcp-protocol-version') } : {})
    });
    response.end(text);
  } catch {
    response.writeHead(502).end();
  }
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`${JSON.stringify({ interopEndpoint: `http://127.0.0.1:${server.address().port}/mcp` })}\n`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
