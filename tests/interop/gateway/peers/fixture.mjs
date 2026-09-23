import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';

export const FIXTURE_SEED = 'gateway-interop-neutral-seed-20260917';
export const FIXTURE_PEER_VERSION = '1.0.0';
export const TARGET_PROTOCOL_VERSION = '2026-07-28';
export const SDK_PROTOCOL_VERSION = '2025-11-25';
export const FIXTURE_AUTH_ALLOW = 'Bearer interop-fixture-allow';
export const FIXTURE_AUTH_DENY = 'Bearer interop-fixture-deny';
export const EXPECTED_ROUTE = 'route.demo';
export const EXPECTED_RESOURCE_URI = 'fixture://artifact/order-demo';
export const EXPECTED_OPERATION_KEY = 'effect-key-1';
const TOOL_STATE = 'b3BhcXVlLWZpeHR1cmUtc3RhdGUtMQ'; // canonical unpadded base64url

export const BUSINESS_PAYLOAD = Object.freeze({
  traceId: 'business-trace',
  auditId: 'business-audit',
  toolExecutionId: 'business-execution',
  order: {
    id: 'order-demo',
    quantity: 2,
    labels: ['alpha', '🌏']
  }
});

export const APPLICATION_META = Object.freeze({
  'business-id': 'order-demo',
  'com.example/traceId': 'business-trace'
});

const IMAGE_DATA = Buffer.from('neutral-image-fixture', 'utf8').toString('base64');
const AUDIO_DATA = Buffer.from('neutral-audio-fixture', 'utf8').toString('base64');

export const TOOL_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    objective: { type: 'string' },
    operationKey: { type: 'string' },
    route: { type: 'string' }
  },
  required: ['objective'],
  additionalProperties: false
});

export class FixtureObserver {
  #events = [];
  #effects = [];
  #upstreamRequests = [];
  #unauthorizedAttempts = 0;

  record(event, details = {}) {
    this.#events.push({ event, details: clone(details) });
  }

  recordUpstreamRequest(request) {
    const copy = clone(request);
    this.#upstreamRequests.push(copy);
    this.record('upstream_request', copy);
  }

  recordEffect(effect) {
    const copy = clone(effect);
    this.#effects.push(copy);
    this.record('effect', copy);
  }

  recordUnauthorizedAttempt(details) {
    this.#unauthorizedAttempts += 1;
    this.record('unauthorized_attempt', details);
  }

  close() {
    this.record('closed');
  }

  snapshot() {
    return {
      events: clone(this.#events),
      effects: clone(this.#effects),
      upstreamRequests: clone(this.#upstreamRequests),
      unauthorizedAttempts: this.#unauthorizedAttempts,
      closed: this.#events.some(({ event }) => event === 'closed')
    };
  }
}

export function createFixtureState({ peerName, observer = new FixtureObserver() } = {}) {
  const name = peerName ?? 'neutral-peer';
  let closed = false;
  const acceptedOperationKeys = new Set();
  const challenges = new Map();

  function resultMeta(status = 'ready') {
    return {
      ...APPLICATION_META,
      'com.example/status': status
    };
  }

  function inputRequired(state, requestKind) {
    if (!challenges.has(state)) challenges.set(state, randomBytes(16).toString('hex'));
    const nonce = challenges.get(state);
    const prompt = requestKind === 'tool'
      ? 'Choose an artifact label'
      : requestKind === 'resource'
        ? 'Confirm the artifact read'
        : 'Confirm the prompt read';
    return {
      resultType: 'input_required',
      requestState: state,
      inputRequests: {
        'confirm-name': {
          method: 'elicitation/create',
          params: {
            mode: 'form',
            message: `${prompt}: ${nonce}`,
            requestedSchema: {
              type: 'object',
              properties: { label: { type: 'string' }, nonce: { type: 'string' } },
              required: ['label', 'nonce']
            }
          }
        }
      }
    };
  }

  function hasAcceptedInput(params, state) {
    const response = params?.inputResponses?.['confirm-name'];
    return response?.action === 'accept' && typeof response.content?.label === 'string'
      && response.content.nonce === challenges.get(state);
  }

  function authorized(context) {
    return context?.authorized === true;
  }

  function recordRequest(method, params, context) {
    observer.recordUpstreamRequest({
      peer: name,
      method,
      name: params?.name,
      uri: params?.uri,
      route: params?.arguments?.route ?? EXPECTED_ROUTE,
      operationKey: params?.arguments?.operationKey,
      requestState: params?.requestState,
      inputResponses: params?.inputResponses,
      principal: context?.principal ?? 'fixture-principal'
    });
  }

  function handleTool(params = {}, context = {}) {
    const args = params.arguments ?? {};
    if (!params.requestState && !params.inputResponses) {
      return inputRequired(TOOL_STATE, 'tool');
    }

    if (params.requestState !== TOOL_STATE) {
      return {
        resultType: 'denied',
        denialCode: 'invalid_request_state',
        _meta: resultMeta('denied')
      };
    }

    recordRequest('tools/call', params, context);
    if (!authorized(context)) {
      observer.recordUnauthorizedAttempt({ method: 'tools/call', route: args.route ?? EXPECTED_ROUTE });
      return {
        resultType: 'denied',
        denialCode: 'authorization_required',
        _meta: resultMeta('denied')
      };
    }

    if (!hasAcceptedInput(params, TOOL_STATE)) {
      return inputRequired(TOOL_STATE, 'tool');
    }

    const operationKey = args.operationKey ?? EXPECTED_OPERATION_KEY;
    const duplicate = acceptedOperationKeys.has(operationKey);
    if (!duplicate) {
      acceptedOperationKeys.add(operationKey);
      observer.recordEffect({ operationKey, route: args.route ?? EXPECTED_ROUTE });
    }

    const label = params.inputResponses['confirm-name'].content.label;
    return {
      resultType: 'complete',
      content: [
        { type: 'text', text: 'artifact prepared' },
        { type: 'image', data: IMAGE_DATA, mimeType: 'image/png' },
        { type: 'audio', data: AUDIO_DATA, mimeType: 'audio/wav' },
        {
          type: 'resource',
          resource: {
            uri: EXPECTED_RESOURCE_URI,
            text: 'artifact body',
            mimeType: 'text/plain'
          }
        },
        {
          type: 'resource_link',
          uri: EXPECTED_RESOURCE_URI,
          name: 'artifact',
          mimeType: 'text/plain'
        }
      ],
      structuredContent: {
        ...clone(BUSINESS_PAYLOAD),
        artifact: label,
        resourceUri: EXPECTED_RESOURCE_URI,
        route: args.route ?? EXPECTED_ROUTE,
        duplicate
      },
      _meta: resultMeta('ready'),
      requestState: 'opaque-fixture-state-2'
    };
  }

  function handleContinuation(method, params = {}, context = {}) {
    const state = method === 'resources/read'
      ? 'opaque-resource-state-1'
      : 'opaque-prompt-state-1';
    if (!params.requestState && !params.inputResponses) {
      return inputRequired(state, method === 'resources/read' ? 'resource' : 'prompt');
    }
    if (params.requestState !== state) {
      return {
        resultType: 'denied',
        denialCode: 'invalid_request_state',
        _meta: resultMeta('denied')
      };
    }
    recordRequest(method, params, context);
    if (!authorized(context)) {
      observer.recordUnauthorizedAttempt({ method });
      return { resultType: 'denied', denialCode: 'authorization_required', _meta: resultMeta('denied') };
    }
    if (!hasAcceptedInput(params, state)) {
      return inputRequired(state, method === 'resources/read' ? 'resource' : 'prompt');
    }
    if (method === 'resources/read') {
      return {
        resultType: 'complete',
        contents: [{
          uri: EXPECTED_RESOURCE_URI,
          text: 'artifact body',
          mimeType: 'text/plain',
          _meta: resultMeta('ready')
        }],
        _meta: resultMeta('ready'),
        requestState: 'opaque-resource-state-2'
      };
    }
    return {
      resultType: 'complete',
      description: 'artifact prompt',
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: 'Prepare the artifact labeled demo',
          _meta: resultMeta('ready')
        }
      }],
      _meta: resultMeta('ready'),
      requestState: 'opaque-prompt-state-2'
    };
  }

  return {
    peerName: name,
    observer,
    getTools() {
      return [{
        name: EXPECTED_ROUTE,
        description: 'Neutral artifact preparation tool',
        inputSchema: TOOL_INPUT_SCHEMA,
        outputSchema: { type: 'object', properties: { artifact: { type: 'string' } }, required: ['artifact'] },
        _meta: { 'com.example/tool': 'neutral' }
      }];
    },
    getResources() {
      return [{
        uri: EXPECTED_RESOURCE_URI,
        name: 'artifact',
        description: 'Neutral artifact fixture',
        mimeType: 'text/plain',
        _meta: { 'business-id': 'order-demo' }
      }];
    },
    getPrompts() {
      return [{
        name: 'artifact-prompt',
        description: 'Neutral artifact prompt',
        arguments: [{ name: 'label', required: true }]
      }];
    },
    handle(method, params, context) {
      if (closed) {
        return { resultType: 'denied', denialCode: 'peer_closed', _meta: resultMeta('closed') };
      }
      if (method === 'tools/call') return handleTool(params, context);
      if (method === 'resources/read') return handleContinuation(method, params, context);
      if (method === 'prompts/get') return handleContinuation(method, params, context);
      throw new Error(`Unsupported fixture method: ${method}`);
    },
    close() {
      if (!closed) {
        closed = true;
        observer.close();
      }
    },
    snapshot() {
      return observer.snapshot();
    }
  };
}

export function createInitializeParams(protocolVersion = TARGET_PROTOCOL_VERSION) {
  return {
    protocolVersion,
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: 'neutral-fixture-client', version: FIXTURE_PEER_VERSION }
  };
}

export function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
