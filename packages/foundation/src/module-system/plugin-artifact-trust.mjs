const MAX_TRUSTED_KEYS = 32;
const MAX_TRUST_BYTES = 16 * 1024;
const KEY_ID = /^ed25519:[A-Za-z0-9._-]{1,96}$/u;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/u;

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function normalizePluginArtifactTrustedPublicKeys(value = {}) {
  if (!plainObject(value)) throw new TypeError("runtime.pluginArtifactTrustedPublicKeys must be an object.");
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > MAX_TRUSTED_KEYS || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_TRUST_BYTES) {
    throw new TypeError("runtime.pluginArtifactTrustedPublicKeys exceeds its bounded size.");
  }
  const normalized = {};
  for (const [keyId, jwk] of entries) {
    if (!KEY_ID.test(keyId) || !plainObject(jwk) || Object.keys(jwk).sort().join(",") !== "crv,kty,x" ||
        jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !PUBLIC_KEY.test(String(jwk.x || ""))) {
      throw new TypeError("runtime.pluginArtifactTrustedPublicKeys contains an invalid public Ed25519 JWK.");
    }
    normalized[keyId] = Object.freeze({ kty: "OKP", crv: "Ed25519", x: jwk.x });
  }
  return Object.freeze(normalized);
}

export function samePluginArtifactTrust(left = {}, right = {}) {
  return JSON.stringify(left) === JSON.stringify(right);
}
