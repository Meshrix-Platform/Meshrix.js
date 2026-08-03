import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createRuntimeLogger,
  getRuntimeLogger,
  logRuntimeEvent,
  setRuntimeLogger,
  summarizeError,
  summarizeForLog,
  summarizeSecurityValue
} from "#meshrix/runtime-logger";
import { createTraceContext, runWithTraceContext } from "#meshrix/foundation/observability/trace-context";

const tempRoots: any[] = [];

async function makeTempRoot() : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-runtime-logger-extra-"));
  tempRoots.push(root);
  return root;
}

async function readJsonlRecords(logDir?: any) : Promise<any> {
  const entries: any = await fs.readdir(logDir, { withFileTypes: true }).catch(() : any => []);
  const files: any = entries
    .filter((entry?: any) : any => entry.isFile() && /^meshrix-.+\.jsonl$/.test(entry.name))
    .map((entry?: any) : any => path.join(logDir, entry.name))
    .sort();
  const records: any[] = [];

  for (const file of files) {
    const text: any = await fs.readFile(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed: any = line.trim();
      if (!trimmed) {
        continue;
      }
      records.push(JSON.parse(trimmed));
    }
  }

  return { files, records };
}

beforeEach(() : any => {
  setRuntimeLogger(null);
});

afterEach(async () : Promise<any> => {
  setRuntimeLogger(null);
  await Promise.all(tempRoots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("runtime logger behavior", () : any => {
  it("writes JSONL records, honors explicit log sinks, and prunes stale files", async () : Promise<any> => {
    const userDataPath: any = await makeTempRoot();
    const logDir: any = path.join(userDataPath, "custom-logs");
    await fs.mkdir(logDir, { recursive: true });

    const today: any = new Date().toISOString().slice(0, 10);
    const stalePath: any = path.join(logDir, "meshrix-server-2000-01-01.jsonl");
    await fs.writeFile(stalePath, `${JSON.stringify({ event: "stale" })}\n`, "utf8");
    const staleDate: any = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await fs.utimes(stalePath, staleDate, staleDate);

    const occupiedPath: any = path.join(logDir, `meshrix-server-${today}.jsonl`);
    await fs.writeFile(
      occupiedPath,
      `${JSON.stringify({ event: "seed", payload: "x".repeat(1024 * 1024 + 32) })}\n`,
      "utf8"
    );

    const logger: any = createRuntimeLogger({
      userDataPath,
      component: "server",
      retentionDays: "0",
      runtimeOptions: {
        logDir,
        profile: "production",
        logLevel: "not-a-valid-level",
        logMaxFileBytes: 512,
        logMaxTotalBytes: "still-not-valid"
      }
    });

    expect(logger.logDir).toBe(path.resolve(logDir));
    expect(logger.level).toBe("info");
    expect(logger.retentionDays).toBe(1);
    expect(logger.maxFileBytes).toBe(1024 * 1024);
    expect(logger.maxTotalBytes).toBe(256 * 1024 * 1024);
    expect(logger.maxPendingRecords).toBe(2048);
    expect(logger.maxRecordBytes).toBe(64 * 1024);
    expect(logger.setLevel("banana")).toBe("info");
    expect(logger.actorSummary()).toEqual({
      type: "system",
      userId: "",
      username: "",
      roleId: ""
    });

    const actorSummary: any = logger.actorSummary({
      user: {
        userId: "user-1",
        username: "Alice Walker",
        roleId: "maintainer"
      }
    });
    expect(actorSummary).toMatchObject({
      type: "console-user",
      roleId: "maintainer"
    });
    expect(actorSummary.userId).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(actorSummary.username).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);

    await logger.cleanup({ force: true });
    await expect(fs.access(stalePath)).rejects.toThrow();

    const error: any = new Error("boom");
    error.code = "E_UNIT";
    error.stack = `Error: boom\n    at test (${path.join(process.cwd(), "packages/foundation/src/observability/runtime-logger.ts")}:1:1)`;

    const child: any = logger.child({
      source: "child-run",
      workspace: path.join(userDataPath, "workspace")
    });

    const record: any = child.info("runtime.file.sink", {
      requestId: "req-1",
      actor: {
        userId: "user-1",
        username: "Alice Walker",
        roleId: "maintainer"
      },
      workspace: path.join(userDataPath, "workspace"),
      payload: {
        path: path.join(userDataPath, "payload", "notes.txt"),
        nested: { ok: true }
      },
      secretToken: "super-secret",
      query: { private: "query-value-private" },
      remoteAddress: "198.51.100.73",
      userAgent: "private-user-agent/9.7",
      clientId: "private-client-identity",
      error
    });

    expect(record).toMatchObject({
      level: "info",
      component: "server",
      event: "runtime.file.sink",
      requestId: "req-1"
    });

    await logger.flush();
    await logger.close();

    const { records, files } = await readJsonlRecords(logDir);
    expect(files).toEqual(
      expect.arrayContaining([
        path.join(logDir, `meshrix-server-${today}.jsonl`),
        path.join(logDir, `meshrix-server-${today}.1.jsonl`)
      ])
    );

    const stored: any = records.find((entry?: any) : any => entry.event === "runtime.file.sink");
    expect(stored).toMatchObject({
      schemaVersion: "v0.0.1:schema:definition-1",
      level: "info",
      component: "server",
      event: "runtime.file.sink",
      requestId: "req-1",
      traceId: ""
    });
    expect(stored.details.source).toMatchObject({
      type: "string",
      metadataOnly: true
    });
    expect(stored.details.workspace).toMatchObject({
      type: "path",
      metadataOnly: true
    });
    expect(stored.details.payload).toEqual({
      type: "object",
      keyCount: 2,
      sha256: expect.stringMatching(/^[0-9a-f]{16}$/),
      hashAlgorithm: "hmac-sha256",
      metadataOnly: true
    });
    expect(stored.details.secretToken).toMatchObject({
      redacted: true,
      reason: "sensitive-key"
    });
    expect(stored.details.error).toMatchObject({
      name: "Error",
      message: {
        type: "error",
        metadataOnly: true
      },
      code: "E_UNIT",
      reasonCode: "E_UNIT",
      stack: {
        type: "stack",
        metadataOnly: true
      }
    });
    expect(stored.details.payload.nested).toBeUndefined();
    expect(stored.details.query).toMatchObject({
      type: "object",
      keyCount: 1,
      metadataOnly: true
    });
    expect(stored.details.remoteAddress).toMatchObject({ redacted: true, metadataOnly: true });
    expect(stored.details.userAgent).toMatchObject({ redacted: true, metadataOnly: true });
    expect(stored.details.clientId).toMatchObject({ redacted: true, metadataOnly: true });
    expect(stored["process.command"]).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(stored["process.command.arg_count"]).toBeGreaterThan(0);

    const persistedText: any = JSON.stringify(stored);
    for (const needle of [
      "Alice Walker",
      "super-secret",
      "query-value-private",
      "198.51.100.73",
      "private-user-agent/9.7",
      "private-client-identity",
      userDataPath,
      error.message,
      error.stack,
      process.argv.slice(0, 2).join(" ")
    ]) {
      expect(persistedText.includes(needle)).toBe(false);
    }
  });

  it("filters debug records by trace, operation, topic, and job ids", async () : Promise<any> => {
    const userDataPath: any = await makeTempRoot();
    const logger: any = createRuntimeLogger({
      userDataPath,
      component: "server",
      runtimeOptions: {
        profile: "production",
        logLevel: "warn"
      }
    });

    expect(logger.logDir).toBe(path.join(path.resolve(userDataPath), "logs", "runtime"));
    expect(logger.level).toBe("warn");
    expect(logger.setLevel("not-a-real-level")).toBe("warn");
    expect(logger.debug("runtime.blocked", { traceId: "trace-blocked" })).toBeNull();

    logger.enableDebugFilter("traceId", "trace-allowed");
    logger.enableDebugFilter("operationId", "op-1");
    logger.enableDebugFilter("topic", "topic-1");
    logger.enableDebugFilter("jobId", "job-1");

    const traceRecord: any = await runWithTraceContext(
      createTraceContext({
        traceId: "trace-allowed",
        requestId: "req-allowed",
        spanId: "span-allowed",
        parentSpanId: "parent-allowed",
        operationId: "trace-op"
      }),
      () : any => logger.debug("runtime.trace.allowed", { topic: "ignored" })
    );
    const operationRecord: any = logger.debug("runtime.operation.allowed", { operationId: "op-1" });
    const topicRecord: any = logger.debug("runtime.topic.allowed", { topic: "topic-1" });
    const jobRecord: any = logger.debug("runtime.job.allowed", { jobId: "job-1" });

    expect(traceRecord).toMatchObject({ event: "runtime.trace.allowed" });
    expect(operationRecord).toMatchObject({ event: "runtime.operation.allowed" });
    expect(topicRecord).toMatchObject({ event: "runtime.topic.allowed" });
    expect(jobRecord).toMatchObject({ event: "runtime.job.allowed" });

    await logger.flush();
    await logger.close();

    const { records } = await readJsonlRecords(logger.logDir);
    expect(records.map((entry?: any) : any => entry.event)).toEqual([
      "runtime.trace.allowed",
      "runtime.operation.allowed",
      "runtime.topic.allowed",
      "runtime.job.allowed"
    ]);
    expect(records[0]).toMatchObject({
      traceId: "trace-allowed",
      requestId: "req-allowed",
      spanId: "span-allowed",
      parentSpanId: "parent-allowed"
    });
    expect(records[1].details.operationId).toBe("op-1");
    expect(records[2].details.topic).toMatchObject({
      type: "string",
      metadataOnly: true
    });
    expect(records[3].details.jobId).toMatchObject({
      type: "string",
      metadataOnly: true
    });

    const sink: Record<string, any> = {
      info: vi.fn(() : any => "info-called"),
      warn: vi.fn(),
      error: vi.fn()
    };
    setRuntimeLogger(sink);
    expect(getRuntimeLogger()).toBe(sink);
    expect(logRuntimeEvent("info", "runtime.singleton", { ok: true })).toBe("info-called");
    expect(sink.info).toHaveBeenCalledWith("runtime.singleton", { ok: true });
    expect(logRuntimeEvent("debug", "runtime.missing", {})).toBeNull();
  });

  it("bounds pending writes and reports dropped low-value records after recovery", async () : Promise<any> => {
    const userDataPath: any = await makeTempRoot();
    const logger: any = createRuntimeLogger({
      userDataPath,
      runtimeOptions: {
        logLevel: "info",
        logMaxPendingRecords: 32
      }
    });

    const accepted: any = Array.from({ length: 1000 }, (_unused?: any, index?: any) : any =>
      logger.info("runtime.queue.pressure", { index })
    ).filter(Boolean);
    expect(accepted).toHaveLength(32);

    await logger.flush();
    expect(logger.info("runtime.queue.recovered", {})).not.toBeNull();
    await logger.flush();
    await logger.close();

    const { records } = await readJsonlRecords(logger.logDir);
    expect(records).toHaveLength(33);
    expect(records.at(-1)).toMatchObject({
      event: "runtime.queue.recovered",
      droppedRecordsBefore: 968
    });
  });

  it("replaces oversized records with bounded diagnostic metadata", async () : Promise<any> => {
    const userDataPath: any = await makeTempRoot();
    const logger: any = createRuntimeLogger({
      userDataPath,
      runtimeOptions: {
        logLevel: "info",
        logMaxRecordBytes: 4096
      }
    });
    const oversizedDetails: any = Object.fromEntries(
      Array.from({ length: 60 }, (_unused?: any, index?: any) : any => [
        `field-${index}`,
        `value-${index}-${"x".repeat(512)}`
      ])
    );

    expect(logger.maxRecordBytes).toBe(4096);
    expect(logger.info("runtime.record.oversized", oversizedDetails)).not.toBeNull();
    await logger.flush();
    await logger.close();

    const { files, records } = await readJsonlRecords(logger.logDir);
    expect(files).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "runtime.record.oversized",
      recordTruncated: true,
      details: {
        metadataOnly: true,
        reason: "record-size-limit",
        originalBytes: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{16}$/),
        hashAlgorithm: "hmac-sha256"
      }
    });
    expect(records[0].details.originalBytes).toBeGreaterThan(4096);
    expect(Buffer.byteLength(await fs.readFile(files[0], "utf8"))).toBeLessThanOrEqual(4096);
  });

  it("summarizes boundary inputs, redacts paths and secrets, and reports errors", async () : Promise<any> => {
    const userDataPath: any = await makeTempRoot();
    const logger: any = createRuntimeLogger({
      userDataPath,
      component: "server",
      runtimeOptions: {}
    });

    expect(logger.logDir).toBe(path.join(path.resolve(userDataPath), "logs", "runtime"));

    expect(summarizeForLog(null)).toBeNull();
    expect(summarizeForLog(undefined)).toBeNull();
    expect(summarizeForLog(123n)).toBe("123");
    expect(summarizeForLog(Buffer.from("abc"))).toMatchObject({
      type: "buffer",
      byteLength: 3
    });

    const summarized: any = summarizeForLog(
      {
        path: "/tmp/runtime/logger.jsonl",
        secretToken: "s3cr3t",
        list: [1, 2, 3, 4],
        deep: {
          one: {
            two: {
              three: "x"
            }
          }
        },
        flag: true,
        extra: "ignored"
      },
      {
        maxDepth: 2,
        maxArrayItems: 2,
        maxObjectKeys: 5
      }
    );

    expect(summarized).toMatchObject({
      path: {
        type: "path",
        metadataOnly: true
      },
      secretToken: {
        redacted: true,
        reason: "sensitive-key"
      },
      list: {
        type: "array",
        length: 4,
        truncated: true,
        items: [1, 2]
      },
      deep: {
        one: {
          type: "object",
          truncated: true
        }
      },
      flag: true,
      __truncatedKeys: 1
    });

    const error: any = new Error("line1\nline2");
    error.name = "UnitError";
    error.code = "E_UNIT";
    error.stack = `UnitError: line1\n    at test (${path.join(process.cwd(), "packages/foundation/src/observability/runtime-logger.ts")}:10:5)`;

    const summarizedError: any = summarizeError(error);
    expect(summarizedError).toMatchObject({
      name: "UnitError",
      message: {
        type: "error",
        metadataOnly: true
      },
      code: "E_UNIT",
      reasonCode: "E_UNIT",
      stack: {
        type: "stack",
        metadataOnly: true,
        lineCount: 2
      }
    });
    expect(JSON.stringify(summarizedError).includes("line1")).toBe(false);
    expect(JSON.stringify(summarizedError).includes(process.cwd())).toBe(false);

    const absolutePathNeedle: any = path.join(
      path.sep,
      "private-fixture",
      "absolute-path",
      "needle.txt"
    );
    const securityProjection: any = summarizeSecurityValue({
      query: { private: "projection-query-needle" },
      username: "projection-user-needle",
      clientId: "projection-client-needle",
      arbitrary: absolutePathNeedle,
      status: "denied",
      reasonCode: "policy_denied"
    });
    expect(securityProjection).toMatchObject({
      query: { type: "object", keyCount: 1, metadataOnly: true },
      username: { redacted: true, metadataOnly: true },
      clientId: { redacted: true, metadataOnly: true },
      arbitrary: { type: "path", metadataOnly: true },
      status: "denied",
      reasonCode: "policy_denied"
    });
    const securityProjectionText: any = JSON.stringify(securityProjection);
    for (const needle of [
      "projection-query-needle",
      "projection-user-needle",
      "projection-client-needle",
      absolutePathNeedle
    ]) {
      expect(securityProjectionText.includes(needle)).toBe(false);
    }

    const actorSummary: any = logger.actorSummary({
      user: {
        userId: "user-123",
        username: "Alice Walker",
        roleId: "maintainer"
      }
    });
    expect(actorSummary).toMatchObject({
      type: "console-user",
      roleId: "maintainer"
    });
    expect(actorSummary.userId).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(actorSummary.username).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(logger.actorSummary()).toEqual({
      type: "system",
      userId: "",
      username: "",
      roleId: ""
    });

    await logger.close();
  });
});
