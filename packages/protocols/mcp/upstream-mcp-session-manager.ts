import { createHttpMcpSession } from "./upstream-mcp-http-session.ts";
import { createUpstreamMcpStdioLauncher } from "./upstream-mcp-stdio-launcher.ts";
import { createStdioMcpSession } from "./upstream-mcp-stdio-session.ts";
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
} from "./upstream-mcp-transport-common.ts";

const DEFAULT_MAX_SESSIONS: any = 16;
const DEFAULT_IDLE_TTL_MS: any = 60_000;
const DEFAULT_MAX_LIFETIME_MS: any = 15 * 60_000;
const DEFAULT_MAX_CONCURRENT_PER_SESSION: any = 32;
const MAX_RETIRED_KEYS_PER_SCOPE: any = 64;

function boundedInt(value?: any, fallback?: any, maximum: any = Number.MAX_SAFE_INTEGER) : any {
  return Math.min(positiveInt(value, fallback), maximum);
}

function capacityError(message?: any, code?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  error.status = 503;
  return error;
}

function waitForPromise(promise?: any, signal?: any) : any {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve?: any, reject?: any) : any => {
    const onAbort: any = () : any => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() : any => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function createTransportSession(config?: any, options?: any) : Promise<any> {
  const normalized: any = normalizeTransportConfig(config);
  if (isHttpMcpTransport(normalized.transport)) {
    return createHttpMcpSession(normalized, options);
  }
  if (normalized.transport === "stdio") {
    return createStdioMcpSession(normalized, options);
  }
  throw new Error(`Unsupported upstream MCP transport: ${normalized.transport}`);
}

export function createUpstreamMcpSessionManager(options: Record<string, any> = {}) : any {
  const maxSessions: any = boundedInt(options.maxSessions, DEFAULT_MAX_SESSIONS, 1024);
  const maxConcurrentRequestsPerSession: any = boundedInt(
    options.maxConcurrentRequestsPerSession,
    DEFAULT_MAX_CONCURRENT_PER_SESSION,
    65_536
  );
  const maxConcurrentRequests: any = boundedInt(
    options.maxConcurrentRequests,
    maxSessions * maxConcurrentRequestsPerSession,
    262_144
  );
  const idleTtlMs: any = boundedInt(options.idleTtlMs, DEFAULT_IDLE_TTL_MS);
  const maxLifetimeMs: any = boundedInt(options.maxLifetimeMs, DEFAULT_MAX_LIFETIME_MS);
  const now: any = typeof options.now === "function" ? options.now : Date.now;
  const stdioLauncher: any = options.stdioLauncher === undefined
    ? createUpstreamMcpStdioLauncher()
    : options.stdioLauncher;
  const transportOptions: Record<string, any> = {
    stdioLauncher,
    fetchTransport: options.fetchTransport,
    env: options.env
  };
  const sessions: any = new Map<any, any>();
  const allEntries: any = new Set<any>();
  const creating: any = new Map<any, any>();
  const currentScopeKeys: any = new Map<any, any>();
  const retiredScopeKeys: any = new Map<any, any>();
  let totalInFlight: any = 0;
  const drainWaiters: any = new Set<any>();
  let nextEntryId: any = 1;
  let closed: any = false;
  let managerClosePromise: any = null;
  let sweepTimer: any = null;
  let poolLock: any = Promise.resolve();

  function withPoolLock(operation?: any) : any {
    const previous: any = poolLock;
    let release: any;
    poolLock = new Promise((resolve?: any) : any => {
      release = resolve;
    });
    return previous.then(operation).finally(release);
  }

  function closeEntry(entry?: any, { force = false }: Record<string, any> = {}) : any {
    if (entry.closePromise) return entry.closePromise;
    if (!force && entry.inFlight > 0) return null;
    if (sessions.get(entry.key) === entry) sessions.delete(entry.key);
    entry.retired = true;
    entry.closePromise = Promise.resolve()
      .then(() : any => entry.session.close())
      .catch(() : any => undefined)
      .finally(() : any => {
        allEntries.delete(entry);
        scheduleSweep();
      });
    return entry.closePromise;
  }

  function retireEntry(entry?: any, options: Record<string, any> = {}) : any {
    if (!entry) return null;
    entry.retired = true;
    if (sessions.get(entry.key) === entry) sessions.delete(entry.key);
    return closeEntry(entry, options);
  }

  function sweepExpired(at: any = now()) : any {
    for (const entry of [...allEntries]) {
      if (entry.retired) {
        closeEntry(entry);
        continue;
      }
      const lifetimeExpired: any = at - entry.createdAt >= maxLifetimeMs;
      const idleExpired: any = entry.inFlight === 0 && at - entry.lastUsedAt >= idleTtlMs;
      const transportFailed: any = entry.session.closed || entry.session.fatal;
      if (lifetimeExpired || idleExpired || transportFailed) retireEntry(entry);
    }
  }

  function scheduleSweep() : any {
    clearTimeout(sweepTimer);
    sweepTimer = null;
    if (closed || allEntries.size === 0) return;
    const at: any = now();
    let delay: any = idleTtlMs;
    for (const entry of allEntries) {
      if (entry.retired) continue;
      const lifetimeRemaining: any = maxLifetimeMs - (at - entry.createdAt);
      const idleRemaining: any = entry.inFlight > 0
        ? idleTtlMs
        : idleTtlMs - (at - entry.lastUsedAt);
      delay = Math.min(delay, Math.max(1, lifetimeRemaining), Math.max(1, idleRemaining));
    }
    sweepTimer = setTimeout(() : any => {
      void withPoolLock(() : any => {
        sweepExpired();
        scheduleSweep();
      });
    }, Math.max(1, delay));
    sweepTimer.unref?.();
  }

  function normalizedGeneration(value: Record<string, any> = {}) : any {
    const source: any = asObject(value);
    const credentialRevisions: any = new Map<any, any>(asArray(source.credentialRevisions)
      .map((entry?: any) : any => [text(entry?.bindingId), Math.max(0, Number(entry?.revision || 0) || 0)])
      .filter(([bindingId]: any[]) : any => bindingId));
    return {
      present: Number(source.serviceRevision || 0) > 0 || credentialRevisions.size > 0,
      serviceRevision: Math.max(0, Number(source.serviceRevision || 0) || 0),
      credentialRevisions
    };
  }

  function compareGeneration(candidate?: any, current?: any) : any {
    if (candidate.serviceRevision !== current.serviceRevision) {
      return candidate.serviceRevision > current.serviceRevision ? 1 : -1;
    }
    let newer: any = false;
    const bindingIds: any = new Set<any>([
      ...candidate.credentialRevisions.keys(),
      ...current.credentialRevisions.keys()
    ]);
    for (const bindingId of bindingIds) {
      const candidateRevision: any = candidate.credentialRevisions.get(bindingId) ?? -1;
      const currentRevision: any = current.credentialRevisions.get(bindingId) ?? -1;
      if (candidateRevision < currentRevision) return -1;
      if (candidateRevision > currentRevision) newer = true;
    }
    return newer ? 1 : 0;
  }

  function rememberRetiredKey(scope?: any, key?: any) : any {
    const retiredKeys: any = retiredScopeKeys.get(scope) || new Set<any>();
    retiredKeys.delete(key);
    retiredKeys.add(key);
    while (retiredKeys.size > MAX_RETIRED_KEYS_PER_SCOPE) {
      retiredKeys.delete(retiredKeys.values().next().value);
    }
    retiredScopeKeys.set(scope, retiredKeys);
  }

  function adoptScope(scope?: any, key?: any, generationValue: Record<string, any> = {}) : any {
    if (!scope) return;
    const generation: any = normalizedGeneration(generationValue);
    const previous: any = currentScopeKeys.get(scope);
    const previousKey: any = previous?.key || "";
    if (previousKey === key) return;
    if (generation.present && previous?.generation?.present) {
      const order: any = compareGeneration(generation, previous.generation);
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

  async function ensureCapacity() : Promise<any> {
    sweepExpired();
    while (allEntries.size + creating.size >= maxSessions) {
      const candidate: any = [...allEntries]
        .filter((entry?: any) : any => entry.inFlight === 0 && !entry.closePromise)
        .sort((left?: any, right?: any) : any => left.lastUsedAt - right.lastUsedAt)[0];
      if (!candidate) {
        const closing: any = [...allEntries]
          .map((entry?: any) : any => entry.closePromise)
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
      const closing: any = retireEntry(candidate);
      if (closing) await closing;
    }
  }

  function beginCreation(config?: any, key?: any, scope?: any) : any {
    const promise: any = (async () : Promise<any> => {
      let session: any;
      try {
        session = await createTransportSession(config, transportOptions);
        return await withPoolLock(async () : Promise<any> => {
          creating.delete(key);
          if (closed || (scope && currentScopeKeys.get(scope)?.key !== key)) {
            await session.close().catch(() : any => undefined);
            throw fatalSessionError("Upstream MCP session configuration changed during initialization.");
          }
          const at: any = now();
          const entry: Record<string, any> = {
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
      } catch (error: any) {
        await withPoolLock(() : any => {
          if (creating.get(key)?.promise === promise) creating.delete(key);
        });
        throw error;
      }
    })();
    creating.set(key, { promise, scope });
    return promise;
  }

  async function acquire(config?: any, signal?: any) : Promise<any> {
    const identity: any = sessionIdentity(config);
    let missingSessionRetries: any = 0;
    while (true) {
      if (signal?.aborted) throw abortError();
      const decision: any = await withPoolLock(async () : Promise<any> => {
        if (closed) throw fatalSessionError("Upstream MCP session manager is closed.");
        adoptScope(identity.scope, identity.key, identity.generation);
        sweepExpired();
        const existing: any = sessions.get(identity.key);
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
        const pendingCreation: any = creating.get(identity.key);
        if (pendingCreation) return { creation: pendingCreation.promise };
        await ensureCapacity();
        return { creation: beginCreation(config, identity.key, identity.scope) };
      });
      if (decision.entry) return decision.entry;
      try {
        await waitForPromise(decision.creation, signal);
      } catch (error: any) {
        if (error?.mcpSessionNotFound && missingSessionRetries === 0 && !signal?.aborted) {
          missingSessionRetries += 1;
          continue;
        }
        throw error;
      }
    }
  }

  function release(entry?: any) : any {
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

  function waitForRequestDrain() : any {
    if (totalInFlight === 0) return Promise.resolve();
    return new Promise((resolve?: any) : any => drainWaiters.add(resolve));
  }

  async function execute(config?: any, signal?: any, operation?: any) : Promise<any> {
    for (let attempt: any = 0; attempt < 2; attempt += 1) {
      const entry: any = await acquire(config, signal);
      try {
        return await operation(entry.session);
      } catch (error: any) {
        if (error?.mcpSessionFatal || entry.session.fatal) retireEntry(entry);
        if (error?.mcpSessionNotFound && attempt === 0 && !signal?.aborted) continue;
        throw error;
      } finally {
        release(entry);
      }
    }
    throw fatalSessionError("Upstream MCP session recovery failed.");
  }

  const manager: Record<string, any> = {
    retireScope(scopeValue: any = "", { remove = false }: Record<string, any> = {}) : any {
      const scope: any = text(scopeValue);
      if (!scope) return Promise.resolve({ retired: 0, removed: false });
      return withPoolLock(() : any => {
        let retired: any = 0;
        const current: any = currentScopeKeys.get(scope);
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
    async listTools(config: Record<string, any> = {}, requestOptions: Record<string, any> = {}) : Promise<any> {
      return execute(config, requestOptions.signal, async (session?: any) : Promise<any> => {
        const result: any = await session.request("tools/list", {}, {
          signal: requestOptions.signal,
          onNotification: requestOptions.onNotification
        });
        return {
          protocolVersion: UPSTREAM_MCP_CLIENT_PROTOCOL_VERSION,
          initialized: session.initialized,
          tools: asArray(result.tools).filter((tool?: any) : any => tool && typeof tool === "object")
        };
      });
    },

    async callTool(config: Record<string, any> = {}, call: Record<string, any> = {}, requestOptions: Record<string, any> = {}) : Promise<any> {
      const toolName: any = text(call.name);
      if (!toolName) throw new Error("Upstream MCP tools/call requires tool name.");
      return execute(config, requestOptions.signal, async (session?: any) : Promise<any> => {
        const result: any = await session.request("tools/call", {
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

    snapshot() : any {
      const at: any = now();
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
          .reduce((count?: any, keys?: any) : any => count + keys.size, 0),
        maxRetiredGenerationsPerScope: MAX_RETIRED_KEYS_PER_SCOPE,
        sessions: [...allEntries].map((entry?: any) : any => ({
          id: entry.id,
          transport: entry.session.transport,
          state: entry.retired ? "retiring" : entry.session.fatal ? "failed" : "ready",
          inFlightRequestCount: entry.inFlight,
          ageMs: Math.max(0, at - entry.createdAt),
          idleMs: Math.max(0, at - entry.lastUsedAt)
        }))
      };
    },

    close() : any {
      if (managerClosePromise) return managerClosePromise;
      managerClosePromise = (async () : Promise<any> => {
        let pendingCreations: any[] = [];
        let closing: any[] = [];
        await withPoolLock(() : any => {
          closed = true;
          clearTimeout(sweepTimer);
          sweepTimer = null;
          pendingCreations = [...creating.values()].map((entry?: any) : any => entry.promise);
          closing = [...allEntries]
            .map((entry?: any) : any => retireEntry(entry, { force: true }))
            .filter(Boolean);
          sessions.clear();
          currentScopeKeys.clear();
          retiredScopeKeys.clear();
        });
        await Promise.allSettled([...pendingCreations, ...closing]);
        await waitForRequestDrain();
        const remaining: any = [...allEntries]
          .map((entry?: any) : any => closeEntry(entry, { force: true }))
          .filter(Boolean);
        await Promise.allSettled(remaining);
      })();
      return managerClosePromise;
    }
  };

  return manager;
}
