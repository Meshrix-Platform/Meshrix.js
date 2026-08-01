import fs from "node:fs/promises";
import path from "node:path";

import {
  discoverMeshrixHub
} from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/discovery.ts";

export function installerProcessEnv(installerHome: any = "") : any {
  return {
    HOME: installerHome,
    USERPROFILE: installerHome,
    XDG_CONFIG_HOME: path.join(installerHome, ".config"),
    MESHRIX_MCP_PROCESS_IDENTITY_STORE: "file"
  };
}

export async function saveInstallerProcessIdentity({
  installerHome = "",
  target = "neutral-peer",
  serverUrl = "",
  identity,
  payload,
  trackRedaction = () : any => {}
}: Record<string, any> = {}) : Promise<any> {
  const clientIdentityPackage: any = payload?.processIdentity?.clientIdentityPackage || null;
  if (!clientIdentityPackage) {
    throw new Error("local grant did not return a process identity package for installer storage");
  }
  const discovered: any = await discoverMeshrixHub({ url: serverUrl });
  const handshakePayload: any = discovered?.handshake?.payload || {};
  const issuerIdentity: Record<string, any> = {
    keyId: String(handshakePayload.identity?.keyId || ""),
    publicKeyJwk: handshakePayload.identity?.publicKeyJwk || null,
    serverId: String(handshakePayload.server?.serverId || "")
  };
  if (!discovered?.ok || !issuerIdentity.keyId || !issuerIdentity.publicKeyJwk || !issuerIdentity.serverId) {
    throw new Error("installer verifier could not establish the stored credential issuer binding");
  }
  const dir: any = path.join(installerHome, ".meshrix", "mcp", "process-identity");
  const filePath: any = path.join(dir, `${target || "mcp"}.json`);
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
  await fs.chmod(filePath, 0o600).catch(() : any => {});
  trackRedaction(filePath);
}
