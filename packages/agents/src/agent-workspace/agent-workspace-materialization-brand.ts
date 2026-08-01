const MATERIALIZATION_BRAND_REGISTRY: any = Symbol.for(
  "meshrix.agent-workspace.materialization-brand-registry"
);
const materializationBrandRegistry: any = (() : any => {
  const globalRegistry: any = globalThis as any;
  if (!globalRegistry[MATERIALIZATION_BRAND_REGISTRY]) {
    Object.defineProperty(globalRegistry, MATERIALIZATION_BRAND_REGISTRY, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: {
        issuedPorts: new WeakSet<object>(),
        rootAuthorities: new WeakMap<object, any>(),
        activeRootIssuance: null
      }
    });
  }
  return globalRegistry[MATERIALIZATION_BRAND_REGISTRY];
})();

function requireRootAuthority(authority?: any) : any {
  const state: any = materializationBrandRegistry.rootAuthorities.get(authority);
  if (!state) {
    throw new TypeError(
      "A composition-root workspace materialization authority is required."
    );
  }
  return state;
}

export function createAgentWorkspaceMaterializationRootAuthority() : any {
  const authority: any = Object.freeze(Object.create(null));
  materializationBrandRegistry.rootAuthorities.set(authority, {
    status: "available",
    port: null
  });
  return authority;
}

export function assertAgentWorkspaceMaterializationRootAuthority(authority?: any) : any {
  const state: any = requireRootAuthority(authority);
  if (state.status !== "available") {
    throw new TypeError(
      "The composition-root workspace materialization authority is not available."
    );
  }
  return authority;
}

export function bindAgentWorkspaceMaterializationRootPort(
  authority?: any,
  createPort?: any
) : any {
  const state: any = requireRootAuthority(authority);
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

  const issuance: Record<string, any> = {
    authority,
    port: null
  };
  state.status = "binding";
  materializationBrandRegistry.activeRootIssuance = issuance;
  try {
    const port: any = createPort();
    if (
      port &&
      typeof port === "object" &&
      typeof port.then === "function"
    ) {
      throw new TypeError(
        "Workspace materialization port issuance must be synchronous."
      );
    }
    if (!issuance.port || issuance.port !== port) {
      throw new TypeError(
        "The workspace materialization port factory did not issue its exact result."
      );
    }
    materializationBrandRegistry.issuedPorts.add(port);
    state.port = port;
    state.status = "bound";
  } catch (error: any) {
    state.port = null;
    state.status = "failed";
    throw error;
  } finally {
    materializationBrandRegistry.activeRootIssuance = null;
  }
}

export function claimAgentWorkspaceMaterializationRootPort(authority?: any) : any {
  const state: any = requireRootAuthority(authority);
  if (state.status !== "bound" || !state.port) {
    throw new TypeError(
      "The composition-root workspace materialization port is unavailable."
    );
  }
  const port: any = state.port;
  state.port = null;
  state.status = "claimed";
  return port;
}

export function issueAgentWorkspaceMaterializationPort(port?: any) : any {
  if (!materializationBrandRegistry.activeRootIssuance) {
    throw new TypeError(
      "Workspace materialization ports may only be issued by the composition root."
    );
  }
  if (
    !port ||
    typeof port !== "object" ||
    !Object.isFrozen(port) ||
    typeof port.withRequest !== "function"
  ) {
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

export function assertAgentWorkspaceMaterializationPort(port?: any) : any {
  if (!materializationBrandRegistry.issuedPorts.has(port)) {
    throw new TypeError(
      "A composition-issued agent workspace materialization port is required."
    );
  }
  return port;
}
