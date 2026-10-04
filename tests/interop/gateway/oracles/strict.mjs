import { validateRawWire, validateUpstreamMeta } from './raw-wire.mjs';
import { deepEqual } from './payload.mjs';

const reject = reason => ({ ok: false, reason });
export function checkStrictObservation(observation) {
  if (!Array.isArray(observation?.rawWire) || observation.rawWire.length === 0) return reject('raw_wire_unobservable');
  for (const frame of observation.rawWire) {
    const checked = validateRawWire(frame.response, frame.id, frame.method, {
      allowError: true, protocolVersion: observation.protocolVersion ?? '2026-07-28'
    });
    if (!checked.ok) return checked;
    if ((observation.protocolVersion ?? '2026-07-28') === '2026-07-28' &&
        !validateUpstreamMeta(frame.params, { 'mcp-protocol-version': '2026-07-28' }).ok) {
      return reject('upstream_meta_missing_or_misplaced');
    }
  }
  if (observation.catalog?.tools?.tools?.[0]?.outputSchema?.type !== 'object') return reject('output_schema_missing');
  const initial = observation.tool?.initial;
  const request = observation.tool?.upstreamRequests?.find(item => item.method === 'tools/call' && item.operationKey === 'effect-key-1' && item.inputResponses?.['confirm-name']);
  const message = initial?.inputRequests?.['confirm-name']?.params?.message;
  const nonce = typeof message === 'string' ? message.split(': ').at(-1) : null;
  if (!/^[0-9a-f]{32}$/.test(nonce ?? '') || request?.inputResponses?.['confirm-name']?.content?.nonce !== nonce) {
    return reject('input_responses_changed');
  }
  if (!Array.isArray(observation.snapshot?.effects)) return reject('effect_unobservable');
  if (!deepEqual(observation.tool.effects, observation.snapshot.effects)) return reject('effect_ledger_mismatch');
  if (observation.authority?.routes?.length === 0 && observation.authority?.authorized === true) return reject('empty_permission_granted');
  if (observation.authority?.approvals?.length === 0 && observation.authority?.destructiveApproved === true) return reject('empty_approval_granted');
  if (observation.catalog?.subjects?.[0]?.routes?.some(route => observation.catalog.subjects?.[1]?.routes?.includes(route))) {
    return reject('catalog_subject_leak');
  }
  return { ok: true };
}
