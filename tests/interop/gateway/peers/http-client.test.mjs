import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import { createHttpClient } from './http-client.mjs';

const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';

function jsonResponse(message, result, { status = 200, headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    async json() { return { jsonrpc: '2.0', id: message?.id ?? null, result }; }
  };
}

function captureRequest(url, init) {
  const headers = Object.fromEntries(Object.entries(init.headers).map(([name, value]) => [name.toLowerCase(), value]));
  return {
    url: String(url),
    method: init.method,
    headers,
    body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined
  };
}

async function withFetch(handler, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function encoded(value) {
  return `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

test('independent HTTP client emits modern request mirrors and preserves legacy lifecycle', async t => {
  await t.test('mirrors modern method and name fields using the specified safe encoding', async () => {
    const requests = [];
    await withFetch(async (url, init) => {
      const request = captureRequest(url, init);
      requests.push(request);
      const { body } = request;
      const results = {
        'server/discover': {
          resultType: 'complete',
          supportedVersions: [MODERN_VERSION],
          capabilities: { tools: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'neutral-client-test', version: '1' } }
        },
        'tools/list': { resultType: 'complete', tools: [] },
        'tools/call': { resultType: 'complete', content: [] },
        'resources/read': { resultType: 'complete', contents: [] },
        'prompts/get': { resultType: 'complete', messages: [] }
      };
      return jsonResponse(body, results[body.method], {
        headers: { 'mcp-protocol-version': MODERN_VERSION }
      });
    }, async () => {
      const client = createHttpClient('http://127.0.0.1/mcp', { protocolVersion: MODERN_VERSION });
      assert.equal((await client.initialize()).protocolVersion, MODERN_VERSION);
      await client.request('tools/list');
      await client.request('tools/call', { name: 'route.demo', arguments: {}, _meta: { 'business-id': 'order-demo' } });
      await client.request('resources/read', { uri: 'fixture://artifact/资料' });
      await client.request('prompts/get', { name: '=?base64?literal?=' });
      await client.request('tools/call', { name: ' padded ', arguments: {} });
      await client.close();
    });

    assert.deepEqual(requests.map(({ body }) => body.method), [
      'server/discover', 'tools/list', 'tools/call', 'resources/read', 'prompts/get', 'tools/call'
    ]);
    for (const request of requests) {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.accept, 'application/json, text/event-stream');
      assert.equal(request.headers['mcp-protocol-version'], MODERN_VERSION);
      assert.equal(request.headers['mcp-method'], request.body.method);
      assert.equal(request.body.params._meta['io.modelcontextprotocol/protocolVersion'], MODERN_VERSION);
      assert.equal(typeof request.body.params._meta['io.modelcontextprotocol/clientCapabilities'], 'object');
    }
    assert.equal(Object.hasOwn(requests[0].headers, 'mcp-name'), false);
    assert.equal(Object.hasOwn(requests[1].headers, 'mcp-name'), false);
    assert.equal(requests[2].headers['mcp-name'], 'route.demo');
    assert.equal(requests[2].body.params._meta['business-id'], 'order-demo');
    assert.equal(requests[3].headers['mcp-name'], encoded('fixture://artifact/资料'));
    assert.equal(requests[4].headers['mcp-name'], encoded('=?base64?literal?='));
    assert.equal(requests[5].headers['mcp-name'], encoded(' padded '));
  });

  await t.test('keeps initialize/session headers isolated to declared legacy profiles', async () => {
    const requests = [];
    await withFetch(async (url, init) => {
      const request = captureRequest(url, init);
      requests.push(request);
      if (request.method === 'DELETE') return jsonResponse(undefined, undefined);
      if (request.body.method === 'initialize') {
        return jsonResponse(request.body, {
          protocolVersion: LEGACY_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'legacy-peer', version: '1' }
        }, { headers: { 'mcp-session-id': 'session-1', 'mcp-protocol-version': LEGACY_VERSION } });
      }
      if (request.body.method === 'notifications/initialized') {
        return { status: 202, ok: true, headers: { get: () => null }, async json() { throw new Error('empty notification response'); } };
      }
      return jsonResponse(request.body, { tools: [{ name: 'route.demo', inputSchema: { type: 'object' } }] }, {
        headers: { 'mcp-protocol-version': LEGACY_VERSION }
      });
    }, async () => {
      const client = createHttpClient('http://127.0.0.1/mcp', { protocolVersion: LEGACY_VERSION });
      assert.equal((await client.initialize()).protocolVersion, LEGACY_VERSION);
      assert.equal((await client.request('tools/list')).tools[0].name, 'route.demo');
      await client.close();
    });

    assert.deepEqual(requests.map(request => request.method === 'DELETE' ? 'DELETE' : request.body.method), [
      'initialize', 'notifications/initialized', 'tools/list', 'DELETE'
    ]);
    for (const request of requests) {
      assert.equal(Object.hasOwn(request.headers, 'mcp-method'), false);
      assert.equal(Object.hasOwn(request.headers, 'mcp-name'), false);
      assert.equal(request.headers['mcp-protocol-version'], LEGACY_VERSION);
    }
    assert.equal(requests[1].headers['mcp-session-id'], 'session-1');
    assert.equal(requests[2].headers['mcp-session-id'], 'session-1');
    assert.equal(requests[3].headers['mcp-session-id'], 'session-1');
  });
});
