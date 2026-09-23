import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  CallToolRequestParamsSchema,
  GetPromptRequestSchema,
  GetPromptRequestParamsSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ReadResourceRequestParamsSchema
} from '@modelcontextprotocol/sdk/types.js';
import {
  FIXTURE_AUTH_ALLOW,
  FIXTURE_PEER_VERSION,
  SDK_PROTOCOL_VERSION,
  FixtureObserver,
  createFixtureState
} from './fixture.mjs';

function headerValue(headers, key) {
  const value = headers?.[key];
  return Array.isArray(value) ? value[0] : value;
}

function isAuthorized(extra, request) {
  return headerValue(extra?.requestInfo?.headers, 'authorization') === FIXTURE_AUTH_ALLOW
    || request?.params?._meta?.['com.example/fixtureAuthorization'] === FIXTURE_AUTH_ALLOW;
}

const InteropCallToolRequestSchema = CallToolRequestSchema.extend({ params: CallToolRequestParamsSchema.loose() });
const InteropReadResourceRequestSchema = ReadResourceRequestSchema.extend({ params: ReadResourceRequestParamsSchema.loose() });
const InteropGetPromptRequestSchema = GetPromptRequestSchema.extend({ params: GetPromptRequestParamsSchema.loose() });

export function createSdkFixtureServer({ fixture = undefined, observer = new FixtureObserver() } = {}) {
  const peerFixture = fixture ?? createFixtureState({ peerName: 'sdk-peer', observer });
  const server = new Server(
    { name: 'neutral-sdk-peer', version: FIXTURE_PEER_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: peerFixture.getTools() }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: peerFixture.getResources() }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: peerFixture.getPrompts() }));
  server.setRequestHandler(InteropCallToolRequestSchema, async (request, extra) => (
    peerFixture.handle('tools/call', request.params, {
      authorized: isAuthorized(extra, request),
      principal: headerValue(extra?.requestInfo?.headers, 'x-fixture-principal')
        ?? request.params?._meta?.['com.example/fixturePrincipal']
        ?? 'fixture-principal'
    })
  ));
  server.setRequestHandler(InteropReadResourceRequestSchema, async (request, extra) => (
    peerFixture.handle('resources/read', request.params, {
      authorized: isAuthorized(extra, request),
      principal: headerValue(extra?.requestInfo?.headers, 'x-fixture-principal')
        ?? request.params?._meta?.['com.example/fixturePrincipal']
        ?? 'fixture-principal'
    })
  ));
  server.setRequestHandler(InteropGetPromptRequestSchema, async (request, extra) => (
    peerFixture.handle('prompts/get', request.params, {
      authorized: isAuthorized(extra, request),
      principal: headerValue(extra?.requestInfo?.headers, 'x-fixture-principal')
        ?? request.params?._meta?.['com.example/fixturePrincipal']
        ?? 'fixture-principal'
    })
  ));

  return { server, fixture: peerFixture, observer };
}

function createEntry(sessions) {
  const observer = new FixtureObserver();
  const { server, fixture } = createSdkFixtureServer({ observer });

  const entry = { server, fixture, observer, sessionId: undefined, transport: undefined };
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized(sessionId) {
      entry.sessionId = sessionId;
      sessions.set(sessionId, entry);
    },
    onsessionclosed(sessionId) {
      sessions.delete(sessionId);
      if (!entry.sessionId || entry.sessionId === sessionId) fixture.close();
    }
  });
  entry.transport = transport;
  return entry;
}

function sendJsonError(response, status, message) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ error: message }));
}

export async function startSdkPeer() {
  const sessions = new Map();
  const entries = new Set();
  const httpServer = createHttpServer(async (request, response) => {
    if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== '/mcp') {
      sendJsonError(response, 404, 'not_found');
      return;
    }

    const sessionId = request.headers['mcp-session-id'];
    let entry = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (!entry && request.method === 'POST' && !sessionId) {
      entry = createEntry(sessions);
      entries.add(entry);
      await entry.server.connect(entry.transport);
    }
    if (!entry) {
      sendJsonError(response, 404, 'unknown_session');
      return;
    }

    try {
      await entry.transport.handleRequest(request, response);
    } catch (error) {
      if (!response.headersSent) sendJsonError(response, 500, 'peer_request_failed');
      entry.observer.record('request_error', { kind: error instanceof Error ? error.name : 'unknown' });
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
  if (!port) throw new Error('SDK peer did not receive a port');

  return {
    kind: 'sdk',
    protocolVersion: SDK_PROTOCOL_VERSION,
    endpoint: `http://127.0.0.1:${port}/mcp`,
    server: httpServer,
    entries,
    snapshot() {
      const snapshots = [...entries].map(entry => entry.fixture.snapshot());
      return snapshots[0] ?? { events: [], effects: [], upstreamRequests: [], unauthorizedAttempts: 0, closed: false };
    },
    async close() {
      for (const entry of entries) {
        entry.fixture.close();
        await entry.server.close().catch(() => {});
      }
      sessions.clear();
      await new Promise(resolve => httpServer.close(() => resolve()));
    }
  };
}
