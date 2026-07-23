import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  elapsedText,
  formatDateTime,
  loadProductionHealthSnapshot,
  statusLabel,
  statusTone,
} from "../../../apps/console/lib/production-health";
import type { ProductionHealthGate } from "../../../apps/console/lib/types";

const productionHealthClientMocks = vi.hoisted(() => ({
  getProductionHealth: vi.fn(),
  getReadinessBaselineStatus: vi.fn(),
}));

vi.mock("../../../apps/console/lib/production-health-client", () => ({
  getProductionHealth: productionHealthClientMocks.getProductionHealth,
  getReadinessBaselineStatus: productionHealthClientMocks.getReadinessBaselineStatus,
}));

function gateWithElapsed(elapsedMs?: number): ProductionHealthGate {
  return {
    category: "coverage",
    command: "npm run vitest:coverage",
    commandSummary: elapsedMs === undefined ? undefined : { elapsedMs },
    description: "Unit coverage",
    gateId: "coverage.unit-threshold",
    label: "Coverage",
    required: true,
    status: "pass",
  } as ProductionHealthGate;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("production health lib behavior", () => {
  it("formats status labels, tones, timestamps, and elapsed durations", () => {
    expect(statusLabel("pass")).toBe("通过");
    expect(statusLabel("fail")).toBe("失败");
    expect(statusLabel("timeout")).toBe("超时");
    expect(statusLabel("blocked")).toBe("阻塞");
    expect(statusLabel("missing")).toBe("缺失");
    expect(statusLabel("partial")).toBe("部分");
    expect(statusLabel("warning")).toBe("预警");
    expect(statusLabel("unknown")).toBe("未知");
    expect(statusLabel("custom")).toBe("custom");
    expect(statusLabel("")).toBe("未知");

    expect(statusTone("pass")).toBe("success");
    expect(statusTone("fail")).toBe("danger");
    expect(statusTone("timeout")).toBe("danger");
    expect(statusTone("blocked")).toBe("danger");
    expect(statusTone("missing")).toBe("warning");
    expect(statusTone("partial")).toBe("warning");
    expect(statusTone("warning")).toBe("warning");
    expect(statusTone("other")).toBe("neutral");

    expect(formatDateTime("")).toBe("未生成");
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
    expect(formatDateTime("2026-06-04T10:20:00.000Z")).toContain("2026");

    expect(elapsedText(gateWithElapsed())).toBe("0ms");
    expect(elapsedText(gateWithElapsed(0))).toBe("0ms");
    expect(elapsedText(gateWithElapsed(999))).toBe("999ms");
    expect(elapsedText(gateWithElapsed(1234))).toBe("1.2s");
    expect(elapsedText(gateWithElapsed(10000))).toBe("10s");
    expect(elapsedText(gateWithElapsed(12345))).toBe("12s");
  });

  it("loads health and baseline snapshots together", async () => {
    const health = {
      gates: [],
      generatedAt: "2026-06-04T10:00:00.000Z",
      reportType: "v0.0.1:platform:production-health-1",
      sections: [],
      status: "pass",
    };
    productionHealthClientMocks.getProductionHealth.mockResolvedValueOnce(health);

    await expect(loadProductionHealthSnapshot()).resolves.toEqual({ health });
    expect(productionHealthClientMocks.getProductionHealth).toHaveBeenCalledTimes(1);
    expect(productionHealthClientMocks.getReadinessBaselineStatus).not.toHaveBeenCalled();
  });

  it("returns the health load error when the main health request fails", async () => {
    productionHealthClientMocks.getProductionHealth.mockRejectedValueOnce(new Error("health unavailable"));

    await expect(loadProductionHealthSnapshot()).resolves.toEqual({
      loadError: "health unavailable",
    });
    expect(productionHealthClientMocks.getReadinessBaselineStatus).not.toHaveBeenCalled();
  });

  it("reports string health load errors", async () => {
    productionHealthClientMocks.getProductionHealth.mockRejectedValueOnce("plain health failure");

    await expect(loadProductionHealthSnapshot()).resolves.toEqual({
      loadError: "plain health failure",
    });
    expect(productionHealthClientMocks.getReadinessBaselineStatus).not.toHaveBeenCalled();
  });
});
