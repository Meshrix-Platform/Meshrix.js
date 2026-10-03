export type ConsoleClientConnectionRow = {
  alignmentState?: string;
  connectionKind?: string;
  connectionMethod?: string;
  connectionDetail?: string;
  connectionStatusLabel?: string;
  connectionState?: string;
  configVersion?: string;
};

export type ClientAlignmentTone = "aligned" | "draining" | "offline" | "attention";
export type ClientStatusTone = ClientAlignmentTone | "online";
export type ClientConfigReportTone = "success" | "warning";

export const clientAlignmentStateLabels: Readonly<Record<string, string>> = Object.freeze({
  aligned: "已对齐",
  outdated: "待对齐",
  draining: "收尾中",
  "bootstrap-only": "仅引导",
  offline: "离线",
  unknown: "未知",
});

export function clientAlignmentTone(state = ""): ClientAlignmentTone {
  if (state === "aligned") return "aligned";
  if (state === "draining") return "draining";
  if (state === "offline") return "offline";
  return "attention";
}

export function clientConnectionMethodLabel(client: ConsoleClientConnectionRow): string {
  if (client.connectionKind === "mcp-plugin") {
    return "MCP 服务";
  }
  return String(client.connectionMethod || "meshrix-client 封装");
}

export function clientConnectionDetail(client: ConsoleClientConnectionRow): string {
  if (client.connectionKind === "mcp-plugin") {
    return "";
  }
  if (client.connectionDetail) {
    return String(client.connectionDetail);
  }
  return "Discovery Check-in";
}

export function clientStatusLabel(client: ConsoleClientConnectionRow): string {
  if (client.connectionKind === "mcp-plugin") {
    return String(client.connectionStatusLabel || "已配对");
  }
  return clientAlignmentStateLabels[String(client.alignmentState || "unknown")] || "未知";
}

export function clientStatusTone(client: ConsoleClientConnectionRow): ClientStatusTone {
  if (client.connectionKind !== "mcp-plugin") {
    return clientAlignmentTone(client.alignmentState);
  }

  if (
    client.connectionState === "disabled" ||
    client.connectionState === "revoked" ||
    client.connectionState === "offline"
  ) {
    return "offline";
  }
  if (client.connectionState === "pending") {
    return "attention";
  }
  return "online";
}

export function clientConfigReportLabel(client: ConsoleClientConnectionRow): string {
  return String(client.configVersion || "").trim() ? "已上报" : "未上报";
}

export function clientConfigReportTone(client: ConsoleClientConnectionRow): ClientConfigReportTone {
  return String(client.configVersion || "").trim() ? "success" : "warning";
}
