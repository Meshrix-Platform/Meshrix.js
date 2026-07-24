import {
  createSignedMcpHeaders,
  createVerifierMcpProcessIdentity
} from "../mcp-process-identity-test-helper.mjs";

export function createVerifierLocalMcpGrantIdentity({ target = "codex", label = "verifier" } = {}) {
  const identity = createVerifierMcpProcessIdentity({ target, label });
  return {
    identity,
    request: identity.request
  };
}

export function bindVerifierLocalMcpGrantIdentity({
  identityByToken,
  token,
  identity,
  payload
} = {}) {
  const clientIdentityPackage = payload?.processIdentity?.clientIdentityPackage || null;
  if (!clientIdentityPackage) {
    throw new Error("local MCP grant did not return a process identity package");
  }
  identityByToken.set(token, {
    identity,
    clientIdentityPackage,
    payload
  });
}

export function verifierMcpRequestHeaders({
  identityByToken,
  token = "",
  target = "codex",
  method = "POST",
  url,
  body = "",
  extraHeaders = {}
} = {}) {
  if (!token) {
    return {
      "Content-Type": "application/json",
      ...extraHeaders
    };
  }
  const binding = identityByToken?.get(token);
  const baseHeaders = binding
    ? createSignedMcpHeaders({
        token,
        target,
        privateKeyPem: binding.identity.keyPair.privateKeyPem,
        clientIdentityPackage: binding.clientIdentityPackage,
        method,
        url,
        body
      })
    : {
        "Content-Type": "application/json",
        "X-Meshrix-Api-Key": token,
        "X-Meshrix-MCP-Target": target
      };
  return {
    ...baseHeaders,
    Authorization: `Bearer ${token}`,
    ...extraHeaders
  };
}
