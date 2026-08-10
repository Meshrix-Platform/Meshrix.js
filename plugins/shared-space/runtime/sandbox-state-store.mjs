import crypto from "node:crypto";

const STATE_RESOURCE = "sandbox-state.json";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function initialState() {
  return {
    schemaVersion: "v0.0.1:shared-space:sandbox-state-1",
    snapshots: {},
    proposals: {}
  };
}

function requirePluginData(pluginData) {
  if (!pluginData || typeof pluginData.readFile !== "function" || typeof pluginData.writeFile !== "function") {
    throw new TypeError("Shared Space requires an opaque plugin data capability.");
  }
  return pluginData;
}

function clone(value) {
  return structuredClone(value);
}

export function canonicalDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function contentDigest(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function createSandboxStateStore({ pluginData } = {}) {
  const data = requirePluginData(pluginData);
  let cachedState = null;
  let operationTail = Promise.resolve();

  function schedule(operation) {
    const scheduled = operationTail.then(operation, operation);
    operationTail = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  async function loadState() {
    if (cachedState) return cachedState;
    let parsed;
    try {
      parsed = asObject(JSON.parse(await data.readFile(STATE_RESOURCE, "utf8")));
    } catch (error) {
      if (error?.code !== "PLUGIN_DATA_NOT_FOUND") throw error;
      parsed = initialState();
    }
    cachedState = {
      ...initialState(),
      ...parsed,
      snapshots: asObject(parsed.snapshots),
      proposals: asObject(parsed.proposals)
    };
    return cachedState;
  }

  async function persist(nextState) {
    await data.writeFile(STATE_RESOURCE, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
    cachedState = nextState;
  }

  function readCollection(collection, key) {
    return schedule(async () => {
      const state = await loadState();
      const value = state[collection][String(key || "")];
      return value ? clone(value) : null;
    });
  }

  function insert(collection, key, value) {
    return schedule(async () => {
      const state = await loadState();
      if (Object.hasOwn(state[collection], key)) {
        throw new Error(`Shared Space ${collection} identity already exists.`);
      }
      const nextState = clone(state);
      nextState[collection][key] = clone(value);
      await persist(nextState);
      return clone(value);
    });
  }

  return Object.freeze({
    getProposal(proposalRef) {
      return readCollection("proposals", proposalRef);
    },
    getSnapshot(snapshotHandle) {
      return readCollection("snapshots", snapshotHandle);
    },
    insertProposal(proposal) {
      return insert("proposals", proposal.proposalRef, proposal);
    },
    insertSnapshot(snapshot) {
      return insert("snapshots", snapshot.snapshotHandle, snapshot);
    },
    updateProposal(proposalRef, update, { expectedStatus = "" } = {}) {
      return schedule(async () => {
        const state = await loadState();
        const key = String(proposalRef || "");
        const current = state.proposals[key];
        if (!current) return null;
        if (expectedStatus && current.status !== expectedStatus) {
          const error = new Error("Shared Space proposal changed before its state transition.");
          error.code = "shared_space_proposal_transition_conflict";
          error.status = 409;
          throw error;
        }
        const next = { ...current, ...clone(update), updatedAt: new Date().toISOString() };
        const nextState = clone(state);
        nextState.proposals[key] = next;
        await persist(nextState);
        return clone(next);
      });
    },
    async close() {
      await operationTail;
    }
  });
}
