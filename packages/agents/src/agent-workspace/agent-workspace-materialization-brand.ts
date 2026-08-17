export interface AgentWorkspaceMaterializationPort {
  withRequest(input?: unknown, task?: unknown): unknown;
}

export type AgentWorkspaceMaterializationRootAuthority = object;

type RootAuthorityStatus = "available" | "binding" | "bound" | "failed" | "claimed";

interface RootAuthorityState {
  status: RootAuthorityStatus;
  port: AgentWorkspaceMaterializationPort | null;
}

interface RootPortIssuance {
  authority: AgentWorkspaceMaterializationRootAuthority;
  port: AgentWorkspaceMaterializationPort | null;
}

interface MaterializationBrandRegistry {
  issuedPorts: WeakSet<AgentWorkspaceMaterializationPort>;
  rootAuthorities: WeakMap<AgentWorkspaceMaterializationRootAuthority, RootAuthorityState>;
  activeRootIssuance: RootPortIssuance | null;
}

const MATERIALIZATION_BRAND_REGISTRY = Symbol.for(
  "meshrix.agent-workspace.materialization-brand-registry"
);
const materializationBrandRegistry: MaterializationBrandRegistry = (() => {
  const globalRegistry = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = globalRegistry[MATERIALIZATION_BRAND_REGISTRY];
  if (!existing) {
    Object.defineProperty(globalRegistry, MATERIALIZATION_BRAND_REGISTRY, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: {
        issuedPorts: new WeakSet<object>(),
        rootAuthorities: new WeakMap<AgentWorkspaceMaterializationRootAuthority, RootAuthorityState>(),
        activeRootIssuance: null
      }
    });
  }
  return globalRegistry[MATERIALIZATION_BRAND_REGISTRY] as MaterializationBrandRegistry;
})();

function isThenable(value: unknown): value is { then: unknown } {
  return value !== null && typeof value === "object" && "then" in value;
}

function isMaterializationPort(value: unknown): value is AgentWorkspaceMaterializationPort {
  return value !== null &&
    typeof value === "object" &&
    Object.isFrozen(value) &&
    "withRequest" in value &&
    typeof value.withRequest === "function";
}

function requireRootAuthority(authority?: unknown): RootAuthorityState {
  const state = authority && typeof authority === "object"
    ? materializationBrandRegistry.rootAuthorities.get(authority)
    : undefined;
  if (!state) {
    throw new TypeError(
      "A composition-root workspace materialization authority is required."
    );
  }
  return state;
}

export function createAgentWorkspaceMaterializationRootAuthority(): AgentWorkspaceMaterializationRootAuthority {
  const authority: AgentWorkspaceMaterializationRootAuthority = Object.freeze(Object.create(null));
  materializationBrandRegistry.rootAuthorities.set(authority, {
    status: "available",
    port: null
  });
  return authority;
}

export function assertAgentWorkspaceMaterializationRootAuthority(
  authority?: unknown
): AgentWorkspaceMaterializationRootAuthority {
  const state = requireRootAuthority(authority);
  if (state.status !== "available") {
    throw new TypeError(
      "The composition-root workspace materialization authority is not available."
    );
  }
  return authority as AgentWorkspaceMaterializationRootAuthority;
}

export function bindAgentWorkspaceMaterializationRootPort(
  authority?: unknown,
  createPort?: () => unknown
): void {
  const state = requireRootAuthority(authority);
  if (state.status !== "available") {
    throw new TypeError(
      "The composition-root workspace materialization authority is not available."
    );
  }
  if (typeof createPort !== "function") {
    throw new TypeError(
      "The workspace materialization port factory is required."
    );
  }
  if (materializationBrandRegistry.activeRootIssuance) {
    throw new TypeError(
      "Nested workspace materialization port issuance is forbidden."
    );
  }

  const issuance: RootPortIssuance = {
    authority: authority as AgentWorkspaceMaterializationRootAuthority,
    port: null
  };
  state.status = "binding";
  materializationBrandRegistry.activeRootIssuance = issuance;
  try {
    const port = createPort();
    if (isThenable(port) && typeof port.then === "function") {
      throw new TypeError(
        "Workspace materialization port issuance must be synchronous."
      );
    }
    if (!issuance.port || issuance.port !== port) {
      throw new TypeError(
        "The workspace materialization port factory did not issue its exact result."
      );
    }
    materializationBrandRegistry.issuedPorts.add(issuance.port);
    state.port = issuance.port;
    state.status = "bound";
  } catch (error: unknown) {
    state.port = null;
    state.status = "failed";
    throw error;
  } finally {
    materializationBrandRegistry.activeRootIssuance = null;
  }
}

export function claimAgentWorkspaceMaterializationRootPort(
  authority?: unknown
): AgentWorkspaceMaterializationPort {
  const state = requireRootAuthority(authority);
  if (state.status !== "bound" || !state.port) {
    throw new TypeError(
      "The composition-root workspace materialization port is unavailable."
    );
  }
  const port = state.port;
  state.port = null;
  state.status = "claimed";
  return port;
}

export function issueAgentWorkspaceMaterializationPort(
  port?: unknown
): AgentWorkspaceMaterializationPort {
  if (!materializationBrandRegistry.activeRootIssuance) {
    throw new TypeError(
      "Workspace materialization ports may only be issued by the composition root."
    );
  }
  if (!isMaterializationPort(port)) {
    throw new TypeError(
      "A frozen agent workspace materialization port is required."
    );
  }
  if (materializationBrandRegistry.activeRootIssuance.port) {
    throw new TypeError(
      "A composition-root authority may issue only one workspace materialization port."
    );
  }
  materializationBrandRegistry.activeRootIssuance.port = port;
  return port;
}

export function assertAgentWorkspaceMaterializationPort(
  port?: unknown
): AgentWorkspaceMaterializationPort {
  if (!port || typeof port !== "object" || !materializationBrandRegistry.issuedPorts.has(port as AgentWorkspaceMaterializationPort)) {
    throw new TypeError(
      "A composition-issued agent workspace materialization port is required."
    );
  }
  return port as AgentWorkspaceMaterializationPort;
}
