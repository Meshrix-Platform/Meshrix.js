import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LOCAL_SECRET_MASTER_KEY_FILE_ENV
} from "../../../packages/foundation/src/security/secrets/local-secret-key-provider.ts";

export async function provisionVerifierLocalSecretKey() : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-verifier-key-"));
  const keyFile: any = path.join(root, "master-key");
  const previous: any = process.env[LOCAL_SECRET_MASTER_KEY_FILE_ENV];
  const key: any = crypto.randomBytes(32);
  try {
    await fs.writeFile(keyFile, `${key.toString("hex")}\n`, { mode: 0o600 });
    process.env[LOCAL_SECRET_MASTER_KEY_FILE_ENV] = keyFile;
  } finally {
    key.fill(0);
  }
  let closed: any = false;
  return Object.freeze({
    async close() : Promise<any> {
      if (closed) return;
      closed = true;
      if (process.env[LOCAL_SECRET_MASTER_KEY_FILE_ENV] === keyFile) {
        if (previous === undefined) delete process.env[LOCAL_SECRET_MASTER_KEY_FILE_ENV];
        else process.env[LOCAL_SECRET_MASTER_KEY_FILE_ENV] = previous;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
