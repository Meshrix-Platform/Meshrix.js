import { asArray, asObject, asText, lowerToken, publicMetadata, uniqueStrings } from "./identity-helpers.ts";

function normalizeMcp(value?: any, frameworkId?: any, inheritedCommands?: any) : any {
  const mcp: any = asObject(value, null);
  if (!mcp) throw new TypeError(`Downstream framework ${frameworkId} requires an MCP adapter.`);
  const adapterId: any = lowerToken(mcp.adapterId);
  const profileId: any = asText(mcp.profileId);
  const installMode: any = lowerToken(mcp.installMode);
  const locations: any = uniqueStrings(asArray(mcp.locations).map(lowerToken));
  const configurationStrategy: any = lowerToken(mcp.configurationStrategy);
  if (!adapterId || !profileId || !installMode || locations.length === 0 || !configurationStrategy) {
    throw new TypeError(`Downstream framework ${frameworkId} MCP adapter is incomplete.`);
  }
  return Object.freeze({
    adapterId,
    profileId,
    installMode,
    locations: Object.freeze(locations),
    configurationStrategy,
    serverName: asText(mcp.serverName, "meshrix"),
    commandNames: Object.freeze(uniqueStrings([...inheritedCommands, ...asArray(mcp.commandNames)])),
    metadata: Object.freeze({ public: Object.freeze(publicMetadata(mcp.metadata)) })
  });
}

export function normalizeFrameworkDefinition(value: Record<string, any> = {}) : any {
  const framework: any = asObject(value);
  const frameworkId: any = lowerToken(framework.frameworkId);
  const label: any = asText(framework.label);
  const kind: any = lowerToken(framework.kind);
  const commandNames: any = uniqueStrings(asArray(framework.commandNames));
  if (!frameworkId || !label || !kind || commandNames.length === 0) {
    throw new TypeError("Downstream MCP framework definition is incomplete.");
  }
  return Object.freeze({
    frameworkId,
    label,
    kind,
    commandNames: Object.freeze(commandNames),
    mcp: normalizeMcp(framework.mcp, frameworkId, commandNames)
  });
}

export function defaultDownstreamClientFrameworks(overrides: any = []) : any {
  return Object.freeze(asArray(overrides).map((entry?: any) : any => normalizeFrameworkDefinition(asObject(entry))));
}
