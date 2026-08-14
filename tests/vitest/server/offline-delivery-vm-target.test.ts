import { describe, expect, it } from "vitest";

import {
  OFFLINE_VM_AMD64_IMAGE,
  OFFLINE_VM_ARM64_IMAGE,
  OFFLINE_VM_BUILD_TARGET,
  OFFLINE_VM_CONSOLE_INDEX_PATH,
  OFFLINE_VM_SERVER_WITH_UI,
  assertOfflineRuntimeUiImage,
  imageHasConsoleIndex,
  isConsoleDocument,
  linuxVmComposeEnvironment,
} from "../../../tools/server-scripts/offline-delivery-vm-target.ts";
import { selectOfflineVmHostPort } from "../../../tools/server-scripts/offline-delivery-local-up.ts";

describe("offline delivery runtime-ui packaging", () : any => {
  it("packages Server + Web Console tags and compose, not API-only runtime", () : any => {
    expect(OFFLINE_VM_BUILD_TARGET).toBe("runtime-ui");
    expect(OFFLINE_VM_SERVER_WITH_UI).toBe("1");
    expect(OFFLINE_VM_CONSOLE_INDEX_PATH).toBe("/app/build/dist/index.html");
    expect(OFFLINE_VM_ARM64_IMAGE).toBe("local.example/meshrix-js/runtime-ui:offline-arm64");
    expect(OFFLINE_VM_AMD64_IMAGE).toBe("local.example/meshrix-js/runtime-ui:offline-amd64");
    expect(OFFLINE_VM_ARM64_IMAGE).not.toMatch(/\/runtime:offline-/u);
    expect(linuxVmComposeEnvironment({ hostPort: 7228 }).MESHRIX_SERVER_WITH_UI).toBe("1");
    expect(isConsoleDocument({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><html><div id=\"app\"></div></html>",
    })).toBe(true);
    expect(isConsoleDocument({
      status: 200,
      contentType: "application/json",
      body: "{\"ok\":true}",
    })).toBe(false);
  });

  it("rejects an API-only image and WITH_UI=0 as offline VM materials", () : any => {
    expect(imageHasConsoleIndex({
      image: "local.example/meshrix-js/runtime:offline-arm64",
      commandRunner: () : any => ({ status: 1, stdout: "", stderr: "" }),
    })).toBe(false);
    expect(() : any => assertOfflineRuntimeUiImage({
      image: "local.example/meshrix-js/runtime:offline-arm64",
      commandRunner: () : any => ({ status: 1, stdout: "", stderr: "" }),
    })).toThrow(/Server \+ Web Console/);
    expect(linuxVmComposeEnvironment().MESHRIX_SERVER_WITH_UI).not.toBe("0");
  });

  it("reuses a Console-serving Meshrix on the default port and fails closed on an unrelated occupant", async () : Promise<any> => {
    await expect(selectOfflineVmHostPort({
      probe: async (port?: any) : Promise<any> => (
        Number(port) === 7228
          ? { listening: true, healthOk: true, consoleOk: true }
          : { listening: false, healthOk: false, consoleOk: false }
      ),
    })).resolves.toMatchObject({ port: 7228, reuse: true });
    await expect(selectOfflineVmHostPort({
      probe: async (port?: any) : Promise<any> => (
        Number(port) === 7228
          ? { listening: true, healthOk: true, consoleOk: false }
          : { listening: false, healthOk: false, consoleOk: false }
      ),
    })).rejects.toMatchObject({ code: "offline_delivery_host_port_conflict" });
  });
});
