import { createSignedMcpHeaders } from "../mcp-process-identity-test-helper.ts";

export function createProtocolConsistencyTokenHeaders({
  identityByToken,
  serverUrl,
  agentProfileId
}: Record<string, any> = {}) : any {
  const absoluteUrl: any = (routeOrUrl?: any) : any => String(routeOrUrl).startsWith("http")
    ? String(routeOrUrl)
    : `${serverUrl()}${routeOrUrl}`;

  return function tokenHeaders(token?: any, {
    method = "POST",
    route = "/",
    body = "",
    extraHeaders = {}
  }: Record<string, any> = {}) : any {
    const binding: any = identityByToken.get(token);
    const baseHeaders: any = binding
      ? createSignedMcpHeaders({
          token,
          target: "codex",
          privateKeyPem: binding.identity.keyPair.privateKeyPem,
          clientIdentityPackage: binding.clientIdentityPackage,
          method,
          url: absoluteUrl(route),
          body
        })
      : {
          "Content-Type": "application/json",
          "X-Meshrix-Api-Key": token,
          "X-Meshrix-MCP-Target": "codex"
        };
    return {
      ...baseHeaders,
      Authorization: `Bearer ${token}`,
      "X-Meshrix-Agent-Profile-Id": agentProfileId,
      ...extraHeaders
    };
  };
}

export function parseMcpSseBlock(block: any = "") : any {
  const dataLines: any = block
    .split(/\r?\n/)
    .filter((line?: any) : any => line.startsWith("data:"))
    .map((line?: any) : any => line.slice("data:".length).trim());
  if (!dataLines.length) {
    return null;
  }
  try {
    return JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }
}
