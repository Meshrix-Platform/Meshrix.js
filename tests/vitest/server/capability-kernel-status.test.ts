import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  describeCapabilityBindingGuardStatus,
  describeCapabilityKernelStatus
} from "../../../packages/foundation/src/security/authorization/capability-kernel-status.ts";

const tempRoots: any[] = [];

async function tempDir(prefix?: any) : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () : Promise<any> => {
  await Promise.all(tempRoots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("capability kernel status boundary behavior", () : any => {
  it("returns error status when the data directory cannot hold provider state", async () : Promise<any> => {
    const root: any = await tempDir("meshrix-capability-kernel-status-");
    const blockedDataPath: any = path.join(root, "not-a-directory");
    await fs.writeFile(blockedDataPath, "blocked", "utf8");

    await expect(describeCapabilityKernelStatus({
      userDataPath: blockedDataPath,
      backend: "local-file",
      alias: "status-extra"
    })).resolves.toMatchObject({
      ok: false,
      status: "error",
      tone: "danger",
      configuredBackend: "local-file",
      recoverySupported: false
    });

    await expect(describeCapabilityBindingGuardStatus({
      userDataPath: blockedDataPath,
      backend: "local-file",
      alias: "status-extra"
    })).resolves.toMatchObject({
      ok: false,
      status: "error",
      tone: "danger",
      configuredBackend: "local-file"
    });
  });
});
