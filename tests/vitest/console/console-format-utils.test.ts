import { describe, expect, it, vi } from "vitest";
import {
  csvCell,
  formatBytes,
  formatCompactDate,
  formatDate,
  formatDuration,
  formatMachineDate,
  jobStatusTone,
  jsonPreview,
  parseFilterDate,
  parseTime,
  safeDownloadName,
} from "../../../apps/console/composables/console-format-utils";

describe("console-format-utils", () : any => {
  it("formats filter boundaries consistently", () : any => {
    expect(parseFilterDate("", "start")).toBe(0);
    expect(parseFilterDate("2026-06-04", "start")).toBeGreaterThan(0);
    expect(parseFilterDate("2026-06-04", "end")).toBeGreaterThan(
      parseFilterDate("2026-06-04", "start"),
    );
  });

  it("formats machine and date strings with fallback values", () : any => {
    expect(formatMachineDate("", "compact")).toBe("未记录");
    expect(formatMachineDate("bad", "compact")).toBe("bad");
    expect(formatMachineDate("2026-06-04T00:00:00", "compact")).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
    expect(formatMachineDate("2026-06-04T00:00:00", "full")).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(formatDate("")).toBe("未记录");
    expect(formatCompactDate("")).toBe("未记录");
  });

  it("sanitizes text helpers", () : any => {
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell(null)).toBe('""');
    expect(jsonPreview({ a: 1 })).toContain("\"a\": 1");
    expect(jsonPreview(undefined)).toBe("{}");
    expect(safeDownloadName(" my report / name ")).toBe("my-report-name");
    expect(safeDownloadName("/\\:*?\"<>|test")).toBe("-test");
  });

  it("parses time and scales bytes with sane suffixes", () : any => {
    expect(parseTime("bad")).toBe(0);
    expect(parseTime("2026-06-04T00:00:00Z")).toBeGreaterThan(0);

    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(700)).toBe("700 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1048576)).toBe("1.0 MB");
    expect(formatBytes(1073741824)).toBe("1.0 GB");
  });

  it("formats elapsed durations across branches", () : any => {
    expect(formatDuration("", "")).toBe("--");
    expect(formatDuration("2026-06-04T00:00:00Z", "2026-06-04T00:00:30Z")).toBe("30s");
    expect(formatDuration("2026-06-04T00:00:00Z", "2026-06-04T00:02:00Z")).toBe("2m 0s");
    expect(formatDuration("2026-06-04T00:00:00Z", "2026-06-04T01:10:00Z")).toBe("1h 10m");
  });

  it("returns passthrough job status tone", () : any => {
    expect(jobStatusTone("running")).toBe("running");
    expect(jobStatusTone("queued")).toBe("queued");
  });

  it("keeps compact date fallback behavior", () : any => {
    expect(formatCompactDate("")).toBe("未记录");
    const now: any = new Date("2026-06-04T00:00:00Z").toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    expect(formatCompactDate("2026-06-04T00:00:00Z")).toBe(now);
    expect(formatDate("2026-06-04T00:00:00Z")).toBe(new Date("2026-06-04T00:00:00Z").toLocaleString("zh-CN", {
      hour12: false,
    }));
  });

  it("falls back when date formatting throws", () : any => {
    const spy: any = vi
      .spyOn(Date.prototype, "toLocaleString")
      .mockImplementation(() : any => {
        throw new Error("forced format failure");
      });

    expect(formatDate("2026-06-04T00:00:00Z")).toBe("2026-06-04T00:00:00Z");
    expect(formatCompactDate("2026-06-04T00:00:00Z")).toBe("2026-06-04T00:00:00Z");

    spy.mockRestore();
  });

  it("formats long duration in days", () : any => {
    expect(
      formatDuration("2026-06-01T00:00:00Z", "2026-06-03T03:00:00Z"),
    ).toBe("2d 3h");
  });
});
