import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runReferenceScenario } from './adapters/reference.mjs';
import { createResourceLedger } from './adapters/resource-ledger.mjs';
import { startProcessPeer } from './peers/process-peer.mjs';
import { createHttpClient } from './peers/http-client.mjs';
import { MUTANTS } from './mutants/index.mjs';
import { evaluateMutant, evaluateObservation } from './oracles/mutations.mjs';
import { validateRawWire } from './oracles/raw-wire.mjs';
import { classifyImportSpecifier, execute, independentImportScan } from './run.mjs';

const ROOT = fileURLToPath(new URL('./', import.meta.url));
const CONFIG = join(ROOT, 'fixtures/neutral-http-candidate.json');
const RUNNER = join(ROOT, 'run.mjs');
const REFERENCE = { candidateKind: 'reference-fixture', command: process.execPath,
  args: [join(ROOT, 'fixtures/neutral-http-candidate.mjs')] };
const variants = new Map([
  ['encoding-alias-replay', 'continuation_replay_accepted'],
  ['empty-permission-bypass', 'empty_permission_granted'],
  ['empty-approval-bypass', 'empty_approval_granted'],
  ['drop-answer', 'input_responses_changed'],
  ['misplaced-meta', 'upstream_meta_missing_or_misplaced'],
  ['value-resource', 'resource_result_shape_invalid'],
  ['unknown-extension', 'result_type_missing_or_invalid'],
  ['drop-output-schema', 'output_schema_missing'],
  ['missing-meta', 'unprefixed_metadata_missing'],
  ['drop-business-field', 'business_field_missing']
]);

function runProcess(config, { variant, report } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, '--mode', 'meshrix', '--config', config,
      '--continue-on-failure', ...(report ? ['--report', report] : [])], {
      env: { ...process.env, ...(variant ? { MESHRIX_INTEROP_CANDIDATE_VARIANT: variant }
        : { MESHRIX_INTEROP_CANDIDATE_VARIANT: '' }) }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', () => {}); // Never persist process stderr or private payloads.
    child.once('error', reject);
    child.once('exit', code => {
      try { resolve({ code, report: JSON.parse(stdout) }); }
      catch { reject(new Error('runner_report_unavailable')); }
    });
  });
}

async function temporaryConfig(config, work) {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-oracle-test-'));
  try {
    const path = join(directory, 'candidate.json');
    await writeFile(path, JSON.stringify(config));
    return await work(path, directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function assertSafeReport(report) {
  assert.doesNotMatch(JSON.stringify(report), /127\.0\.0\.1|Bearer |\/Users\/|\/home\/|inputResponses|nonce|interop-fixture-allow/);
  assert.equal(report.cleanup.complete, true, JSON.stringify(report.cleanup));
  assert.equal(report.cleanup.childProcesses, 0);
  assert.equal(report.cleanup.sockets, 0);
  assert.equal(report.cleanup.temporaryDirectories, 0);
}

let reference;
test('independent lock and source boundary reject private imports and checkout escape', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/@modelcontextprotocol/sdk'].version, pkg.dependencies['@modelcontextprotocol/sdk']);
  assert.equal(lock.packages['node_modules/ajv'].version, pkg.dependencies.ajv);
  assert.equal(independentImportScan().ok, true);
  const context = { file: RUNNER, ownName: pkg.name, declaredDependencies: new Set(Object.keys(pkg.dependencies)) };
  for (const specifier of ['@meshrix/gateway', 'meshrix', '#imports', '../../../packages/gateway/src/index.ts', 'file:../../private.js']) {
    assert.notEqual(classifyImportSpecifier(specifier, context), null, specifier);
  }
});

test('GC-066/067: separate SDK and process wire peer pass dynamic challenge and observed ledger', async () => {
  reference = await runReferenceScenario({ ledger: createResourceLedger() });
  assert.equal(reference.parity.ok, true);
  assert.equal(reference.peerVersions.sdkProtocol, '2025-11-25');
  assert.equal(reference.peerVersions.wireProtocol, '2026-07-28');
  assert.equal(reference.observation.tool.continued.resultType, 'complete');
  const nonce = reference.observation.tool.initial.inputRequests['confirm-name'].params.message.split(': ').at(-1);
  assert.match(nonce, /^[0-9a-f]{32}$/);
  const token = reference.observation.tool.initial.requestState;
  const padded = `${token}${'='.repeat((4 - token.length % 4) % 4)}`;
  assert.notEqual(token, padded);
  assert.equal(Buffer.from(token, 'base64url').toString('hex'), Buffer.from(padded, 'base64url').toString('hex'));
  const transmitted = reference.observation.tool.upstreamRequests.find(item => item.inputResponses?.['confirm-name']);
  assert.equal(transmitted.inputResponses['confirm-name'].content.nonce, nonce);
  assert.equal(reference.observation.snapshot.effects.length, 1);
  assert.equal(reference.observation.snapshot.events.filter(item => item.event === 'initialize').length, 0,
    'modern peer must not accept initialize');
  assert.ok(reference.observation.snapshot.events.some(item => item.event === 'discover'));
  assert.ok(reference.observation.rawWire.some(item => item.method === 'server/discover'));
  assert.equal(reference.cleanup.created.childProcesses, 1);
  assert.equal(reference.cleanup.created.sockets, 1);
  assert.equal(reference.cleanup.complete, true);
  assert.equal(evaluateObservation(reference.observation, 'upstream-observable').ok, true);
});

test('GC-069: malformed raw envelopes are rejected before any candidate canonicalization', () => {
  const raw = reference.observation.rawWire.find(frame => frame.method === 'resources/read' && frame.response.result.resultType === 'complete');
  assert.equal(validateRawWire(raw.response, raw.id, raw.method).ok, true);
  assert.equal(validateRawWire({ ...raw.response, result: { resultType: 'complete', value: raw.response.result } }, raw.id, raw.method).reason,
    'resource_result_shape_invalid');
  assert.equal(validateRawWire({ ...raw.response, result: { ...raw.response.result, resultType: undefined } }, raw.id, raw.method).reason,
    'result_type_missing_or_invalid');
  assert.equal(validateRawWire(raw.response, raw.id + 1, raw.method).reason, 'jsonrpc_envelope_invalid');
});

test('declared older versions negotiate separately without claiming modern SDK coverage', async () => {
  await Promise.all(['2025-03-26', '2025-06-18', '2025-11-25'].map(async version => {
    const ledger = createResourceLedger();
    const peer = await startProcessPeer(ledger, version);
    const client = createHttpClient(peer.endpoint, { protocolVersion: version });
    try {
      assert.equal((await client.initialize()).protocolVersion, version);
      assert.equal((await client.request('tools/list')).tools[0].name, 'route.demo');
    } finally {
      await client.close();
      await peer.close();
    }
    assert.equal(ledger.snapshot().complete, true);
    assert.equal(ledger.snapshot().created.childProcesses, 1);
  }));
});

test('GC-070/071/072: original eight and new semantic mutants die for exact named assertions', () => {
  assert.equal(MUTANTS.length, 18);
  for (const mutant of MUTANTS) {
    const adjudicated = evaluateMutant(reference.observation, mutant, 'upstream-observable');
    assert.equal(adjudicated.actualReason, mutant.expectedReason, mutant.id);
    assert.equal(adjudicated.ok, true, mutant.id);
  }
  // This deliberately bad adjudicator must NOT be counted as killing the mutation.
  const missed = evaluateMutant(reference.observation, MUTANTS[0], 'upstream-observable', () => ({ ok: true }));
  assert.equal(missed.ok, false);
  assert.equal(missed.rejected, false);
  const broken = structuredClone(reference.observation);
  delete broken.tool.continued.structuredContent.auditId;
  assert.equal(evaluateMutant(broken, MUTANTS[0], 'upstream-observable').actualReason, 'observation_not_intact');
  assert.equal(evaluateMutant(undefined, MUTANTS[0], 'upstream-observable').actualReason, 'observation_missing');
});

test('GC-068/073: explicit framework HTTP command uses child peer, network, ledger and measured cleanup', async () => {
  const { code, report } = await runProcess(CONFIG);
  assert.equal(code, 0, JSON.stringify(report.cases));
  assert.equal(report.counts.pass, 8);
  assert.equal(report.gc068.status, 'not_run', 'fixture success is not product integration');
  assert.equal(report.productIntegration, 'not_run');
  assert.equal(report.candidate.kind, 'reference-fixture');
  assert.equal(report.cleanup.created.childProcesses, 2);
  assertSafeReport(report);
});

test('GC-069: declared public URI remaps only protocol positions, not business payload', async () => {
  await temporaryConfig({ ...REFERENCE, publicMapping: { resourceUri: 'fixture://gateway/public-artifact' } }, async path => {
    const mapped = await runProcess(path, { variant: 'public-uri-map' });
    assert.equal(mapped.code, 0, JSON.stringify(mapped.report.cases));
    assertSafeReport(mapped.report);
  });
  const undeclared = await runProcess(CONFIG, { variant: 'public-uri-map' });
  assert.equal(undeclared.code, 1);
  assert.ok(undeclared.report.cases.some(item => item.reason === 'resource_uri_rewritten'));
});

test('GC-071/072: each network bad proxy has a named semantic failure, not a timeout or crash', async () => {
  const results = await Promise.all([...variants].map(async ([variant, expected]) => ({
    variant, expected, ...(await runProcess(CONFIG, { variant }))
  })));
  for (const { variant, expected, code, report } of results) {
    assert.equal(code, 1, `${variant}: ${JSON.stringify(report.cases)}`);
    assert.ok(report.cases.some(item => item.status === 'fail' && item.reason === expected), `${variant}: ${JSON.stringify(report.cases)}`);
    assert.equal(report.gc068.status, 'not_run');
    assertSafeReport(report);
  }
});

test('GC-073: no candidate, process exit and unreachable endpoint never count as mutation kills', async () => {
  const absent = await execute(['--mode', 'meshrix', '--continue-on-failure']);
  assert.equal(absent.code, 2);
  assert.equal(absent.report.counts.not_run, 8);
  assert.equal(absent.report.candidate.launched, false);
  await temporaryConfig({ ...REFERENCE, args: ['-e', 'process.exit(7)'] }, async path => {
    const stopped = await runProcess(path);
    assert.notEqual(stopped.code, 0);
    assert.equal(stopped.report.cases.find(item => item.gc === 'GC-070').status, 'not_run');
    assertSafeReport(stopped.report);
  });
  await temporaryConfig({ candidateKind: 'reference-fixture', endpoint: 'http://127.0.0.1:9/mcp', requestTimeoutMs: 500 }, async path => {
    const endpoint = await runProcess(path);
    assert.notEqual(endpoint.code, 0);
    assert.equal(endpoint.report.counts.not_run, 8);
    assertSafeReport(endpoint.report);
  });
  await temporaryConfig({ ...REFERENCE, requestTimeoutMs: 200 }, async path => {
    const stalled = await runProcess(path, { variant: 'stall' });
    assert.equal(stalled.code, 2);
    assert.ok(stalled.report.counts.not_run >= 7);
    assert.equal(stalled.report.cases.find(item => item.gc === 'GC-070').status, 'not_run');
    assertSafeReport(stalled.report);
  });
});

test('GC-073: an HTTP success from a peer outside the owned effect ledger stays unobservable', async () => {
  const foreignLedger = createResourceLedger();
  const foreign = await startProcessPeer(foreignLedger);
  try {
    await temporaryConfig({ candidateKind: 'reference-fixture', endpoint: foreign.endpoint }, async path => {
      const observed = await runProcess(path);
      assert.equal(observed.code, 2, JSON.stringify(observed.report.cases));
      assert.ok(observed.report.cases.every(item => item.status === 'not_run'));
      assert.ok(observed.report.cases.every(item => item.reason === 'effect_unobservable'));
      assertSafeReport(observed.report);
    });
    const snapshot = await foreign.snapshot();
    assert.ok(snapshot.effects.length >= 1, 'foreign peer really saw the effect');
  } finally { await foreign.close(); }
  assert.equal(foreignLedger.snapshot().complete, true);
});

test('GC-068: packed manifest cannot bind checkout fixture or forged digest', async () => {
  const script = join(ROOT, 'fixtures/neutral-http-candidate.mjs');
  const sha256 = createHash('sha256').update(await readFile(script)).digest('hex');
  await temporaryConfig({}, async (unused, directory) => {
    const manifest = join(directory, 'manifest.json');
    const config = join(directory, 'candidate.json');
    const base = { schema: 'meshrix.gateway-candidate-manifest/v1', candidateKind: 'standalone-packed-http',
      commit: 'synthetic-revision', serverInfo: { name: 'neutral-wire-peer', version: '1.0.0' },
      artifacts: [{ path: script, sha256 }] };
    await writeFile(manifest, JSON.stringify(base));
    await writeFile(config, JSON.stringify({ candidateKind: base.candidateKind, command: process.execPath,
      args: [script], manifest }));
    let run = await runProcess(config);
    assert.equal(run.code, 2);
    assert.equal(run.report.cases[0].reason, 'framework_fixture_not_product_artifact');
    await writeFile(manifest, JSON.stringify({ ...base, artifacts: [{ path: script, sha256: '0'.repeat(64) }] }));
    run = await runProcess(config);
    assert.equal(run.code, 1);
    assert.ok(run.report.cases.some(item => item.reason === 'candidate_artifact_digest_mismatch'));
  });
});

test('GC-073: two simultaneous runs keep reports and process ledgers isolated', async () => {
  await temporaryConfig(REFERENCE, async (config, directory) => {
    const goodFile = join(directory, 'good.json');
    const badFile = join(directory, 'bad.json');
    const [good, bad] = await Promise.all([
      runProcess(config, { report: goodFile }),
      runProcess(config, { report: badFile, variant: 'drop-business-field' })
    ]);
    assert.equal(good.code, 0);
    assert.equal(bad.code, 1);
    assert.equal(good.report.counts.pass, 8);
    assert.ok(bad.report.cases.some(item => item.reason === 'business_field_missing'));
    assert.deepEqual(JSON.parse(await readFile(goodFile, 'utf8')), good.report);
    assert.deepEqual(JSON.parse(await readFile(badFile, 'utf8')), bad.report);
    assert.notDeepEqual(good.report.cases, bad.report.cases);
    assertSafeReport(good.report);
    assertSafeReport(bad.report);
  });
});
