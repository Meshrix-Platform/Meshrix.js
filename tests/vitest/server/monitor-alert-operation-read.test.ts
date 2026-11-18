import { describe, expect, it, vi } from "vitest";

import { executeMonitorAlertOperation } from
  "../../../packages/server-runtime/src/composition/console-domain/operation-executors/storage-client-monitor-executors.ts";

describe("monitor alert read operation", () : any => {
  it("reads the published state without triggering a monitor cycle", async () : Promise<any> => {
    const getMonitorAlertState: any = vi.fn(async () : Promise<any> => ({
      status: "unconfigured",
      reason: "configuration_missing",
      activeAlerts: [],
    }));
    const workQueueObservation: Record<string, any> = { id: "work-queue-observation" };

    const response: any = await executeMonitorAlertOperation({
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
