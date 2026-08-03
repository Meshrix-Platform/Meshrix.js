import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createTestJobManager } from "./job-manager-test-harness.ts";

const tempRoots: any[] = [];

async function withTempUserData(callback?: any) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-job-queue-authority-"));
  tempRoots.push(userDataPath);
  return callback(userDataPath);
}

afterEach(async () : Promise<any> => {
  await Promise.all(tempRoots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("job manager queue authority boundary", () : any => {
  it("leaves work-queue observation and recovery to the workflow provider", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const manager: any = createTestJobManager({
        userDataPath,
        processingEnabled: false,
        logger: { info() : any {}, warn() : any {}, error() : any {}, debug() : any {} }
      });
      const job: any = await manager.createJob({
        checkpointId: "checkpoint-authority-boundary",
        archiveBatchId: "archive-authority-boundary"
      });

      expect(job.status).toBe("queued");
      expect(typeof manager.listJobs).toBe("function");
      expect(manager.inspectWorkQueue).toBeUndefined();
      await manager.close();
    });
  });
});
