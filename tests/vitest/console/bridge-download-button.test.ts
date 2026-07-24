// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BridgeDownloadButton from "../../../apps/console/components/BridgeDownloadButton.vue";

const bridgeMock = vi.hoisted(() => ({
  downloadFile: vi.fn(),
}));

vi.mock("../../../apps/console/lib/bridge", () => ({
  bridge: {
    downloadFile: bridgeMock.downloadFile,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  bridgeMock.downloadFile.mockReset();
});

describe("BridgeDownloadButton behavior", () => {
  it("downloads with a custom filename and emits the result", async () => {
    bridgeMock.downloadFile.mockResolvedValue({
      fileName: "report.csv",
      ok: true,
      size: 42,
    });
    const wrapper = mount(BridgeDownloadButton, {
      props: {
        buttonClass: "bridge-download-link",
        busyLabel: "正在保存",
        downloadName: "report.csv",
        href: "/api/export/report",
        inline: true,
        label: "保存 CSV",
      },
    });

    expect(wrapper.find(".bridge-download-button").attributes("data-inline")).toBe("true");
    expect(wrapper.find("button").classes()).toContain("bridge-download-link");
    await wrapper.find("button").trigger("click");
    await wrapper.vm.$nextTick();

    expect(bridgeMock.downloadFile).toHaveBeenCalledWith("/api/export/report", {
      fileName: "report.csv",
    });
    expect(wrapper.emitted("downloaded")?.[0]).toEqual([
      { fileName: "report.csv", ok: true, size: 42 },
    ]);
    expect(wrapper.emitted("failed")).toBeUndefined();
    expect(wrapper.find("button").text()).toBe("保存 CSV");
  });

  it("reports download failures and renders the error message", async () => {
    bridgeMock.downloadFile.mockRejectedValue(new Error("download denied"));
    const wrapper = mount(BridgeDownloadButton, {
      props: {
        href: "/api/export/denied",
      },
    });

    await wrapper.find("button").trigger("click");
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("download denied");
    expect(wrapper.find(".bridge-download-error").text()).toBe("download denied");
    expect(wrapper.emitted("failed")?.[0]).toEqual(["download denied"]);
    expect(wrapper.emitted("downloaded")).toBeUndefined();
  });

  it("uses a generic failure message for non-Error rejections", async () => {
    bridgeMock.downloadFile.mockRejectedValue("plain failure");
    const wrapper = mount(BridgeDownloadButton, {
      props: {
        href: "/api/export/plain",
      },
    });

    await wrapper.find("button").trigger("click");
    await wrapper.vm.$nextTick();

    expect(wrapper.find(".bridge-download-error").text()).toBe("下载失败。");
    expect(wrapper.emitted("failed")?.[0]).toEqual(["下载失败。"]);
  });

  it("does not start downloads while disabled or without a usable href", async () => {
    const disabled = mount(BridgeDownloadButton, {
      props: {
        disabled: true,
        href: "/api/export/report",
      },
    });
    const missingHref = mount(BridgeDownloadButton, {
      props: {
        href: "",
      },
    });
    const placeholderHref = mount(BridgeDownloadButton, {
      props: {
        href: "#",
      },
    });

    expect(disabled.find("button").attributes("disabled")).toBeDefined();
    expect(missingHref.find("button").attributes("disabled")).toBeDefined();
    expect(placeholderHref.find("button").attributes("disabled")).toBeDefined();
    await disabled.find("button").trigger("click");
    await missingHref.find("button").trigger("click");
    await placeholderHref.find("button").trigger("click");

    expect(bridgeMock.downloadFile).not.toHaveBeenCalled();
  });
});
