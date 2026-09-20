import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  FIXTURE_AUTH_ALLOW,
  FIXTURE_PEER_VERSION,
  SDK_PROTOCOL_VERSION,
  TARGET_PROTOCOL_VERSION,
  FixtureObserver,
  createFixtureState
} from './fixture.mjs';
import { createSdkFixtureServer } from './sdk-peer.mjs';

function authorized(options, params) {
  return options.authorization === FIXTURE_AUTH_ALLOW
    || params?._meta?.['com.example/fixtureAuthorization'] === FIXTURE_AUTH_ALLOW;
}

export function createMemoryWirePeer() {
  const observer = new FixtureObserver();
  const fixture = createFixtureState({ peerName: 'wire-peer', observer });
  return {
    kind: 'wire-memory',
    protocolVersion: TARGET_PROTOCOL_VERSION,
    observer,
    snapshot: () => fixture.snapshot(),
    async createClient(options = {}) {
      let connected = false;
      return {
        async initialize() {
          connected = true;
          observer.record('initialize', { protocolVersion: TARGET_PROTOCOL_VERSION });
          return {
            protocolVersion: TARGET_PROTOCOL_VERSION,
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: 'neutral-wire-peer', version: FIXTURE_PEER_VERSION }
          };
      },
      async request(method, params = {}) {
        if (!connected) throw new Error('client_not_initialized');
        if (options.slowGoodPath && method === 'tools/list') {
          await new Promise(resolve => setTimeout(resolve, 15));
          observer.record('slow_good_path', { delayMs: 15 });
        }
        if (method === 'tools/list') return { tools: fixture.getTools() };
          if (method === 'resources/list') return { resources: fixture.getResources() };
          if (method === 'prompts/list') return { prompts: fixture.getPrompts() };
          return fixture.handle(method, params, {
            authorized: authorized(options, params),
            principal: options.principal ?? 'fixture-principal'
          });
        },
        async close() {
          connected = false;
        }
      };
    },
    async close() {
      fixture.close();
    }
  };
}

export function createMemorySdkPeer() {
  const observer = new FixtureObserver();
  const fixture = createFixtureState({ peerName: 'sdk-peer', observer });
  const sessions = new Set();
  return {
    kind: 'sdk-memory',
    protocolVersion: SDK_PROTOCOL_VERSION,
    observer,
    snapshot: () => fixture.snapshot(),
    async createClient(options = {}) {
      const { server } = createSdkFixtureServer({ fixture, observer });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: 'neutral-sdk-client', version: '1.0.0' },
        { capabilities: { elicitation: { form: {} } } }
      );
      await client.connect(clientTransport);
      const session = { server, client };
      sessions.add(session);
      return {
        async initialize() {
          return {
            protocolVersion: client.getServerVersion() ? SDK_PROTOCOL_VERSION : SDK_PROTOCOL_VERSION,
            capabilities: client.getServerCapabilities() ?? {},
            serverInfo: client.getServerVersion() ?? { name: 'neutral-sdk-peer', version: FIXTURE_PEER_VERSION }
          };
        },
        async request(method, params = {}) {
          const requestParams = {
            ...params,
            _meta: {
              ...(params._meta ?? {}),
              'com.example/fixtureAuthorization': options.authorization,
              'com.example/fixturePrincipal': options.principal ?? 'fixture-principal'
            }
          };
          return client.request({ method, params: requestParams }, ResultSchema);
        },
        async close() {
          await client.close().catch(() => {});
          await server.close().catch(() => {});
          sessions.delete(session);
        }
      };
    },
    async close() {
      for (const session of sessions) {
        await session.client.close().catch(() => {});
        await session.server.close().catch(() => {});
      }
      sessions.clear();
      fixture.close();
    }
  };
}
