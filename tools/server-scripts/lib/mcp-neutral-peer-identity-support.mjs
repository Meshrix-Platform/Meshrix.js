import fs from "node:fs/promises";
import path from "node:path";

import {
  discoverLicoHub
} from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/discovery.mjs";

export function installerProcessEnv(installerHome = "") {
  return {
    HOME: installerHome,
    USERPROFILE: installerHome,
    XDG_CONFIG_HOME: path.join(installerHome, ".config"),
    LICO_MCP_PROCESS_IDENTITY_STORE: "file"
  };
}

export async function saveInstallerProcessIdentity({
  installerHome = "",
  target = "neutral-peer",
  serverUrl = "",
  identity,
  payload,
  trackRedaction = () => {}
} = {}) {
  const clientIdentityPackage = payload?.processIdentity?.clientIdentityPackage || null;
  if (!clientIdentityPackage) {
    throw new Error("local grant did not return a process identity package for installer storage");
  }
  const discovered = await discoverLicoHub({ url: serverUrl });
  const handshakePayload = discovered?.handshake?.payload || {};
  const issuerIdentity = {
    keyId: String(handshakePayload.identity?.keyId || ""),
    publicKeyJwk: handshakePayload.identity?.publicKeyJwk || null,
    serverId: String(handshakePayload.server?.serverId || "")
  };
  if (!discovered?.ok || !issuerIdentity.keyId || !issuerIdentity.publicKeyJwk || !issuerIdentity.serverId) {
    throw new Error("installer verifier could not establish the stored credential issuer binding");
  }
  const dir = path.join(installerHome, ".lico", "mcp", "process-identity");
  const filePath = path.join(dir, `${target || "mcp"}.json`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify({
    schemaVersion: "v0.0.1:process-identity:mcp-file-1",
    target,
    baseUrl: serverUrl,
    savedAt: new Date().toISOString(),
    grantToken: String(payload?.token || ""),
    grantId: String(payload?.grant?.id || ""),
    tokenPrefix: String(payload?.tokenPrefix || payload?.grant?.tokenPrefix || ""),
    issuerIdentity,
    privateKeyPem: identity.keyPair.privateKeyPem,
    clientIdentityPackage,
    serverIdentity: payload.processIdentity?.serverIdentity || null,
    storageBackend: "private-file-fallback"
  }, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => {});
  trackRedaction(filePath);
}
