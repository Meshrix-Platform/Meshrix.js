import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { getBackgroundProcessStatus } from "../../../packages/foundation/src/observability/background-process-status.ts";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-background-status-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it("uses the current import-worker demand snapshot without rescanning job metadata", async () => {
  const userDataPath = await tempDir();
  await fs.mkdir(path.join(userDataPath, "background"), { recursive: true });
  await fs.writeFile(path.join(userDataPath, "background", "processes.json"), JSON.stringify({
    supervisor: { pid: process.pid, startedAt: new Date().toISOString(), status: "running" },
    processes: []
  }));
  const demand = {
    kind: "import_parse_job",
    active: true,
    activeCount: 1,
    queuedCount: 1,
    runningCount: 0,
    activeJobIds: ["synthetic-job"],
    jobsRootPath: path.join(userDataPath, "jobs"),
    checkedAt: "2026-10-08T00:00:00.000Z"
  };

  const status = await getBackgroundProcessStatus(userDataPath, {
    demandSnapshot: { importWorker: demand }
  });
  const importWorker = status.processes.find((item: Record<string, any>) => item.role === "import-worker");

  expect(importWorker).toMatchObject({
    desired: true,
    details: { demand: { active: true, activeJobIds: ["synthetic-job"] } }
  });
  await expect(fs.stat(path.join(userDataPath, "jobs"))).rejects.toMatchObject({ code: "ENOENT" });
});
