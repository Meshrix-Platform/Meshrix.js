import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EXPOSITION: string = [
  "# HELP meshrix_relay_sessions_admitted Sessions admitted after directory authority checks.",
  "# TYPE meshrix_relay_sessions_admitted counter",
  'meshrix_relay_sessions_admitted{object="session",tenant="t-1",route="r-1",device="",scope="durable"} 4',
  'meshrix_relay_sessions_admitted{object="session",tenant="t-1",route="r-2",device="",scope="durable"} 2',
  "# HELP meshrix_relay_bytes_in Wire bytes received from connected sockets.",
  "# TYPE meshrix_relay_bytes_in counter",
  'meshrix_relay_bytes_in{object="session",tenant="t-1",route="r-1",device="",scope="ephemeral"} 2048',
  "# HELP meshrix_relay_sessions_closed Sessions closed at durable transitions.",
  "# TYPE meshrix_relay_sessions_closed counter",
  'meshrix_relay_sessions_closed{object="session",tenant="t-1",route="",device="d-9",scope="durable"} 7',
  "# HELP foreign_exporter_metric A metric that is not part of the relay projection.",
  'foreign_exporter_metric{tenant="t-1"} 999',
  "",
].join("\n");

async function loadExecutor() : Promise<any> {
  const mod: any = await import(
    "../../../packages/server-runtime/src/composition/console-domain/operation-executors/system-observation-executors.ts"
  );
  return mod.executeSystemObservationOperation;
}

function stubMetricsFetch(body: string = EXPOSITION, status: number = 200) : any {
  const fetchMock: any = vi.fn(async () : Promise<any> => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () : Promise<string> => body
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() : any => {
  vi.resetModules();
  vi.stubEnv("MESHRIX_RELAY_METRICS_URL", "");
  vi.stubEnv("MESHRIX_RELAY_ADMIN_TOKEN", "");
  vi.stubEnv("MESHRIX_RELAY_TRAFFIC_PERSIST", "");
});

afterEach(() : any => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("system.relay_traffic executor", () : any => {
  it("reports configured:false honestly when the metrics URL is absent", async () : Promise<any> => {
    const execute: any = await loadExecutor();
    const response: any = await execute({
      operationId: "system.relay_traffic",
      input: {},
      context: {}
    });
    expect(response).toMatchObject({ status: 200, payload: { configured: false } });
  });

  it("parses the v0.0.4 exposition, sends the bearer token and seeds history", async () : Promise<any> => {
    vi.stubEnv("MESHRIX_RELAY_METRICS_URL", "https://relay.example.test/admin/metrics?tenant=t-1");
    vi.stubEnv("MESHRIX_RELAY_ADMIN_TOKEN", "tok-1");
    const fetchMock: any = stubMetricsFetch();
    const execute: any = await loadExecutor();

    const response: any = await execute({
      operationId: "system.relay_traffic",
      input: {},
      context: {}
    });

    expect(response.status).toBe(200);
    expect(response.payload.configured).toBe(true);
    expect(response.payload.error).toBeUndefined();
    expect(typeof response.payload.fetchedAt).toBe("string");

    const metrics: any = response.payload.metrics;
    // Only the meshrix_relay_* projection is kept; foreign exporter series
    // are dropped rather than materialized.
    expect(metrics.map((metric?: any) : any => metric.name)).toEqual([
      "meshrix_relay_sessions_admitted",
      "meshrix_relay_bytes_in",
      "meshrix_relay_sessions_closed"
    ]);
    const admitted: any = metrics[0];
    expect(admitted.help).toBe("Sessions admitted after directory authority checks.");
    expect(admitted.type).toBe("counter");
    expect(admitted.samples).toHaveLength(2);
    expect(admitted.samples[0]).toEqual({
      labels: { object: "session", tenant: "t-1", route: "r-1", device: "", scope: "durable" },
      value: 4
    });

    expect(response.payload.history).toHaveLength(1);
    expect(response.payload.history[0].sums).toMatchObject({
      meshrix_relay_sessions_admitted: 6,
      meshrix_relay_bytes_in: 2048,
      meshrix_relay_sessions_closed: 7
    });
    expect(response.payload.history[0].sums.foreign_exporter_metric).toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://relay.example.test/admin/metrics?tenant=t-1");
    expect(init.headers.authorization).toBe("Bearer tok-1");
  });

  it("omits the authorization header when no admin token is configured", async () : Promise<any> => {
    vi.stubEnv("MESHRIX_RELAY_METRICS_URL", "https://relay.example.test/admin/metrics");
    const fetchMock: any = stubMetricsFetch();
    const execute: any = await loadExecutor();

    await execute({ operationId: "system.relay_traffic", input: {}, context: {} });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.authorization).toBeUndefined();
  });

  it("bounds the history ring and appends at most one point per interval", async () : Promise<any> => {
    vi.useFakeTimers();
    const base: any = 1_700_000_000_000;
    vi.setSystemTime(base);
    vi.stubEnv("MESHRIX_RELAY_METRICS_URL", "https://relay.example.test/admin/metrics");
    stubMetricsFetch();
    const execute: any = await loadExecutor();
    const run: any = () : Promise<any> => execute({ operationId: "system.relay_traffic", input: {}, context: {} });

    const first: any = await run();
    expect(first.payload.history).toHaveLength(1);

    // A second fetch inside the 15s interval must not append another point.
    const second: any = await run();
    expect(second.payload.history).toHaveLength(1);

    for (let index = 1; index <= 244; index += 1) {
      vi.setSystemTime(base + index * 20_000);
      await run();
    }
    const last: any = await run();
    vi.setSystemTime(base + 245 * 20_000);
    const afterCap: any = await run();

    expect(last.payload.history.length).toBe(240);
    expect(afterCap.payload.history.length).toBe(240);
    // Kept entries are the newest 240 of the 245 recorded points.
    expect(afterCap.payload.history[0].t).toBe(base + 6 * 20_000);
    expect(afterCap.payload.history[239].t).toBe(base + 245 * 20_000);
  });

  it("returns an honest relay_unreachable error on fetch failure", async () : Promise<any> => {
    vi.stubEnv("MESHRIX_RELAY_METRICS_URL", "https://relay.example.test/admin/metrics");
    vi.stubGlobal("fetch", vi.fn(async () : Promise<any> => {
      throw new Error("connect ECONNREFUSED");
    }));
    const execute: any = await loadExecutor();

    const response: any = await execute({ operationId: "system.relay_traffic", input: {}, context: {} });

    expect(response.status).toBe(200);
    expect(response.payload).toMatchObject({ configured: true, error: "relay_unreachable" });
    expect(response.payload.metrics).toBeUndefined();
  });

  it("returns relay_unreachable with the HTTP status on non-2xx responses", async () : Promise<any> => {
    vi.stubEnv("MESHRIX_RELAY_METRICS_URL", "https://relay.example.test/admin/metrics");
    stubMetricsFetch("Unauthorized", 401);
    const execute: any = await loadExecutor();

    const response: any = await execute({ operationId: "system.relay_traffic", input: {}, context: {} });

    expect(response.status).toBe(200);
    expect(response.payload).toMatchObject({ configured: true, error: "relay_unreachable", status: 401 });
  });

  it("rejects an oversized exposition body instead of buffering it fully", async () : Promise<any> => {
    vi.stubEnv("MESHRIX_RELAY_METRICS_URL", "https://relay.example.test/admin/metrics");
    stubMetricsFetch(`meshrix_relay_sessions_admitted 1\n${"# HELP pad ".padEnd(300_000, "x")}`);
    const execute: any = await loadExecutor();

    const response: any = await execute({ operationId: "system.relay_traffic", input: {}, context: {} });

    expect(response.status).toBe(200);
    expect(response.payload).toMatchObject({ configured: true, error: "metrics_response_invalid" });
    expect(response.payload.metrics).toBeUndefined();
  });

  it("bounds metric series and per-series samples from remote input", async () : Promise<any> => {
    vi.stubEnv("MESHRIX_RELAY_METRICS_URL", "https://relay.example.test/admin/metrics");
    const lines: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      lines.push(`meshrix_relay_sessions_admitted{index="${index}"} ${index}`);
    }
    for (let index = 0; index < 80; index += 1) {
      lines.push(`meshrix_relay_synthetic_${index} 1`);
    }
    stubMetricsFetch(lines.join("\n"));
    const execute: any = await loadExecutor();

    const response: any = await execute({ operationId: "system.relay_traffic", input: {}, context: {} });

    expect(response.status).toBe(200);
    expect(response.payload.metrics.length).toBeLessThanOrEqual(64);
    for (const metric of response.payload.metrics) {
      expect(metric.samples.length).toBeLessThanOrEqual(128);
    }
  });
});

describe("system.relay_traffic history persistence", () : any => {
  const makeTempDir: any = () : any => fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-relay-traffic-"));

  it("writes the ring to MESHRIX_RELAY_TRAFFIC_PERSIST on each append and reloads it fresh", async () : Promise<any> => {
    vi.useFakeTimers();
    const base: any = 1_700_000_000_000;
    vi.setSystemTime(base);
    const dir: any = makeTempDir();
    const file: any = path.join(dir, "history.json");
    vi.stubEnv("MESHRIX_RELAY_METRICS_URL", "https://relay.example.test/admin/metrics");
    vi.stubEnv("MESHRIX_RELAY_TRAFFIC_PERSIST", file);
    stubMetricsFetch();
    let execute: any = await loadExecutor();
    const run: any = () : Promise<any> => execute({ operationId: "system.relay_traffic", input: {}, context: {} });

    await run();
    vi.setSystemTime(base + 20_000);
    await run();

    expect(fs.existsSync(file)).toBe(true);
    const persisted: any = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(persisted).toHaveLength(2);
    expect(persisted[0].t).toBe(base);
    expect(persisted[0].sums.meshrix_relay_sessions_admitted).toBe(6);
    expect(persisted[1].t).toBe(base + 20_000);
    // Atomic-ish write: the tmp file is renamed away, not left behind.
    expect(fs.readdirSync(dir).sort()).toEqual(["history.json"]);

    // Fresh module state reloads the persisted ring; the restored last
    // sample time also keeps the append interval honest (no re-append at
    // the same instant), and a later tick appends after it.
    vi.resetModules();
    execute = await loadExecutor();
    let response: any = await run();
    expect(response.status).toBe(200);
    expect(response.payload.history).toHaveLength(2);
    expect(response.payload.history[0].t).toBe(base);
    expect(response.payload.history[0].sums.meshrix_relay_bytes_in).toBe(2048);

    vi.setSystemTime(base + 40_000);
    response = await run();
    expect(response.payload.history).toHaveLength(3);
    expect(response.payload.history[2].t).toBe(base + 40_000);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolves the literal \"1\" to <userDataPath>/relay-traffic-history.json", async () : Promise<any> => {
    const dir: any = makeTempDir();
    vi.stubEnv("MESHRIX_RELAY_METRICS_URL", "https://relay.example.test/admin/metrics");
    vi.stubEnv("MESHRIX_RELAY_TRAFFIC_PERSIST", "1");
    stubMetricsFetch();
    const execute: any = await loadExecutor();

    const response: any = await execute({
      operationId: "system.relay_traffic",
      input: {},
      context: { userDataPath: dir }
    });

    expect(response.status).toBe(200);
    const file: any = path.join(dir, "relay-traffic-history.json");
    expect(fs.existsSync(file)).toBe(true);
    const persisted: any = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(persisted).toHaveLength(1);
    expect(persisted[0].sums.meshrix_relay_sessions_admitted).toBe(6);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the ring in memory when \"1\" has no userDataPath", async () : Promise<any> => {
    vi.stubEnv("MESHRIX_RELAY_METRICS_URL", "https://relay.example.test/admin/metrics");
    vi.stubEnv("MESHRIX_RELAY_TRAFFIC_PERSIST", "1");
    stubMetricsFetch();
    const execute: any = await loadExecutor();

    const response: any = await execute({ operationId: "system.relay_traffic", input: {}, context: {} });

    expect(response.status).toBe(200);
    expect(response.payload.history).toHaveLength(1);
  });

  it("tolerates malformed persisted content and drops invalid entries", async () : Promise<any> => {
    const dir: any = makeTempDir();
    const file: any = path.join(dir, "history.json");
    fs.writeFileSync(file, JSON.stringify([
      "junk",
      { t: "not-a-number", sums: {} },
      { t: 1234, sums: { meshrix_relay_bytes_in: 42, bogus: "x" } },
      { t: 9999, sums: "not-an-object" }
    ]), "utf8");
    vi.stubEnv("MESHRIX_RELAY_METRICS_URL", "https://relay.example.test/admin/metrics");
    vi.stubEnv("MESHRIX_RELAY_TRAFFIC_PERSIST", file);
    stubMetricsFetch();
    const execute: any = await loadExecutor();

    const response: any = await execute({ operationId: "system.relay_traffic", input: {}, context: {} });

    expect(response.status).toBe(200);
    // Only the well-formed entry is restored; non-finite sums are dropped
    // and the fresh fetch appends normally after it.
    expect(response.payload.history).toHaveLength(2);
    expect(response.payload.history[0]).toEqual({ t: 1234, sums: { meshrix_relay_bytes_in: 42 } });
    expect(response.payload.history[1].sums.meshrix_relay_sessions_admitted).toBe(6);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps serving the in-memory ring when the file cannot be written", async () : Promise<any> => {
    const dir: any = makeTempDir();
    const blocker: any = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "x", "utf8");
    // A path through a regular file makes every write fail (ENOTDIR).
    vi.stubEnv("MESHRIX_RELAY_METRICS_URL", "https://relay.example.test/admin/metrics");
    vi.stubEnv("MESHRIX_RELAY_TRAFFIC_PERSIST", path.join(blocker, "history.json"));
    stubMetricsFetch();
    const execute: any = await loadExecutor();

    const response: any = await execute({ operationId: "system.relay_traffic", input: {}, context: {} });

    expect(response.status).toBe(200);
    expect(response.payload.history).toHaveLength(1);
    expect(response.payload.history[0].sums.meshrix_relay_sessions_admitted).toBe(6);
    // The write failure is surfaced, not masked as normal: the panel can
    // show that restart would lose the in-memory ring.
    expect(response.payload.persistence).toMatchObject({
      state: "degraded",
      reason: "write_failed"
    });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports persistence degradation then recovers once writes succeed", async () : Promise<any> => {
    vi.useFakeTimers();
    const base: any = 1_700_000_000_000;
    vi.setSystemTime(base);
    const dir: any = makeTempDir();
    const blocker: any = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "x", "utf8");
    const goodFile: any = path.join(dir, "history.json");
    vi.stubEnv("MESHRIX_RELAY_METRICS_URL", "https://relay.example.test/admin/metrics");
    vi.stubEnv("MESHRIX_RELAY_TRAFFIC_PERSIST", path.join(blocker, "history.json"));
    stubMetricsFetch();
    const execute: any = await loadExecutor();
    const run: any = () : Promise<any> => execute({ operationId: "system.relay_traffic", input: {}, context: {} });

    const failed: any = await run();
    expect(failed.payload.persistence).toMatchObject({ state: "degraded", reason: "write_failed" });

    // Pointing the ring at a writable path lets the next append persist:
    // degradation recovers instead of latching.
    vi.stubEnv("MESHRIX_RELAY_TRAFFIC_PERSIST", goodFile);
    vi.setSystemTime(base + 20_000);
    const recovered: any = await run();
    expect(recovered.payload.persistence).toMatchObject({ state: "durable" });
    expect(recovered.payload.history).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(goodFile, "utf8"))).toHaveLength(2);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
