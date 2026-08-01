import path from "node:path";
import { atomicWriteJson, readJsonFile } from "#meshrix/state-coordinator";
import { createExternalGatewayAuthority } from "#meshrix/agents/agent-gateway/external-gateway/index";
import { loadOrCreateMcpIdentity } from "./mcp-identity-provider.ts";
import { probeExternalGatewayEndpoint } from "./external-gateway-endpoint-probe.ts";

const STATE_FILE: any = "external-gateway.json";

export function createExternalGatewayManagementProvider({ externalGateway }: Record<string, any>) : any {
  if (!externalGateway || typeof externalGateway.getState !== "function") {
    throw new TypeError("External Gateway management requires a state authority.");
  }

  return Object.freeze({
    getState: () : any => externalGateway.getState(),
    listAdapters: () : any => externalGateway.listAdapters(),
    validate: (input: Record<string, any> = {}) : any => externalGateway.validate(input),
    apply: (input: Record<string, any> = {}) : any => externalGateway.apply(input),
    switchDirect: (input: Record<string, any> = {}) : any => externalGateway.switchDirect(input),
  });
}

export async function createPersistentExternalGatewayManagementProvider({ userDataPath, fetchImpl = globalThis.fetch }: Record<string, any>) : Promise<any> {
  const statePath: any = path.join(userDataPath, "runtime", STATE_FILE);
  const [initialState, expectedIdentity] = await Promise.all([
    readJsonFile(statePath, { mode: "direct", generation: 0 }),
    loadOrCreateMcpIdentity(userDataPath),
  ]);
  const externalGateway: any = createExternalGatewayAuthority({
    initialState,
    persist: (state?: any) : any => atomicWriteJson(statePath, state, { trailingNewline: false }),
    probe: ({ profile }: Record<string, any>) : any => probeExternalGatewayEndpoint({ profile, expectedIdentity, fetchImpl }),
  });
  return createExternalGatewayManagementProvider({ externalGateway });
}
