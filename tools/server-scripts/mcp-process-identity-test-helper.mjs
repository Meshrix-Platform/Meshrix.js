import crypto from "node:crypto";

import {
  CLIENT_FINGERPRINT_VERSION,
  createProcessIdentityRequestHeaders,
  generateProcessIdentityClientKeyPair
} from "../../packages/foundation/src/security/process-identity/index.mjs";

export function createVerifierMcpProcessIdentity({ target = "codex", label = "verifier" } = {}) {
  const keyPair = generateProcessIdentityClientKeyPair();
  const normalizedLabel = String(label || "verifier")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "verifier";
  const installationId = `${normalizedLabel}-${target}-install`;
  const clientFingerprint = {
    fingerprintId: `${normalizedLabel}-fp`,
    machineInstanceId: `${normalizedLabel}-machine`,
    appInstanceId: `${normalizedLabel}-app`,
    runtimeInstanceId: `${normalizedLabel}-runtime`
  };
  clientFingerprint.fingerprintHash = `sha256:${crypto
    .createHash("sha256")
    .update(Buffer.from([
      CLIENT_FINGERPRINT_VERSION,
      clientFingerprint.fingerprintId,
      clientFingerprint.machineInstanceId,
      clientFingerprint.appInstanceId,
      clientFingerprint.runtimeInstanceId
    ].join("\n"), "utf8"))
    .digest("base64url")}`;
  const defaultIdentityHash = `sha256:${crypto
    .createHash("sha256")
    .update(Buffer.from([
      "v0.0.1:process-identity:mcp-default-identity-1",
      target,
      installationId,
      keyPair.publicKeyHash,
      clientFingerprint.fingerprintHash
    ].join("\n"), "utf8"))
    .digest("base64url")}`;
  return {
    keyPair,
    request: {
      clientId: target,
      installationId,
      processPublicKeyPem: keyPair.publicKeyPem,
      clientFingerprint,
      defaultIdentityHash
    }
  };
}

export function createSignedMcpHeaders({
  token,
  target = "codex",
  privateKeyPem,
  clientIdentityPackage,
  method = "POST",
  url,
  body,
  nonce
} = {}) {
  return {
    "Content-Type": "application/json",
    "X-Meshrix-Api-Key": token,
    "X-Meshrix-MCP-Target": target,
    ...createProcessIdentityRequestHeaders({
      privateKeyPem,
      method,
      url,
      body,
      clientIdentityPackage,
      nonce
    })
  };
}
