import { describe, expect, it, vi } from "vitest";

import { executeMonitorAlertOperation } from
  "../../../packages/server-runtime/src/composition/console-domain/operation-executors/storage-client-monitor-executors.mjs";

describe("monitor alert read operation", () => {
  it("reads the published state without triggering a monitor cycle", async () => {
    const getMonitorAlertState = vi.fn(async () => ({
      status: "unconfigured",
      reason: "configuration_missing",
      activeAlerts: [],
    }));
    const workQueueObservation = { id: "work-queue-observation" };

    const response = await executeMonitorAlertOperation({
      operationId: "system.monitor_alerts.get",
      input: {},
      context: {
        devopsProvider: { getMonitorAlertState },
        workQueueObservation,
      },
    });

    expect(response).toMatchObject({
      status: 200,
      payload: { status: "unconfigured", reason: "configuration_missing" },
    });
    expect(getMonitorAlertState).toHaveBeenCalledWith({
      refresh: false,
      workQueueObservation,
    });
  });
});
