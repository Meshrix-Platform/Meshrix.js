import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHttpServer } from "../../apps/server/runtime/http-server.mjs";
import { authHeaders, installAuthenticatedFetch } from "./test-auth-helper.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    payload: text.trim() ? JSON.parse(text) : {}
  };
}

async function readJsonl(filePath) {
  const text = await fs.readFile(filePath, "utf8").catch(() => "");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readRuntimeLogs(logDir) {
  const entries = await fs.readdir(logDir, { withFileTypes: true }).catch(() => []);
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^lico-.+\.jsonl$/.test(entry.name)) {
      continue;
    }
    records.push(...await readJsonl(path.join(logDir, entry.name)));
  }
  return records;
}

async function removeTempDir(dirPath) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rm(dirPath, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100
      });
      return;
    } catch (error) {
      if (attempt === 7 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

async function main() {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-trace-context-data-"));
  const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "lico-trace-context-logs-"));
  let server = null;
  try {
    server = await startHttpServer({
      userDataPath,
      runtimeOptions: {
        profile: "minimal",
        enableFeatures: ["maintenance-agent-runbooks"],
        cwd: repoRoot,
        logDir
      }
    });
    const auth = await installAuthenticatedFetch(server);
    const health = await requestJson(`${server.url}/api/healthz`);
    assert.equal(health.status, 200);
    const healthTraceId = health.headers.get("x-licomesh-trace-id");
    assert.match(healthTraceId, /^trace_/);

    const settings = await requestJson(`${server.url}/api/settings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(auth, { method: "POST", safetyConfirm: true })
      },
      body: JSON.stringify({
        defaultModelProvider: "local-model"
      })
    });
    assert.equal(settings.status, 200);
    const settingsTraceId = settings.headers.get("x-licomesh-trace-id");
    assert.match(settingsTraceId, /^trace_/);

    const maintenanceRun = await requestJson(`${server.url}/api/maintenance-agent/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(auth, { method: "POST", safetyConfirm: true })
      },
      body: JSON.stringify({
        runbook: "health_smoke",
        wait: false
      })
    });
    assert.equal(maintenanceRun.status, 200);
    const maintenanceTraceId = maintenanceRun.headers.get("x-licomesh-trace-id");
    assert.match(maintenanceTraceId, /^trace_/);

    await new Promise((resolve) => setTimeout(resolve, 400));
    const audit = await requestJson(`${server.url}/api/auth/audit?limit=200`, {
      headers: authHeaders(auth)
    });
    assert.equal(audit.status, 200);
    assert.ok(
      (audit.payload.items || []).some((entry) => entry.operationId === "settings.set" && entry.traceId === settingsTraceId),
      "central audit must include operation traceId"
    );
    await server.close();
    server = null;

    const runtimeRecords = await readRuntimeLogs(logDir);
    assert.ok(
      runtimeRecords.some((record) => record.event === "http.request.started" && record.traceId === healthTraceId),
      "runtime logs must include HTTP traceId"
    );
    assert.ok(
      runtimeRecords.some((record) => record.event === "operation.http.completed" && record.traceId === settingsTraceId),
      "operation logs must inherit request traceId"
    );
    const events = await readJsonl(path.join(userDataPath, "protocol-events", "events.jsonl"));
    assert.ok(events.every((event) => Object.hasOwn(event, "traceId")), "events must carry traceId fields");
    assert.ok(events.some((event) => event.traceId === maintenanceTraceId || event.traceId === settingsTraceId));
  } finally {
    if (server) {
      await server.close().catch(() => {});
    }
    await removeTempDir(userDataPath);
    await removeTempDir(logDir);
  }
}

await main();
console.log("trace-context verification passed");
