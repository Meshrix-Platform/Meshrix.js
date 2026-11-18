const MESHRIX_CLIENT_CONNECTION: Record<string, any> = {
  kind: "meshrix-client",
  method: "meshrix-client 封装",
  state: "active",
  statusLabel: ""
};

const MCP_PLUGIN_CONNECTION: Record<string, any> = {
  kind: "mcp-plugin"
};

function asArray(value?: any) : any {
  return Array.isArray(value) ? value : [];
}

function compactText(value?: any) : any {
  return String(value || "").trim();
}

function normalizeMeshrixClientRow(item?: any) : any {
  const alignmentState: any = compactText(item.alignmentState) || "unknown";
  return {
    ...item,
    connectionKind: compactText(item.connectionKind) || MESHRIX_CLIENT_CONNECTION.kind,
    connectionMethod: compactText(item.connectionMethod) || MESHRIX_CLIENT_CONNECTION.method,
    connectionState: compactText(item.connectionState) || (alignmentState === "offline" ? "offline" : MESHRIX_CLIENT_CONNECTION.state),
    connectionStatusLabel: compactText(item.connectionStatusLabel) || MESHRIX_CLIENT_CONNECTION.statusLabel,
    supportsAlignment: item.supportsAlignment !== false
  };
}

function buildClientConnectionSummary(items?: any) : any {
  return {
    totalCount: items.length,
    alignedCount: items.filter((item?: any) : any => item.alignmentState === "aligned").length,
    outdatedCount: items.filter((item?: any) : any => item.alignmentState === "outdated").length,
    drainingCount: items.filter((item?: any) : any => item.alignmentState === "draining").length,
    bootstrapOnlyCount: items.filter((item?: any) : any => item.alignmentState === "bootstrap-only").length,
    offlineCount: items.filter((item?: any) : any => item.alignmentState === "offline").length,
    unknownCount: items.filter((item?: any) : any => item.alignmentState === "unknown").length,
    meshrixClientCount: items.filter((item?: any) : any => item.connectionKind === MESHRIX_CLIENT_CONNECTION.kind).length,
    mcpPluginCount: items.filter((item?: any) : any => item.connectionKind === MCP_PLUGIN_CONNECTION.kind).length,
    alignableCount: items.filter((item?: any) : any => item.supportsAlignment !== false).length
  };
}

export function buildClientConnectionList(clientRegistrations?: any, additionalConnectionRows: any = []) : any {
  const meshrixClientRows: any = asArray(clientRegistrations?.items).map(normalizeMeshrixClientRow);
  const mcpRows: any = asArray(additionalConnectionRows);
  const items: any = [...meshrixClientRows, ...mcpRows].sort((left?: any, right?: any) : any =>
    compactText(right.lastSeenAt).localeCompare(compactText(left.lastSeenAt))
  );
  return {
    summary: buildClientConnectionSummary(items),
    items
  };
}
