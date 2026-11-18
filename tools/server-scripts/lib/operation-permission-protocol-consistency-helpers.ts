export function createProtocolConsistencyTokenHeaders({
  agentProfileId
}: Record<string, any> = {}) : any {
  return function tokenHeaders(token?: any, {
    extraHeaders = {}
  }: Record<string, any> = {}) : any {
    const credential: any = String(token || "");
    const credentialHeaders: any = credential.startsWith("mxak1.")
      ? { "X-Meshrix.js-Api-Key": credential }
      : credential
        ? { Authorization: `Bearer ${credential}` }
        : {};
    return {
      "Content-Type": "application/json",
      ...credentialHeaders,
      "X-Meshrix.js-MCP-Target": "codex",
      "X-Meshrix.js-Agent-Profile-Id": agentProfileId,
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
