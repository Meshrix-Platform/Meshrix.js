import { Buffer } from "node:buffer";

export const DEVELOPMENT_MESHRIX_SIGNER_SECRET = "meshrix-development-signer";

export function isDevelopmentMeshrixSignerSecret(value?: string | Buffer | null): boolean {
  const secret = Buffer.isBuffer(value) ? Buffer.from(value as Buffer).toString("utf8") : String(value || "");
  return secret === DEVELOPMENT_MESHRIX_SIGNER_SECRET;
}
