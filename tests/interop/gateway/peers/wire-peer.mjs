import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { validateUpstreamMeta } from '../oracles/raw-wire.mjs';
import {
  FIXTURE_AUTH_ALLOW,
  FIXTURE_PEER_VERSION,
  TARGET_PROTOCOL_VERSION,
  FixtureObserver,
  createFixtureState
} from './fixture.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
const SLOW_PATH_DELAY_MS = 15;

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body_too_large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    request.on('error', reject);
  });
}

function writeJson(response, status, body, headers = {}) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
  response.end(body === undefined ? '' : JSON.stringify(body));
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function headerValue(request, key) {
  const value = request.headers[key];
  return Array.isArray(value) ? value[0] : value;
}

export async function startWirePeer({ protocolVersion = TARGET_PROTOCOL_VERSION } = {}) {
  const sessions = new Set();
  const observer = new FixtureObserver();
  const fixture = createFixtureState({ peerName: 'wire-peer', observer });
  const httpServer = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/mcp') {
      writeJson(response, 404, { error: 'not_found' });
      return;
    }
    if (request.method === 'DELETE') {
      const sessionId = headerValue(request, 'mcp-session-id');
      sessions.delete(sessionId);
      writeJson(response, 200, {});
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST, DELETE');
      writeJson(response, 405, { error: 'method_not_allowed' });
      return;
    }

    let message;
    try {
      message = await readBody(request);
    } catch (error) {
      writeJson(response, 400, rpcError(null, -32700, error instanceof Error ? error.message : 'invalid_json'));
      return;
    }
    if (Array.isArray(message)) {
      writeJson(response, 400, rpcError(null, -32600, 'batch_not_supported'));
      return;
    }
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      writeJson(response, 400, rpcError(message?.id ?? null, -32600, 'invalid_request'));
      return;
    }

    if (message.method === 'initialize') {
      if (protocolVersion === TARGET_PROTOCOL_VERSION) {
        writeJson(response, 400, rpcError(message.id, -32601, 'modern_initialize_not_supported'));
        return;
      }
      if (message.params?.protocolVersion !== protocolVersion) {
        writeJson(response, 200, rpcError(message.id, -32602, 'protocol_version_not_supported'));
        return;
      }
      const sessionId = randomUUID();
      sessions.add(sessionId);
      writeJson(response, 200, rpcResult(message.id, {
        protocolVersion,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'neutral-wire-peer', version: FIXTURE_PEER_VERSION },
        instructions: 'neutral fixture only'
      }), { 'mcp-session-id': sessionId, 'mcp-protocol-version': protocolVersion });
      observer.record('initialize', { protocolVersion: message.params?.protocolVersion });
      return;
    }

    if (protocolVersion !== TARGET_PROTOCOL_VERSION) {
      const sessionId = headerValue(request, 'mcp-session-id');
      if (typeof sessionId !== 'string' || !sessions.has(sessionId)) {
        writeJson(response, 404, rpcError(message.id ?? null, -32001, 'unknown_session'));
        return;
      }
    } else if (headerValue(request, 'mcp-session-id')) {
      writeJson(response, 400, rpcError(message.id ?? null, -32602, 'modern_session_not_supported'));
      return;
    }
    if (headerValue(request, 'mcp-protocol-version') !== protocolVersion) {
      writeJson(response, 400, rpcError(message.id ?? null, -32602, 'protocol_header_mismatch'));
      return;
    }
    if (message.method === 'notifications/initialized' && protocolVersion === TARGET_PROTOCOL_VERSION) {
      writeJson(response, 400, rpcError(null, -32601, 'modern_initialized_not_supported'));
      return;
    }
    if (message.method === 'notifications/initialized' || message.id === undefined) {
      observer.record('notification', { method: message.method });
      writeJson(response, 202);
      return;
    }

    if (protocolVersion === TARGET_PROTOCOL_VERSION && message.method !== 'ping' && !validateUpstreamMeta(message.params, request.headers).ok) {
      observer.record('invalid_meta', { method: message.method });
      writeJson(response, 400, rpcError(message.id, -32602, 'upstream_meta_missing_or_misplaced'));
      return;
    }

    try {
      let result;
      if (message.method === 'server/discover' && protocolVersion === TARGET_PROTOCOL_VERSION) {
        observer.record('discover');
        result = { resultType: 'complete', supportedVersions: [TARGET_PROTOCOL_VERSION],
          capabilities: { tools: {}, resources: {}, prompts: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'neutral-wire-peer', version: FIXTURE_PEER_VERSION } } };
      } else if (message.method === 'ping') {
        result = {};
      } else if (message.method === 'tools/list') {
        // Benign-but-slow path, identical to the in-process wire peer and to the
        // candidates, so the same observation can be made over real loopback HTTP.
        if (message.params?.slowGoodPath === true) {
          await new Promise(resolve => setTimeout(resolve, SLOW_PATH_DELAY_MS));
        }
        result = { resultType: 'complete', tools: fixture.getTools() };
      } else if (message.method === 'resources/list') {
        result = { resultType: 'complete', resources: fixture.getResources() };
      } else if (message.method === 'prompts/list') {
        result = { resultType: 'complete', prompts: fixture.getPrompts() };
      } else if (['tools/call', 'resources/read', 'prompts/get'].includes(message.method)) {
        result = fixture.handle(message.method, message.params, {
          authorized: headerValue(request, 'authorization') === FIXTURE_AUTH_ALLOW,
          principal: headerValue(request, 'x-fixture-principal') ?? 'fixture-principal'
        });
        if (result.resultType === 'denied') {
          writeJson(response, 200, rpcError(message.id, -32003, 'authorization_required'));
          return;
        }
      } else {
        writeJson(response, 200, rpcError(message.id, -32601, 'method_not_found'));
        return;
      }
      writeJson(response, 200, rpcResult(message.id, result), {
        'mcp-protocol-version': protocolVersion
      });
    } catch (error) {
      observer.record('request_error', { kind: error instanceof Error ? error.name : 'unknown' });
      writeJson(response, 500, rpcError(message.id ?? null, -32603, 'internal_error'));
    }
  });

  await new Promise((resolve, reject) => {
    const onError = error => {
      httpServer.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off('error', onError);
      resolve();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(0, '127.0.0.1');
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  if (!port) throw new Error('wire peer did not receive a port');

  return {
    kind: 'wire',
    protocolVersion,
    endpoint: `http://127.0.0.1:${port}/mcp`,
    server: httpServer,
    observer,
    fixture,
    snapshot: () => fixture.snapshot(),
    async close() {
      sessions.clear();
      fixture.close();
      await new Promise(resolve => httpServer.close(() => resolve()));
    }
  };
}
