import { canonicalJson as stableStringify } from "#meshrix/contracts/serialization/canonical-json";
export declare const MCP_IDENTITY_SCHEMA_VERSION: any;
export declare const MCP_HANDSHAKE_SCHEMA_VERSION: any;
export { stableStringify };
export declare function publicMcpIdentity(identity?: any): any;
export declare function buildMcpHandshakePayload({ nonce, issuedAt, identity, discovery, baseUrl, vmBaseUrl, externalGateway }: Record<string, any>): any;
export declare function signMcpHandshake({ identity, payload }: Record<string, any>): any;
export declare function verifyMcpHandshakeSignature({ publicKeyJwk, payload, signature }: Record<string, any>): any;
//# sourceMappingURL=mcp-identity.d.ts.map