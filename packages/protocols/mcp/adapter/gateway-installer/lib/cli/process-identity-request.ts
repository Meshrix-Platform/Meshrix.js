import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign
} from "node:crypto";

import {
  CLIENT_FINGERPRINT_VERSION,
  PROCESS_IDENTITY_CANONICAL_REQUEST_VERSION
} from "./constants.ts";
import { normalizeTarget } from "./basic-utils.ts";

function sha256Base64Url(value?: any) : any {
  return createHash("sha256").update(value).digest("base64url");
}

export function sha256Hex(value?: any) : any {
  return createHash("sha256").update(value).digest("hex");
}

function clientFingerprintHash(fingerprint: Record<string, any> = {}) : any {
  return `sha256:${sha256Base64Url(Buffer.from([
    CLIENT_FINGERPRINT_VERSION,
    String(fingerprint.fingerprintId || ""),
    String(fingerprint.machineInstanceId || ""),
    String(fingerprint.appInstanceId || ""),
    String(fingerprint.runtimeInstanceId || "")
  ].join("\n"), "utf8"))}`;
}

export function createProcessIdentityClaim(target: any = "codex") : any {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeySpki: any = publicKey.export({ format: "der", type: "spki" });
  const processPublicKeyHash: any = `sha256:${sha256Base64Url(publicKeySpki)}`;
  const processKeyId: any = `pkey_${sha256Base64Url(publicKeySpki).slice(0, 24)}`;
  const installationId: any = `install_${randomBytes(18).toString("base64url")}`;
  const fingerprint: Record<string, any> = {
    fingerprintId: `fp_${randomBytes(16).toString("base64url")}`,
    machineInstanceId: `machine_${randomBytes(16).toString("base64url")}`,
    appInstanceId: `app_${randomBytes(16).toString("base64url")}`,
    runtimeInstanceId: `runtime_${randomBytes(16).toString("base64url")}`
  };
  fingerprint.fingerprintHash = clientFingerprintHash(fingerprint);
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
    request: {
      clientId: normalizeTarget(target) || "mcp",
      installationId,
      processKeyId,
      processPublicKeyPem: publicKey.export({ format: "pem", type: "spki" }),
      clientFingerprint: fingerprint,
      defaultIdentityHash: `sha256:${sha256Base64Url(Buffer.from([
        "v0.0.1:process-identity:mcp-default-identity-1",
        normalizeTarget(target) || "mcp",
        installationId,
        processPublicKeyHash,
        fingerprint.fingerprintHash
      ].join("\n"), "utf8"))}`,
      nonce: randomBytes(24).toString("base64url")
    }
  };
}

function pathWithQuery(url?: any) : any {
  const parsed: any = url instanceof URL ? url : new URL(String(url || "/mcp"), "http://127.0.0.1");
  return `${parsed.pathname || "/"}${parsed.search || ""}`;
}

export function processIdentityHeaders({ method = "POST", url, body = "", identity = null }: Record<string, any> = {}) : any {
  if (!identity?.clientIdentityPackage || !identity?.privateKeyPem) {
    return {};
  }
  const packageObject: any = identity.clientIdentityPackage;
  const processKey: any = packageObject.processKey || {};
  const fingerprint: any = packageObject.clientFingerprint || {};
  const bodyBuffer: any = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""), "utf8");
  const bodySha256: any = sha256Hex(bodyBuffer);
  const timestamp: any = new Date().toISOString();
  const nonce: any = randomBytes(24).toString("base64url");
  const canonical: any = [
    PROCESS_IDENTITY_CANONICAL_REQUEST_VERSION,
    String(method || "POST").toUpperCase(),
    pathWithQuery(url),
    bodySha256,
    timestamp,
    nonce,
    packageObject.clientId || "",
    packageObject.packageId || "",
    processKey.processKeyId || "",
    fingerprint.fingerprintId || "",
    fingerprint.machineInstanceId || "",
    fingerprint.appInstanceId || "",
    fingerprint.runtimeInstanceId || "",
    fingerprint.fingerprintHash || ""
  ].join("\n");
  const signature: any = sign(
    null,
    Buffer.from(canonical, "utf8"),
    createPrivateKey(identity.privateKeyPem)
  ).toString("base64url");
  return {
    "x-meshrix-client-id": packageObject.clientId || "",
    "x-meshrix-identity-package-id": packageObject.packageId || "",
    "x-meshrix-process-key-id": processKey.processKeyId || "",
    "x-meshrix-timestamp": timestamp,
    "x-meshrix-nonce": nonce,
    "x-meshrix-body-sha256": bodySha256,
    "x-meshrix-client-fingerprint-id": fingerprint.fingerprintId || "",
    "x-meshrix-machine-instance-id": fingerprint.machineInstanceId || "",
    "x-meshrix-app-instance-id": fingerprint.appInstanceId || "",
    "x-meshrix-runtime-instance-id": fingerprint.runtimeInstanceId || "",
    "x-meshrix-client-fingerprint-hash": fingerprint.fingerprintHash || "",
    "x-meshrix-signature": signature,
    "x-meshrix-capability-key": packageObject.capability?.key || ""
  };
}
