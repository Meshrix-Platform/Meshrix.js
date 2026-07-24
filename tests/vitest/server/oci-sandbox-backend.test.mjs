import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOciSandboxBackend } from "#meshrix/server-runtime/execution-sandbox/oci-backend";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function sandboxPaths() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-backend-test-"));
  roots.push(root);
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  const scratchRoot = path.join(root, "scratch");
  await Promise.all([inputRoot, outputRoot, scratchRoot].map((directory) => fs.mkdir(directory, { mode: 0o700 })));
  await fs.chmod(inputRoot, 0o555);
  return { inputRoot, outputRoot, scratchRoot };
}

function context(paths, runId = "opaque-run-reference") {
  return {
    runId,
    request: {
      artifact: { entryPoint: "probe.mjs" },
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

describe("OCI sandbox backend", () => {
  it("constructs a non-pulling, privately namespaced, resource-bounded container", async () => {
    const calls = [];
    const commandRunner = async (binary, args, options) => {
      calls.push({ binary, args, options });
      if (args[0] === "inspect") return { code: 0, signal: "", bytes: 1, stdout: "0\n" };
      return { code: 0, signal: "", bytes: args[0] === "start" ? 9 : 0, stdout: "" };
    };
    const paths = await sandboxPaths();
    const backend = createOciSandboxBackend({
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

    const createArgs = calls.find((call) => call.args[0] === "create").args;
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
    expect(createArgs.find((value) => value.startsWith("meshrix.sandbox.run-digest=")))
      .toMatch(/^meshrix\.sandbox\.run-digest=[a-f0-9]{64}$/u);
    expect(createArgs).toEqual(expect.arrayContaining([
      "--permission",
      "--allow-fs-read=*",
      "--allow-fs-write=/sandbox/output",
      "--allow-fs-write=/sandbox/scratch"
    ]));
    expect(createArgs.filter((value) => value.startsWith("type=bind,"))).toHaveLength(2);
    expect(createArgs.find((value) => value.startsWith("/sandbox/scratch:"))).toContain(`uid=${process.getuid()},gid=${process.getgid()}`);

    await expect(backend.run(context(paths))).rejects.toMatchObject({ code: "sandbox_runtime_failed" });
    await expect(backend.cleanup({ runId: "opaque-run-reference" })).resolves.toEqual({ destroyed: true });
  });

  it("passes an explicit runtime class for non-default podman profiles", async () => {
    const calls = [];
    const backend = createOciSandboxBackend({
      id: "oci.test",
      binary: "/fixed/bin/podman",
      engine: "podman",
      runtimeClass: "crun",
      commandRunner: async (_binary, args) => {
        calls.push(args);
        if (args[0] === "inspect") return { code: 0, signal: "", bytes: 1, stdout: "0\n" };
        return { code: 0, signal: "", bytes: 0, stdout: "" };
      }
    });
    const paths = await sandboxPaths();
    await backend.run(context(paths));
    const createArgs = calls.find((args) => args[0] === "create");
    expect(createArgs).toEqual(expect.arrayContaining(["--runtime", "crun"]));
  });

  it("rejects a non-zero subprocess capability that the backend cannot count independently", async () => {
    const paths = await sandboxPaths();
    const calls = [];
    const backend = createOciSandboxBackend({
      id: "oci.test",
      binary: "/fixed/bin/docker",
      engine: "docker",
      runtimeClass: "runc",
      commandRunner: async (...args) => {
        calls.push(args);
        return { code: 0, signal: "", bytes: 0, stdout: "" };
      }
    });
    const unsupported = context(paths, "non-zero-subprocess-capability");
    unsupported.policy.capabilities.subprocesses = 1;

    await expect(backend.run(unsupported)).rejects.toMatchObject({
      code: "sandbox_policy_unsupported"
    });
    expect(calls).toHaveLength(0);
  });

  it("accepts a bounded configured Node eval after installing permission flags", async () => {
    const paths = await sandboxPaths();
    const calls = [];
    const backend = createOciSandboxBackend({
      id: "oci.test",
      binary: "/fixed/bin/docker",
      engine: "docker",
      runtimeClass: "runc",
      commandRunner: async (_binary, args) => {
        calls.push(args);
        if (args[0] === "inspect") return { code: 0, signal: "", bytes: 1, stdout: "0\n" };
        return { code: 0, signal: "", bytes: 0, stdout: "" };
      }
    });
    const evalContext = context(paths, "configured-node-eval");
    evalContext.policy.workload.command = ["node", "-e", "process.exitCode=0"];

    await expect(backend.run(evalContext)).resolves.toMatchObject({ status: "succeeded" });
    const createArgs = calls.find((args) => args[0] === "create");
    expect(createArgs.indexOf("--permission")).toBeLessThan(createArgs.indexOf("-e"));
    expect(createArgs).toEqual(expect.arrayContaining(["-e", "process.exitCode=0", "probe.mjs"]));
  });

  it("rejects Node command forms outside the governed file and bounded eval profiles", async () => {
    const paths = await sandboxPaths();
    const calls = [];
    const backend = createOciSandboxBackend({
      id: "oci.test",
      binary: "/fixed/bin/docker",
      engine: "docker",
      runtimeClass: "runc",
      commandRunner: async (...args) => {
        calls.push(args);
        return { code: 0, signal: "", bytes: 0, stdout: "" };
      }
    });
    const unsupported = context(paths, "unsupported-node-command");
    unsupported.policy.workload.command = ["node", "--no-permission", "probe.mjs"];

    await expect(backend.run(unsupported)).rejects.toMatchObject({
      code: "sandbox_policy_unsupported"
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects a symbolic-link bind source before invoking the container engine", async () => {
    const paths = await sandboxPaths();
    const target = path.join(path.dirname(paths.outputRoot), "output-target");
    await fs.mkdir(target, { mode: 0o700 });
    await fs.rm(paths.outputRoot, { recursive: true });
    await fs.symlink(target, paths.outputRoot);
    const calls = [];
    const backend = createOciSandboxBackend({
      id: "oci.test",
      binary: "/fixed/bin/docker",
      engine: "docker",
      runtimeClass: "runc",
      commandRunner: async (...args) => {
        calls.push(args);
        return { code: 0, signal: "", bytes: 0, stdout: "" };
      }
    });

    await expect(backend.run(context(paths))).rejects.toMatchObject({ code: "sandbox_runtime_failed" });
    expect(calls).toHaveLength(0);
  });

  it("reports a bounded failure stage for a non-zero workload exit", async () => {
    const paths = await sandboxPaths();
    const backend = createOciSandboxBackend({
      id: "oci.test",
      binary: "/fixed/bin/docker",
      engine: "docker",
      runtimeClass: "runc",
      commandRunner: async (_binary, args) => {
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
