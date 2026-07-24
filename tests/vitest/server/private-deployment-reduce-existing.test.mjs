import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PRIVATE_DEPLOYMENT_OPEN_PLATFORM_E2E_REPORT_PATH
} from "../../../tools/server-scripts/lib/private-deployment-open-platform-e2e-catalog.mjs";
import {
  PRIVATE_DEPLOYMENT_REQUIRED_REPORTS
} from "../../../tools/server-scripts/lib/platform-acceptance-command-catalog.mjs";
import {
  reduceExistingReports
} from "../../../tools/server-scripts/verify-private-deployment-open-platform-e2e.mjs";

describe("private deployment existing-evidence reduction", () => {
  it("does not remove or execute child evidence while producing a fail-closed aggregate", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-reduce-existing-"));
    const childPath = path.join(root, ...PRIVATE_DEPLOYMENT_REQUIRED_REPORTS[0].split("/"));
    const sentinel = "{\"sentinel\":true}\n";
    await fs.mkdir(path.dirname(childPath), { recursive: true });
    await fs.writeFile(childPath, sentinel, "utf8");
    try {
      const report = await reduceExistingReports({
        root,
        startedAtMs: Date.parse("2026-07-10T04:00:00.000Z"),
        setExitCode: false,
        log: false
      });
      expect(report).toMatchObject({
        status: "blocked",
        algorithm: { commandExecutionMode: "platform-acceptance-existing-evidence-reduction" },
        summary: { commandCount: 0, releaseReady: false, reportLeakScan: false }
      });
      expect(await fs.readFile(childPath, "utf8")).toBe(sentinel);
      await expect(fs.readFile(
        path.join(root, ...PRIVATE_DEPLOYMENT_OPEN_PLATFORM_E2E_REPORT_PATH.split("/")),
        "utf8"
      )).resolves.toContain("platform-acceptance-existing-evidence-reduction");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
