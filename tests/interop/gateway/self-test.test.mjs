import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runReferenceScenario } from './adapters/reference.mjs';
import { canonicalizeCompleteResult } from './adapters/meshrix.mjs';
import { MUTANTS } from './mutants/index.mjs';
import { evaluateMutant, evaluateObservation } from './oracles/mutations.mjs';
import { checkCandidateAuthority } from './oracles/security.mjs';
import { checkCandidateMrtrLifecycle, checkNoFalseMutationTimeout } from './oracles/lifecycle.mjs';
import { compareBusinessPayload } from './oracles/payload.mjs';
import { runSchemaVectors } from './oracles/schema.mjs';
import { classifyImportSpecifier, independentImportScan } from './run.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(ROOT, '../../..');
const NEUTRAL_CANDIDATE_CONFIG = 'tests/interop/gateway/fixtures/neutral-candidate.json';
const ABSENT_CANDIDATE_CONFIG = '/tmp/meshrix-interop-absent-candidate.json';
let reference;

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else files.push(path);
  }
  return files;
}

function runNode(args, env = {}, cwd = REPOSITORY_ROOT) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([, value]) => value !== undefined)),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function parseReport(stdout) {
  const start = stdout.indexOf('{');
  assert.notEqual(start, -1, 'runner did not emit a JSON report');
  return JSON.parse(stdout.slice(start));
}

function caseOf(report, id) {
  return report.cases.find(item => item.id === id);
}

test('standalone package and imports do not depend on Meshrix private modules', async () => {
  const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const lockJson = JSON.parse(await readFile(join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(packageJson.dependencies['@modelcontextprotocol/sdk'], '1.29.0');
  assert.equal(packageJson.dependencies.ajv, '8.20.0');
  assert.equal(lockJson.packages['node_modules/@modelcontextprotocol/sdk'].version, '1.29.0');
  assert.equal(lockJson.packages['node_modules/ajv'].version, '8.20.0');
  const files = (await listFiles(ROOT)).filter(file => file.endsWith('.mjs'));
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*(?:packages|apps|plugins)\//, file);
    assert.doesNotMatch(source, /require\(\s*['"][^'"]*(?:packages|apps|plugins)\//, file);
  }
  // The same boundary as a relation over every specifier in the tree.
  assert.deepEqual(independentImportScan(), { ok: true, reason: 'standalone_import_contract_checked' });
});

test('the import boundary rejects private imports that are not path-shaped', () => {
  const context = {
    file: join(ROOT, 'adapters/meshrix.mjs'),
    ownName: '@meshrix/gateway-interop-oracle',
    declaredDependencies: new Set(['@modelcontextprotocol/sdk', 'ajv'])
  };
  const rejected = {
    '@meshrix/gateway': 'undeclared_private_import',
    '@meshrix/contracts/subpath': 'undeclared_private_import',
    meshrix: 'undeclared_private_import',
    'meshrix-runtime': 'undeclared_private_import',
    '#meshrix/session': 'private_import_alias',
    '#imports': 'private_import_alias',
    lodash: 'undeclared_private_import',
    '../../../../packages/gateway/src/index.ts': 'import_escapes_framework',
    '../../notes/file.mjs': 'import_escapes_framework'
  };
  for (const [specifier, reason] of Object.entries(rejected)) {
    assert.equal(classifyImportSpecifier(specifier, context), reason, specifier);
  }
  for (const specifier of ['node:fs', 'ajv', 'ajv/dist/2020.js', '@modelcontextprotocol/sdk/inMemory.js', './peers/fixture.mjs', '../oracles/payload.mjs', '@meshrix/gateway-interop-oracle']) {
    assert.equal(classifyImportSpecifier(specifier, context), null, specifier);
  }
});

test('standard schema vectors are checked with the pinned 2020-12 validator', () => {
  const result = runSchemaVectors();
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.vectorCount, 14);
  assert.equal(result.instanceCount, 28);
});

test('SDK and independent wire reference peers pass the neutral good path', async () => {
  reference = await runReferenceScenario();
  assert.equal(reference.parity.ok, true, reference.parity.reason);
  assert.equal(reference.observation.tool.initial.resultType, 'input_required');
  assert.equal(reference.observation.tool.continued.resultType, 'complete');
  assert.equal(reference.observation.resource.continued.resultType, 'complete');
  assert.equal(reference.observation.prompt.continued.resultType, 'complete');
  // Negotiation is recorded per peer rather than assumed equal.
  assert.equal(reference.peerVersions.targetProfile, '2026-07-28');
  assert.equal(reference.peerVersions.wireProtocol, '2026-07-28');
  assert.equal(reference.peerVersions.sdkProtocol, '2025-11-25');
});

test('all eight bad proxies are rejected for their exact semantic reason', () => {
  assert.ok(reference, 'reference scenario was not initialized');
  const results = MUTANTS.map(mutant => evaluateMutant(reference.observation, mutant, 'upstream-observable'));
  assert.equal(results.length, 8);
  for (const result of results) {
    assert.equal(result.rejected, true, result.id);
    assert.equal(result.actualReason, result.expectedReason, result.id);
    assert.equal(result.ok, true, result.id);
  }
});

test('the adjudicator only accepts an observation that is actually intact', () => {
  assert.ok(reference, 'reference scenario was not initialized');
  const intact = structuredClone(reference.observation);
  assert.equal(evaluateObservation(intact, 'upstream-observable').ok, true);
  assert.equal(evaluateObservation(intact, 'public-entry').ok, false);

  // Negative control: if the payload oracle degenerated into "always ok", these fail.
  const droppedField = structuredClone(intact);
  delete droppedField.tool.continued.structuredContent.auditId;
  assert.equal(compareBusinessPayload(droppedField.tool.continued).reason, 'business_field_missing');
  assert.equal(evaluateObservation(droppedField, 'upstream-observable').reason, 'business_field_missing');

  const rewiredUri = structuredClone(intact);
  rewiredUri.tool.continued.content = rewiredUri.tool.continued.content.map(block => (
    block.type === 'resource' ? { ...block, resource: { ...block.resource, uri: 'fixture://artifact/wrong' } } : block
  ));
  assert.equal(compareBusinessPayload(rewiredUri.tool.continued).reason, 'resource_uri_rewritten');

  const replayed = structuredClone(intact);
  replayed.tool.effects.push(structuredClone(replayed.tool.effects[0]));
  assert.equal(evaluateObservation(replayed, 'upstream-observable').reason, 'effect_replayed');
});

test('a degenerate candidate observation is reported, never allowed to crash the runner', () => {
  for (const observation of [undefined, null, {}, { tool: {} }, { tool: { continued: undefined } }]) {
    const results = MUTANTS.map(mutant => evaluateMutant(observation, mutant, 'public-entry'));
    assert.equal(results.length, 8);
    for (const result of results) {
      assert.equal(result.ok, false, `${result.id} must not pass vacuously`);
      assert.equal(result.rejected, false, `${result.id} must not claim a rejection it cannot attribute`);
      assert.ok(
        ['observation_missing', 'observation_not_intact'].includes(result.actualReason),
        `${result.id}: ${result.actualReason}`
      );
    }
  }
  // A base observation that is present but already broken must not let a mutant claim a
  // rejection either: the benign control has to pass before a mutation means anything.
  assert.ok(reference, 'reference scenario was not initialized');
  const brokenBase = structuredClone(reference.observation);
  delete brokenBase.tool.continued.structuredContent.auditId;
  for (const mutant of MUTANTS) {
    const result = evaluateMutant(brokenBase, mutant, 'upstream-observable');
    assert.equal(result.ok, false, mutant.id);
    assert.equal(result.actualReason, 'observation_not_intact', mutant.id);
  }

  assert.equal(evaluateObservation(undefined, 'public-entry').ok, false);
  const canonical = canonicalizeCompleteResult({ resultType: 'complete' });
  assert.equal(canonical.ok, false);
  assert.equal(canonical.reason, 'complete_result_payload_missing');
});

test('a timeout, or a synthetic pass with no real round trip, is not accepted as a mutation observation', () => {
  const timeout = checkNoFalseMutationTimeout({ status: 'timeout', reason: 'request_timeout' });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.reason, 'request_timeout');

  const notRun = checkNoFalseMutationTimeout({ status: 'not_run', reason: 'slow_good_path_peer_not_configured' });
  assert.equal(notRun.ok, false);
  assert.equal(notRun.reason, 'slow_good_path_peer_not_configured');

  // Negative controls: a hand-written "pass" without measured timing, or one too fast to
  // have crossed a slow path, must not satisfy the oracle.
  assert.equal(checkNoFalseMutationTimeout({ status: 'pass', reason: 'synthetic' }).reason, 'slow_path_not_observed');
  assert.equal(
    checkNoFalseMutationTimeout({ observed: true, status: 'pass', elapsedMs: 1, minimumDelayMs: 15 }).reason,
    'slow_path_not_actually_slow'
  );
  assert.equal(checkNoFalseMutationTimeout({ observed: true, status: 'pass', elapsedMs: 17, minimumDelayMs: 15 }).ok, true);
});

test('the public-entry lifecycle and authority oracles reject tampering they are meant to catch', () => {
  assert.ok(reference, 'reference scenario was not initialized');
  const candidateObservation = {
    profile: 'public-entry',
    mrt: { stateIssued: true, statePresentedBack: true, tamperedRefused: true },
    tool: {
      initial: { resultType: 'input_required', requestState: 'issued-state-token' },
      continued: { resultType: 'complete' },
      effects: [{ operationKey: 'effect-key-1', route: 'route.demo' }]
    },
    authorized: { resultType: 'complete' },
    authorizedEffects: [{}],
    unauthorized: { resultType: 'denied', denialCode: 'authorization_required' },
    unauthorizedEffects: [],
    contexts: [{ principal: 'a', observedRoute: 'route.demo' }, { principal: 'b', observed: 'refused' }]
  };
  assert.equal(checkCandidateMrtrLifecycle(candidateObservation).ok, true);
  assert.equal(checkCandidateAuthority(candidateObservation).ok, true);

  const unenforced = structuredClone(candidateObservation);
  unenforced.mrt.tamperedRefused = false;
  assert.equal(checkCandidateMrtrLifecycle(unenforced).reason, 'continuation_state_not_enforced');

  const coerced = structuredClone(candidateObservation);
  coerced.tool.initial.resultType = 'complete';
  assert.equal(checkCandidateMrtrLifecycle(coerced).reason, 'result_type_coerced_to_complete');

  const bypassed = structuredClone(candidateObservation);
  bypassed.unauthorized = structuredClone(bypassed.authorized);
  bypassed.unauthorizedEffects = [{}];
  assert.equal(checkCandidateAuthority(bypassed).reason, 'authorization_bypassed');

  const blanketFailure = structuredClone(candidateObservation);
  blanketFailure.authorized = { resultType: 'denied' };
  assert.equal(checkCandidateAuthority(blanketFailure).reason, 'authorized_call_failed');
});

test('reference runner emits eight passing cases with measured cleanup', async () => {
  const result = await runNode(['tests/interop/gateway/run.mjs', '--mode', 'reference', '--continue-on-failure'], {
    MESHRIX_INTEROP_TRANSPORT: 'memory'
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = parseReport(result.stdout);
  assert.equal(report.totalCases, 8);
  assert.equal(report.conclusion, 'passed');
  assert.equal(report.counts.pass, 8);
  assert.equal(report.cleanup.complete, true);
  assert.equal(report.cleanup.childProcesses, 0);
  assert.equal(report.cleanup.sockets, 0);
  assert.equal(report.cleanup.temporaryDirectories, 0);
  assert.equal(report.candidate.available, false);
  assert.equal(report.control.continueOnFailure, true);
  assert.equal(report.control.skipped, 0);
  // The slow-path case carries a measured round trip, not a status literal.
  const slow = caseOf(report, 'CASE-O06');
  assert.equal(slow.observed, true);
  assert.ok(slow.elapsedMs >= slow.minimumDelayMs, JSON.stringify(slow));
  assert.doesNotMatch(JSON.stringify(report), /127\.0\.0\.1|Bearer|fixtureAuth/i);
});

test('the loopback HTTP profile really runs and reports eight real observations', async () => {
  const result = await runNode(['tests/interop/gateway/run.mjs', '--mode', 'reference', '--continue-on-failure'], {
    MESHRIX_INTEROP_TRANSPORT: 'http'
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = parseReport(result.stdout);
  assert.equal(report.conclusion, 'passed');
  assert.equal(report.counts.not_run, undefined);
  assert.equal(report.counts.pass, 8);
  // Two loopback listeners were opened and both were released: the cleanup conclusion is
  // a measurement of owned sockets, not a constant.
  assert.ok(report.cleanup.created.sockets >= 2, JSON.stringify(report.cleanup));
  assert.equal(report.cleanup.sockets, 0);
  assert.equal(report.cleanup.complete, true);
  const slow = caseOf(report, 'CASE-O06');
  assert.equal(slow.observed, true);
  assert.equal(slow.transport, 'node:http-jsonrpc');
  assert.ok(slow.elapsedMs >= slow.minimumDelayMs, JSON.stringify(slow));
  assert.doesNotMatch(JSON.stringify(report), /127\.0\.0\.1|Bearer|fixtureAuth/i);
});

test('meshrix mode resolves and really launches the in-repo default candidate', async () => {
  const result = await runNode(['tests/interop/gateway/run.mjs', '--mode', 'meshrix', '--continue-on-failure'], {
    MESHRIX_INTEROP_CONFIG: undefined
  });
  const report = parseReport(result.stdout);
  assert.equal(report.totalCases, 8);
  assert.equal(report.candidate.source, 'default-in-repo');
  assert.match(report.candidate.configPath, /tests\/interop\/gateway\/fixtures\/fix-b-candidate\.json$/);
  assert.equal(report.candidate.launched, true);
  assert.equal(report.candidate.identity?.transport, 'stdio');
  assert.match(report.candidate.identity.args.join(' '), /tests\/vitest\/gateway\/interop-candidate\.mjs/);
  // Every required case was executed against the launched candidate: no case is a
  // hard-coded not_run, and the runner itself caused none.
  assert.equal(report.counts.not_run, undefined, JSON.stringify(report.cases));
  assert.ok(report.cases.every(item => item.reason !== 'stopped_after_failure'));
  assert.equal(report.control.executed, 8);
  // The in-repo candidate now emits the plan's normative complete encoding (the flat
  // `{resultType, content, structuredContent, _meta}` skeleton), the same one the neutral
  // candidate is asserted to emit below, so a regression to a non-normative spelling
  // still fails here.
  assert.equal(report.candidate.encodings.complete, 'structured-content');
});

test('meshrix mode computes all eight cases against a launched candidate', async () => {
  const result = await runNode(['tests/interop/gateway/run.mjs', '--mode', 'meshrix', '--continue-on-failure', '--config', NEUTRAL_CANDIDATE_CONFIG], {
    MESHRIX_INTEROP_CONFIG: undefined,
    MESHRIX_INTEROP_CANDIDATE_VARIANT: undefined
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = parseReport(result.stdout);
  assert.equal(report.conclusion, 'passed');
  assert.equal(report.counts.pass, 8);
  assert.equal(report.candidate.launched, true);
  assert.equal(report.candidate.source, 'argument');
  assert.equal(report.candidate.encodings.complete, 'structured-content');
  assert.equal(report.candidate.processExit.exited, true);
  assert.equal(report.cleanup.complete, true);
  assert.equal(report.cleanup.created.childProcesses, 1);
  // The MRTR case carries a tamper observation, and the slow-path case a real round trip.
  assert.equal(caseOf(report, 'CASE-O04').mrt.tamperedRefused, true);
  assert.equal(caseOf(report, 'CASE-O06').observed, true);
  assert.doesNotMatch(JSON.stringify(report), /127\.0\.0\.1|Bearer|fixtureAuth/i);
});

test('--continue-on-failure resumes after a failure without changing case statuses', async () => {
  const broken = { MESHRIX_INTEROP_CANDIDATE_VARIANT: 'drop-business-field' };
  const halted = parseReport((await runNode(
    ['tests/interop/gateway/run.mjs', '--mode', 'meshrix', '--config', NEUTRAL_CANDIDATE_CONFIG],
    broken
  )).stdout);
  const continued = parseReport((await runNode(
    ['tests/interop/gateway/run.mjs', '--mode', 'meshrix', '--continue-on-failure', '--config', NEUTRAL_CANDIDATE_CONFIG],
    broken
  )).stdout);

  assert.equal(halted.control.continueOnFailure, false);
  assert.equal(halted.control.halted, true);
  assert.ok(halted.control.skipped > 0, JSON.stringify(halted.control));
  assert.ok(halted.cases.some(item => item.reason === 'stopped_after_failure'));

  assert.equal(continued.control.continueOnFailure, true);
  assert.equal(continued.control.halted, false);
  assert.equal(continued.control.skipped, 0);
  assert.equal(continued.control.executed, 8);
  assert.ok(continued.counts.fail > 0, 'the broken candidate must still be reported as failing');
  assert.ok(continued.counts.fail >= halted.counts.fail, 'the resumed run must discover at least as many failures');

  // The flag changes how far the run gets, never what a case means.
  for (const haltedCase of halted.cases) {
    if (haltedCase.reason === 'stopped_after_failure') continue;
    const continuedCase = caseOf(continued, haltedCase.id);
    assert.equal(continuedCase.status, haltedCase.status, haltedCase.id);
    assert.equal(continuedCase.reason, haltedCase.reason, haltedCase.id);
  }
});

test('meshrix mode reports an absent candidate as not_run and exits non-zero', async () => {
  const result = await runNode(['tests/interop/gateway/run.mjs', '--mode', 'meshrix', '--continue-on-failure'], {
    MESHRIX_INTEROP_CONFIG: ABSENT_CANDIDATE_CONFIG
  });
  assert.notEqual(result.code, 0);
  const report = parseReport(result.stdout);
  assert.equal(report.conclusion, 'incomplete');
  assert.equal(report.counts.not_run, 8);
  assert.equal(report.candidate.available, false);
  assert.equal(report.candidate.launched, false);
  assert.ok(report.cases.every(item => item.status === 'not_run'));
  assert.ok(report.cases.every(item => typeof item.reason === 'string' && item.reason.length > 0));
});
