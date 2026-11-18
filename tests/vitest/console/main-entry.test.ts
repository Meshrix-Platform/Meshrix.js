// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("console main entry behavior", () : any => {
  beforeEach(() : any => {
    vi.resetModules();
    window.localStorage.clear();
    document.documentElement.removeAttribute("lang");
    document.documentElement.removeAttribute("translate");
    document.documentElement.className = "";
    document.body.removeAttribute("translate");
    document.body.className = "";
    document.body.innerHTML = '<div id="root"></div>';
  });

  it("sets translation guards and mounts the console app with Element Plus components", async () : Promise<any> => {
    const app: Record<string, any> = {
      use: vi.fn(),
      component: vi.fn(),
      mount: vi.fn()
    };
    app.use.mockReturnValue(app);
    app.component.mockReturnValue(app);
    app.mount.mockReturnValue(app);
    const createApp: any = vi.fn(() : any => app);
    const router: Record<string, any> = { name: "router" };
    const ServerConsoleApp: Record<string, any> = { name: "ServerConsoleApp" };

    vi.doMock("vue", async (importOriginal?: any) : Promise<any> => ({
      ...(await importOriginal<typeof import("vue")>()),
      createApp,
    }));
    vi.doMock("../../../apps/console/router/index", () : any => ({ router }));
    vi.doMock("../../../apps/console/ServerConsoleApp.vue", () : any => ({ default: ServerConsoleApp }));
    vi.doMock("element-plus/es/components/button/index.mjs", () : any => ({ ElButton: { name: "ElButton" } }));
    vi.doMock("element-plus/es/components/loading/index.mjs", () : any => ({ ElLoading: { name: "ElLoading" } }));
    vi.doMock("element-plus/es/components/select/index.mjs", () : any => ({
      ElOption: { name: "ElOption" },
      ElSelect: { name: "ElSelect" }
    }));
    vi.doMock("element-plus/es/components/table/index.mjs", () : any => ({
      ElTable: { name: "ElTable" },
      ElTableColumn: { name: "ElTableColumn" }
    }));
    vi.doMock("element-plus/es/components/button/style/css", () : any => ({}));
    vi.doMock("element-plus/es/components/loading/style/css", () : any => ({}));
    vi.doMock("element-plus/es/components/select/style/css", () : any => ({}));
    vi.doMock("element-plus/es/components/table/style/css", () : any => ({}));
    vi.doMock("element-plus/es/components/table-column/style/css", () : any => ({}));

    await import("../../../apps/console/main");

    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.documentElement.getAttribute("translate")).toBe("no");
    expect(document.documentElement.classList.contains("notranslate")).toBe(true);
    expect(document.body.getAttribute("translate")).toBe("no");
    expect(document.body.classList.contains("notranslate")).toBe(true);
    expect(createApp).toHaveBeenCalledWith(ServerConsoleApp);
    expect(app.use).toHaveBeenCalledWith(router);
    expect(app.use).toHaveBeenCalledWith({ name: "ElLoading" });
    expect(app.component.mock.calls.map((call?: any) : any => call[0])).toEqual([
      "ElButton",
      "ElSelect",
      "ElOption",
      "ElTable",
      "ElTableColumn"
    ]);
    expect(app.mount).toHaveBeenCalledWith("#root");
  });

  it("uses the stored console language before mounting", async () : Promise<any> => {
    window.localStorage.setItem("meshrix-language", "en");
    const app: Record<string, any> = {
      use: vi.fn(),
      component: vi.fn(),
      mount: vi.fn()
    };
    app.use.mockReturnValue(app);
    app.component.mockReturnValue(app);
    app.mount.mockReturnValue(app);
    const createApp: any = vi.fn(() : any => app);
    const router: Record<string, any> = { name: "router" };
    const ServerConsoleApp: Record<string, any> = { name: "ServerConsoleApp" };

    vi.doMock("vue", async (importOriginal?: any) : Promise<any> => ({
      ...(await importOriginal<typeof import("vue")>()),
      createApp,
    }));
    vi.doMock("../../../apps/console/router/index", () : any => ({ router }));
    vi.doMock("../../../apps/console/ServerConsoleApp.vue", () : any => ({ default: ServerConsoleApp }));
    vi.doMock("element-plus/es/components/button/index.mjs", () : any => ({ ElButton: { name: "ElButton" } }));
    vi.doMock("element-plus/es/components/loading/index.mjs", () : any => ({ ElLoading: { name: "ElLoading" } }));
    vi.doMock("element-plus/es/components/select/index.mjs", () : any => ({
      ElOption: { name: "ElOption" },
      ElSelect: { name: "ElSelect" }
    }));
    vi.doMock("element-plus/es/components/table/index.mjs", () : any => ({
      ElTable: { name: "ElTable" },
      ElTableColumn: { name: "ElTableColumn" }
    }));
    vi.doMock("element-plus/es/components/button/style/css", () : any => ({}));
    vi.doMock("element-plus/es/components/loading/style/css", () : any => ({}));
    vi.doMock("element-plus/es/components/select/style/css", () : any => ({}));
    vi.doMock("element-plus/es/components/table/style/css", () : any => ({}));
    vi.doMock("element-plus/es/components/table-column/style/css", () : any => ({}));

    await import("../../../apps/console/main");

    expect(document.documentElement.lang).toBe("en");
  });
});
