import { describe, expect, it, vi } from "vitest";

import {
  runPrivateEndpointClaimCommand,
  type PrivateEndpointClaimCommandDependencies,
  type PrivateEndpointClaimResult,
} from "../../../apps/mcp-gateway-installer/src/cli.ts";
const canned1 = "https://account.meshrix.test";




const RESULT: PrivateEndpointClaimResult = Object.freeze({
  outcome: "claimed",
  configPath: "/tmp/private-endpoint.json",
  accountId: "account.test.1",
  authEpoch: 2,
  tenantId: "tenant.test.1",
  routeId: "route.test.1",
  endpointDeviceId: "device.endpoint.1",
  vaultId: "vault.test.1",
});

describe("private endpoint claim CLI", () => {
  it("opens only the browser handoff and prints the redacted claim result", async () => {
    const lines: string[] = [];
    const opened: string[] = [];
    const claim = vi.fn(async (input: Parameters<NonNullable<PrivateEndpointClaimCommandDependencies["claim"]>>[0]) => {
      await input.openBrowser?.("https://account.meshrix.test/account?transactionId=tx.opaque.test");
      input.onProgress?.({ stage: "claimed", accountId: RESULT.accountId, routeId: RESULT.routeId, endpointDeviceId: RESULT.endpointDeviceId });
      return RESULT;
    });

    await runPrivateEndpointClaimCommand({
      configPath: RESULT.configPath,
      authorityOrigin: canned1,
    }, {
      claim,
      openBrowser: async (url) => { opened.push(url); },
      writeLine: (line) => { lines.push(line); },
    });

    expect(claim).toHaveBeenCalledWith(expect.objectContaining({
      configPath: RESULT.configPath,
      authorityOrigin: canned1,
      openBrowser: expect.any(Function),
      onProgress: expect.any(Function),
    }));
    expect(opened).toEqual(["https://account.meshrix.test/account?transactionId=tx.opaque.test"]);
    expect(lines).toContain("Endpoint account ownership is active.");
    expect(lines).toContain(JSON.stringify(RESULT));
    expect(lines.some((line) => line.includes("transactionId="))).toBe(false);
  });

  it("shows token-free browser handoff URLs only in explicit headless mode", async () => {
    const lines: string[] = [];
    const claim = vi.fn(async (input: Parameters<NonNullable<PrivateEndpointClaimCommandDependencies["claim"]>>[0]) => {
      expect(input.openBrowser).toBeUndefined();
      input.onProgress?.({ stage: "browser_login", browserUrl: "https://account.meshrix.test/account?transactionId=tx.opaque.test" });
      return RESULT;
    });

    await runPrivateEndpointClaimCommand({ configPath: RESULT.configPath, headless: true }, {
      claim,
      writeLine: (line) => { lines.push(line); },
    });

    expect(lines).toContain("Open this account authorization link to continue: https://account.meshrix.test/account?transactionId=tx.opaque.test");
    expect(lines).toContain(JSON.stringify(RESULT));
  });

  it("prints the operator handoff if the native browser launcher is unavailable", async () => {
    const lines: string[] = [];
    const claim = vi.fn(async (input: Parameters<NonNullable<PrivateEndpointClaimCommandDependencies["claim"]>>[0]) => {
      await input.openBrowser?.("https://account.meshrix.test/account?transactionId=tx.opaque.test");
      return RESULT;
    });
    const dependencies: PrivateEndpointClaimCommandDependencies = {
      claim,
      openBrowser: async () => { throw new Error("browser launcher unavailable"); },
      writeLine: (line) => { lines.push(line); },
    };

    await runPrivateEndpointClaimCommand({ configPath: RESULT.configPath }, dependencies);

    expect(lines).toContain("Open this account authorization link to continue: https://account.meshrix.test/account?transactionId=tx.opaque.test");
    expect(lines).toContain(JSON.stringify(RESULT));
  });

  it("requires an explicit endpoint config before starting authentication", async () => {
    const claim = vi.fn();
    await expect(runPrivateEndpointClaimCommand({}, { claim })).rejects.toMatchObject({ code: "private_endpoint_config_required" });
    expect(claim).not.toHaveBeenCalled();
  });
});
