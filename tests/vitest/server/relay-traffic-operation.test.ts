import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EXPOSITION: string = [
  "# HELP meshrix_relay_sessions_admitted Sessions admitted after directory authority checks.",
  "# TYPE meshrix_relay_sessions_admitted counter",
  'meshrix_relay_sessions_admitted{object="session",tenant="t-1",route="r-1",device="",scope="durable"} 4',
  'meshrix_relay_sessions_admitted{object="session",tenant="t-1",route="r-2",device="",scope="durable"} 2',
  "# HELP meshrix_relay_bytes_in Wire bytes received from connected sockets.",
  "# TYPE meshrix_relay_bytes_in counter",
  'meshrix_relay_bytes_in{object="session",tenant="t-1",route="r-1",device="",scope="ephemeral"} 2048',
  "# HELP meshrix_relay_mailbox_acked Peer acknowledgements durably recorded.",
  "# TYPE meshrix_relay_mailbox_acked counter",
  'meshrix_relay_mailbox_acked{object="mailbox",tenant="t-1",route="",device="d-9",scope="durable"} 7',
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
    expect(metrics.map((metric?: any) : any => metric.name)).toEqual([
      "meshrix_relay_sessions_admitted",
      "meshrix_relay_bytes_in",
      "meshrix_relay_mailbox_acked"
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
      meshrix_relay_mailbox_acked: 7
    });

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
});
