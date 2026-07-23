import { createSignedMcpHeaders } from "../mcp-process-identity-test-helper.mjs";

export function createProtocolConsistencyTokenHeaders({
  identityByToken,
  serverUrl,
  agentProfileId
} = {}) {
  const absoluteUrl = (routeOrUrl) => String(routeOrUrl).startsWith("http")
    ? String(routeOrUrl)
    : `${serverUrl()}${routeOrUrl}`;

  return function tokenHeaders(token, {
    method = "POST",
    route = "/",
    body = "",
    extraHeaders = {}
  } = {}) {
    const binding = identityByToken.get(token);
    const baseHeaders = binding
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
          "X-LicoMesh-Api-Key": token,
          "X-Lico-MCP-Target": "codex"
        };
    return {
      ...baseHeaders,
      Authorization: `Bearer ${token}`,
      "X-Lico-Agent-Profile-Id": agentProfileId,
      ...extraHeaders
    };
  };
}

export function parseMcpSseBlock(block = "") {
  const dataLines = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());
  if (!dataLines.length) {
    return null;
  }
  try {
    return JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }
}
