export const MCP_GATEWAY_LOAD_FIXTURE_OPERATION_TIMEOUT_MS: number = 30_000;

export function mcpGatewayLoadPhaseShouldIssueNext({
  issued = 0,
  requestTarget = 0,
  safetyTriggered = false
}: Record<string, any> = {}) : boolean {
  return safetyTriggered !== true && Number(issued) < Number(requestTarget);
}

function percentile(values: number[] = [], percentileValue = 50) : number {
  if (values.length === 0) return 0;
  const sorted: number[] = [...values].sort((left, right) => left - right);
  const index: number = Math.min(
    sorted.length - 1,
    Math.floor((percentileValue / 100) * sorted.length)
  );
  return Number(sorted[index].toFixed(2));
}

function safeFailureCode(value: unknown, fallback = "request_failed"): string {
  const normalized: string = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(normalized)
    ? normalized
    : fallback;
}

function responseFailure(response: any): { code: string; status: number } {
  const data: any = response?.payload?.error?.data;
  const status: number = Number.isSafeInteger(Number(data?.status))
    ? Number(data.status)
    : Number.isSafeInteger(Number(response?.status))
      ? Number(response.status)
      : 0;
  return {
    code: safeFailureCode(
      data?.code ||
      response?.payload?.error?.code ||
      (status > 0 ? String(status) : "request_failed")
    ),
    status: status >= 100 && status <= 599 ? status : 0
  };
}

export async function runMcpGatewayLoadPhase({
  name,
  requestTarget,
  concurrency,
  invoke,
  safetyCheck
}: Record<string, any> = {}) : Promise<Record<string, any>> {
  const startedAt: number = performance.now();
  const latencies: number[] = [];
  const failureCounts: Map<string, { code: string; status: number; count: number }> = new Map();
  const stats: Record<string, any> = {
    name,
    issued: 0,
    completed: 0,
    ok: 0,
    failed: 0,
    firstErrorCode: "",
    safetyStop: false,
    safetyReason: ""
  };

  function recordFailure({ code, status }: { code: string; status: number }): void {
    const key: string = `${status}\u0000${code}`;
    const existing = failureCounts.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    failureCounts.set(key, { code, status, count: 1 });
  }

  async function worker(workerId = 0) : Promise<void> {
    while (mcpGatewayLoadPhaseShouldIssueNext({
      issued: stats.issued,
      requestTarget,
      safetyTriggered: stats.safetyStop
    })) {
      const safety: any = safetyCheck();
      if (safety?.triggered) {
        stats.safetyStop = true;
        stats.safetyReason = String(safety.reason || "");
        return;
      }
      if (!mcpGatewayLoadPhaseShouldIssueNext({
        issued: stats.issued,
        requestTarget,
        safetyTriggered: stats.safetyStop
      })) {
        return;
      }
      const id: number = stats.issued + 1;
      stats.issued += 1;
      const before: number = performance.now();
      try {
        const response: any = await invoke(id, workerId);
        latencies.push(performance.now() - before);
        stats.completed += 1;
        if (response?.status === 200 && !response?.payload?.error) {
          stats.ok += 1;
        } else {
          stats.failed += 1;
          const failure = responseFailure(response);
          stats.firstErrorCode ||= failure.code;
          recordFailure(failure);
        }
      } catch (error: any) {
        stats.completed += 1;
        stats.failed += 1;
        const failure = { code: safeFailureCode(error?.code || error?.name), status: 0 };
        stats.firstErrorCode ||= failure.code;
        recordFailure(failure);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Number(concurrency) || 1) }, (_unused, index) => worker(index)));
  const durationMs: number = Math.max(1, performance.now() - startedAt);
  return {
    ...stats,
    safetyStop: stats.safetyStop,
    durationMs: Number(durationMs.toFixed(2)),
    requestsPerSecond: Number(((stats.completed * 1000) / durationMs).toFixed(2)),
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    failureClassifications: [...failureCounts.values()].sort((left, right) : number =>
      left.status - right.status || left.code.localeCompare(right.code)
    )
  };
}
