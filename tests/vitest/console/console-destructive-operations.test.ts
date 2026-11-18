// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ref } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const __dirname: any = path.dirname(fileURLToPath(import.meta.url));

const authClientMocks: any = vi.hoisted(() : any => ({
  revokeAuthSession: vi.fn(),
}));

vi.mock("../../../apps/console/lib/auth-client", () : any => ({
  getAuthOidc: vi.fn(),
  getAuthSession: vi.fn(),
  listAuthAudit: vi.fn(),
  listAuthSessions: vi.fn(),
  listAuthUsers: vi.fn(),
  loginAuth: vi.fn(),
  logoutAuth: vi.fn(),
  revokeAuthSession: authClientMocks.revokeAuthSession,
  saveAuthOidc: vi.fn(),
  updateAuthUser: vi.fn(),
}));

const shellContext: any = vi.hoisted(() : any => ({} as any));

vi.mock("#meshrix/console/server-console-shell-context", async () : Promise<any> => {
  const { namespaceServerConsoleShell } = await import("../../../tests/vitest/console/console-shell-test-utils");
  return {
    useServerConsoleShellContext: () : any => namespaceServerConsoleShell(shellContext),
  };
});

import ConsoleServiceDiscoveryPanel from "../../../apps/console/components/shell/ConsoleServiceDiscoveryPanel.vue";
import { createConsoleAuthController } from "../../../apps/console/composables/console-auth-controller";
import {
  registerConsoleConfirmHost,
  settleAllConsoleConfirms,
  settleConsoleConfirm,
  unregisterConsoleConfirmHost,
  useConsoleConfirmState,
} from "../../../apps/console/composables/console-confirm-controller";
import {
  CONSOLE_DESTRUCTIVE_OPERATIONS,
  getDestructiveOperation,
  requestDestructiveConfirm,
} from "../../../apps/console/composables/console-destructive-operation-registry";
import { clearConsoleToasts } from "../../../apps/console/composables/console-toast-controller";
import { consoleMessages } from "../../../apps/console/i18n/console";
import { SERVER_ADDRESS_STORAGE_KEY } from "../../../apps/console/lib/console-server-addresses";

const EXPECTED_OPERATION_IDS: any = [
  "auth.session.revoke",
  "service-discovery.address.remove",
  "publish.service.disable",
  "publish.service.republish",
  "publish.service.remove",
];

function resolveDottedMessage(root: any, dottedKey: string) : any {
  let node: any = root;
  for (const segment of dottedKey.split(".")) {
    node = node?.[segment];
  }
  return typeof node === "string" ? node : "";
}

function listConsoleSourceFiles(dir: string) : any {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath: any = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listConsoleSourceFiles(fullPath));
    } else if (/\.(ts|vue)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

beforeEach(() : any => {
  registerConsoleConfirmHost();
});

afterEach(() : any => {
  settleAllConsoleConfirms(false);
  unregisterConsoleConfirmHost();
  clearConsoleToasts();
  window.localStorage.removeItem(SERVER_ADDRESS_STORAGE_KEY);
});

describe("console destructive operation registry", () : any => {
  it("exports exactly the frozen id set, each entry frozen with tone/consequence and no requireText", () : any => {
    expect(CONSOLE_DESTRUCTIVE_OPERATIONS.map((operation: any) : any => operation.id)).toEqual(
      EXPECTED_OPERATION_IDS,
    );
    expect(Object.isFrozen(CONSOLE_DESTRUCTIVE_OPERATIONS)).toBe(true);
    for (const operation of CONSOLE_DESTRUCTIVE_OPERATIONS) {
      expect(Object.isFrozen(operation)).toBe(true);
      expect(["neutral", "warning", "danger"]).toContain(operation.tone);
      expect(operation.consequence).toMatch(/^destructive\.consequence\.[a-zA-Z]+$/);
      expect(operation.requireText).toBeUndefined();
    }
  });

  it("resolves consequence copy with a resource placeholder in both locales", () : any => {
    for (const operation of CONSOLE_DESTRUCTIVE_OPERATIONS) {
      for (const locale of ["zh-CN", "en"]) {
        const copy: any = resolveDottedMessage(consoleMessages[locale], operation.consequence);
        expect(copy, `${operation.id} / ${locale}`).toBeTruthy();
        expect(copy, `${operation.id} / ${locale}`).toContain("{resource}");
      }
    }
  });

  it("looks up operations by id and returns undefined for unregistered ids", () : any => {
    expect(getDestructiveOperation("auth.session.revoke")?.tone).toBe("danger");
    expect(getDestructiveOperation("service-discovery.address.remove")?.tone).toBe("danger");
    expect(getDestructiveOperation("publish.service.disable")?.tone).toBe("danger");
    expect(getDestructiveOperation("publish.service.remove")?.tone).toBe("danger");
    expect(getDestructiveOperation("publish.service.republish")?.tone).toBe("warning");
    expect(getDestructiveOperation("unknown.id")).toBeUndefined();
  });

  it("resolves false without a dialog host", async () : Promise<any> => {
    unregisterConsoleConfirmHost();
    await expect(
      requestDestructiveConfirm("auth.session.revoke", { resource: "session-1" }),
    ).resolves.toBe(false);
  });

  it("builds a consequence-stating confirm request and honors the decision", async () : Promise<any> => {
    const { currentConfirm } = useConsoleConfirmState();

    const declined: any = requestDestructiveConfirm("auth.session.revoke", { resource: "session-9" });
    expect(currentConfirm.value?.tone).toBe("danger");
    expect(currentConfirm.value?.message).toContain("session-9");
    expect(currentConfirm.value?.title).toBeTruthy();
    expect(currentConfirm.value?.confirmLabel).toBeTruthy();
    expect(currentConfirm.value?.requireText).toBeUndefined();
    settleConsoleConfirm(false);
    await expect(declined).resolves.toBe(false);

    const accepted: any = requestDestructiveConfirm("service-discovery.address.remove", {
      resource: "https://b.example.com",
    });
    expect(currentConfirm.value?.message).toContain("https://b.example.com");
    settleConsoleConfirm(true);
    await expect(accepted).resolves.toBe(true);
  });

  it("maps the audit-level warning tone to the dialog neutral tone", async () : Promise<any> => {
    const { currentConfirm } = useConsoleConfirmState();
    const pending: any = requestDestructiveConfirm("publish.service.republish", {
      resource: "service-a",
    });
    expect(currentConfirm.value?.tone).toBe("neutral");
    settleConsoleConfirm(true);
    await expect(pending).resolves.toBe(true);
  });

  it("throws for unregistered ids instead of confirming unguarded", () : any => {
    expect(() : any => requestDestructiveConfirm("bogus.id" as any, { resource: "x" })).toThrow(
      /Unregistered destructive operation/,
    );
  });

  it("keeps typed confirmation (requireText) at the existing two sites console-wide", () : any => {
    const consoleRoot: any = path.resolve(__dirname, "../../../apps/console");
    const sites: string[] = [];
    for (const file of listConsoleSourceFiles(consoleRoot)) {
      const text: any = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(/requireText:\s*([^,\n}]+)/g)) {
        const value: any = String(match[1] || "").trim();
        // Pass-throughs of an optional request field are not typed-confirmation policy sites.
        if (value === "options.requireText" || value === "operation.requireText") {
          continue;
        }
        sites.push(`${path.relative(consoleRoot, file).split(path.sep).join("/")} -> ${value}`);
      }
    }
    expect(sites.sort()).toEqual([
      "composables/console-api-key-distribution-controller.ts -> record.workloadDisplayName",
      "composables/console-workspace-management-controller.ts -> \"DELETE\"",
    ]);
  });
});

describe("auth session revoke confirm", () : any => {
  beforeEach(() : any => {
    authClientMocks.revokeAuthSession.mockReset();
    authClientMocks.revokeAuthSession.mockResolvedValue(undefined);
  });

  function createController() : any {
    const setBusy: any = vi.fn();
    const clearBusy: any = vi.fn();
    const controller: any = createConsoleAuthController({
      consoleState: ref(null),
      error: ref(""),
      clearBusy,
      refreshState: vi.fn(async () : Promise<any> => undefined),
      resetServerEventCursor: vi.fn(),
      setBusy,
      startServerEventSubscription: vi.fn(),
      stopServerEventSubscription: vi.fn(),
    });
    return { controller, setBusy, clearBusy };
  }

  it("requires a consequence-stating confirm before revoking a session", async () : Promise<any> => {
    const { controller, setBusy, clearBusy } = createController();
    const { currentConfirm } = useConsoleConfirmState();

    const declined: any = controller.revokeConsoleSession("session-1");
    expect(currentConfirm.value?.message).toContain("session-1");
    expect(authClientMocks.revokeAuthSession).not.toHaveBeenCalled();
    settleConsoleConfirm(false);
    await declined;
    expect(authClientMocks.revokeAuthSession).not.toHaveBeenCalled();
    expect(setBusy).not.toHaveBeenCalled();

    const accepted: any = controller.revokeConsoleSession("session-1");
    expect(currentConfirm.value?.message).toContain("session-1");
    settleConsoleConfirm(true);
    await accepted;
    expect(authClientMocks.revokeAuthSession).toHaveBeenCalledTimes(1);
    expect(authClientMocks.revokeAuthSession).toHaveBeenCalledWith("session-1");
    expect(setBusy).toHaveBeenCalledWith("auth:session:session-1");
    expect(clearBusy).toHaveBeenCalledWith("auth:session:session-1");
  });
});

describe("service discovery address remove confirm", () : any => {
  beforeEach(() : any => {
    shellContext.isBusy = () : any => false;
    shellContext.consoleState = ref<any>({ server: { url: "https://current.example.com" } });
    shellContext.discoveryDraft = ref<any>({
      serverId: "",
      serverLabel: "",
      activeServiceUrl: "",
      advertisedBaseUrl: "",
      bootstrapBaseUrl: "",
    });
    shellContext.error = ref("");
    shellContext.msg = ref<any>({
      drawer: {
        autoDetected: "Auto detected",
        serviceDiscovery: "Discovery",
        serviceId: "Service ID",
        serviceLabel: "Service Label",
        serverUrl: "Server URL",
        saveDiscovery: "Save",
        saving: "Saving",
      },
    });
    shellContext.serverAvailable = ref(false);
    window.localStorage.setItem(
      SERVER_ADDRESS_STORAGE_KEY,
      JSON.stringify({
        activeUrl: "https://a.example.com",
        addresses: ["https://a.example.com", "https://b.example.com"],
      }),
    );
  });

  function storedAddresses() : any {
    const raw: any = window.localStorage.getItem(SERVER_ADDRESS_STORAGE_KEY);
    return raw ? (JSON.parse(raw).addresses as string[]) : [];
  }

  it("requires a consequence-stating confirm before deleting and persisting", async () : Promise<any> => {
    const wrapper: any = mount(ConsoleServiceDiscoveryPanel);
    const { currentConfirm } = useConsoleConfirmState();
    expect(wrapper.findAll(".server-address-row")).toHaveLength(3);
    expect(wrapper.findAll(".server-url-remove-button")).toHaveLength(2);

    // Declined: the row stays and nothing persists.
    await wrapper.findAll(".server-url-remove-button")[0].trigger("click");
    expect(currentConfirm.value?.message).toContain("https://b.example.com");
    expect(wrapper.findAll(".server-address-row")).toHaveLength(3);
    settleConsoleConfirm(false);
    await flushPromises();
    expect(wrapper.findAll(".server-address-row")).toHaveLength(3);
    expect(storedAddresses()).toContain("https://b.example.com");

    // Confirmed: the row is deleted and persisted.
    await wrapper.findAll(".server-url-remove-button")[0].trigger("click");
    settleConsoleConfirm(true);
    await flushPromises();
    expect(wrapper.findAll(".server-address-row")).toHaveLength(2);
    expect(storedAddresses()).not.toContain("https://b.example.com");
    wrapper.unmount();
  });
});
