import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHttpClient } from '../peers/http-client.mjs';
import { FIXTURE_AUTH_ALLOW, TARGET_PROTOCOL_VERSION } from '../peers/fixture.mjs';

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
/** `tests/interop/gateway/adapters` -> repository root. */
export const REPOSITORY_ROOT = resolve(MODULE_DIRECTORY, '../../../..');

/**
 * In-repo default candidate. The plan's frozen full-regression command
 * (`node tests/interop/gateway/run.mjs --mode meshrix --continue-on-failure`) carries no
 * `--config` and the environment supplies no `MESHRIX_INTEROP_CONFIG`, so the runner
 * itself must resolve a candidate. This is the frozen cross-Task entry owned by TASK-001;
 * the framework only reads and launches it.
 */
export const DEFAULT_CANDIDATE_CONFIG_PATH = join(REPOSITORY_ROOT, 'tests/interop/gateway/fixtures/fix-b-candidate.json');

/** Authorization convention the neutral client declares to a candidate. */
export const INTEROP_AUTHORIZATION_META = 'interop-authorization';

const RESERVED_COMPLETE_KEYS = new Set(['content', 'structuredContent', '_meta', 'isError', 'resultType', 'requestState', 'value']);

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the candidate to launch without ever inventing one:
 * explicit `--config` argument, then `MESHRIX_INTEROP_CONFIG`, then the in-repo default.
 * The returned `source` is recorded in the report so a reader can tell which candidate a
 * run actually used.
 */
export async function resolveCandidateConfig({ argumentPath, environmentPath } = {}) {
  const explicit = argumentPath ?? environmentPath;
  const source = argumentPath ? 'argument' : environmentPath ? 'environment' : 'default-in-repo';
  const path = explicit ?? DEFAULT_CANDIDATE_CONFIG_PATH;
  if (!explicit && !(await fileExists(path))) {
    return { ok: false, reason: 'default_candidate_config_missing', source, path };
  }
  const loaded = await readCandidateConfig(path);
  if (!loaded.ok) return { ...loaded, source, path };
  return { ok: true, config: normalizeCandidateConfig(loaded.config), source, path };
}

export async function readCandidateConfig(configPath) {
  if (!configPath) return { ok: false, reason: 'candidate_config_missing' };
  try {
    const raw = await readFile(configPath, 'utf8');
    const config = JSON.parse(raw);
    const validation = validateCandidateConfig(config);
    return validation.ok ? { ok: true, config } : validation;
  } catch (error) {
    return { ok: false, reason: error instanceof SyntaxError ? 'candidate_config_invalid_json' : 'candidate_config_unreadable' };
  }
}

export function validateCandidateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { ok: false, reason: 'candidate_config_not_object' };
  const hasEndpoint = typeof config.endpoint === 'string' && /^https?:\/\//.test(config.endpoint);
  const hasCommand = typeof config.command === 'string' && config.command.length > 0;
  if (!hasEndpoint && !hasCommand) return { ok: false, reason: 'candidate_endpoint_missing' };
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== 'string'))) {
    return { ok: false, reason: 'candidate_args_invalid' };
  }
  if (config.cwd !== undefined && (typeof config.cwd !== 'string' || config.cwd.length === 0)) {
    return { ok: false, reason: 'candidate_cwd_invalid' };
  }
  return { ok: true };
}

/**
 * Relative `cwd` values in a candidate config are written relative to the repository
 * root (that is where the frozen command runs), not relative to whatever directory the
 * caller happened to invoke node from.
 */
function normalizeCandidateConfig(config) {
  if (typeof config.cwd !== 'string' || isAbsolute(config.cwd)) return config;
  return { ...config, cwd: resolve(REPOSITORY_ROOT, config.cwd) };
}

/**
 * A candidate is reached only through its public entry: a process on stdio, or an HTTP
 * endpoint. The framework never imports candidate internals, so anything the candidate
 * does behind that entry is unobservable and is marked as such rather than synthesized.
 */
function omitReservedKeys(value) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !RESERVED_COMPLETE_KEYS.has(key)));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Canonicalizes a candidate's `complete` result into the framework's flat result model
 * (`{resultType, content, structuredContent, _meta}`).
 *
 * The plan's normative wire skeleton (`docs/plans/.../fixtures/mrtr-wire-sequence.json`)
 * spells a complete result flat with `structuredContent`. A candidate may instead nest
 * the tool result under `value`; that is recorded as `encoding:'value'` in the
 * observation and surfaced in the report, so the deviation stays visible instead of
 * being silently normalized away. Business-field fidelity is still asserted on the real
 * observed payload.
 */
export function canonicalizeCompleteResult(result) {
  if (!isPlainObject(result) || result.resultType !== 'complete') {
    return { ok: false, reason: 'complete_result_missing', encoding: 'unrecognized' };
  }
  if (isPlainObject(result.structuredContent)) {
    return {
      ok: true,
      encoding: 'structured-content',
      result: {
        resultType: 'complete',
        ...(result.content === undefined ? {} : { content: result.content }),
        structuredContent: result.structuredContent,
        ...(result._meta === undefined ? {} : { _meta: result._meta }),
        ...(result.isError === undefined ? {} : { isError: result.isError })
      }
    };
  }
  if (isPlainObject(result.value)) {
    const inner = result.value;
    const structuredContent = isPlainObject(inner.structuredContent) ? inner.structuredContent : omitReservedKeys(inner);
    if (inner.content === undefined && Object.keys(structuredContent).length === 0) {
      return { ok: false, reason: 'complete_result_payload_missing', encoding: 'value' };
    }
    return {
      ok: true,
      encoding: 'value',
      result: {
        resultType: 'complete',
        ...(inner.content === undefined ? {} : { content: inner.content }),
        structuredContent,
        ...(inner._meta === undefined ? {} : { _meta: inner._meta }),
        ...(inner.isError === undefined ? {} : { isError: inner.isError })
      }
    };
  }
  return { ok: false, reason: 'complete_result_payload_missing', encoding: 'unrecognized' };
}

/** Canonicalizes an `input_required` result. Both encodings spell this one flat. */
export function canonicalizeInputRequiredResult(result) {
  if (!isPlainObject(result) || result.resultType !== 'input_required') {
    return { ok: false, reason: 'input_required_result_missing' };
  }
  return {
    ok: true,
    result: {
      resultType: 'input_required',
      ...(result.inputRequests === undefined ? {} : { inputRequests: result.inputRequests }),
      ...(result.requestState === undefined ? {} : { requestState: result.requestState })
    },
    hasRequestState: typeof result.requestState === 'string' && result.requestState.length > 0
  };
}

/**
 * Classifies a refusal into a stable code taken from the observed error, never from a
 * free-form message and never from a hard-coded expectation about a particular product.
 */
export function classifyRefusal(error) {
  if (!error) return 'request_failed';
  const dataCode = error.data?.code;
  if (typeof dataCode === 'string' && dataCode.length > 0) return dataCode;
  if (typeof error.code === 'number') return `jsonrpc_error_${error.code}`;
  if (typeof error.code === 'string' && error.code.length > 0) return error.code;
  return 'request_failed';
}

function createStdioClient(command, args, {
  cwd = REPOSITORY_ROOT,
  requestTimeoutMs = 5000,
  ledger,
  label = 'candidate'
} = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, MESHRIX_INTEROP_CANDIDATE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false
  });
  const releaseChild = ledger?.trackChild(child.pid, { label, handle: child });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  let stderrBytes = 0;
  let exitCode;
  let exitResolve;
  const exited = new Promise(resolve => { exitResolve = resolve; });

  const rejectPending = error => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  // Only the byte count is retained: candidate stderr can carry business data and must
  // not reach the persisted report.
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
  child.on('error', error => {
    closed = true;
    rejectPending(error);
    exitResolve({ code: null, error });
  });
  child.on('close', code => {
    exitCode = code;
    closed = true;
    releaseChild?.();
    rejectPending(Object.assign(new Error('candidate_process_exited'), { code }));
    exitResolve({ code });
  });
  lines.on('line', line => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      rejectPending(new Error('candidate_invalid_json_line'));
      return;
    }
    const request = pending.get(message?.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) {
      request.reject(Object.assign(new Error('candidate_jsonrpc_error'), {
        code: message.error.code,
        data: message.error.data
      }));
      return;
    }
    request.resolve(message);
  });

  function send(message) {
    if (closed || child.stdin.destroyed) throw new Error('candidate_process_closed');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async function request(method, params = {}) {
    if (closed) throw new Error('candidate_process_closed');
    const id = nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    send(message);
    let timer;
    try {
      const returned = await Promise.race([
        response,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`candidate_request_timeout:${method}`)), requestTimeoutMs);
        })
      ]);
      if (returned?.result === undefined) {
        throw Object.assign(new Error(`${method}_missing_result`), { code: -32000, data: returned?.error?.data });
      }
      return returned.result;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }

  async function initialize(protocolVersion) {
    const result = await request('initialize', {
      protocolVersion,
      capabilities: { elicitation: { form: {} } },
      clientInfo: { name: 'neutral-stdio-client', version: '1.0.0' }
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return result;
  }

  async function close() {
    if (closed) return { exited: exitCode !== undefined, exitCode };
    closed = true;
    let outcome = { exited: false, exitCode: undefined };
    try {
      child.stdin.end();
      outcome = await Promise.race([
        exited.then(result => ({ ...result, exited: true })),
        new Promise(resolve => setTimeout(() => resolve({ exited: false, exitCode: undefined, timedOut: true }), requestTimeoutMs))
      ]);
    } finally {
      // A candidate that only stopped because it was killed is a leaked child, not a
      // clean shutdown, so the kill is recorded rather than folded into `exited`.
      if (!outcome.exited && child.exitCode === null) {
        child.kill();
        outcome = { ...outcome, killed: true };
      }
      lines.close();
      if (outcome.exited) releaseChild?.();
    }
    return outcome;
  }

  return {
    protocolVersion: TARGET_PROTOCOL_VERSION,
    initialize,
    request,
    close,
    identity: { transport: 'stdio', command, args: [...args], cwd },
    get stderrBytes() { return stderrBytes; },
    get exitCode() { return exitCode; }
  };
}

function safeRequest(client, method, params) {
  return client.request(method, params).then(
    result => ({ ok: true, result }),
    error => ({ ok: false, refusalCode: classifyRefusal(error), refusalData: error?.data ?? null })
  );
}

function toolCallParams({ name, operationKey, requestState, authorization, slowPath }) {
  return {
    name,
    arguments: { objective: 'prepare artifact', operationKey, route: 'route.demo' },
    ...(requestState === undefined ? {} : { requestState }),
    ...(requestState === undefined ? {} : { inputResponses: { 'confirm-name': { action: 'accept', content: { label: 'demo' } } } }),
    _meta: {
      'business-id': 'order-demo',
      'com.example/traceId': 'business-trace',
      ...(authorization === 'deny' ? { [INTEROP_AUTHORIZATION_META]: 'deny' } : {}),
      ...(slowPath ? { slowGoodPath: true } : {})
    }
  };
}

/**
 * Runs one candidate through its public entry and records what was actually observed.
 *
 * Deliberately absent: the previous adapter's synthesized `effects`/`upstreamRequests`
 * and its `resultType === 'denied' ? [] : [{}]` effect guess, which turned an unobserved
 * refusal into a claimed effect. Everything below is either a real response, a real
 * timing measurement, or explicitly marked unobservable.
 */
export async function runPublicCandidate(config, { ledger } = {}) {
  const requestTimeoutMs = config.requestTimeoutMs ?? 5000;
  const protocolVersion = config.protocolVersion ?? TARGET_PROTOCOL_VERSION;
  const slowPathDelayMs = Number(config.slowPathDelayMs ?? 0);
  const usingCommand = typeof config.command === 'string' && config.command.length > 0;
  let client;
  let identity;
  if (usingCommand) {
    client = createStdioClient(config.command, config.args ?? [], {
      cwd: config.cwd ?? REPOSITORY_ROOT,
      requestTimeoutMs,
      ledger,
      label: 'candidate'
    });
    identity = client.identity;
  } else {
    const endpoint = config.endpoint ?? process.env.MESHRIX_INTEROP_ENDPOINT;
    if (!endpoint || !/^https?:\/\//.test(endpoint)) return { ok: false, notRunReason: 'candidate_endpoint_missing' };
    client = createHttpClient(endpoint, {
      protocolVersion,
      authorization: process.env.MESHRIX_INTEROP_AUTHORIZATION ?? FIXTURE_AUTH_ALLOW,
      principal: 'interop-candidate',
      requestTimeoutMs
    });
    // Configured endpoints are never persisted into the report.
    identity = { transport: 'http', endpointRedacted: true };
  }
  const source = usingCommand ? 'command' : 'endpoint';
  const encodings = { complete: 'unrecognized' };
  let closeOutcome = { exited: false };
  let outcome;
  let startupError;

  /** Everything after a successful handshake: real observations only. */
  async function observeCandidate() {
    const initialize = await client.initialize(protocolVersion);
    const catalog = {
      tools: await client.request('tools/list'),
      resources: await client.request('resources/list'),
      prompts: await client.request('prompts/list')
    };
    const tools = Array.isArray(catalog.tools?.tools) ? catalog.tools.tools : [];
    const tool = tools.find(item => item.name === 'route.demo') ?? tools[0];
    if (!tool?.name) return { ok: false, reason: 'candidate_tool_missing', initialize, catalog, identity, source, encodings };

    const initialRaw = await client.request('tools/call', toolCallParams({ name: tool.name, operationKey: 'effect-key-1' }));
    const initial = canonicalizeInputRequiredResult(initialRaw);

    // The token the candidate issued must be presented back verbatim for the
    // continuation to complete.
    const continuedRaw = initial.hasRequestState
      ? await client.request('tools/call', toolCallParams({
        name: tool.name,
        operationKey: 'effect-key-1',
        requestState: initialRaw.requestState
      }))
      : initialRaw;
    const continued = canonicalizeCompleteResult(continuedRaw);
    if (continued.ok) encodings.complete = continued.encoding;

    // A tampered token must not complete. This is the public-entry form of "the original
    // state is exactly restored at the upstream observation point": if the candidate
    // ignored the token, a corrupted one would have completed too.
    const tampered = initial.hasRequestState
      ? await safeRequest(client, 'tools/call', toolCallParams({
        name: tool.name,
        operationKey: 'effect-key-1',
        requestState: 'interop-tampered-state-0000'
      }))
      : { ok: false, refusalCode: 'request_state_not_issued' };
    const tamperedCanonical = tampered.ok ? canonicalizeCompleteResult(tampered.result) : null;

    const unauthorizedResponse = await safeRequest(client, 'tools/call', toolCallParams({
      name: tool.name,
      operationKey: 'effect-key-unauthorized',
      authorization: 'deny'
    }));
    const unauthorizedCanonical = unauthorizedResponse.ok ? canonicalizeCompleteResult(unauthorizedResponse.result) : null;

    const slowStarted = performance.now();
    const slowResponse = await safeRequest(client, 'tools/list', { slowGoodPath: true });
    const slowElapsedMs = Math.round(performance.now() - slowStarted);

    // An effect entry is recorded only for a completion that was actually observed
    // through the public entry. The candidate's internal upstream requests are not
    // observable from outside, so `upstreamObservable` stays false instead of being
    // filled with a synthesized request list.
    const completedEffects = continued.ok
      ? [{ operationKey: 'effect-key-1', route: 'route.demo', source: 'observed-completion' }]
      : [];
    const unauthorizedRefused = unauthorizedCanonical?.ok !== true;

    const observation = {
      profile: 'public-entry',
      mrt: {
        stateIssued: initial.hasRequestState === true,
        statePresentedBack: initial.hasRequestState === true && continued.ok,
        tamperedRefused: initial.hasRequestState === true && !tamperedCanonical?.ok,
        tamperedRefusalCode: tampered.ok ? null : tampered.refusalCode,
        tamperedEffectOutcome: tampered.refusalData?.effectOutcome ?? null
      },
      tool: {
        initial: initial.ok ? initial.result : null,
        initialReason: initial.ok ? null : initial.reason,
        continued: continued.ok ? continued.result : null,
        continuedReason: continued.ok ? null : continued.reason,
        upstreamObservable: false,
        upstreamRequests: [],
        effectsObservable: false,
        effects: completedEffects
      },
      authorized: continued.ok ? continued.result : null,
      authorizedEffects: completedEffects,
      unauthorized: unauthorizedCanonical?.ok
        ? unauthorizedCanonical.result
        : { resultType: 'denied', denialCode: unauthorizedResponse.refusalCode ?? 'request_failed' },
      unauthorizedEffects: unauthorizedCanonical?.ok
        ? [{ operationKey: 'effect-key-unauthorized', route: 'route.demo', source: 'observed-completion' }]
        : [],
      contexts: [
        { principal: 'interop-candidate', observedRoute: continued.ok ? continued.result.structuredContent?.route ?? null : null },
        {
          principal: 'interop-candidate-deny',
          observed: unauthorizedRefused ? 'refused' : 'completed',
          refusalCode: unauthorizedRefused ? unauthorizedResponse.refusalCode : null
        }
      ]
    };

    return {
      ok: true,
      initialize,
      catalog,
      observation,
      encodings,
      slowGoodPath: {
        observed: true,
        status: slowResponse.ok && Array.isArray(slowResponse.result?.tools) ? 'pass' : 'fail',
        reason: slowResponse.ok ? 'slow_good_path_response_observed' : slowResponse.refusalCode,
        elapsedMs: slowElapsedMs,
        minimumDelayMs: slowPathDelayMs
      },
      identity,
      source
    };
  }

  try {
    outcome = await observeCandidate();
  } catch (error) {
    startupError = error;
  } finally {
    closeOutcome = await client.close();
    if (ledger) ledger.note(`candidate_process_exit:${closeOutcome.exited ? 'reaped' : 'unreaped'}`);
  }

  // An endpoint candidate has no child process to reap; that is recorded explicitly
  // rather than being reported as a clean exit that was never observed.
  const processExit = usingCommand
    ? {
      exited: closeOutcome?.exited === true,
      killed: closeOutcome?.killed === true,
      timedOut: closeOutcome?.timedOut === true
    }
    : { exited: null, killed: false, timedOut: false, notApplicable: true };
  if (startupError) {
    // A candidate that never completed its handshake was not started: that is the
    // declared not_run condition, never a disguised case result.
    return {
      ok: false,
      notRunReason: classifyStartupFailure(startupError, processExit),
      processExit,
      stderrBytes: client.stderrBytes ?? 0,
      identity,
      source,
      encodings
    };
  }
  return { ...outcome, processExit, stderrBytes: client.stderrBytes ?? 0 };
}

export function classifyStartupFailure(error, processExit) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('candidate_request_timeout')) return 'candidate_startup_timeout';
  if (message === 'candidate_invalid_json_line') return 'candidate_protocol_not_jsonrpc';
  if (processExit?.exited === true) return 'candidate_process_exited';
  if (message === 'candidate_process_closed') return 'candidate_process_closed';
  return 'candidate_startup_failed';
}
