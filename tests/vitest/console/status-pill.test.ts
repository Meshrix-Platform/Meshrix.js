// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import StatusPill from "@meshrix/ui-console/status-pill";
import {
  currentConsoleLocale,
  localizeConsoleText,
  setConsoleLocaleState,
} from "../../../apps/console/i18n/console";

// The canonical pill renders the label it receives; call sites localize labels
// before passing them in (this mirrors the helper used by StatusPill consumers).
const localizeStatusPillLabel = (value: any) : any =>
  localizeConsoleText(String(value ?? ""), currentConsoleLocale.value);

afterEach(() : any => {
  setConsoleLocaleState("zh-CN");
});

describe("StatusPill behavior", () : any => {
  it("uses explicit tones, aria labels, and optional dots", () : any => {
    const wrapper: any = mount(StatusPill, {
      props: {
        ariaLabel: "Custom status",
        label: "Running",
        showDot: false,
        tone: "  danger  ",
      },
    });

    expect(wrapper.attributes("data-tone")).toBe("danger");
    expect(wrapper.attributes("aria-label")).toBe("Custom status");
    expect(wrapper.attributes("data-enabled")).toBeUndefined();
    expect(wrapper.find(".standard-status-pill-dot").exists()).toBe(false);
    expect(wrapper.find(".standard-status-pill-label").text()).toBe("Running");
  });

  it("derives success and neutral tones from enabled state", () : any => {
    const enabled: any = mount(StatusPill, {
      props: {
        enabled: true,
        label: "enabled",
      },
    });
    const disabled: any = mount(StatusPill, {
      props: {
        enabled: false,
        label: 404,
      },
    });
    const neutral: any = mount(StatusPill, {
      props: {
        label: "neutral",
      },
    });

    expect(enabled.attributes("data-tone")).toBe("success");
    expect(enabled.attributes("data-enabled")).toBe("true");
    expect(enabled.find(".standard-status-pill-dot").exists()).toBe(true);
    expect(disabled.attributes("data-tone")).toBe("neutral");
    expect(disabled.attributes("data-enabled")).toBe("false");
    expect(disabled.attributes("aria-label")).toBe("404");
    expect(neutral.attributes("data-tone")).toBe("neutral");
    expect(neutral.attributes("data-enabled")).toBeUndefined();
  });

  it("renders call-site localized display and accessible labels", () : any => {
    setConsoleLocaleState("en");
    const wrapper: any = mount(StatusPill, {
      props: {
        label: localizeStatusPillLabel("运行中"),
        tone: "completed",
      },
    });

    expect(wrapper.attributes("data-tone")).toBe("completed");
    expect(wrapper.find(".standard-status-pill-label").text()).toBe("Running");
    expect(wrapper.attributes("aria-label")).toBe("Running");
  });

  it("localizes cleared approval status labels at the call site", () : any => {
    setConsoleLocaleState("en");
    const wrapper: any = mount(StatusPill, {
      props: {
        label: localizeStatusPillLabel("已清空"),
        tone: "success",
      },
    });

    expect(wrapper.find(".standard-status-pill-label").text()).toBe("Cleared");
    expect(wrapper.attributes("aria-label")).toBe("Cleared");
  });

  it("localizes english labels back to chinese at the call site", () : any => {
    const wrapper: any = mount(StatusPill, {
      props: {
        label: localizeStatusPillLabel("Running"),
      },
    });

    expect(wrapper.find(".standard-status-pill-label").text()).toBe("运行中");
  });
});
