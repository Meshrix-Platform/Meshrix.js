const MESHRIX_CLIENT_CONNECTION = {
  kind: "meshrix-client",
  method: "meshrix-client 封装",
  state: "active",
  statusLabel: ""
};

const MCP_PLUGIN_CONNECTION = {
  kind: "mcp-plugin"
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value) {
  return String(value || "").trim();
}

function normalizeLicoClientRow(item) {
  const alignmentState = compactText(item.alignmentState) || "unknown";
  return {
    ...item,
    connectionKind: compactText(item.connectionKind) || MESHRIX_CLIENT_CONNECTION.kind,
    connectionMethod: compactText(item.connectionMethod) || MESHRIX_CLIENT_CONNECTION.method,
    connectionState: compactText(item.connectionState) || (alignmentState === "offline" ? "offline" : MESHRIX_CLIENT_CONNECTION.state),
    connectionStatusLabel: compactText(item.connectionStatusLabel) || MESHRIX_CLIENT_CONNECTION.statusLabel,
    supportsAlignment: item.supportsAlignment !== false
  };
}

function buildClientConnectionSummary(items) {
  return {
    totalCount: items.length,
    alignedCount: items.filter((item) => item.alignmentState === "aligned").length,
    outdatedCount: items.filter((item) => item.alignmentState === "outdated").length,
    drainingCount: items.filter((item) => item.alignmentState === "draining").length,
    bootstrapOnlyCount: items.filter((item) => item.alignmentState === "bootstrap-only").length,
    offlineCount: items.filter((item) => item.alignmentState === "offline").length,
    unknownCount: items.filter((item) => item.alignmentState === "unknown").length,
    meshrixClientCount: items.filter((item) => item.connectionKind === MESHRIX_CLIENT_CONNECTION.kind).length,
    mcpPluginCount: items.filter((item) => item.connectionKind === MCP_PLUGIN_CONNECTION.kind).length,
    alignableCount: items.filter((item) => item.supportsAlignment !== false).length
  };
}

export function buildClientConnectionList(clientRegistrations, additionalConnectionRows = []) {
  const meshrixClientRows = asArray(clientRegistrations?.items).map(normalizeLicoClientRow);
  const mcpRows = asArray(additionalConnectionRows);
  const items = [...meshrixClientRows, ...mcpRows].sort((left, right) =>
    compactText(right.lastSeenAt).localeCompare(compactText(left.lastSeenAt))
  );
  return {
    summary: buildClientConnectionSummary(items),
    items
  };
}
