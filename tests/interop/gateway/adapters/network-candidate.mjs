import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpClient } from '../peers/http-client.mjs';
import { startProcessPeer } from '../peers/process-peer.mjs';
import { answersFor } from './reference.mjs';
import { EXPECTED_RESOURCE_URI, FIXTURE_AUTH_ALLOW, FIXTURE_AUTH_DENY, TARGET_PROTOCOL_VERSION } from '../peers/fixture.mjs';
import { compareBusinessPayload, comparePromptPayload, compareResourcePayload } from '../oracles/payload.mjs';

async function within(promise, ms, reason) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), ms); })]); }
  finally { clearTimeout(timer); }
}
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const FRAMEWORK_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cleanReason = error => {
  const reason = error?.reason ?? error?.message;
  return /^(?:[a-z][a-z0-9_]*|(?:tools\/call|resources\/read|prompts\/get|tools\/list|initialize):[a-z][a-z0-9_]*)$/.test(reason ?? '') ? reason : 'candidate_transport_failed';
};

async function verifyManifest(config) {
  if (config.candidateKind === 'reference-fixture') return { ok: true, kind: 'reference-fixture', identity: 'framework-owned-control' };
  if (!config.manifest) return { ok: false, reason: 'candidate_manifest_missing' };
  try {
    const manifest = JSON.parse(await readFile(config.manifest, 'utf8'));
    if (manifest.schema !== 'meshrix.gateway-candidate-manifest/v1' || manifest.candidateKind !== config.candidateKind ||
        !manifest.commit || !manifest.serverInfo?.name || !manifest.serverInfo?.version ||
        !Array.isArray(manifest.artifacts) || !manifest.artifacts.length) return { ok: false, reason: 'candidate_manifest_invalid' };
    const artifacts = [];
    for (const entry of manifest.artifacts) {
      if (!entry.path || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) return { ok: false, reason: 'candidate_manifest_invalid' };
      const actual = digest(await readFile(entry.path));
      if (actual !== entry.sha256) return { ok: false, reason: 'candidate_artifact_digest_mismatch' };
      const path = await realpath(entry.path);
      if (path === FRAMEWORK_ROOT || path.startsWith(`${FRAMEWORK_ROOT}/`)) return { ok: false, reason: 'framework_fixture_not_product_artifact' };
      artifacts.push(path);
    }
    const entry = config.args?.find(arg => artifacts.includes(resolve(config.cwd ?? process.cwd(), arg))) ??
      (artifacts.includes(resolve(config.command ?? '')) ? config.command : null);
    if (!entry) return { ok: false, reason: config.endpoint ? 'candidate_endpoint_identity_unverifiable' : 'candidate_executed_entry_unbound' };
    const entryDigest = manifest.artifacts[artifacts.indexOf(resolve(config.cwd ?? process.cwd(), entry))]?.sha256;
    return { ok: true, manifest, digest: entryDigest, entry: basename(entry) };
  } catch { return { ok: false, reason: 'candidate_manifest_unreadable' }; }
}

async function launch(config, peerEndpoint, ledger) {
  if (config.endpoint) return { endpoint: config.endpoint, processExit: { notApplicable: true }, async close() {} };
  const child = spawn(config.command, config.args ?? [], {
    cwd: config.cwd ?? process.cwd(),
    env: { ...process.env, MESHRIX_INTEROP_PEER_ENDPOINT: peerEndpoint },
    stdio: ['ignore', 'pipe', 'pipe'], shell: false
  });
  const release = ledger.trackChild(child.pid, { label: 'candidate', handle: child });
  const lines = createInterface({ input: child.stdout });
  let stderrBytes = 0;
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => { release(); resolve({ code, signal }); });
    child.once('error', () => { release(); resolve({ code: null, signal: null }); });
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    lines.on('line', line => {
      try {
        const endpoint = JSON.parse(line).interopEndpoint;
        if (typeof endpoint === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(endpoint)) resolveReady(endpoint);
      } catch { /* Untrusted process output is not a report. */ }
    });
    child.once('error', rejectReady);
    child.once('exit', () => rejectReady(new Error('candidate_process_exited')));
  });
  let endpoint;
  try { endpoint = await within(ready, config.startupTimeoutMs ?? 5000, 'candidate_startup_timeout'); }
  catch (error) {
    child.kill(); await exited;
    lines.close();
    throw error;
  }
  return {
    endpoint,
    get stderrBytes() { return stderrBytes; },
    async close() {
      child.kill('SIGTERM');
      const result = await within(exited, config.requestTimeoutMs ?? 5000, 'candidate_shutdown_timeout').catch(() => null);
      if (!result) { child.kill('SIGKILL'); await exited; lines.close(); return { exited: true, killed: true }; }
      lines.close();
      return { exited: true, killed: false };
    }
  };
}

export async function runNetworkCandidate(config, ledger) {
  const binding = await verifyManifest(config);
  if (!binding.ok) return { ok: false, reason: binding.reason, cleanup: ledger.snapshot() };
  let peer;
  let candidate;
  let allowed;
  let denied;
  let outcome;
  let failure;
  try {
    peer = await startProcessPeer(ledger, config.protocolVersion ?? TARGET_PROTOCOL_VERSION);
    candidate = await launch(config, peer.endpoint, ledger);
    const options = { protocolVersion: config.protocolVersion ?? TARGET_PROTOCOL_VERSION,
      requestTimeoutMs: config.requestTimeoutMs ?? 5000 };
    const rawWire = [];
    allowed = createHttpClient(candidate.endpoint, { ...options, authorization: config.authorization ?? FIXTURE_AUTH_ALLOW,
      principal: 'control-allowed', onWire: frame => rawWire.push(frame) });
    denied = createHttpClient(candidate.endpoint, { ...options, authorization: FIXTURE_AUTH_DENY, principal: 'control-denied' });
    const initialize = await allowed.initialize(options.protocolVersion);
    const deniedInitialize = await denied.initialize(options.protocolVersion);
    const [tools, resources, prompts] = await Promise.all([
      allowed.request('tools/list'), allowed.request('resources/list'), allowed.request('prompts/list')
    ]);
    const mapping = config.publicMapping ?? {};
    const selectedTool = tools.tools?.find(item => item.name === mapping.toolName) ?? tools.tools?.[0];
    const selectedResource = resources.resources?.find(item => item.uri === mapping.resourceUri) ?? resources.resources?.[0];
    const selectedPrompt = prompts.prompts?.find(item => item.name === mapping.promptName) ?? prompts.prompts?.[0];
    if ((mapping.toolName && selectedTool?.name !== mapping.toolName) ||
        (mapping.resourceUri && selectedResource?.uri !== mapping.resourceUri) ||
        (mapping.promptName && selectedPrompt?.name !== mapping.promptName)) throw new Error('declared_public_mapping_missing');
    if (binding.manifest && (initialize.serverInfo?.name !== binding.manifest.serverInfo.name ||
        initialize.serverInfo?.version !== binding.manifest.serverInfo.version)) throw new Error('candidate_runtime_identity_mismatch');
    const argumentsObject = { objective: 'prepare artifact', operationKey: 'effect-key-1', route: 'route.demo' };
    const toolParams = { name: selectedTool?.name, arguments: argumentsObject,
      _meta: { 'business-id': 'order-demo', 'com.example/traceId': 'business-trace' } };
    const initial = await allowed.request('tools/call', toolParams);
    const answer = answersFor(initial);
    const unanswered = await allowed.request('tools/call', { ...toolParams, requestState: initial.requestState, inputResponses: {} });
    const continued = await allowed.request('tools/call', { ...toolParams, requestState: initial.requestState, inputResponses: answer });
    const replay = async requestState => {
      try {
        const result = await allowed.request('tools/call', { ...toolParams, requestState, inputResponses: answer });
        return { refused: result.resultType !== 'complete' };
      } catch (error) { return { refused: true, reason: cleanReason(error) }; }
    };
    const replayOriginal = await replay(initial.requestState);
    const replayAlias = await replay(`${initial.requestState}${'='.repeat((4 - initial.requestState.length % 4) % 4)}`);
    const protectedProbe = async (suffix, meta) => {
      const params = { ...toolParams, arguments: { ...argumentsObject, operationKey: `effect-key-${suffix}` },
        _meta: { ...toolParams._meta, ...meta } };
      try {
        const challenge = await allowed.request('tools/call', params);
        if (challenge.resultType === 'input_required') {
          const result = await allowed.request('tools/call', { ...params, requestState: challenge.requestState, inputResponses: answersFor(challenge) });
          return { refused: result.resultType !== 'complete' };
        }
        return { refused: challenge.resultType !== 'complete' };
      } catch (error) { return { refused: true, reason: cleanReason(error) }; }
    };
    const emptyPermission = await protectedProbe('empty-permission', { 'interop-permissions': [] });
    const emptyApproval = await protectedProbe('empty-approval', { 'interop-destructive': true, 'interop-approvals': [] });
    const beforeDenied = await peer.snapshot();
    const deniedInitial = await denied.request('tools/call', { ...toolParams, arguments: { ...argumentsObject, operationKey: 'effect-key-denied' } });
    let deniedReason = null;
    try {
      await denied.request('tools/call', {
        ...toolParams, arguments: { ...argumentsObject, operationKey: 'effect-key-denied' },
        requestState: deniedInitial.requestState, inputResponses: answersFor(deniedInitial)
      });
    } catch (error) { deniedReason = cleanReason(error); }
    const afterDenied = await peer.snapshot();
    const resourceParams = { uri: selectedResource?.uri };
    const resourceInitial = await allowed.request('resources/read', resourceParams);
    const resource = await allowed.request('resources/read', { ...resourceParams, requestState: resourceInitial.requestState, inputResponses: answersFor(resourceInitial) });
    const promptParams = { name: selectedPrompt?.name, arguments: { label: 'demo' } };
    const promptInitial = await allowed.request('prompts/get', promptParams);
    const prompt = await allowed.request('prompts/get', { ...promptParams, requestState: promptInitial.requestState, inputResponses: answersFor(promptInitial) });
    const snapshot = await peer.snapshot();
    if (snapshot.upstreamRequests.some(item => item.method === 'resources/read' && item.uri !== EXPECTED_RESOURCE_URI) ||
        snapshot.upstreamRequests.some(item => item.method === 'tools/call' && item.name !== 'route.demo')) {
      throw new Error('upstream_public_mapping_invalid');
    }
    if (continued.resultType === 'complete' && snapshot.effects.length === 0) {
      throw new Error('effect_unobservable');
    }
    outcome = {
      ok: true, initialize, deniedInitialize, catalog: { tools, resources, prompts },
      observation: { profile: 'upstream-observable', protocolVersion: options.protocolVersion,
        publicMapping: mapping, tool: {
        initial, continued, upstreamRequests: snapshot.upstreamRequests.filter(r => r.method === 'tools/call'),
        effects: snapshot.effects }, resource: { initial: resourceInitial, continued: resource,
        upstreamRequests: snapshot.upstreamRequests.filter(r => r.method === 'resources/read') },
      prompt: { initial: promptInitial, continued: prompt,
        upstreamRequests: snapshot.upstreamRequests.filter(r => r.method === 'prompts/get') },
      authorized: continued, authorizedEffects: beforeDenied.effects,
      unauthorized: { resultType: deniedReason ? 'denied' : 'complete', denialCode: deniedReason ? 'authorization_required' : undefined },
      unauthorizedEffects: afterDenied.effects.slice(beforeDenied.effects.length),
      contexts: [{ principal: 'control-allowed', observedRoute: continued.structuredContent?.route },
        { principal: 'control-denied', observedRoute: deniedReason ?? 'completed' }],
      snapshot, rawWire, catalog: { tools, resources, prompts, subjects: [
        { principal: 'control-allowed', routes: ['route.demo'] },
        { principal: 'control-denied', routes: [] }
      ] },
      authority: { routes: ['route.demo'], authorized: true, approvals: [], destructiveApproved: false } },
      comparisons: {
        tool: compareBusinessPayload(continued, { resourceUri: mapping.resourceUri }),
        resource: compareResourcePayload(resource, { resourceUri: mapping.resourceUri }),
        prompt: comparePromptPayload(prompt)
      },
      probes: {
        unansweredRemainsPending: unanswered.resultType === 'input_required',
        answeredCompleted: continued.resultType === 'complete',
        replayOriginalRefused: replayOriginal.refused,
        replayAliasRefused: replayAlias.refused,
        emptyPermissionRefused: emptyPermission.refused,
        emptyApprovalRefused: emptyApproval.refused,
        effectsAfterProbes: beforeDenied.effects.length
      },
      binding: { verified: true, kind: config.candidateKind, artifactDigest: binding.digest ?? null,
        commit: binding.manifest?.commit ?? null, executedEntry: binding.entry ?? null }
    };
  } catch (error) {
    failure = cleanReason(error);
    try {
      if ((await peer?.snapshot())?.events?.some(event => event.event === 'invalid_meta')) failure = 'upstream_meta_missing_or_misplaced';
    } catch { /* The unavailable peer remains unobservable, never a protocol kill. */ }
  }
  finally {
    await Promise.allSettled([allowed?.close(), denied?.close()]);
    try { if (candidate) outcome = { ...outcome, processExit: await candidate.close() }; }
    catch { failure = failure ?? 'candidate_cleanup_failed'; }
    try { await peer?.close(); } catch { failure = failure ?? 'peer_cleanup_failed'; }
  }
  const cleanup = ledger.snapshot();
  if (failure) return { ok: false, reason: failure, cleanup, processExit: outcome?.processExit,
    binding: { verified: true, kind: config.candidateKind, artifactDigest: binding.digest ?? null,
      commit: binding.manifest?.commit ?? null } };
  return { ...outcome, cleanup };
}
