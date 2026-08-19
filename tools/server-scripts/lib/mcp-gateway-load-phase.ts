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

export async function runMcpGatewayLoadPhase({
  name,
  requestTarget,
  concurrency,
  invoke,
  safetyCheck
}: Record<string, any> = {}) : Promise<Record<string, any>> {
  const startedAt: number = performance.now();
  const latencies: number[] = [];
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
          stats.firstErrorCode ||= String(
            response?.payload?.error?.data?.code ||
            response?.payload?.error?.code ||
            response?.status
          );
        }
      } catch (error: any) {
        stats.completed += 1;
        stats.failed += 1;
        stats.firstErrorCode ||= error?.name || "request_failed";
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
    p95Ms: percentile(latencies, 95)
  };
}
