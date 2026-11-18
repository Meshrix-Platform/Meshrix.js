import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";

function stableJson(value?: any) : any {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key?: any) : any => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const sha256: any = (value?: any) : any => createHash("sha256").update(String(value)).digest("hex");

export function createArtifactSignerFixture() : any {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyJwk: any = createPublicKey(privateKey).export({ format: "jwk" });
  const keyId: any = `ed25519:${sha256(stableJson(publicKeyJwk)).slice(0, 32)}`;
  return Object.freeze({
    publicKey,
    publicKeyJwk,
    keyId,
    port: Object.freeze({
      id: "ArtifactSignerPort",
      async describe(input: Record<string, any> = {}) : Promise<any> {
        return { ok: true, keyId, publicKeyJwk, algorithm: "ed25519", payloadEncoding: "sha256-digest-utf8", purpose: input.purpose, revision: 1 };
      },
      async sign(input: Record<string, any> = {}) : Promise<any> {
        const contextDigest: any = `sha256:${sha256(stableJson(input.context || {}))}`;
        const signedEnvelope: Record<string, any> = { purpose: input.purpose, payloadDigest: input.payloadDigest, contextDigest };
        const signedAt: any = new Date().toISOString();
        return {
          ok: true,
          keyId,
          publicKeyJwk,
          algorithm: "ed25519",
          payloadEncoding: "sha256-digest-utf8",
          purpose: input.purpose,
          payloadDigest: input.payloadDigest,
          contextDigest,
          signedEnvelope,
          signature: sign(null, Buffer.from(stableJson(signedEnvelope)), privateKey).toString("base64url"),
          receipt: { receiptId: "fixture-receipt", keyId, purpose: input.purpose, payloadDigest: input.payloadDigest, contextDigest, signedAt, secretRevision: 1 }
        };
      }
    })
  });
}
