import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyOciCommandFailure,
  createOciSandboxBackend
} from "#meshrix/server-runtime/execution-sandbox/oci-backend";

const roots: any[] = [];

afterEach(async () : Promise<any> => {
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

async function sandboxPaths() : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-backend-test-"));
  roots.push(root);
  const inputRoot: any = path.join(root, "input");
  const outputRoot: any = path.join(root, "output");
  const scratchRoot: any = path.join(root, "scratch");
  await Promise.all([inputRoot, outputRoot, scratchRoot].map((directory?: any) : any => fs.mkdir(directory, { mode: 0o700 })));
  await fs.chmod(inputRoot, 0o555);
  return { inputRoot, outputRoot, scratchRoot };
}

function context(paths?: any, runId: any = "opaque-run-reference") : any {
  return {
    runId,
    request: {
      artifact: { entryPoint: "probe.ts" },
      invocation: { workingDirectory: "input/0", args: [] },
      resources: {
        wallTimeMs: 10_000,
        cpuMillis: 2_000,
        memoryBytes: 128 * 1024 * 1024,
        processes: 32,
        fileDescriptors: 64,
        diskBytes: 16 * 1024 * 1024,
        inodes: 256,
        outputBytes: 64 * 1024,
        logBytes: 64 * 1024
      }
    },
    policy: {
      workload: {
        image: `example.invalid/probe@sha256:${"a".repeat(64)}`,
        command: ["node"]
      },
      capabilities: { network: [], secretRefs: [], tools: [], subprocesses: 0 }
    },
    paths,
    signal: new AbortController().signal
  };
}

describe("OCI sandbox backend", () : any => {
  it("reduces engine errors to fixed privacy-safe failure classes", () : any => {
    expect(classifyOciCommandFailure("write failed: no space left on device"))
      .toBe("oci_storage_exhausted");
    expect(classifyOciCommandFailure("unknown flag: --example"))
      .toBe("oci_option_unsupported");
    expect(classifyOciCommandFailure("permission denied while creating container"))
      .toBe("oci_permission_denied");
    expect(classifyOciCommandFailure("context deadline exceeded"))
      .toBe("oci_daemon_request_expired");
    expect(classifyOciCommandFailure("resource temporarily unavailable"))
      .toBe("oci_runtime_busy");
    expect(classifyOciCommandFailure("failed to create shim task: OCI runtime create failed"))
      .toBe("oci_runtime_initialization_failed");
    expect(classifyOciCommandFailure("failed to set up container networking"))
      .toBe("oci_network_setup_failed");
    expect(classifyOciCommandFailure("cgroup namespace rejected"))
      .toBe("oci_cgroup_rejected");
    expect(classifyOciCommandFailure("seccomp profile rejected"))
      .toBe("oci_seccomp_rejected");
    expect(classifyOciCommandFailure("invalid reference format"))
      .toBe("oci_image_reference_invalid");
    expect(classifyOciCommandFailure("Error response from daemon: rejected"))
      .toBe("oci_daemon_rejected");
    expect(classifyOciCommandFailure("", "resource temporarily unavailable", 125))
      .toBe("oci_runtime_busy");
    expect(classifyOciCommandFailure("", "", 125))
      .toBe("oci_cli_invocation_rejected");
    expect(classifyOciCommandFailure("private engine payload"))
      .toBe("oci_command_rejected");
  });

  it("constructs a non-pulling, privately namespaced, resource-bounded container", async () : Promise<any> => {
    const calls: any[] = [];
    const commandRunner: any = async (binary?: any, args?: any, options?: any) : Promise<any> => {
      calls.push({ binary, args, options });
      if (args[0] === "inspect") return { code: 0, signal: "", bytes: 1, stdout: "0\n" };
      return { code: 0, signal: "", bytes: args[0] === "start" ? 9 : 0, stdout: "" };
    };
    const paths: any = await sandboxPaths();
    const backend: any = createOciSandboxBackend({
      id: "oci.test",
      binary: "/fixed/bin/docker",
      engine: "docker",
      runtimeClass: "runc",
      commandRunner
    });

    await expect(backend.run(context(paths))).resolves.toMatchObject({
      status: "succeeded",
      resourceTotals: { logBytes: 9 }
    });

    const createArgs: any = calls.find((call?: any) : any => call.args[0] === "create").args;
    expect(createArgs).toEqual(expect.arrayContaining([
      "--pull", "never",
      "--network", "none",
      "--ipc", "none",
      "--cgroupns", "private",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--ulimit", "core=0:0",
      "--pids-limit", "32"
    ]));
    expect(createArgs.includes("--runtime")).toBe(false);
    expect(createArgs.join(" ")).not.toContain("opaque-run-reference");
    expect(createArgs.find((value?: any) : any => value.startsWith("meshrix.sandbox.run-digest=")))
      .toMatch(/^meshrix\.sandbox\.run-digest=[a-f0-9]{64}$/u);
    expect(createArgs).toEqual(expect.arrayContaining([
      "--permission",
      "--allow-fs-read=*",
      "--allow-fs-write=/sandbox/output",
      "--allow-fs-write=/sandbox/scratch"
    ]));
    expect(createArgs.filter((value?: any) : any => value.startsWith("type=bind,"))).toHaveLength(2);
    expect(createArgs.find((value?: any) : any => value.startsWith("/sandbox/scratch:"))).toContain(`uid=${process.getuid()},gid=${process.getgid()}`);
    for (const call of calls.filter((entry?: any) : any => ["create", "start", "inspect"].includes(entry.args[0]))) {
      expect(call.options.timeoutMs).toBe(10_000);
    }

    await expect(backend.run(context(paths))).rejects.toMatchObject({ code: "sandbox_runtime_failed" });
    await expect(backend.cleanup({ runId: "opaque-run-reference" })).resolves.toEqual({ destroyed: true });
    expect(calls.find((call?: any) : any => call.args[0] === "rm").options.timeoutMs).toBe(30_000);
  });

  it("passes an explicit runtime class for non-default podman profiles", async () : Promise<any> => {
    const calls: any[] = [];
    const backend: any = createOciSandboxBackend({
      id: "oci.test",
      binary: "/fixed/bin/podman",
      engine: "podman",
      runtimeClass: "crun",
      commandRunner: async (_binary?: any, args?: any) : Promise<any> => {
        calls.push(args);
        if (args[0] === "inspect") return { code: 0, signal: "", bytes: 1, stdout: "0\n" };
        return { code: 0, signal: "", bytes: 0, stdout: "" };
      }
    });
    const paths: any = await sandboxPaths();
    await backend.run(context(paths));
    const createArgs: any = calls.find((args?: any) : any => args[0] === "create");
    expect(createArgs).toEqual(expect.arrayContaining(["--runtime", "crun"]));
  });

  it("serializes container creation while preserving concurrent executions", async () : Promise<any> => {
    const firstPaths: any = await sandboxPaths();
    const secondPaths: any = await sandboxPaths();
    let activeCreates: any = 0;
    let maximumActiveCreates: any = 0;
    let createCount: any = 0;
    const backend: any = createOciSandboxBackend({
      id: "oci.test",
      binary: "/fixed/bin/docker",
      engine: "docker",
      runtimeClass: "runc",
      commandRunner: async (_binary?: any, args?: any) : Promise<any> => {
        if (args[0] === "create") {
          createCount += 1;
          activeCreates += 1;
          maximumActiveCreates = Math.max(maximumActiveCreates, activeCreates);
          await new Promise((resolve?: any) : any => setTimeout(resolve, 5));
          activeCreates -= 1;
        }
        if (args[0] === "inspect") return { code: 0, signal: "", bytes: 1, stdout: "0\n" };
        return { code: 0, signal: "", bytes: 0, stdout: "" };
      }
    });

    await Promise.all([
      backend.run(context(firstPaths, "concurrent-one")),
      backend.run(context(secondPaths, "concurrent-two"))
    ]);

    expect(createCount).toBe(2);
    expect(maximumActiveCreates).toBe(1);
    await backend.cleanup({ runId: "concurrent-one" });
    await backend.cleanup({ runId: "concurrent-two" });
  });

  it("retries one empty-output OCI CLI create rejection after deterministic cleanup", async () : Promise<any> => {
    const paths: any = await sandboxPaths();
    const calls: any[] = [];
    let createAttempts: any = 0;
    const backend: any = createOciSandboxBackend({
      id: "oci.test",
      binary: "/fixed/bin/docker",
      engine: "docker",
      runtimeClass: "runc",
      commandRunner: async (_binary?: any, args?: any, options?: any) : Promise<any> => {
        calls.push({ args, options });
        if (args[0] === "create" && createAttempts++ === 0) {
          throw Object.assign(new Error("synthetic empty-output rejection"), {
            code: "sandbox_runtime_failed",
            failureStage: "oci_create_failed",
            failureReason: "oci_cli_invocation_rejected",
            exitCode: 125
          });
        }
        if (args[0] === "inspect") return { code: 0, signal: "", bytes: 1, stdout: "0\n" };
        return { code: 0, signal: "", bytes: 0, stdout: "" };
      }
    });

    await expect(backend.run(context(paths))).resolves.toMatchObject({ status: "succeeded" });
    expect(calls.map((call?: any) : any => call.args[0])).toEqual([
      "create",
      "rm",
      "create",
      "start",
      "inspect"
    ]);
    expect(calls[1].args.slice(0, 2)).toEqual(["rm", "--force"]);
    expect(calls[1].options).toMatchObject({ allowFailure: true, timeoutMs: 30_000 });
  });

  it("does not retry explicit OCI argument or policy rejection classes", async () : Promise<any> => {
    const paths: any = await sandboxPaths();
    const calls: any[] = [];
    const backend: any = createOciSandboxBackend({
      id: "oci.test",
      binary: "/fixed/bin/docker",
      engine: "docker",
      runtimeClass: "runc",
      commandRunner: async (_binary?: any, args?: any) : Promise<any> => {
        calls.push(args);
        throw Object.assign(new Error("synthetic option rejection"), {
          code: "sandbox_runtime_failed",
          failureStage: "oci_create_failed",
          failureReason: "oci_option_unsupported",
          exitCode: 125
        });
      }
    });

    await expect(backend.run(context(paths))).rejects.toMatchObject({
      failureReason: "oci_option_unsupported"
    });
    expect(calls.map((args?: any) : any => args[0])).toEqual(["create"]);
  });

  it("rejects a non-zero subprocess capability that the backend cannot count independently", async () : Promise<any> => {
    const paths: any = await sandboxPaths();
    const calls: any[] = [];
    const backend: any = createOciSandboxBackend({
      id: "oci.test",
      binary: "/fixed/bin/docker",
      engine: "docker",
      runtimeClass: "runc",
      commandRunner: async (...args: any[]) : Promise<any> => {
        calls.push(args);
        return { code: 0, signal: "", bytes: 0, stdout: "" };
      }
    });
    const unsupported: any = context(paths, "non-zero-subprocess-capability");
    unsupported.policy.capabilities.subprocesses = 1;

    await expect(backend.run(unsupported)).rejects.toMatchObject({
      code: "sandbox_policy_unsupported"
    });
    expect(calls).toHaveLength(0);
  });

  it("accepts a bounded configured Node eval after installing permission flags", async () : Promise<any> => {
    const paths: any = await sandboxPaths();
    const calls: any[] = [];
    const backend: any = createOciSandboxBackend({
      id: "oci.test",
      binary: "/fixed/bin/docker",
      engine: "docker",
      runtimeClass: "runc",
      commandRunner: async (_binary?: any, args?: any) : Promise<any> => {
        calls.push(args);
        if (args[0] === "inspect") return { code: 0, signal: "", bytes: 1, stdout: "0\n" };
        return { code: 0, signal: "", bytes: 0, stdout: "" };
      }
    });
    const evalContext: any = context(paths, "configured-node-eval");
    evalContext.policy.workload.command = ["node", "-e", "process.exitCode=0"];

    await expect(backend.run(evalContext)).resolves.toMatchObject({ status: "succeeded" });
    const createArgs: any = calls.find((args?: any) : any => args[0] === "create");
    expect(createArgs.indexOf("--permission")).toBeLessThan(createArgs.indexOf("-e"));
    expect(createArgs).toEqual(expect.arrayContaining(["-e", "process.exitCode=0", "probe.ts"]));
  });

  it("rejects Node command forms outside the governed file and bounded eval profiles", async () : Promise<any> => {
    const paths: any = await sandboxPaths();
    const calls: any[] = [];
    const backend: any = createOciSandboxBackend({
      id: "oci.test",
      binary: "/fixed/bin/docker",
      engine: "docker",
      runtimeClass: "runc",
      commandRunner: async (...args: any[]) : Promise<any> => {
        calls.push(args);
        return { code: 0, signal: "", bytes: 0, stdout: "" };
      }
    });
    const unsupported: any = context(paths, "unsupported-node-command");
    unsupported.policy.workload.command = ["node", "--no-permission", "probe.ts"];

    await expect(backend.run(unsupported)).rejects.toMatchObject({
      code: "sandbox_policy_unsupported"
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects a symbolic-link bind source before invoking the container engine", async () : Promise<any> => {
    const paths: any = await sandboxPaths();
    const target: any = path.join(path.dirname(paths.outputRoot), "output-target");
    await fs.mkdir(target, { mode: 0o700 });
    await fs.rm(paths.outputRoot, { recursive: true });
    await fs.symlink(target, paths.outputRoot);
    const calls: any[] = [];
    const backend: any = createOciSandboxBackend({
      id: "oci.test",
      binary: "/fixed/bin/docker",
      engine: "docker",
      runtimeClass: "runc",
      commandRunner: async (...args: any[]) : Promise<any> => {
        calls.push(args);
        return { code: 0, signal: "", bytes: 0, stdout: "" };
      }
    });

    await expect(backend.run(context(paths))).rejects.toMatchObject({ code: "sandbox_runtime_failed" });
    expect(calls).toHaveLength(0);
  });

  it("reports a bounded failure stage for a non-zero workload exit", async () : Promise<any> => {
    const paths: any = await sandboxPaths();
    const backend: any = createOciSandboxBackend({
      id: "oci.test",
      binary: "/fixed/bin/docker",
      engine: "docker",
      runtimeClass: "runc",
      commandRunner: async (_binary?: any, args?: any) : Promise<any> => {
        if (args[0] === "inspect") return { code: 0, signal: "", bytes: 1, stdout: "9\n" };
        return { code: 0, signal: "", bytes: 0, stdout: "" };
      }
    });

    await expect(backend.run(context(paths))).rejects.toMatchObject({
      code: "sandbox_runtime_failed",
      failureStage: "oci_workload_failed",
      exitCode: 9
    });
    await expect(backend.cleanup({ runId: "opaque-run-reference" })).resolves.toEqual({ destroyed: true });
  });
});
