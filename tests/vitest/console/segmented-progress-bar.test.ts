// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SegmentedProgressBar from "../../../apps/console/components/SegmentedProgressBar.vue";

describe("SegmentedProgressBar behavior", () => {
  it("renders generated label segments from completed step counts", () => {
    const wrapper = mount(SegmentedProgressBar, {
      props: {
        ariaLabel: "上传进度",
        completedSteps: 2,
        labels: ["选择", "上传", "解析"],
        showLabels: true,
        size: "compact",
        valueLabel: "2 / 3",
      },
    });

    const segments = wrapper.findAll(".meshrix-segmented-progress-segment");
    expect(wrapper.attributes("role")).toBe("progressbar");
    expect(wrapper.attributes("aria-label")).toBe("上传进度");
    expect(wrapper.attributes("aria-valuemax")).toBe("3");
    expect(wrapper.attributes("aria-valuenow")).toBe("2");
    expect(wrapper.attributes("aria-valuetext")).toBe("2 / 3");
    expect(wrapper.attributes("data-size")).toBe("compact");
    expect(wrapper.attributes("data-show-labels")).toBe("true");
    expect(segments.map((segment) => segment.attributes("data-state"))).toEqual([
      "complete",
      "complete",
      "pending",
    ]);
    expect(segments.map((segment) => segment.attributes("title"))).toEqual([
      "选择",
      "上传",
      "解析",
    ]);
    expect(wrapper.text()).toContain("选择");
    expect(wrapper.attributes("style")).toContain("repeat(3, minmax(0, 1fr))");
  });

  it("normalizes explicit segment states and fallback labels", () => {
    const wrapper = mount(SegmentedProgressBar, {
      props: {
        segments: [
          { key: "queued", label: "Queued", state: "completed" },
          { key: "running", state: "running" },
          { key: "bad", label: "Bad", state: "failed" },
          { key: "idle", label: "", state: "mystery" },
        ],
      },
    });

    const segments = wrapper.findAll(".meshrix-segmented-progress-segment");
    expect(wrapper.attributes("aria-valuemax")).toBe("4");
    expect(wrapper.attributes("aria-valuenow")).toBe("1");
    expect(wrapper.attributes("aria-valuetext")).toBeUndefined();
    expect(segments.map((segment) => segment.attributes("data-state"))).toEqual([
      "complete",
      "active",
      "failed",
      "pending",
    ]);
    expect(segments.map((segment) => segment.attributes("title"))).toEqual([
      "Queued",
      "running",
      "Bad",
      "idle",
    ]);
    expect(wrapper.text()).toBe("");
  });

  it("keeps a stable one-column layout when no steps are supplied", () => {
    const wrapper = mount(SegmentedProgressBar);

    expect(wrapper.findAll(".meshrix-segmented-progress-segment")).toHaveLength(0);
    expect(wrapper.attributes("aria-valuemax")).toBe("0");
    expect(wrapper.attributes("aria-valuenow")).toBe("0");
    expect(wrapper.attributes("style")).toContain("repeat(1, minmax(0, 1fr))");
  });
});
