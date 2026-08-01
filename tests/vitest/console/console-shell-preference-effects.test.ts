// @vitest-environment jsdom
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  applyAppearancePresetDocument,
  applyConsoleLanguageDocument,
  persistAppearancePreset,
  persistConsoleLanguage,
  readStoredAppearancePreset,
  readStoredConsoleLanguage,
} from "../../../apps/console/composables/console-shell-preference-effects";
import { consoleMessages } from "../../../apps/console/i18n/console";

const browserWindowMock: any = vi.hoisted(() : any => ({
  readBrowserLocalStorageItem: vi.fn(),
  writeBrowserLocalStorageItem: vi.fn(),
}));

vi.mock("../../../apps/console/lib/browser-window", () : any => ({
  readBrowserLocalStorageItem: browserWindowMock.readBrowserLocalStorageItem,
  writeBrowserLocalStorageItem: browserWindowMock.writeBrowserLocalStorageItem,
}));

describe("console shell preference effects behavior", () : any => {
  beforeEach(() : any => {
    vi.clearAllMocks();
    document.documentElement.className = "";
    document.documentElement.lang = "";
    document.title = "";
  });

  it("reads only supported stored appearance preset and language values", () : any => {
    browserWindowMock.readBrowserLocalStorageItem.mockImplementation((key: string) : any =>
      key === "meshrix-appearance-preset" ? "sunset-ember" : null,
    );
    expect(readStoredAppearancePreset()).toBe("sunset-ember");

    browserWindowMock.readBrowserLocalStorageItem.mockImplementation((key: string) : any =>
      key === "meshrix-appearance-preset" ? "unknown" : null,
    );
    expect(readStoredAppearancePreset()).toBeNull();

    browserWindowMock.readBrowserLocalStorageItem.mockReset();
    browserWindowMock.readBrowserLocalStorageItem.mockReturnValueOnce("en");
    expect(readStoredConsoleLanguage()).toBe("en");

    browserWindowMock.readBrowserLocalStorageItem.mockReturnValueOnce("zh-CN");
    expect(readStoredConsoleLanguage()).toBe("zh-CN");

    browserWindowMock.readBrowserLocalStorageItem.mockReturnValueOnce("fr");
    expect(readStoredConsoleLanguage()).toBeNull();
  });

  it("returns null when storage reads throw and swallows write failures", () : any => {
    browserWindowMock.readBrowserLocalStorageItem.mockImplementation(() : any => {
      throw new Error("storage blocked");
    });
    browserWindowMock.writeBrowserLocalStorageItem.mockImplementation(() : any => {
      throw new Error("storage blocked");
    });

    expect(readStoredAppearancePreset()).toBeNull();
    expect(readStoredConsoleLanguage()).toBeNull();
    expect(() : any => persistAppearancePreset("sunset-ember")).not.toThrow();
    expect(() : any => persistConsoleLanguage("en")).not.toThrow();
  });

  it("persists preferences using stable storage keys", () : any => {
    persistAppearancePreset("geek-light-blue");
    persistConsoleLanguage("zh-CN");

    expect(browserWindowMock.writeBrowserLocalStorageItem).toHaveBeenCalledWith("meshrix-appearance-preset", "geek-light-blue");
    expect(browserWindowMock.writeBrowserLocalStorageItem).toHaveBeenCalledWith("meshrix-language", "zh-CN");
  });

  it("applies appearance through the document dataset", () : any => {
    document.documentElement.classList.add("theme-dark", "theme-light");
    applyAppearancePresetDocument("geek-light-blue");
    expect(document.documentElement.dataset.appearancePreset).toBe("geek-light-blue");
    expect(document.documentElement.dataset.appearanceColorScheme).toBe("light");
    expect(document.documentElement.classList.contains("theme-dark")).toBe(false);
    expect(document.documentElement.classList.contains("theme-light")).toBe(false);
  });

  it("applies document language and localized title", () : any => {
    applyConsoleLanguageDocument("en");
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe(consoleMessages.en.appTitle);

    applyConsoleLanguageDocument("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.title).toBe(consoleMessages["zh-CN"].appTitle);
  });
});
