import { writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  resolveCandidateConfig,
  runPublicCandidate
} from './adapters/meshrix.mjs';
import { createResourceLedger } from './adapters/resource-ledger.mjs';
import { runReferenceScenario } from './adapters/reference.mjs';
import { MUTANTS } from './mutants/index.mjs';
import { evaluateMutant } from './oracles/mutations.mjs';
import {
  checkCandidateMrtrLifecycle,
  checkNoFalseMutationTimeout,
  checkPromptLifecycle,
  checkResourceLifecycle,
  checkToolLifecycle
} from './oracles/lifecycle.mjs';
import { compareBusinessPayload } from './oracles/payload.mjs';
import { runSchemaVectors } from './oracles/schema.mjs';
import { checkCandidateAuthority, checkContextIsolation, checkSecurityObservation } from './oracles/security.mjs';

export const CASE_IDS = Object.freeze(['CASE-O01', 'CASE-O02', 'CASE-O03', 'CASE-O04', 'CASE-O05', 'CASE-O06', 'CASE-O07', 'CASE-O08']);

const FRAMEWORK_ROOT = dirname(fileURLToPath(import.meta.url));
const ABSENT_CANDIDATE_PATH = join(FRAMEWORK_ROOT, 'fixtures/__absent-candidate__.json');

function parseArgs(argv) {
  const args = { mode: undefined, report: undefined, config: process.env.MESHRIX_INTEROP_CONFIG, continueOnFailure: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') args.mode = argv[++index];
    else if (arg === '--report') args.report = argv[++index];
    else if (arg === '--config') args.config = argv[++index];
    else if (arg === '--continue-on-failure') args.continueOnFailure = true;
    else if (arg === '--help') args.help = true;
    else throw new Error('unknown_argument');
  }
  return args;
}

function caseResult(id, status, reason, details = {}) {
  return { id, status, reason, ...details };
}

function passed(id, reason = 'passed', details = {}) {
  return caseResult(id, 'pass', reason, details);
}

function failed(id, reason, details = {}) {
  return caseResult(id, 'fail', reason, details);
}

function notRun(id, reason) {
  return caseResult(id, 'not_run', reason);
}

function caseController(continueOnFailure) {
  return { continueOnFailure, halted: false };
}

function recordCase(cases, controller, result) {
  if (controller.halted) return;
  cases.push(result);
  if (!controller.continueOnFailure && result.status === 'fail') controller.halted = true;
}

function completeCaseSequence(cases, controller) {
  const recorded = new Set(cases.map(item => item.id));
  for (const id of CASE_IDS) {
    if (!recorded.has(id)) cases.push(notRun(id, 'stopped_after_failure'));
  }
  return cases;
}

function firstFailure(checks) {
  return checks.find(check => check && check.ok === false);
}

/**
 * Independent-import boundary, decided by import relations rather than by path spelling.
 *
 * For every module in this framework the scanner resolves what each specifier actually
 * refers to: builtins and declared pinned dependencies are allowed, the framework's own
 * package name is itself, and anything else - a private `@meshrix/*` or bare `meshrix`
 * package, a `#imports` alias, an undeclared package, a `file:` hand-off, or a relative
 * specifier that escapes this directory into `packages/`, `apps/` or `plugins/` - is a
 * boundary violation. Matching only `packages/`-shaped strings previously missed
 * `from '@meshrix/gateway'`, which is exactly the leak this boundary exists to prevent.
 */
/**
 * Decides one import specifier against the framework's boundary. Returns a violation
 * reason, or `null` when the specifier stays inside the independent tree.
 *
 * Exported so the self-test can prove the boundary rejects private imports that are not
 * path-shaped (`@meshrix/gateway`, `#meshrix/...`, a bare `meshrix` package, an
 * undeclared package, a `file:` hand-off) instead of only matching `packages/` strings.
 */
export function classifyImportSpecifier(specifier, { file, ownName, declaredDependencies }) {
  if (specifier.startsWith('node:')) return null;
  if (specifier.startsWith('#')) return 'private_import_alias';
  if (specifier.startsWith('.') || isAbsolute(specifier)) {
    const target = resolve(dirname(file), specifier);
    const inside = relative(FRAMEWORK_ROOT, target);
    return inside.startsWith('..') || isAbsolute(inside) ? 'import_escapes_framework' : null;
  }
  // A bare specifier is judged by the package it resolves into, so subpath imports of a
  // pinned dependency (`ajv/dist/2020.js`) are not mistaken for a private package.
  const packageName = packageRootOf(specifier);
  if (packageName === ownName) return null;
  if (declaredDependencies.has(packageName)) return null;
  return 'undeclared_private_import';
}

function independentImportScan() {
  const packageJson = JSON.parse(readFileSync(join(FRAMEWORK_ROOT, 'package.json'), 'utf8'));
  const declaredDependencies = new Set(Object.keys(packageJson.dependencies ?? {}));
  const ownName = packageJson.name;
  if (declaredDependencies.has('meshrix') || [...declaredDependencies].some(name => name.startsWith('@meshrix/'))) {
    return { ok: false, reason: 'private_dependency_declared' };
  }
  for (const [name, range] of Object.entries(packageJson.dependencies ?? {})) {
    if (/^(?:file|link|workspace):/.test(String(range))) {
      return { ok: false, reason: `workspace_dependency_declared:${name}` };
    }
  }

  const files = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') visit(path);
      else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(path);
    }
  };
  visit(FRAMEWORK_ROOT);

  const specifierPattern = /(?:^|[^\w$])(?:import|export)\s+(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(specifierPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) continue;
      const violation = classifyImportSpecifier(specifier, { file, ownName, declaredDependencies });
      if (violation) {
        return { ok: false, reason: `${violation}:${specifier}:${relative(FRAMEWORK_ROOT, file)}` };
      }
    }
  }
  return { ok: true, reason: 'standalone_import_contract_checked' };
}

function packageRootOf(specifier) {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return name ? `${scope}/${name}` : scope;
  }
  return specifier.split('/')[0];
}

/**
 * The missing-candidate contract, computed on a genuinely absent path: all required
 * cases must be `not_run` with a stable reason and the run must exit non-zero. CASE-O07
 * exists to stop a missing precondition from being reported as a pass.
 */
async function missingCandidateContract() {
  const resolved = await resolveCandidateConfig({ argumentPath: ABSENT_CANDIDATE_PATH });
  if (resolved.ok) return { ok: false, reason: 'absent_candidate_resolved' };
  const cases = CASE_IDS.map(id => notRun(id, resolved.reason ?? 'candidate_missing'));
  const report = buildReport('meshrix', cases, emptyCleanup(), { available: false, source: resolved.source ?? 'argument' });
  const code = exitCodeFor(report);
  if (code === 0) return { ok: false, reason: 'missing_candidate_reported_as_passing' };
  if (cases.some(item => item.status !== 'not_run')) return { ok: false, reason: 'missing_candidate_status_disguised' };
  return { ok: true, reason: 'missing_candidate_not_run_and_nonzero', exitCode: code };
}

function emptyCleanup() {
  return { complete: true, childProcesses: 0, sockets: 0, temporaryDirectories: 0, created: {} , leaks: [], notes: [] };
}

async function runReferenceCases({ continueOnFailure = false } = {}) {
  const ledger = createResourceLedger();
  let reference;
  try {
    reference = await runReferenceScenario({ ledger });
  } catch (error) {
    const reason = error?.code === 'UND_ERR_CONNECT_TIMEOUT' ? 'reference_peer_startup_failed' : 'reference_peer_execution_failed';
    return {
      cases: CASE_IDS.map(id => notRun(id, reason)),
      cleanup: ledger.snapshot(),
      peer: { wire: 'not_started' }
    };
  }

  const observation = reference.observation;
  const cases = [];
  const controller = caseController(continueOnFailure);
  const importCheck = independentImportScan();
  recordCase(cases, controller, importCheck.ok ? passed('CASE-O01', importCheck.reason) : failed('CASE-O01', importCheck.reason));

  if (!controller.halted) {
    recordCase(cases, controller, reference.parity.ok
      ? passed('CASE-O02', 'sdk_and_wire_peers_agree', { negotiation: reference.peerVersions })
      : failed('CASE-O02', reference.parity.reason));
  }

  if (!controller.halted) {
    const schema = runSchemaVectors();
    const payload = compareBusinessPayload(observation.tool.continued);
    const schemaPayloadFailure = firstFailure([schema, payload]);
    recordCase(cases, controller, schemaPayloadFailure
      ? failed('CASE-O03', schemaPayloadFailure.reason, { vectors: schema.vectorCount, instances: schema.instanceCount })
      : passed('CASE-O03', 'schema_and_business_payload_preserved', { vectors: schema.vectorCount, instances: schema.instanceCount }));
  }

  if (!controller.halted) {
    const lifecycleChecks = [
      checkToolLifecycle(observation),
      checkResourceLifecycle(observation.resource),
      checkPromptLifecycle(observation.prompt),
      checkSecurityObservation(observation),
      checkContextIsolation(observation)
    ];
    const lifecycleFailure = firstFailure(lifecycleChecks);
    recordCase(cases, controller, lifecycleFailure ? failed('CASE-O04', lifecycleFailure.reason) : passed('CASE-O04', 'lifecycle_state_and_authority_observed'));
  }

  if (!controller.halted) {
    const mutantResults = MUTANTS.map(mutant => evaluateMutant(observation, mutant, 'upstream-observable'));
    const mutantFailure = mutantResults.find(result => !result.ok);
    recordCase(cases, controller, mutantFailure
      ? failed('CASE-O05', `mutant_not_rejected:${mutantFailure.id}`, { rejected: mutantResults.filter(result => result.rejected).length })
      : passed('CASE-O05', 'all_eight_mutants_rejected', { rejected: mutantResults.length }));
  }

  if (!controller.halted) {
    const slowCheck = checkNoFalseMutationTimeout(reference.slowGoodPath);
    recordCase(cases, controller, slowCheck.ok
      ? passed('CASE-O06', 'slow_good_path_observed', reference.slowGoodPath)
      : failed('CASE-O06', slowCheck.reason, reference.slowGoodPath));
  }
  if (!controller.halted) {
    const contract = await missingCandidateContract();
    recordCase(cases, controller, contract.ok
      ? passed('CASE-O07', contract.reason, { exitCode: contract.exitCode })
      : failed('CASE-O07', contract.reason));
  }
  if (!controller.halted) recordCase(cases, controller, reference.cleanup?.complete
    ? passed('CASE-O08', 'reference_resources_cleaned', reference.cleanup)
    : failed('CASE-O08', 'reference_cleanup_incomplete', reference.cleanup));
  completeCaseSequence(cases, controller);
  return { cases, cleanup: reference.cleanup, peer: reference.peerVersions, controller };
}

async function runMeshrixCases({ configPath, continueOnFailure = false } = {}) {
  const resolved = await resolveCandidateConfig({ argumentPath: configPath });
  if (!resolved.ok) {
    return {
      cases: CASE_IDS.map(id => notRun(id, resolved.reason)),
      cleanup: emptyCleanup(),
      candidate: { available: false, source: resolved.source ?? 'configuration', launched: false, configPath: resolved.path ?? null }
    };
  }

  const ledger = createResourceLedger();
  const candidate = await runPublicCandidate(resolved.config, { ledger });
  const candidateRecord = {
    available: candidate.ok === true,
    source: resolved.source,
    launched: true,
    configPath: resolved.path,
    identity: candidate.identity ?? null,
    encodings: candidate.encodings ?? { complete: 'unrecognized' },
    processExit: candidate.processExit ?? null,
    commit: resolved.config.candidateCommit ?? process.env.MESHRIX_CANDIDATE_COMMIT ?? null,
    artifactDigest: resolved.config.artifactDigest ?? process.env.MESHRIX_CANDIDATE_DIGEST ?? null
  };

  if (!candidate.ok) {
    // The candidate never handed over a usable session: that is the declared not_run
    // condition, reported with a reason derived from what was actually observed.
    return {
      cases: CASE_IDS.map(id => notRun(id, candidate.notRunReason ?? candidate.reason ?? 'candidate_case_not_run')),
      cleanup: ledger.snapshot(),
      candidate: candidateRecord
    };
  }

  const observation = candidate.observation;
  const cases = [];
  const controller = caseController(continueOnFailure);
  const importCheck = independentImportScan();
  recordCase(cases, controller, importCheck.ok ? passed('CASE-O01', importCheck.reason) : failed('CASE-O01', importCheck.reason));

  if (!controller.halted) {
    const protocolOk = candidate.initialize?.protocolVersion === '2026-07-28'
      && Array.isArray(candidate.catalog?.tools?.tools)
      && candidate.catalog.tools.tools.length > 0
      && typeof candidate.catalog.tools.tools[0]?.name === 'string';
    recordCase(cases, controller, protocolOk
      ? passed('CASE-O02', 'candidate_protocol_and_catalog_observed', {
        protocolVersion: candidate.initialize?.protocolVersion,
        tools: candidate.catalog?.tools?.tools?.length ?? 0,
        resources: candidate.catalog?.resources?.resources?.length ?? 0,
        prompts: candidate.catalog?.prompts?.prompts?.length ?? 0,
        completeEncoding: candidateRecord.encodings.complete
      })
      : failed('CASE-O02', 'candidate_protocol_or_catalog_invalid', {
        protocolVersion: candidate.initialize?.protocolVersion ?? null
      }));
  }

  if (!controller.halted) {
    const schema = runSchemaVectors();
    const payload = compareBusinessPayload(observation?.tool?.continued);
    const schemaPayloadFailure = firstFailure([schema, payload]);
    recordCase(cases, controller, schemaPayloadFailure
      ? failed('CASE-O03', schemaPayloadFailure.reason, { vectors: schema.vectorCount, instances: schema.instanceCount })
      : passed('CASE-O03', 'candidate_schema_and_payload_preserved', {
        vectors: schema.vectorCount,
        instances: schema.instanceCount,
        completeEncoding: candidateRecord.encodings.complete
      }));
  }

  if (!controller.halted) {
    // A candidate reached only through its public entry cannot expose its internal
    // upstream requests, so the asserted properties are the ones observable from
    // outside: state issued and enforced, refusal on a tampered token, refusal without an
    // effect under a revoked context, and separated contexts.
    const lifecycleChecks = [
      checkCandidateMrtrLifecycle(observation),
      checkCandidateAuthority(observation),
      checkContextIsolation(observation)
    ];
    const lifecycleFailure = firstFailure(lifecycleChecks);
    recordCase(cases, controller, lifecycleFailure
      ? failed('CASE-O04', lifecycleFailure.reason, { mrt: observation?.mrt })
      : passed('CASE-O04', 'candidate_mrt_state_and_authority_observed', { mrt: observation?.mrt }));
  }

  if (!controller.halted) {
    const mutantResults = MUTANTS.map(mutant => evaluateMutant(observation, mutant, 'public-entry'));
    const mutantFailure = mutantResults.find(result => !result.ok);
    recordCase(cases, controller, mutantFailure
      ? failed('CASE-O05', `mutant_not_rejected:${mutantFailure.id}`, { rejected: mutantResults.filter(result => result.rejected).length })
      : passed('CASE-O05', 'candidate_mutation_profile_rejected', { rejected: mutantResults.length }));
  }

  if (!controller.halted) {
    const slowCheck = checkNoFalseMutationTimeout(candidate.slowGoodPath);
    recordCase(cases, controller, slowCheck.ok
      ? passed('CASE-O06', 'candidate_slow_good_path_observed', candidate.slowGoodPath)
      : failed('CASE-O06', slowCheck.reason, candidate.slowGoodPath));
  }

  if (!controller.halted) {
    const contract = await missingCandidateContract();
    const identityOk = Boolean(candidateRecord.identity?.command || candidateRecord.identity?.transport);
    recordCase(cases, controller, identityOk && contract.ok
      ? passed('CASE-O07', 'candidate_identity_recorded_and_missing_candidate_contract_honored', {
        identity: candidateRecord.identity,
        source: candidateRecord.source
      })
      : failed('CASE-O07', identityOk ? contract.reason : 'candidate_identity_missing'));
  }

  if (!controller.halted) {
    const cleanup = ledger.snapshot();
    const processSettled = candidateRecord.processExit?.exited === true || candidateRecord.processExit?.notApplicable === true;
    const clean = cleanup.complete && processSettled;
    recordCase(cases, controller, clean
      ? passed('CASE-O08', 'candidate_resources_cleaned', cleanup)
      : failed('CASE-O08', cleanup.complete ? 'candidate_process_not_reaped' : 'candidate_cleanup_incomplete', cleanup));
  }

  completeCaseSequence(cases, controller);
  return { cases, cleanup: ledger.snapshot(), candidate: candidateRecord, controller };
}

function buildReport(mode, cases, cleanup, candidate = {}, peerVersions = {}, controller = null) {
  const counts = cases.reduce((result, item) => {
    result[item.status] = (result[item.status] ?? 0) + 1;
    return result;
  }, {});
  return {
    schema: 'meshrix.gateway.interop-report/v1',
    mode,
    profile: mode === 'reference' ? 'reference-neutral' : 'meshrix-public-entry',
    seed: 'gateway-interop-neutral-seed-20260917',
    specification: { protocol: '2026-07-28', schemaDialect: '2020-12' },
    peer: {
      sdk: peerVersions.sdk ?? '@modelcontextprotocol/sdk@1.29.0',
      wire: peerVersions.wire ?? (mode === 'reference' ? 'not_started' : 'candidate-public-entry'),
      validator: 'ajv@8.20.0/draft-2020-12'
    },
    candidate: {
      available: candidate.available ?? (mode === 'reference' ? false : undefined),
      source: candidate.source ?? (mode === 'reference' ? 'none' : 'configuration'),
      launched: candidate.launched ?? false,
      identity: candidate.identity ?? null,
      encodings: candidate.encodings ?? null,
      processExit: candidate.processExit ?? null,
      configPath: candidate.configPath ?? null,
      commit: candidate.commit ?? process.env.MESHRIX_CANDIDATE_COMMIT ?? null,
      artifactDigest: candidate.artifactDigest ?? process.env.MESHRIX_CANDIDATE_DIGEST ?? null
    },
    totalCases: cases.length,
    cases,
    counts,
    cleanup,
    control: {
      continueOnFailure: controller?.continueOnFailure ?? false,
      halted: controller?.halted ?? false,
      executed: cases.filter(item => item.reason !== 'stopped_after_failure').length,
      skipped: cases.filter(item => item.reason === 'stopped_after_failure').length
    },
    conclusion: counts.fail || counts.not_run ? 'incomplete' : 'passed'
  };
}

export function exitCodeFor(report) {
  if (report.conclusion === 'passed') return 0;
  return report.counts?.not_run ? 2 : 1;
}

export async function execute(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) return { code: 0, report: { usage: 'node run.mjs --mode reference|meshrix --continue-on-failure' } };
  if (!['reference', 'meshrix'].includes(options.mode)) {
    return { code: 2, report: { schema: 'meshrix.gateway.interop-report/v1', error: 'mode_required' } };
  }
  const result = options.mode === 'reference'
    ? await runReferenceCases({ continueOnFailure: options.continueOnFailure })
    : await runMeshrixCases({ configPath: options.config, continueOnFailure: options.continueOnFailure });
  const report = buildReport(options.mode, result.cases, result.cleanup, result.candidate, result.peer, result.controller);
  report.control.continueOnFailure = options.continueOnFailure;
  const code = exitCodeFor(report);
  if (options.report) await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { code, report };
}

async function main() {
  try {
    const result = await execute();
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    process.exitCode = result.code;
  } catch (error) {
    const report = buildReport('unknown', CASE_IDS.map(id => notRun(id, 'runner_failed')), emptyCleanup());
    process.stderr.write(`${error instanceof Error ? error.name : 'runner_error'}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

export { independentImportScan, resolveCandidateConfig };
