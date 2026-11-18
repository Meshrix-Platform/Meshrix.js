import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHttpServer } from "../../apps/server/runtime/http-server.ts";
import { openSqliteDatabase } from "../../packages/foundation/src/storage/sqlite-database.ts";
import { authHeaders, installAuthenticatedFetch } from "./test-auth-helper.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function requestJson(url?: any, options: Record<string, any> = {}) : Promise<any> {
  const response: any = await fetch(url, options);
  const text: any = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    payload: text.trim() ? JSON.parse(text) : {}
  };
}

async function readJsonl(filePath?: any) : Promise<any> {
  const text: any = await fs.readFile(filePath, "utf8").catch(() : any => "");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line?: any) : any => JSON.parse(line));
}

async function readRuntimeLogs(logDir?: any) : Promise<any> {
  const entries: any = await fs.readdir(logDir, { withFileTypes: true }).catch(() : any => []);
  const records: any[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^meshrix-.+\.jsonl$/.test(entry.name)) {
      continue;
    }
    records.push(...await readJsonl(path.join(logDir, entry.name)));
  }
  return records;
}

function readProtocolEventTraces(userDataPath?: any) : any {
  const database: any = openSqliteDatabase(
    path.join(userDataPath, "protocol-events", "events.sqlite"),
    { readonly: true, fileMustExist: true }
  );
  try {
    return database.prepare(`
      SELECT trace_json
      FROM protocol_events
      ORDER BY offset ASC
    `).all().map((entry?: any) : any => JSON.parse(String(entry.trace_json || "{}")));
  } finally {
    database.close();
  }
}

async function removeTempDir(dirPath?: any) : Promise<any> {
  for (let attempt: any = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rm(dirPath, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100
      });
      return;
    } catch (error: any) {
      if (attempt === 7 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) {
        throw error;
      }
      await new Promise((resolve?: any) : any => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

async function main() : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-trace-context-data-"));
  const logDir: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-trace-context-logs-"));
  let server: any = null;
  try {
    server = await startHttpServer({
      userDataPath,
      runtimeOptions: {
        profile: "minimal",
        cwd: repoRoot,
        logDir
      }
    });
    const auth: any = await installAuthenticatedFetch(server);
    const health: any = await requestJson(`${server.url}/api/healthz`);
    assert.equal(health.status, 200);
    const healthTraceId: any = health.headers.get("x-meshrix-trace-id");
    assert.match(healthTraceId, /^trace_/);

    const settings: any = await requestJson(`${server.url}/api/settings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(auth, { method: "POST", safetyConfirm: true })
      },
      body: JSON.stringify({})
    });
    assert.equal(settings.status, 200);
    const settingsTraceId: any = settings.headers.get("x-meshrix-trace-id");
    assert.match(settingsTraceId, /^trace_/);

    await new Promise((resolve?: any) : any => setTimeout(resolve, 400));
    const audit: any = await requestJson(`${server.url}/api/auth/audit?limit=200`, {
      headers: authHeaders(auth)
    });
    assert.equal(audit.status, 200);
    assert.ok(
      (audit.payload.items || []).some((entry?: any) : any => entry.operationId === "settings.set" && entry.traceId === settingsTraceId),
      "central audit must include operation traceId"
    );
    await server.close();
    server = null;

    const runtimeRecords: any = await readRuntimeLogs(logDir);
    assert.ok(
      !runtimeRecords.some(
        (record?: any) : any =>
          record.event === "http.request.started" &&
          record.traceId === healthTraceId
      ),
      "routine health probes must not be persisted as request logs"
    );
    const eventTraces: any = readProtocolEventTraces(userDataPath);
    assert.ok(
      eventTraces.every((trace?: any) : any => Object.hasOwn(trace, "traceId")),
      "events must carry traceId fields"
    );
    assert.ok(
      eventTraces.some(
        (trace?: any) : any =>
          trace.traceId === settingsTraceId
      )
    );
  } finally {
    if (server) {
      await server.close().catch(() : any => {});
    }
    await removeTempDir(userDataPath);
    await removeTempDir(logDir);
  }
}

await main();
console.log("trace-context verification passed");
