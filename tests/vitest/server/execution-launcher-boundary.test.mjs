import { describe, expect, test } from "vitest";

import {
  classifyLauncherImport,
  extractChildProcessImports,
  extractExecutionBoundarySyntax,
  runExecutionLauncherBoundary
} from "../../../tools/verifiers/execution-launcher-boundary.mjs";

describe("execution launcher boundary", () => {
  test("uses syntax-aware import extraction", async () => {
    expect(await extractChildProcessImports(`
      // import { spawn } from "node:child_process";
      const text = 'require("child_process")';
      import { fork as createWorker } from "node:child_process";
    `)).toEqual([{
      specifier: "node:child_process",
      bindings: ["fork"]
    }]);
  });

  test("fails closed for an unregistered direct launcher", () => {
    expect(classifyLauncherImport("packages/server-runtime/src/example.mjs", [{
      specifier: "node:child_process",
      bindings: ["spawn"]
    }])).toMatchObject({
      approved: false,
      classification: "unclassified_direct_process_launcher"
    });
  });

  test("detects direct sandbox internals and dynamic host execution syntax", async () => {
    expect(await extractExecutionBoundarySyntax(`
      import { createSandboxExecutionBroker } from "@lico/server-runtime/execution-sandbox/broker";
      const options = { shell: true };
      eval("fixture");
    `)).toEqual({
      internalImports: ["@lico/server-runtime/execution-sandbox/broker"],
      unsafeCalls: ["eval", "shell:true"]
    });
  });

  test("fails closed when a source file cannot be parsed", async () => {
    await expect(extractChildProcessImports(
      'import { spawn } from "node:child_process"; const = ;',
      "invalid.mjs"
    )).rejects.toThrow("execution_launcher_boundary_parse_failed:invalid.mjs");
  });

  test("classifies only canonical governed launchers", async () => {
    const report = await runExecutionLauncherBoundary();
    expect(report.launchers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "packages/server-runtime/src/execution-sandbox/oci-backend.mjs",
        approved: true,
        classification: "canonical_sandbox_backend"
      }),
      expect.objectContaining({
        path: "packages/server-runtime/src/execution-sandbox/trusted-oci-provider-adapters.mjs",
        approved: true,
        classification: "fixed_provider_probe"
      }),
      expect.objectContaining({
        path: "packages/protocols/mcp/upstream-mcp-stdio-launcher.mjs",
        approved: true,
        classification: "protocol_owned_stdio_session_launcher"
      }),
      expect.objectContaining({
        path: "packages/foundation/src/module-system/isolated-plugin-process-host.mjs",
        approved: true,
        classification: "plugin_owned_isolated_process_host"
      })
    ]));
    expect(report.summary.violationCount).toBe(0);
    expect(report.violations).toEqual([]);
    expect(report.boundaryClosed).toBe(true);
  });
});
