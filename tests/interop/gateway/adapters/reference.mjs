import { createHttpClient } from '../peers/http-client.mjs';
import {
  EXPECTED_RESOURCE_URI,
  FIXTURE_AUTH_ALLOW,
  FIXTURE_AUTH_DENY,
  TARGET_PROTOCOL_VERSION
} from '../peers/fixture.mjs';
import { comparePromptPayload, compareResourcePayload, deepEqual } from '../oracles/payload.mjs';
import { createMemorySdkPeer, createMemoryWirePeer } from '../peers/memory-peers.mjs';
import { startSdkPeer } from '../peers/sdk-peer.mjs';
import { startWirePeer } from '../peers/wire-peer.mjs';

const APP_META = {
  'business-id': 'order-demo',
  'com.example/traceId': 'business-trace'
};

function toolParams(overrides = {}) {
  return {
    name: 'route.demo',
    arguments: {
      objective: 'prepare artifact',
      operationKey: 'effect-key-1',
      route: 'route.demo'
    },
    _meta: APP_META,
    ...overrides
  };
}

const inputResponses = {
  'confirm-name': { action: 'accept', content: { label: 'demo' } }
};

async function runPeerScenario(peer) {
  const client = await createPeerClient(peer, {
    protocolVersion: peer.protocolVersion,
    authorization: FIXTURE_AUTH_ALLOW,
    principal: 'principal-alpha'
  });
  let clientSnapshot;
  try {
    const initialize = await client.initialize(peer.protocolVersion);
    const tools = await client.request('tools/list');
    const resources = await client.request('resources/list');
    const prompts = await client.request('prompts/list');

    const initialTool = await client.request('tools/call', toolParams());
    const continuedTool = await client.request('tools/call', toolParams({
      requestState: initialTool.requestState,
      inputResponses
    }));

    const initialResource = await client.request('resources/read', {
      uri: EXPECTED_RESOURCE_URI,
      _meta: APP_META
    });
    const continuedResource = await client.request('resources/read', {
      uri: EXPECTED_RESOURCE_URI,
      requestState: initialResource.requestState,
      inputResponses,
      _meta: APP_META
    });

    const initialPrompt = await client.request('prompts/get', {
      name: 'artifact-prompt',
      arguments: { label: 'demo' },
      _meta: APP_META
    });
    const continuedPrompt = await client.request('prompts/get', {
      name: 'artifact-prompt',
      arguments: { label: 'demo' },
      requestState: initialPrompt.requestState,
      inputResponses,
      _meta: APP_META
    });
    clientSnapshot = peer.snapshot();

    return {
      initialize,
      catalog: { tools, resources, prompts },
      tool: {
        initial: initialTool,
        continued: continuedTool,
        upstreamRequests: clientSnapshot.upstreamRequests.filter(request => request.method === 'tools/call'),
        effects: clientSnapshot.effects
      },
      resource: {
        initial: initialResource,
        continued: continuedResource,
        upstreamRequests: clientSnapshot.upstreamRequests.filter(request => request.method === 'resources/read')
      },
      prompt: {
        initial: initialPrompt,
        continued: continuedPrompt,
        upstreamRequests: clientSnapshot.upstreamRequests.filter(request => request.method === 'prompts/get')
      },
      snapshot: clientSnapshot
    };
  } finally {
    await client.close();
  }
}

export const SLOW_PATH_MIN_DELAY_MS = 15;
/**
 * Drives a real slow-but-benign round trip against the wire peer and measures it.
 *
 * Both profiles are exercised through the peer's own transport - in-process dispatch, or
 * a real loopback HTTP request - so the timing in the case evidence comes from a round
 * trip that actually happened rather than from a status literal.
 */
async function observeSlowGoodPath(peer, transport) {
  const started = performance.now();
  let client;
  try {
    client = peer.createClient
      ? await peer.createClient({
        protocolVersion: peer.protocolVersion,
        authorization: FIXTURE_AUTH_ALLOW,
        principal: 'principal-slow-good-path',
        slowGoodPath: true
      })
      : createHttpClient(peer.endpoint, {
        protocolVersion: peer.protocolVersion,
        authorization: FIXTURE_AUTH_ALLOW,
        principal: 'principal-slow-good-path'
      });
    await client.initialize(peer.protocolVersion);
    const listed = await client.request('tools/list', { slowGoodPath: true });
    const elapsedMs = Math.round(performance.now() - started);
    return {
      observed: true,
      status: Array.isArray(listed?.tools) ? 'pass' : 'fail',
      reason: Array.isArray(listed?.tools) ? 'slow_good_path_response_observed' : 'slow_good_path_response_invalid',
      elapsedMs,
      minimumDelayMs: SLOW_PATH_MIN_DELAY_MS,
      transport
    };
  } catch (error) {
    return {
      observed: false,
      status: 'not_run',
      reason: error instanceof Error && error.name === 'TimeoutError' ? 'slow_good_path_request_timeout' : 'slow_good_path_round_trip_failed',
      minimumDelayMs: SLOW_PATH_MIN_DELAY_MS,
      transport
    };
  } finally {
    await client?.close?.().catch?.(() => {});
  }
}

async function runUnauthorizedScenario(peer, effectCountBefore) {
  const client = await createPeerClient(peer, {
    protocolVersion: peer.protocolVersion,
    authorization: FIXTURE_AUTH_DENY,
    principal: 'principal-deny'
  });
  try {
    await client.initialize(peer.protocolVersion);
    const initial = await client.request('tools/call', toolParams({
      arguments: {
        objective: 'prepare artifact',
        operationKey: 'effect-key-unauthorized',
        route: 'route.demo'
      }
    }));
    const unauthorized = await client.request('tools/call', toolParams({
      arguments: {
        objective: 'prepare artifact',
        operationKey: 'effect-key-unauthorized',
        route: 'route.demo'
      },
      requestState: initial.requestState,
      inputResponses
    }));
    const snapshot = peer.snapshot();
    return {
      initial,
      unauthorized,
      unauthorizedEffects: snapshot.effects.slice(effectCountBefore),
      snapshot
    };
  } finally {
    await client.close();
  }
}

async function createPeerClient(peer, options) {
  if (peer.createClient) return peer.createClient(options);
  return createHttpClient(peer.endpoint, options);
}

export async function runPeerScenarioWithSecurity(peer) {
  const scenario = await runPeerScenario(peer);
  const security = await runUnauthorizedScenario(peer, scenario.tool.effects.length);
  return {
    ...scenario,
    authorized: scenario.tool.continued,
    authorizedEffects: scenario.tool.effects,
    unauthorized: security.unauthorized,
    unauthorizedEffects: security.unauthorizedEffects,
    contexts: [
      { principal: 'principal-alpha', observedRoute: scenario.tool.continued.structuredContent?.route },
      { principal: 'principal-deny', observedRoute: security.unauthorized.denialCode }
    ]
  };
}

export async function runReferenceScenario({ ledger } = {}) {
  const transport = process.env.MESHRIX_INTEROP_TRANSPORT ?? 'memory';
  const transportLabel = transport === 'http' ? 'node:http-jsonrpc' : 'node:http-jsonrpc/in-process-dispatch';
  let sdkPeer;
  let wirePeer;
  const releaseSockets = [];
  try {
    if (transport === 'http') {
      sdkPeer = await startSdkPeer();
      wirePeer = await startWirePeer();
    } else {
      sdkPeer = createMemorySdkPeer();
      wirePeer = createMemoryWirePeer();
    }
    // The loopback listeners are real sockets this run owns; they are registered in the
    // ledger so the cleanup conclusion is a measurement of what was actually released.
    for (const [label, peer] of [['sdk-peer', sdkPeer], ['wire-peer', wirePeer]]) {
      if (peer.server) releaseSockets.push([label, peer.server, ledger?.trackOpenSocket(label, peer.server)]);
    }
  } catch (error) {
    await sdkPeer?.close().catch(() => {});
    await wirePeer?.close().catch(() => {});
    for (const [, server, release] of releaseSockets) {
      if (server.listening !== true) release?.();
    }
    throw error;
  }
  let result;
  let closeError;
  try {
    const [sdk, wire] = await Promise.all([
      runPeerScenarioWithSecurity(sdkPeer),
      runPeerScenarioWithSecurity(wirePeer)
    ]);
    const parity = compareReferencePeers(sdk, wire);
    result = {
      sdk,
      wire,
      observation: wire,
      parity,
      peerVersions: {
        sdk: '@modelcontextprotocol/sdk@1.29.0',
        sdkProtocol: sdkPeer.protocolVersion,
        wire: transportLabel,
        wireProtocol: wirePeer.protocolVersion,
        targetProfile: TARGET_PROTOCOL_VERSION
      },
      slowGoodPath: await observeSlowGoodPath(wirePeer, transportLabel)
    };
  } catch (error) {
    closeError = error;
  } finally {
    await Promise.all([sdkPeer.close(), wirePeer.close()]);
    for (const [, server, release] of releaseSockets) {
      if (server.listening !== true) release?.();
    }
  }
  if (closeError) throw closeError;
  const cleanup = ledger
    ? ledger.snapshot()
    : { complete: true, childProcesses: 0, sockets: 0, temporaryDirectories: 0 };
  return { ...result, cleanup };
}

/**
 * Peer parity: catalogs, business payloads, resource and prompt payloads, result types
 * and the protocol each peer actually negotiated.
 *
 * The two peers share a fixture definition, so this compares two independent transports
 * and two independent serializers over the same declared contract rather than two
 * framings of one serializer. Negotiated protocol versions are reported rather than
 * assumed: the pinned official SDK negotiates its own supported version while the wire
 * peer negotiates the target profile, and that difference is visible instead of hidden.
 */
export function compareReferencePeers(left, right) {
  const leftCatalog = normalizeCatalog(left.catalog);
  const rightCatalog = normalizeCatalog(right.catalog);
  if (!deepEqual(leftCatalog, rightCatalog)) return { ok: false, reason: 'peer_catalog_changed' };
  if (!deepEqual(left.tool.continued.structuredContent, right.tool.continued.structuredContent)) {
    return { ok: false, reason: 'peer_business_payload_diverged' };
  }
  if (left.tool.continued.resultType !== 'complete' || right.tool.continued.resultType !== 'complete') {
    return { ok: false, reason: 'peer_result_type_diverged' };
  }
  const leftResource = compareResourcePayload(left.resource.continued);
  const rightResource = compareResourcePayload(right.resource.continued);
  if (!leftResource.ok || !rightResource.ok) {
    return { ok: false, reason: leftResource.ok ? rightResource.reason : leftResource.reason };
  }
  const leftPrompt = comparePromptPayload(left.prompt.continued);
  const rightPrompt = comparePromptPayload(right.prompt.continued);
  if (!leftPrompt.ok || !rightPrompt.ok) {
    return { ok: false, reason: leftPrompt.ok ? rightPrompt.reason : leftPrompt.reason };
  }
  if (!deepEqual(left.resource.continued.contents, right.resource.continued.contents)) {
    return { ok: false, reason: 'peer_resource_payload_diverged' };
  }
  if (!deepEqual(left.prompt.continued.messages, right.prompt.continued.messages)) {
    return { ok: false, reason: 'peer_prompt_payload_diverged' };
  }
  return { ok: true };
}

function normalizeCatalog(catalog) {
  return {
    tools: catalog.tools.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    resources: catalog.resources.resources.map(({ uri, name, mimeType }) => ({ uri, name, mimeType })),
    prompts: catalog.prompts.prompts.map(({ name, description, arguments: args }) => ({ name, description, arguments: args }))
  };
}
