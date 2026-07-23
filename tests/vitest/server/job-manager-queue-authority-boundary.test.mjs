import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createJobManager } from "../../../packages/server-runtime/src/jobs/jobs/job-manager.mjs";

const tempRoots = [];

async function withTempUserData(callback) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-job-queue-authority-"));
  tempRoots.push(userDataPath);
  return callback(userDataPath);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("job manager queue authority boundary", () => {
  it("leaves work-queue observation and recovery to the workflow provider", async () => {
    await withTempUserData(async (userDataPath) => {
      const manager = createJobManager({
        userDataPath,
        processingEnabled: false,
        logger: { info() {}, warn() {}, error() {}, debug() {} }
      });
      const job = await manager.createJob({
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
