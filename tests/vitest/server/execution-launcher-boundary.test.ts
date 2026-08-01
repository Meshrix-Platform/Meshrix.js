import { describe, expect, test } from "vitest";

import {
  classifyLauncherImport,
  extractChildProcessImports,
  extractExecutionBoundarySyntax,
  runExecutionLauncherBoundary
} from "../../../tools/verifiers/execution-launcher-boundary.ts";

describe("execution launcher boundary", () : any => {
  test("uses syntax-aware import extraction", async () : Promise<any> => {
    expect(await extractChildProcessImports(`
      // import { spawn } from "node:child_process";
      const text = 'require("child_process")';
      import { fork as createWorker } from "node:child_process";
    `)).toEqual([{
      specifier: "node:child_process",
      bindings: ["fork"]
    }]);
  });

  test("fails closed for an unregistered direct launcher", () : any => {
    expect(classifyLauncherImport("packages/server-runtime/src/example.ts", [{
      specifier: "node:child_process",
      bindings: ["spawn"]
    }])).toMatchObject({
      approved: false,
      classification: "unclassified_direct_process_launcher"
    });
  });

  test("detects direct sandbox internals and dynamic host execution syntax", async () : Promise<any> => {
    expect(await extractExecutionBoundarySyntax(`
      import { createSandboxExecutionBroker } from "@meshrix/server-runtime/execution-sandbox/broker";
      const options = { shell: true };
      eval("fixture");
    `)).toEqual({
      internalImports: ["@meshrix/server-runtime/execution-sandbox/broker"],
      unsafeCalls: ["eval", "shell:true"]
    });
  });

  test("fails closed when a source file cannot be parsed", async () : Promise<any> => {
    await expect(extractChildProcessImports(
      'import { spawn } from "node:child_process"; const = ;',
      "invalid.ts"
    )).rejects.toThrow("execution_launcher_boundary_parse_failed:invalid.ts");
  });

  test("classifies only canonical governed launchers", async () : Promise<any> => {
    const report: any = await runExecutionLauncherBoundary();
    expect(report.launchers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "packages/server-runtime/src/execution-sandbox/oci-backend.ts",
        approved: true,
        classification: "canonical_sandbox_backend"
      }),
      expect.objectContaining({
        path: "packages/server-runtime/src/execution-sandbox/trusted-oci-provider-adapters.ts",
        approved: true,
        classification: "fixed_provider_probe"
      }),
      expect.objectContaining({
        path: "packages/protocols/mcp/upstream-mcp-stdio-launcher.ts",
        approved: true,
        classification: "protocol_owned_stdio_session_launcher"
      }),
      expect.objectContaining({
        path: "packages/foundation/src/module-system/isolated-plugin-process-host.ts",
        approved: true,
        classification: "plugin_owned_isolated_process_host"
      }),
      expect.objectContaining({
        path: "packages/agents/src/agent-workspace/agent-workspace-materialization-file-worker.ts",
        approved: true,
        classification: "workspace_materialization_file_worker"
      })
    ]));
    expect(report.summary.violationCount).toBe(0);
    expect(report.violations).toEqual([]);
    expect(report.boundaryClosed).toBe(true);
  });
});
