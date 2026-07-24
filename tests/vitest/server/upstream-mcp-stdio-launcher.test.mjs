import { describe, expect, it, vi } from "vitest";

import { createUpstreamMcpSessionManager } from "../../../packages/protocols/mcp/upstream-mcp-client.mjs";
import { createUpstreamMcpStdioLauncher } from "../../../packages/protocols/mcp/upstream-mcp-stdio-launcher.mjs";

describe("upstream MCP stdio launcher boundary", () => {
  it("launches without a shell and projects only baseline plus configured environment", () => {
    const child = {};
    const spawnImpl = vi.fn(() => child);
    const launcher = createUpstreamMcpStdioLauncher({ spawnImpl });

    expect(launcher.launch({
      transport: "stdio",
      command: "/runtime/node",
      args: ["", "service.mjs"],
      env: {
        SERVICE_TOKEN: "$PRIVATE_SOURCE",
        SERVICE_MODE: "fixture"
      }
    }, {
      env: {
        PATH: "/runtime/bin",
        PRIVATE_SOURCE: "resolved-value",
        UNRELATED_PRIVATE_VALUE: "must-not-pass"
      }
    })).toBe(child);

    expect(spawnImpl).toHaveBeenCalledWith(
      "/runtime/node",
      ["", "service.mjs"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: "/runtime/bin",
          SERVICE_TOKEN: "resolved-value",
          SERVICE_MODE: "fixture"
        },
        shell: false,
        windowsHide: true
      }
    );
  });

  it("rejects malformed or unbounded launch descriptors before process creation", () => {
    const spawnImpl = vi.fn();
    const launcher = createUpstreamMcpStdioLauncher({ spawnImpl });

    expect(() => launcher.launch({ transport: "http", command: "/runtime/node" }))
      .toThrow("requires stdio transport configuration");
    expect(() => launcher.launch({ transport: "stdio", command: "/runtime/node\0suffix" }))
      .toThrow("must be a bounded non-empty string");
    expect(() => launcher.launch({
      transport: "stdio",
      command: "/runtime/node",
      env: { "INVALID-NAME": "value" }
    })).toThrow("environment contains an invalid entry");
    expect(() => launcher.launch({
      transport: "stdio",
      command: "/runtime/node",
      args: Array.from({ length: 129 }, () => "arg")
    })).toThrow("arguments exceed the transport limit");
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("fails closed when the manager has no protocol-owned launcher", async () => {
    const manager = createUpstreamMcpSessionManager({ stdioLauncher: null });
    try {
      await expect(manager.listTools({
        transport: "stdio",
        command: "/runtime/unavailable",
        sessionKey: "fixture",
        sessionScope: "fixture"
      })).rejects.toThrow("process launcher is unavailable");
    } finally {
      await manager.close();
    }
  });
});
