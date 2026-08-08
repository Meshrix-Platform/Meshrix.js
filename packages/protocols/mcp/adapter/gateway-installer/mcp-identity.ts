import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { canonicalJson as stableStringify } from "#meshrix/contracts/serialization/canonical-json";

export const MCP_IDENTITY_SCHEMA_VERSION: any = "v0.0.1:mcp:identity-1";
export const MCP_HANDSHAKE_SCHEMA_VERSION: any = "v0.0.1:mcp:handshake-1";

export { stableStringify };

export function publicMcpIdentity(identity?: any) : any {
  return {
    schemaVersion: MCP_IDENTITY_SCHEMA_VERSION,
    algorithm: "Ed25519",
    keyId: identity.keyId,
    publicKeyJwk: identity.publicKeyJwk
  };
}

export function buildMcpHandshakePayload({
  nonce,
  issuedAt,
  identity,
  discovery,
  baseUrl,
  vmBaseUrl,
  externalGateway = null
}: Record<string, any>) : any {
  return {
    schemaVersion: MCP_HANDSHAKE_SCHEMA_VERSION,
    nonce,
    issuedAt,
    identity: publicMcpIdentity(identity),
    server: {
      name: "Meshrix.js",
      serverId: discovery?.serverId || "",
      serverVersion: discovery?.serverVersion || "",
      interfaceVersion: discovery?.interfaceVersion || "",
      toolsetVersion: discovery?.toolsetVersion || "",
      stableToolName: discovery?.stableToolName || ""
    },
    endpoints: {
      baseUrl,
      mcpUrl: `${baseUrl}/mcp`,
      discoveryUrl: `${baseUrl}/api/mcp/discovery`,
      wellKnownUrl: `${baseUrl}/.well-known/meshrix/mcp.json`,
      vmMcpUrl: `${vmBaseUrl}/mcp`
    },
    sharedHub: discovery?.sharedHub || null,
    ...(externalGateway ? { externalGateway } : {})
  };
}

export function signMcpHandshake({ identity, payload }: Record<string, any>) : any {
  const privateKey: any = createPrivateKey({ key: identity.privateKeyJwk, format: "jwk" });
  return {
    algorithm: "Ed25519",
    payloadEncoding: "v0.0.1:platform:stable-json-1",
    value: sign(null, Buffer.from(stableStringify(payload)), privateKey).toString("base64url")
  };
}

export function verifyMcpHandshakeSignature({ publicKeyJwk, payload, signature }: Record<string, any>) : any {
  const publicKey: any = createPublicKey({ key: publicKeyJwk, format: "jwk" });
  return verify(
    null,
    Buffer.from(stableStringify(payload)),
    publicKey,
    Buffer.from(String(signature || ""), "base64url")
  );
}
