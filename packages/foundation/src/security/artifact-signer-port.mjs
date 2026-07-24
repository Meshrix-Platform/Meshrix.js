import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";

import { resolveLocalSecretPayload } from "./secrets/local-secret-store.mjs";

export const ARTIFACT_SIGNER_PORT_ID = "ArtifactSignerPort";
export const ARTIFACT_SIGNER_ALGORITHM = "ed25519";
export const ARTIFACT_SIGNER_PAYLOAD_ENCODING = "sha256-digest-utf8";

function text(value = "") {
  return String(value ?? "").trim();
}

function record(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}


function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function validateInput(input = {}, pluginId, allowedPurposes) {
  const source = record(input);
  const secretRef = text(source.secretRef);
  const purpose = text(source.purpose);
  const context = record(source.context, null);
  if (!secretRef || !purpose || !context) {
    const error = new Error("Artifact signer request is incomplete.");
    error.code = "artifact_signer_request_invalid";
    throw error;
  }
  if (!allowedPurposes.has(purpose)) {
    const error = new Error("Artifact signer purpose is not allowed.");
    error.code = "artifact_signer_purpose_denied";
    throw error;
  }
  return { secretRef, purpose, context };
}

function clearPrivateJwk(jwk = null) {
  if (!jwk || typeof jwk !== "object") return;
  for (const key of Object.keys(jwk)) {
    if (typeof jwk[key] === "string") jwk[key] = "";
    else if (jwk[key] && typeof jwk[key] === "object") clearPrivateJwk(jwk[key]);
  }
}

function keyFacts(privateKeyJwk) {
  const privateKey = createPrivateKey({ key: privateKeyJwk, format: "jwk" });
  const publicKeyJwk = createPublicKey(privateKey).export({ format: "jwk" });
  const keyId = `ed25519:${sha256(stableJson(publicKeyJwk)).slice(0, 32)}`;
  return { privateKey, publicKeyJwk, keyId };
}

export function createArtifactSignerPort({
  dataDir = "",
  resolveSecretPayload = resolveLocalSecretPayload,
  pluginId = "",
  serviceId = "",
  allowedPurposes = []
} = {}) {
  const boundPluginId = text(pluginId);
  const purposeGrant = new Set(Array.isArray(allowedPurposes) ? allowedPurposes.map(text).filter(Boolean) : []);
  if (!text(dataDir) || typeof resolveSecretPayload !== "function" || !/^[a-z][a-z0-9-]*$/u.test(boundPluginId) || purposeGrant.size === 0 ||
      [...purposeGrant].some((purpose) => !purpose.startsWith(`plugin-artifact.${boundPluginId}.`))) {
    throw new TypeError("Artifact signer custody is not configured.");
  }
  const boundServiceId = text(serviceId) || `plugin-artifact:${boundPluginId}`;

  async function withKey(input, task) {
    const request = validateInput(input, boundPluginId, purposeGrant);
    const resolved = await resolveSecretPayload({
      dataDir,
      secretRef: request.secretRef,
      expectedScope: {
        serviceId: boundServiceId,
        requiredScopes: ["artifact:sign"],
        protocol: "artifact-signing"
      }
    });
    const payload = record(resolved.payload);
    const privateKeyJwk = payload.privateKeyJwk ? structuredClone(payload.privateKeyJwk) : null;
    if (!privateKeyJwk) {
      const error = new Error("Artifact signing key material is unavailable.");
      error.code = "artifact_signer_key_unavailable";
      throw error;
    }
    try {
      const facts = keyFacts(privateKeyJwk);
      return await task({ request, facts, revision: Number(resolved.revision || 0) });
    } finally {
      clearPrivateJwk(privateKeyJwk);
    }
  }

  return Object.freeze({
    id: ARTIFACT_SIGNER_PORT_ID,
    async describe(input = {}) {
      return withKey(input, async ({ request, facts, revision }) => Object.freeze({
        ok: true,
        keyId: facts.keyId,
        publicKeyJwk: Object.freeze({ ...facts.publicKeyJwk }),
        algorithm: ARTIFACT_SIGNER_ALGORITHM,
        payloadEncoding: ARTIFACT_SIGNER_PAYLOAD_ENCODING,
        purpose: request.purpose,
        revision
      }));
    },
    async sign(input = {}) {
      const payloadDigest = text(input.payloadDigest);
      if (!/^sha256:[0-9a-f]{64}$/u.test(payloadDigest)) {
        const error = new Error("Artifact signer payload digest is invalid.");
        error.code = "artifact_signer_payload_digest_invalid";
        throw error;
      }
      return withKey(input, async ({ request, facts, revision }) => {
        const contextDigest = `sha256:${sha256(stableJson(request.context))}`;
        const signedEnvelope = Object.freeze({ purpose: request.purpose, payloadDigest, contextDigest });
        const bytes = Buffer.from(stableJson(signedEnvelope), "utf8");
        try {
          const signature = sign(null, bytes, facts.privateKey).toString("base64url");
          const signedAt = new Date().toISOString();
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
