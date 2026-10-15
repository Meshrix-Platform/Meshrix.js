import crypto from "node:crypto";
import path from "node:path";

import { operationAuditProjectionKeyId } from "../../../../packages/foundation/src/security/operation-audit-projection.ts";

export function operationAuditTestProjectionOptions(userDataPath: string): Readonly<{
  projectionKey: Buffer;
  projectionKeyId: string;
}> {
  const projectionKey = crypto.createHash("sha256")
    .update("meshrix-test-operation-audit-projection-v1\0")
    .update(path.resolve(userDataPath))
    .digest();
  return Object.freeze({
    projectionKey,
    projectionKeyId: operationAuditProjectionKeyId(projectionKey)
  });
}
