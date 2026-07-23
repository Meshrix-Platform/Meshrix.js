import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMaintenanceAgentAuditStore, redactForMaintenanceAudit } from "../../../packages/agents/src/maintenance/audit-store.mjs";

async function withTempDir(testCase) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lico-maintenance-agent-audit-"));
  try {
    return await testCase(root);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
}

describe("maintenance agent audit redaction and persistence", () => {
  it("redacts secret fields and absolute paths", () => {
    const redacted = redactForMaintenanceAudit({
      token: "top-secret",
      user: {
        apiKey: "server-key",
        endpoint: "/private/lico/config",
      },
      values: [
        "/tmp/lico/agent.log",
        42,
      ],
    });

    expect(redacted).toEqual({
      token: "<redacted>",
      user: {
        apiKey: "<redacted>",
        endpoint: "<redacted-path>",
      },
      values: ["<redacted-path>", 42],
    });
  });

  it("persists audit and run snapshot entries and returns sorted latest runs", async () => {
    await withTempDir(async (root) => {
      const store = createMaintenanceAgentAuditStore({ userDataPath: root });

      await store.appendRunSnapshot({ runId: "run-1", updatedAt: "2026-06-03T00:00:00.000Z", status: "queued" });
      await store.appendRunSnapshot({ runId: "run-2", updatedAt: "2026-06-03T00:01:00.000Z", status: "queued" });
      await store.appendRunSnapshot({ runId: "run-1", updatedAt: "2026-06-03T00:02:00.000Z", status: "running" });
      const runs = await store.listLatestRuns({ limit: 10 });

      expect(runs).toHaveLength(2);
      expect(runs[0].runId).toBe("run-1");
      expect(runs[0].status).toBe("running");
      expect(runs[1].runId).toBe("run-2");
      expect(runs[1].status).toBe("queued");

      const audit = await store.appendAudit({ action: "maintenance.agent.event", runId: "run-1", status: "ok" });
      const listed = await store.listAudit({ limit: 5 });

      expect(audit.auditId).toMatch(/^maa_/);
      expect(listed[0].auditId).toBe(audit.auditId);
      expect(listed[0].action).toBe("maintenance.agent.event");
    });
  });

  it("ignores invalid json lines when reading logs", async () => {
    await withTempDir(async (root) => {
      const store = createMaintenanceAgentAuditStore({ userDataPath: root });
      const auditPath = path.join(root, "maintenance-agent-audit.jsonl");

      await fs.writeFile(auditPath, "{\"auditId\":\"good\"}\ninvalid-line\n", "utf8");

      const items = await store.listAudit({ limit: 10 });
      expect(items).toHaveLength(1);
      expect(items[0].auditId).toBe("good");
    });
  });
});
