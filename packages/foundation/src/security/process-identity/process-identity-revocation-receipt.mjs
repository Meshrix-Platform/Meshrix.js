import crypto from "node:crypto";

import {
  PROCESS_IDENTITY_PROTOCOL_VERSION,
  asObject,
  normalizeClientFingerprint,
  publicServerIdentity,
  sha256Hex,
  signStableObject,
  stableJson,
  text
} from "./process-identity-core.mjs";

export const PROCESS_IDENTITY_REVOCATION_RECEIPT_VERSION = "v0.0.1:process-identity:revocation-receipt-1";
export const PROCESS_IDENTITY_SIGNATURE_PAYLOAD_ENCODING = "v0.0.1:platform:stable-json-1";

function revocationReceiptPayloadFromInput(input = {}) {
  const source = asObject(input);
  return {
    schemaVersion: text(source.schemaVersion) || "v0.0.1:schema:definition-1",
    protocolVersion: text(source.protocolVersion) || PROCESS_IDENTITY_PROTOCOL_VERSION,
    receiptVersion: text(source.receiptVersion) || PROCESS_IDENTITY_REVOCATION_RECEIPT_VERSION,
    receiptKind: "process-identity-package-revocation",
    serverId: text(source.serverId),
    serverKeyId: text(source.serverKeyId),
    serverTrustPin: text(source.serverTrustPin),
    packageId: text(source.packageId),
    clientId: text(source.clientId),
    installationId: text(source.installationId),
    processKeyId: text(source.processKeyId),
    processPublicKeyHash: text(source.processPublicKeyHash),
    clientFingerprintHash: text(source.clientFingerprintHash),
    identityGeneration: Math.max(1, Number(source.identityGeneration || 1)),
    status: "revoked",
    revokedAt: text(source.revokedAt),
    reason: text(source.reason),
    endpoint: text(source.endpoint),
    ownerSubjectRef: text(source.ownerSubjectRef),
    ownerArtifactId: text(source.ownerArtifactId),
    ownerArtifactDigestSha256: text(source.ownerArtifactDigestSha256)
  };
}

export function createProcessIdentityRevocationReceipt({
  state = {},
  client = {},
  revokedAt = "",
  reason = "process_identity_package_revoked",
  endpoint = "/api/process-identity/package/revoke",
  ownerSubjectRef = "",
  ownerArtifactId = "",
  ownerArtifactDigestSha256 = ""
} = {}) {
  const serverIdentity = state.serverIdentity || {};
  const fingerprint = normalizeClientFingerprint(client.clientFingerprint, { required: false });
  const payload = revocationReceiptPayloadFromInput({
    serverId: serverIdentity.serverId,
    serverKeyId: serverIdentity.serverKeyId,
    serverTrustPin: serverIdentity.serverTrustPin,
    packageId: client.packageId,
    clientId: client.clientId,
    installationId: client.installationId,
    processKeyId: client.processKeyId,
    processPublicKeyHash: client.processPublicKeyHash,
    clientFingerprintHash: fingerprint.fingerprintHash || "",
    identityGeneration: client.identityGeneration,
    revokedAt,
    reason,
    endpoint,
    ownerSubjectRef,
    ownerArtifactId,
    ownerArtifactDigestSha256
  });
  const receiptDigestSha256 = sha256Hex(stableJson(payload));
  return {
    ...payload,
    receiptDigestSha256,
    serverIdentity: publicServerIdentity(serverIdentity),
    signature: {
      algorithm: "ed25519",
      keyId: serverIdentity.serverKeyId,
      authority: serverIdentity.serverId,
      payloadEncoding: PROCESS_IDENTITY_SIGNATURE_PAYLOAD_ENCODING,
      payloadDigest: `sha256:${receiptDigestSha256}`,
      value: signStableObject(serverIdentity.privateKeyPem, payload)
    }
  };
}

export function verifyProcessIdentityRevocationReceiptSignature({
  receipt = null,
  serverIdentity = {},
  expected = {}
} = {}) {
  const source = asObject(receipt, null);
  if (!source) {
    return { ok: false, reasonCode: "process_identity_revocation_receipt_missing" };
  }
  const effectiveServerIdentity = asObject(serverIdentity, {});
  const payload = revocationReceiptPayloadFromInput(source);
  const receiptDigestSha256 = sha256Hex(stableJson(payload));
  const signature = asObject(source.signature);
  const publicKeyPem = text(effectiveServerIdentity.publicKeyPem);
  if (
    source.receiptDigestSha256 !== receiptDigestSha256 ||
    signature.algorithm !== "ed25519" ||
    signature.keyId !== text(effectiveServerIdentity.serverKeyId) ||
    signature.authority !== text(effectiveServerIdentity.serverId) ||
    signature.payloadEncoding !== PROCESS_IDENTITY_SIGNATURE_PAYLOAD_ENCODING ||
    signature.payloadDigest !== `sha256:${receiptDigestSha256}` ||
    !text(signature.value) ||
    !publicKeyPem
  ) {
    return { ok: false, reasonCode: "process_identity_revocation_receipt_signature_metadata_invalid" };
  }
  const checks = {
    serverId: text(effectiveServerIdentity.serverId),
    serverKeyId: text(effectiveServerIdentity.serverKeyId),
    serverTrustPin: text(effectiveServerIdentity.serverTrustPin),
    status: "revoked",
    packageId: text(expected.packageId),
    clientId: text(expected.clientId),
    processKeyId: text(expected.processKeyId),
    endpoint: text(expected.endpoint),
    reason: text(expected.reason),
    ownerSubjectRef: text(expected.ownerSubjectRef),
    ownerArtifactId: text(expected.ownerArtifactId),
    ownerArtifactDigestSha256: text(expected.ownerArtifactDigestSha256)
  };
  for (const [field, expectedValue] of Object.entries(checks)) {
    if (expectedValue && text(payload[field]) !== expectedValue) {
      return {
        ok: false,
        reasonCode: "process_identity_revocation_receipt_binding_mismatch",
        field
      };
    }
  }
  try {
    const ok = crypto.verify(
      null,
      Buffer.from(stableJson(payload), "utf8"),
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(text(signature.value), "base64url")
    );
    return ok
      ? {
          ok: true,
          reasonCode: "process_identity_revocation_receipt_signature_valid",
          payload,
          receiptDigestSha256
        }
      : { ok: false, reasonCode: "process_identity_revocation_receipt_signature_invalid" };
  } catch {
    return { ok: false, reasonCode: "process_identity_revocation_receipt_signature_invalid" };
  }
}
