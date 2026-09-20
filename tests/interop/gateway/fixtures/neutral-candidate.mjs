#!/usr/bin/env node
/**
 * Neutral stdio candidate for the meshrix runner profile.
 *
 * This is deliberately NOT a Meshrix implementation and NOT a TASK-001 artifact: it
 * wraps the same neutral fixture the reference peers use (`peers/fixture.mjs`) and
 * speaks it over a real child process on stdio, exactly the way a product candidate is
 * launched. It exists so the independent framework can prove end to end - without
 * TASK-001 and without a product candidate - that:
 *
 *   - the runner resolves and really launches a configured candidate process,
 *   - all eight oracle cases are computed from real observations of that process,
 *   - a conformant candidate can reach a passing meshrix report.
 *
 * It emits the plan's normative flat complete envelope
 * (`{resultType, content, structuredContent, _meta}`), so a passing run also shows the
 * framework accepts the normative encoding rather than one product's spelling.
 *
 * `MESHRIX_INTEROP_CANDIDATE_VARIANT=drop-business-field` degrades one field so the
 * runner's failure and `--continue-on-failure` control flow can be observed against a
 * real process instead of a synthetic status.
 */
import { createInterface } from 'node:readline';
import { createFixtureState, FIXTURE_AUTH_DENY, TARGET_PROTOCOL_VERSION } from '../peers/fixture.mjs';

const VARIANT = process.env.MESHRIX_INTEROP_CANDIDATE_VARIANT ?? 'conformant';
const SLOW_PATH_DELAY_MS = 15;

const observer = {
  record() {},
  recordUpstreamRequest() {},
  recordEffect() {},
  recordUnauthorizedAttempt() {},
  close() {},
  snapshot() {
    return { events: [], effects: [], upstreamRequests: [], unauthorizedAttempts: 0, closed: false };
  }
};

const fixture = createFixtureState({ peerName: 'neutral-stdio-candidate', observer });

function authorizedFrom(message) {
  if (message?.params?._meta?.['interop-authorization'] === 'deny') return false;
  return message?.params?._meta?.['com.example/fixtureAuthorization'] === FIXTURE_AUTH_DENY
    ? false
    : true;
}

function degrade(result) {
  if (VARIANT !== 'drop-business-field') return result;
  if (result?.resultType !== 'complete' || !result.structuredContent) return result;
  const structuredContent = { ...result.structuredContent };
  delete structuredContent.auditId;
  return { ...result, structuredContent };
}

function handle(message) {
  const method = message?.method;
  const params = message?.params ?? {};
  if (method === 'tools/list') return { tools: fixture.getTools() };
  if (method === 'resources/list') return { resources: fixture.getResources() };
  if (method === 'prompts/list') return { prompts: fixture.getPrompts() };
  if (['tools/call', 'resources/read', 'prompts/get'].includes(method)) {
    return degrade(fixture.handle(method, params, {
      authorized: authorizedFrom(message),
      principal: params?._meta?.['com.example/fixturePrincipal'] ?? 'neutral-stdio-candidate'
    }));
  }
  return undefined;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const lines = createInterface({ input: process.stdin });
try {
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.method === 'notifications/initialized' || message.id === undefined) continue;
    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: TARGET_PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: 'neutral-stdio-candidate', version: '1.0.0' }
        }
      });
      continue;
    }
    if (message.method === 'tools/list' && message.params?.slowGoodPath === true) {
      await new Promise(resolve => setTimeout(resolve, SLOW_PATH_DELAY_MS));
    }
    const result = handle(message);
    if (result === undefined) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method_not_found' } });
      continue;
    }
    send({ jsonrpc: '2.0', id: message.id, result });
  }
} finally {
  fixture.close();
}
