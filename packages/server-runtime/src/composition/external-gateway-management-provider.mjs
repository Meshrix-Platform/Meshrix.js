import path from "node:path";
import { atomicWriteJson, readJsonFile } from "#lico/state-coordinator";
import { createExternalGatewayAuthority } from "../../../agents/src/agent-gateway/external-gateway/index.mjs";
import { loadOrCreateMcpIdentity } from "./mcp-identity-provider.mjs";
import { probeExternalGatewayEndpoint } from "./external-gateway-endpoint-probe.mjs";

const STATE_FILE = "external-gateway.json";

export function createExternalGatewayManagementProvider({ externalGateway }) {
  if (!externalGateway || typeof externalGateway.getState !== "function") {
    throw new TypeError("External Gateway management requires a state authority.");
  }

  return Object.freeze({
    getState: () => externalGateway.getState(),
    listAdapters: () => externalGateway.listAdapters(),
    validate: (input = {}) => externalGateway.validate(input),
    apply: (input = {}) => externalGateway.apply(input),
    switchDirect: (input = {}) => externalGateway.switchDirect(input),
  });
}

export async function createPersistentExternalGatewayManagementProvider({ userDataPath, fetchImpl = globalThis.fetch }) {
  const statePath = path.join(userDataPath, "runtime", STATE_FILE);
  const [initialState, expectedIdentity] = await Promise.all([
    readJsonFile(statePath, { mode: "direct", generation: 0 }),
    loadOrCreateMcpIdentity(userDataPath),
  ]);
  const externalGateway = createExternalGatewayAuthority({
    initialState,
    persist: (state) => atomicWriteJson(statePath, state, { trailingNewline: false }),
    probe: ({ profile }) => probeExternalGatewayEndpoint({ profile, expectedIdentity, fetchImpl }),
  });
  return createExternalGatewayManagementProvider({ externalGateway });
}
