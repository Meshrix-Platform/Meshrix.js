import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createReadinessBaselineProvider } from "../../../packages/foundation/src/observability/readiness-baseline/baseline-provider.ts";

function collectKeys(value?: any, keys: any = new Set<any>()) : any {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
    return keys;
  }
  if (!value || typeof value !== "object") return keys;
  for (const [key, child] of (Object.entries(value) as [string, any][])) {
    keys.add(key);
    collectKeys(child, keys);
  }
  return keys;
}

describe("readiness baseline public projection", () : any => {
  it("reports runtime observation without paths or a release-readiness claim", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-readiness-projection-"));
    try {
      const status: any = await createReadinessBaselineProvider({ userDataPath }).status();

      expect(status).toMatchObject({
        status: "operational",
        verificationMode: "runtime-observed",
        readiness: {
          status: "not-assessed",
          authority: "platform-acceptance-reducer"
        }
      });
      expect([...collectKeys(status)]).not.toEqual(expect.arrayContaining([
        "rootPath",
        "path",
        "configRoot",
        "artifactRoot",
        "registryPath",
        "auditPath"
      ]));
      expect(JSON.stringify(status)).not.toContain(userDataPath);
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });
});
