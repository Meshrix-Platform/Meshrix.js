import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import type { JsonWebKey, JsonWebKeyInput, KeyObject } from "node:crypto";

import { resolveLocalSecretPayload } from "./secrets/local-secret-store.ts";
import type { LocalSecretKeyProvider } from "./secrets/local-secret-key-provider.ts";

export const ARTIFACT_SIGNER_PORT_ID = "ArtifactSignerPort";
export const ARTIFACT_SIGNER_ALGORITHM = "ed25519";
export const ARTIFACT_SIGNER_PAYLOAD_ENCODING = "sha256-digest-utf8";

type DataRecord = Record<string, unknown>;
interface SignerRequest { secretRef: string; purpose: string; context: DataRecord; }
interface KeyFacts { privateKey: KeyObject; publicKeyJwk: JsonWebKey; keyId: string; }
interface PrivateJwkRecord extends DataRecord { kty: string; crv: string; x: string; d: string; }
interface ResolvedSecret { payload?: unknown; revision?: number; }
type SecretResolver = (input: {
  dataDir: string;
  secretRef: string;
  expectedScope: { serviceId: string; requiredScopes: string[]; protocol: string };
  keyProvider: LocalSecretKeyProvider | null;
}) => Promise<ResolvedSecret>;
interface ArtifactSignerOptions {
  dataDir?: string;
  resolveSecretPayload?: SecretResolver;
  secretKeyProvider?: LocalSecretKeyProvider | null;
  pluginId?: string;
  serviceId?: string;
  allowedPurposes?: unknown[];
}

function text(value: unknown = ""): string {
  return String(value ?? "").trim();
}

function record(value: unknown, fallback: DataRecord | null = {}): DataRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as DataRecord : fallback;
}


function sha256(value: unknown = ""): string {
  return createHash("sha256").update(String(value)).digest("hex");
}

function validateInput(input: DataRecord = {}, allowedPurposes: ReadonlySet<string>): SignerRequest {
  const source = record(input) ?? {};
  const secretRef = text(source.secretRef);
  const purpose = text(source.purpose);
  const context = record(source.context, null);
  if (!secretRef || !purpose || !context) {
    const error = Object.assign(new Error("Artifact signer request is incomplete."), { code: "artifact_signer_request_invalid" });
    throw error;
  }
  if (!allowedPurposes.has(purpose)) {
    const error = Object.assign(new Error("Artifact signer purpose is not allowed."), { code: "artifact_signer_purpose_denied" });
    throw error;
  }
  return { secretRef, purpose, context };
}

function clearPrivateJwk(jwk: DataRecord | null = null): void {
  if (!jwk || typeof jwk !== "object") return;
  for (const key of Object.keys(jwk)) {
    if (typeof jwk[key] === "string") jwk[key] = "";
    else {
      const nested = record(jwk[key], null);
      if (nested) clearPrivateJwk(nested);
    }
  }
}

function privateJwkRecord(value: unknown): PrivateJwkRecord | null {
  const source = record(value, null);
  if (!source || source.kty !== "OKP" || source.crv !== "Ed25519" ||
      typeof source.x !== "string" || typeof source.d !== "string") {
    return null;
  }
  return { ...source, kty: source.kty, crv: source.crv, x: source.x, d: source.d };
}

function keyFacts(privateKeyJwk: PrivateJwkRecord): KeyFacts {
  const key: JsonWebKey = {
    kty: privateKeyJwk.kty,
    crv: privateKeyJwk.crv,
    x: privateKeyJwk.x,
    d: privateKeyJwk.d
  };
  const keyInput: JsonWebKeyInput = { key, format: "jwk" };
  const privateKey = createPrivateKey(keyInput);
  const publicKeyJwk = createPublicKey(privateKey).export({ format: "jwk" });
  const keyId = `ed25519:${sha256(stableJson(publicKeyJwk)).slice(0, 32)}`;
  return { privateKey, publicKeyJwk, keyId };
}

export function createArtifactSignerPort({
  dataDir = "",
  resolveSecretPayload = resolveLocalSecretPayload,
  secretKeyProvider = null,
  pluginId = "",
  serviceId = "",
  allowedPurposes = []
}: ArtifactSignerOptions = {}) {
  const boundPluginId = text(pluginId);
  const purposeGrant = new Set(Array.isArray(allowedPurposes) ? allowedPurposes.map(text).filter(Boolean) : []);
  if (!text(dataDir) || typeof resolveSecretPayload !== "function" || !/^[a-z][a-z0-9-]*$/u.test(boundPluginId) || purposeGrant.size === 0 ||
      [...purposeGrant].some((purpose) => !purpose.startsWith(`plugin-artifact.${boundPluginId}.`))) {
    throw new TypeError("Artifact signer custody is not configured.");
  }
  const boundServiceId = text(serviceId) || `plugin-artifact:${boundPluginId}`;

  async function withKey<T>(input: DataRecord, task: (input: { request: SignerRequest; facts: KeyFacts; revision: number }) => Promise<T>): Promise<T> {
    const request = validateInput(input, purposeGrant);
    const resolved = await resolveSecretPayload({
      dataDir,
      secretRef: request.secretRef,
      expectedScope: {
        serviceId: boundServiceId,
        requiredScopes: ["artifact:sign"],
        protocol: "artifact-signing"
      },
      keyProvider: secretKeyProvider
    });
    const payload = record(resolved.payload) ?? {};
    const sourcePrivateKeyJwk = privateJwkRecord(payload.privateKeyJwk);
    const privateKeyJwk = sourcePrivateKeyJwk ? structuredClone(sourcePrivateKeyJwk) : null;
    if (!privateKeyJwk) {
      const error = Object.assign(new Error("Artifact signing key material is unavailable."), { code: "artifact_signer_key_unavailable" });
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
    async describe(input: DataRecord = {}) {
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
    async sign(input: DataRecord = {}) {
      const payloadDigest = text(input.payloadDigest);
      if (!/^sha256:[0-9a-f]{64}$/u.test(payloadDigest)) {
        const error = Object.assign(new Error("Artifact signer payload digest is invalid."), { code: "artifact_signer_payload_digest_invalid" });
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
