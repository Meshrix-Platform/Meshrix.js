import { createHttpMcpSession } from "./upstream-mcp-http-session.mjs";
import { createUpstreamMcpStdioLauncher } from "./upstream-mcp-stdio-launcher.mjs";
import { createStdioMcpSession } from "./upstream-mcp-stdio-session.mjs";
import {
  abortError,
  asArray,
  asObject,
  fatalSessionError,
  isHttpMcpTransport,
  normalizeTransportConfig,
  positiveInt,
  sessionIdentity,
  text,
  UPSTREAM_MCP_CLIENT_PROTOCOL_VERSION
} from "./upstream-mcp-transport-common.mjs";

const DEFAULT_MAX_SESSIONS = 16;
const DEFAULT_IDLE_TTL_MS = 60_000;
const DEFAULT_MAX_LIFETIME_MS = 15 * 60_000;
const DEFAULT_MAX_CONCURRENT_PER_SESSION = 32;
const MAX_RETIRED_KEYS_PER_SCOPE = 64;

function boundedInt(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  return Math.min(positiveInt(value, fallback), maximum);
}

function capacityError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.status = 503;
  return error;
}

function waitForPromise(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function createTransportSession(config, options) {
  const normalized = normalizeTransportConfig(config);
  if (isHttpMcpTransport(normalized.transport)) {
    return createHttpMcpSession(normalized, options);
  }
  if (normalized.transport === "stdio") {
    return createStdioMcpSession(normalized, options);
  }
  throw new Error(`Unsupported upstream MCP transport: ${normalized.transport}`);
}

export function createUpstreamMcpSessionManager(options = {}) {
  const maxSessions = boundedInt(options.maxSessions, DEFAULT_MAX_SESSIONS, 1024);
  const maxConcurrentRequestsPerSession = boundedInt(
    options.maxConcurrentRequestsPerSession,
    DEFAULT_MAX_CONCURRENT_PER_SESSION,
    65_536
  );
  const maxConcurrentRequests = boundedInt(
    options.maxConcurrentRequests,
    maxSessions * maxConcurrentRequestsPerSession,
    262_144
  );
  const idleTtlMs = boundedInt(options.idleTtlMs, DEFAULT_IDLE_TTL_MS);
  const maxLifetimeMs = boundedInt(options.maxLifetimeMs, DEFAULT_MAX_LIFETIME_MS);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const stdioLauncher = options.stdioLauncher === undefined
    ? createUpstreamMcpStdioLauncher()
    : options.stdioLauncher;
  const transportOptions = {
    stdioLauncher,
    fetchImpl: options.fetchImpl,
    fetchTransport: options.fetchTransport,
    env: options.env
  };
  const sessions = new Map();
  const allEntries = new Set();
  const creating = new Map();
  const currentScopeKeys = new Map();
  const retiredScopeKeys = new Map();
  let totalInFlight = 0;
  const drainWaiters = new Set();
  let nextEntryId = 1;
  let closed = false;
  let managerClosePromise = null;
  let sweepTimer = null;
  let poolLock = Promise.resolve();

  function withPoolLock(operation) {
    const previous = poolLock;
    let release;
    poolLock = new Promise((resolve) => {
      release = resolve;
    });
    return previous.then(operation).finally(release);
  }

  function closeEntry(entry, { force = false } = {}) {
    if (entry.closePromise) return entry.closePromise;
    if (!force && entry.inFlight > 0) return null;
    if (sessions.get(entry.key) === entry) sessions.delete(entry.key);
    entry.retired = true;
    entry.closePromise = Promise.resolve()
      .then(() => entry.session.close())
      .catch(() => undefined)
      .finally(() => {
        allEntries.delete(entry);
        scheduleSweep();
      });
    return entry.closePromise;
  }

  function retireEntry(entry, options = {}) {
    if (!entry) return null;
    entry.retired = true;
    if (sessions.get(entry.key) === entry) sessions.delete(entry.key);
    return closeEntry(entry, options);
  }

  function sweepExpired(at = now()) {
    for (const entry of [...allEntries]) {
      if (entry.retired) {
        closeEntry(entry);
        continue;
      }
      const lifetimeExpired = at - entry.createdAt >= maxLifetimeMs;
      const idleExpired = entry.inFlight === 0 && at - entry.lastUsedAt >= idleTtlMs;
      const transportFailed = entry.session.closed || entry.session.fatal;
      if (lifetimeExpired || idleExpired || transportFailed) retireEntry(entry);
    }
  }

  function scheduleSweep() {
    clearTimeout(sweepTimer);
    sweepTimer = null;
    if (closed || allEntries.size === 0) return;
    const at = now();
    let delay = idleTtlMs;
    for (const entry of allEntries) {
      if (entry.retired) continue;
      const lifetimeRemaining = maxLifetimeMs - (at - entry.createdAt);
      const idleRemaining = entry.inFlight > 0
        ? idleTtlMs
        : idleTtlMs - (at - entry.lastUsedAt);
      delay = Math.min(delay, Math.max(1, lifetimeRemaining), Math.max(1, idleRemaining));
    }
    sweepTimer = setTimeout(() => {
      void withPoolLock(() => {
        sweepExpired();
        scheduleSweep();
      });
    }, Math.max(1, delay));
    sweepTimer.unref?.();
  }

  function normalizedGeneration(value = {}) {
    const source = asObject(value);
    const credentialRevisions = new Map(asArray(source.credentialRevisions)
      .map((entry) => [text(entry?.bindingId), Math.max(0, Number(entry?.revision || 0) || 0)])
      .filter(([bindingId]) => bindingId));
    return {
      present: Number(source.serviceRevision || 0) > 0 || credentialRevisions.size > 0,
      serviceRevision: Math.max(0, Number(source.serviceRevision || 0) || 0),
      credentialRevisions
    };
  }

  function compareGeneration(candidate, current) {
    if (candidate.serviceRevision !== current.serviceRevision) {
      return candidate.serviceRevision > current.serviceRevision ? 1 : -1;
    }
    let newer = false;
    const bindingIds = new Set([
      ...candidate.credentialRevisions.keys(),
      ...current.credentialRevisions.keys()
    ]);
    for (const bindingId of bindingIds) {
      const candidateRevision = candidate.credentialRevisions.get(bindingId) ?? -1;
      const currentRevision = current.credentialRevisions.get(bindingId) ?? -1;
      if (candidateRevision < currentRevision) return -1;
      if (candidateRevision > currentRevision) newer = true;
    }
    return newer ? 1 : 0;
  }

  function rememberRetiredKey(scope, key) {
    const retiredKeys = retiredScopeKeys.get(scope) || new Set();
    retiredKeys.delete(key);
    retiredKeys.add(key);
    while (retiredKeys.size > MAX_RETIRED_KEYS_PER_SCOPE) {
      retiredKeys.delete(retiredKeys.values().next().value);
    }
    retiredScopeKeys.set(scope, retiredKeys);
  }

  function adoptScope(scope, key, generationValue = {}) {
    if (!scope) return;
    const generation = normalizedGeneration(generationValue);
    const previous = currentScopeKeys.get(scope);
    const previousKey = previous?.key || "";
    if (previousKey === key) return;
    if (generation.present && previous?.generation?.present) {
      const order = compareGeneration(generation, previous.generation);
      if (order < 0 || order === 0) {
        throw capacityError(
          order < 0
            ? "Upstream MCP session configuration is an obsolete generation."
            : "Upstream MCP session generation conflicts with the current configuration.",
          order < 0
            ? "UPSTREAM_MCP_STALE_SESSION_GENERATION"
            : "UPSTREAM_MCP_SESSION_GENERATION_CONFLICT"
        );
      }
    } else if (retiredScopeKeys.get(scope)?.has(key)) {
      throw capacityError(
        "Upstream MCP session configuration is an obsolete generation.",
        "UPSTREAM_MCP_STALE_SESSION_GENERATION"
      );
    }
    if (previousKey) {
      rememberRetiredKey(scope, previousKey);
    }
    currentScopeKeys.set(scope, { key, generation });
    for (const entry of allEntries) {
      if (entry.scope === scope && entry.key !== key) retireEntry(entry);
    }
  }

  async function ensureCapacity() {
    sweepExpired();
    while (allEntries.size + creating.size >= maxSessions) {
      const candidate = [...allEntries]
        .filter((entry) => entry.inFlight === 0 && !entry.closePromise)
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!candidate) {
        const closing = [...allEntries]
          .map((entry) => entry.closePromise)
          .filter(Boolean);
        if (closing.length > 0) {
          await Promise.race(closing);
          continue;
        }
        throw capacityError(
          "Upstream MCP session capacity is currently exhausted.",
          "UPSTREAM_MCP_SESSION_CAPACITY"
        );
      }
      const closing = retireEntry(candidate);
      if (closing) await closing;
    }
  }

  function beginCreation(config, key, scope) {
    const promise = (async () => {
      let session;
      try {
        session = await createTransportSession(config, transportOptions);
        return await withPoolLock(async () => {
          creating.delete(key);
          if (closed || (scope && currentScopeKeys.get(scope)?.key !== key)) {
            await session.close().catch(() => undefined);
            throw fatalSessionError("Upstream MCP session configuration changed during initialization.");
          }
          const at = now();
          const entry = {
            id: nextEntryId++,
            key,
            scope,
            session,
            createdAt: at,
            lastUsedAt: at,
            inFlight: 0,
            retired: false,
            closePromise: null
          };
          sessions.set(key, entry);
          allEntries.add(entry);
          scheduleSweep();
          return entry;
        });
      } catch (error) {
        await withPoolLock(() => {
          if (creating.get(key)?.promise === promise) creating.delete(key);
        });
        throw error;
      }
    })();
    creating.set(key, { promise, scope });
    return promise;
  }

  async function acquire(config, signal) {
    const identity = sessionIdentity(config);
    let missingSessionRetries = 0;
    while (true) {
      if (signal?.aborted) throw abortError();
      const decision = await withPoolLock(async () => {
        if (closed) throw fatalSessionError("Upstream MCP session manager is closed.");
        adoptScope(identity.scope, identity.key, identity.generation);
        sweepExpired();
        const existing = sessions.get(identity.key);
        if (existing && !existing.retired && !existing.session.closed && !existing.session.fatal) {
          if (existing.inFlight >= maxConcurrentRequestsPerSession) {
            throw capacityError(
              "Upstream MCP per-session concurrency limit was reached.",
              "UPSTREAM_MCP_SESSION_CONCURRENCY"
            );
          }
          if (totalInFlight >= maxConcurrentRequests) {
            throw capacityError(
              "Upstream MCP manager concurrency limit was reached.",
              "UPSTREAM_MCP_MANAGER_CONCURRENCY"
            );
          }
          existing.inFlight += 1;
          totalInFlight += 1;
          existing.lastUsedAt = now();
          scheduleSweep();
          return { entry: existing };
        }
        const pendingCreation = creating.get(identity.key);
        if (pendingCreation) return { creation: pendingCreation.promise };
        await ensureCapacity();
        return { creation: beginCreation(config, identity.key, identity.scope) };
      });
      if (decision.entry) return decision.entry;
      try {
        await waitForPromise(decision.creation, signal);
      } catch (error) {
        if (error?.mcpSessionNotFound && missingSessionRetries === 0 && !signal?.aborted) {
          missingSessionRetries += 1;
          continue;
        }
        throw error;
      }
    }
  }

  function release(entry) {
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    totalInFlight = Math.max(0, totalInFlight - 1);
    if (totalInFlight === 0) {
      for (const resolve of drainWaiters) resolve();
      drainWaiters.clear();
    }
    entry.lastUsedAt = now();
    if (entry.retired || entry.session.closed || entry.session.fatal) closeEntry(entry);
    scheduleSweep();
  }

  function waitForRequestDrain() {
    if (totalInFlight === 0) return Promise.resolve();
    return new Promise((resolve) => drainWaiters.add(resolve));
  }

  async function execute(config, signal, operation) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const entry = await acquire(config, signal);
      try {
        return await operation(entry.session);
      } catch (error) {
        if (error?.mcpSessionFatal || entry.session.fatal) retireEntry(entry);
        if (error?.mcpSessionNotFound && attempt === 0 && !signal?.aborted) continue;
        throw error;
      } finally {
        release(entry);
      }
    }
    throw fatalSessionError("Upstream MCP session recovery failed.");
  }

  const manager = {
    retireScope(scopeValue = "", { remove = false } = {}) {
      const scope = text(scopeValue);
      if (!scope) return Promise.resolve({ retired: 0, removed: false });
      return withPoolLock(() => {
        let retired = 0;
        const current = currentScopeKeys.get(scope);
        if (current?.key) rememberRetiredKey(scope, current.key);
        for (const entry of allEntries) {
          if (entry.scope !== scope) continue;
          retireEntry(entry);
          retired += 1;
        }
        for (const pending of creating.values()) {
          if (pending.scope === scope) {
            retired += 1;
          }
        }
        if (remove) {
          currentScopeKeys.delete(scope);
          retiredScopeKeys.delete(scope);
        } else if (current) {
          currentScopeKeys.set(scope, { ...current, key: "" });
        }
        return { retired, removed: remove };
      });
    },
    async listTools(config = {}, requestOptions = {}) {
      return execute(config, requestOptions.signal, async (session) => {
        const result = await session.request("tools/list", {}, {
          signal: requestOptions.signal,
          onNotification: requestOptions.onNotification
        });
        return {
          protocolVersion: UPSTREAM_MCP_CLIENT_PROTOCOL_VERSION,
          initialized: session.initialized,
          tools: asArray(result.tools).filter((tool) => tool && typeof tool === "object")
        };
      });
    },

    async callTool(config = {}, call = {}, requestOptions = {}) {
      const toolName = text(call.name);
      if (!toolName) throw new Error("Upstream MCP tools/call requires tool name.");
      return execute(config, requestOptions.signal, async (session) => {
        const result = await session.request("tools/call", {
          name: toolName,
          arguments: asObject(call.arguments)
        }, {
          signal: requestOptions.signal,
          onNotification: requestOptions.onNotification
        });
        return {
          protocolVersion: UPSTREAM_MCP_CLIENT_PROTOCOL_VERSION,
          initialized: session.initialized,
          result
        };
      });
    },

    snapshot() {
      const at = now();
      return {
        protocolVersion: UPSTREAM_MCP_CLIENT_PROTOCOL_VERSION,
        state: closed ? "closed" : "ready",
        sessionCount: allEntries.size,
        reusableSessionCount: sessions.size,
        creatingSessionCount: creating.size,
        inFlightRequestCount: totalInFlight,
        maxSessions,
        maxConcurrentRequests,
        maxConcurrentRequestsPerSession,
        trackedScopeCount: currentScopeKeys.size,
        retiredGenerationCount: [...retiredScopeKeys.values()]
          .reduce((count, keys) => count + keys.size, 0),
        maxRetiredGenerationsPerScope: MAX_RETIRED_KEYS_PER_SCOPE,
        sessions: [...allEntries].map((entry) => ({
          id: entry.id,
          transport: entry.session.transport,
          state: entry.retired ? "retiring" : entry.session.fatal ? "failed" : "ready",
          inFlightRequestCount: entry.inFlight,
          ageMs: Math.max(0, at - entry.createdAt),
          idleMs: Math.max(0, at - entry.lastUsedAt)
        }))
      };
    },

    close() {
      if (managerClosePromise) return managerClosePromise;
      managerClosePromise = (async () => {
        let pendingCreations = [];
        let closing = [];
        await withPoolLock(() => {
          closed = true;
          clearTimeout(sweepTimer);
          sweepTimer = null;
          pendingCreations = [...creating.values()].map((entry) => entry.promise);
          closing = [...allEntries]
            .map((entry) => retireEntry(entry, { force: true }))
            .filter(Boolean);
          sessions.clear();
          currentScopeKeys.clear();
          retiredScopeKeys.clear();
        });
        await Promise.allSettled([...pendingCreations, ...closing]);
        await waitForRequestDrain();
        const remaining = [...allEntries]
          .map((entry) => closeEntry(entry, { force: true }))
          .filter(Boolean);
        await Promise.allSettled(remaining);
      })();
      return managerClosePromise;
    }
  };

  return manager;
}
