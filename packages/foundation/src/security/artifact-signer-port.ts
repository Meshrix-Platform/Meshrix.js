import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";

import { resolveLocalSecretPayload } from "./secrets/local-secret-store.ts";

export const ARTIFACT_SIGNER_PORT_ID: any = "ArtifactSignerPort";
export const ARTIFACT_SIGNER_ALGORITHM: any = "ed25519";
export const ARTIFACT_SIGNER_PAYLOAD_ENCODING: any = "sha256-digest-utf8";

function text(value: any = "") : any {
  return String(value ?? "").trim();
}

function record(value?: any, fallback: Record<string, any> | null = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}


function sha256(value?: any) : any {
  return createHash("sha256").update(String(value)).digest("hex");
}

function validateInput(input: Record<string, any> = {}, pluginId?: any, allowedPurposes?: any) : any {
  const source: any = record(input);
  const secretRef: any = text(source.secretRef);
  const purpose: any = text(source.purpose);
  const context: any = record(source.context, null);
  if (!secretRef || !purpose || !context) {
    const error: Error & Record<string, any> = new Error("Artifact signer request is incomplete.");
    error.code = "artifact_signer_request_invalid";
    throw error;
  }
  if (!allowedPurposes.has(purpose)) {
    const error: Error & Record<string, any> = new Error("Artifact signer purpose is not allowed.");
    error.code = "artifact_signer_purpose_denied";
    throw error;
  }
  return { secretRef, purpose, context };
}

function clearPrivateJwk(jwk: any = null) : any {
  if (!jwk || typeof jwk !== "object") return;
  for (const key of Object.keys(jwk)) {
    if (typeof jwk[key] === "string") jwk[key] = "";
    else if (jwk[key] && typeof jwk[key] === "object") clearPrivateJwk(jwk[key]);
  }
}

function keyFacts(privateKeyJwk?: any) : any {
  const privateKey: any = createPrivateKey({ key: privateKeyJwk, format: "jwk" });
  const publicKeyJwk: any = createPublicKey(privateKey).export({ format: "jwk" });
  const keyId: any = `ed25519:${sha256(stableJson(publicKeyJwk)).slice(0, 32)}`;
  return { privateKey, publicKeyJwk, keyId };
}

export function createArtifactSignerPort({
  dataDir = "",
  resolveSecretPayload = resolveLocalSecretPayload,
  secretKeyProvider = null,
  pluginId = "",
  serviceId = "",
  allowedPurposes = []
}: Record<string, any> = {}) : any {
  const boundPluginId: any = text(pluginId);
  const purposeGrant: any = new Set<any>(Array.isArray(allowedPurposes) ? allowedPurposes.map(text).filter(Boolean) : []);
  if (!text(dataDir) || typeof resolveSecretPayload !== "function" || !/^[a-z][a-z0-9-]*$/u.test(boundPluginId) || purposeGrant.size === 0 ||
      [...purposeGrant].some((purpose?: any) : any => !purpose.startsWith(`plugin-artifact.${boundPluginId}.`))) {
    throw new TypeError("Artifact signer custody is not configured.");
  }
  const boundServiceId: any = text(serviceId) || `plugin-artifact:${boundPluginId}`;

  async function withKey(input?: any, task?: any) : Promise<any> {
    const request: any = validateInput(input, boundPluginId, purposeGrant);
    const resolved: any = await resolveSecretPayload({
      dataDir,
      secretRef: request.secretRef,
      expectedScope: {
        serviceId: boundServiceId,
        requiredScopes: ["artifact:sign"],
        protocol: "artifact-signing"
      },
      keyProvider: secretKeyProvider
    });
    const payload: any = record(resolved.payload);
    const privateKeyJwk: any = payload.privateKeyJwk ? structuredClone(payload.privateKeyJwk) : null;
    if (!privateKeyJwk) {
      const error: Error & Record<string, any> = new Error("Artifact signing key material is unavailable.");
      error.code = "artifact_signer_key_unavailable";
      throw error;
    }
    try {
      const facts: any = keyFacts(privateKeyJwk);
      return await task({ request, facts, revision: Number(resolved.revision || 0) });
    } finally {
      clearPrivateJwk(privateKeyJwk);
    }
  }

  return Object.freeze({
    id: ARTIFACT_SIGNER_PORT_ID,
    async describe(input: Record<string, any> = {}) : Promise<any> {
      return withKey(input, async ({ request, facts, revision }: Record<string, any>) : Promise<any> => Object.freeze({
        ok: true,
        keyId: facts.keyId,
        publicKeyJwk: Object.freeze({ ...facts.publicKeyJwk }),
        algorithm: ARTIFACT_SIGNER_ALGORITHM,
        payloadEncoding: ARTIFACT_SIGNER_PAYLOAD_ENCODING,
        purpose: request.purpose,
        revision
      }));
    },
    async sign(input: Record<string, any> = {}) : Promise<any> {
      const payloadDigest: any = text(input.payloadDigest);
      if (!/^sha256:[0-9a-f]{64}$/u.test(payloadDigest)) {
        const error: Error & Record<string, any> = new Error("Artifact signer payload digest is invalid.");
        error.code = "artifact_signer_payload_digest_invalid";
        throw error;
      }
      return withKey(input, async ({ request, facts, revision }: Record<string, any>) : Promise<any> => {
        const contextDigest: any = `sha256:${sha256(stableJson(request.context))}`;
        const signedEnvelope: Readonly<Record<string, any>> = Object.freeze({ purpose: request.purpose, payloadDigest, contextDigest });
        const bytes: any = Buffer.from(stableJson(signedEnvelope), "utf8");
        try {
          const signature: any = sign(null, bytes, facts.privateKey).toString("base64url");
          const signedAt: any = new Date().toISOString();
          return Object.freeze({
            ok: true,
            keyId: facts.keyId,
            publicKeyJwk: Object.freeze({ ...facts.publicKeyJwk }),
            algorithm: ARTIFACT_SIGNER_ALGORITHM,
            payloadEncoding: ARTIFACT_SIGNER_PAYLOAD_ENCODING,
            purpose: request.purpose,
            payloadDigest,
            contextDigest,
            signedEnvelope,
            signature,
            receipt: Object.freeze({
              receiptId: `artifact-signature:${sha256(`${facts.keyId}\0${request.purpose}\0${payloadDigest}\0${signedAt}`)}`,
              keyId: facts.keyId,
              purpose: request.purpose,
              payloadDigest,
              contextDigest,
              signedAt,
              secretRevision: revision
            })
          });
        } finally {
          bytes.fill(0);
        }
      });
    }
  });
}
