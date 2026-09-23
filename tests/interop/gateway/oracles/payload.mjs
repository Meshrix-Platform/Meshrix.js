import { createHash } from 'node:crypto';

const EXPECTED_BUSINESS = {
  traceId: 'business-trace',
  auditId: 'business-audit',
  toolExecutionId: 'business-execution',
  order: {
    id: 'order-demo',
    quantity: 2,
    labels: ['alpha', '🌏']
  },
  artifact: 'demo',
  resourceUri: 'fixture://artifact/order-demo',
  route: 'route.demo',
  duplicate: false
};

const EXPECTED_META = {
  'business-id': 'order-demo',
  'com.example/traceId': 'business-trace',
  'com.example/status': 'ready'
};

export const EXPECTED_RESOURCE_URI = 'fixture://artifact/order-demo';

export function compareBusinessPayload(result, { resourceUri = EXPECTED_RESOURCE_URI } = {}) {
  if (!result || typeof result !== 'object') return reject('business_payload_missing');
  const actual = result.structuredContent;
  if (!actual || typeof actual !== 'object') return reject('business_field_missing');

  for (const key of ['traceId', 'auditId', 'toolExecutionId', 'order', 'artifact', 'resourceUri']) {
    if (!(key in actual)) return reject('business_field_missing');
  }
  if (actual.traceId !== EXPECTED_BUSINESS.traceId || actual.auditId !== EXPECTED_BUSINESS.auditId || actual.toolExecutionId !== EXPECTED_BUSINESS.toolExecutionId) {
    return reject('business_context_mixed');
  }
  if (actual.route !== EXPECTED_BUSINESS.route) return reject('route_changed');
  if (!deepEqual(actual, EXPECTED_BUSINESS)) return reject('business_payload_changed');

  const meta = result._meta;
  if (!meta || typeof meta !== 'object') return reject('unprefixed_metadata_missing');
  for (const [key, value] of Object.entries(EXPECTED_META)) {
    if (!(key in meta)) return reject('unprefixed_metadata_missing');
    if (meta[key] !== value) return reject('business_metadata_changed');
  }

  const contents = Array.isArray(result.content) ? result.content : [];
  const resource = contents.find(block => block?.type === 'resource');
  const resourceLink = contents.find(block => block?.type === 'resource_link');
  if (resource?.resource?.uri !== resourceUri || resourceLink?.uri !== resourceUri) {
    return reject('resource_uri_rewritten');
  }
  const image = contents.find(block => block?.type === 'image');
  const audio = contents.find(block => block?.type === 'audio');
  if (!image || !audio || image.mimeType !== 'image/png' || audio.mimeType !== 'audio/wav') {
    return reject('content_block_changed');
  }
  if (digestBase64(image.data) !== digestText('neutral-image-fixture')) return reject('content_bytes_changed');
  if (digestBase64(audio.data) !== digestText('neutral-audio-fixture')) return reject('content_bytes_changed');
  return accept();
}

export function compareResourcePayload(result, { resourceUri = EXPECTED_RESOURCE_URI } = {}) {
  const content = result?.contents?.[0];
  if (!content) return reject('resource_payload_missing');
  if (content.uri !== resourceUri) return reject('resource_uri_rewritten');
  if (content.text !== 'artifact body' || content.mimeType !== 'text/plain') return reject('resource_payload_changed');
  return accept();
}

export function comparePromptPayload(result) {
  const content = result?.messages?.[0]?.content;
  if (!content || content.type !== 'text') return reject('prompt_payload_missing');
  if (content.text !== 'Prepare the artifact labeled demo') return reject('prompt_payload_changed');
  return accept();
}

export function deepEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digestText(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function digestBase64(value) {
  try {
    return createHash('sha256').update(Buffer.from(value, 'base64')).digest('hex');
  } catch {
    return undefined;
  }
}

function accept() {
  return { ok: true };
}

function reject(reason) {
  return { ok: false, reason };
}
