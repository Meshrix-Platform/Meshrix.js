import { FIXTURE_AUTH_ALLOW } from './fixture.mjs';

const DEFAULT_TIMEOUT_MS = 5000;

export function createHttpClient(endpoint, {
  protocolVersion,
  authorization = FIXTURE_AUTH_ALLOW,
  principal = 'fixture-principal',
  requestTimeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  let nextId = 1;
  let sessionId;
  let negotiatedProtocolVersion = protocolVersion;
  let closed = false;

  function headers() {
    const value = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      authorization,
      'x-fixture-principal': principal
    };
    if (sessionId) value['mcp-session-id'] = sessionId;
    if (negotiatedProtocolVersion) value['mcp-protocol-version'] = negotiatedProtocolVersion;
    return value;
  }

  async function post(message) {
    if (closed) throw new Error('client_closed');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    const returnedSessionId = response.headers.get('mcp-session-id');
    if (returnedSessionId) sessionId = returnedSessionId;
    const returnedProtocolVersion = response.headers.get('mcp-protocol-version');
    if (returnedProtocolVersion) negotiatedProtocolVersion = returnedProtocolVersion;
    if (response.status === 202 || response.status === 204) return undefined;
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`peer_invalid_response_${response.status}`);
    }
    if (!response.ok) throw new Error(`peer_http_${response.status}`);
    return body;
  }

  return {
    get sessionId() {
      return sessionId;
    },
    get protocolVersion() {
      return negotiatedProtocolVersion;
    },
    async initialize(clientProtocolVersion = protocolVersion) {
      const response = await post({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'initialize',
        params: {
          protocolVersion: clientProtocolVersion,
          capabilities: { elicitation: { form: {} } },
          clientInfo: { name: 'neutral-fixture-client', version: '1.0.0' }
        }
      });
      if (!response?.result) throw new Error('initialize_missing_result');
      negotiatedProtocolVersion = response.result.protocolVersion ?? negotiatedProtocolVersion;
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return response.result;
    },
    async request(method, params = {}) {
      const response = await post({
        jsonrpc: '2.0',
        id: nextId++,
        method,
        params
      });
      if (!response?.result) throw new Error(`${method}_missing_result`);
      return response.result;
    },
    async notify(method, params = {}) {
      await post({ jsonrpc: '2.0', method, params });
    },
    async close() {
      if (closed) return { closed: true };
      if (!sessionId) {
        closed = true;
        return { closed: true };
      }
      try {
        await fetch(endpoint, {
          method: 'DELETE',
          headers: headers(),
          signal: AbortSignal.timeout(requestTimeoutMs)
        });
      } catch {
        // Cleanup callers record the close attempt; a peer that already exited is clean.
      } finally {
        closed = true;
      }
      return { closed: true };
    }
  };
}
