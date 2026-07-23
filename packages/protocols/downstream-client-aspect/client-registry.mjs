import { asArray, asObject, asText, lowerToken, publicMetadata, uniqueStrings } from "./identity-helpers.mjs";

function normalizeMcp(value, frameworkId, inheritedCommands) {
  const mcp = asObject(value, null);
  if (!mcp) throw new TypeError(`Downstream framework ${frameworkId} requires an MCP adapter.`);
  const adapterId = lowerToken(mcp.adapterId);
  const profileId = asText(mcp.profileId);
  const installMode = lowerToken(mcp.installMode);
  const locations = uniqueStrings(asArray(mcp.locations).map(lowerToken));
  const configurationStrategy = lowerToken(mcp.configurationStrategy);
  if (!adapterId || !profileId || !installMode || locations.length === 0 || !configurationStrategy) {
    throw new TypeError(`Downstream framework ${frameworkId} MCP adapter is incomplete.`);
  }
  return Object.freeze({
    adapterId,
    profileId,
    installMode,
    locations: Object.freeze(locations),
    configurationStrategy,
    serverName: asText(mcp.serverName, "lico"),
    commandNames: Object.freeze(uniqueStrings([...inheritedCommands, ...asArray(mcp.commandNames)])),
    metadata: Object.freeze({ public: Object.freeze(publicMetadata(mcp.metadata)) })
  });
}

export function normalizeFrameworkDefinition(value = {}) {
  const framework = asObject(value);
  const frameworkId = lowerToken(framework.frameworkId);
  const label = asText(framework.label);
  const kind = lowerToken(framework.kind);
  const commandNames = uniqueStrings(asArray(framework.commandNames));
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

export function defaultDownstreamClientFrameworks(overrides = []) {
  return Object.freeze(asArray(overrides).map((entry) => normalizeFrameworkDefinition(asObject(entry))));
}
