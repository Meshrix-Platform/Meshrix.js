import { describe, expect, it } from "vitest";
import {
  discoverLocalExecutionEnvironment,
  type DockerProbeCommandResult,
  type LocalEnvironmentProbeOptions
} from "../../../tools/server-scripts/lib/local-execution-environment.ts";

function probeOptions({
  endpoint = "unix:///var/run/docker.sock",
  daemonPlatform = "linux/arm64",
  daemonStatus = 0,
  resolveDockerCommandFn = () => "/synthetic/docker",
  calls = [] as string[][]
}: {
  endpoint?: string;
  daemonPlatform?: string;
  daemonStatus?: number | null;
  resolveDockerCommandFn?: LocalEnvironmentProbeOptions["resolveDockerCommandFn"];
  calls?: string[][];
} = {}): LocalEnvironmentProbeOptions & { calls: string[][] } {
  const runDockerFn = async (
    _command: string,
    args: readonly string[]
  ): Promise<DockerProbeCommandResult> => {
    calls.push([...args]);
    if (args[0] === "context") return { status: 0, stdout: JSON.stringify(endpoint) };
    if (args[0] === "info") return { status: daemonStatus, stdout: daemonPlatform };
    return { status: 1, stdout: "" };
  };
  return {
    platform: "darwin",
    architecture: "arm64",
    nodeVersion: "v24.18.1",
    env: {},
    resolveDockerCommandFn,
    runDockerFn,
    calls
  };
}

describe("current-device execution environment discovery", () => {
  it("normalizes process facts and recognizes a same-architecture local Linux daemon", async () => {
    const options = probeOptions();
    const result = await discoverLocalExecutionEnvironment(options);

    expect(result).toEqual({
      native: { os: "darwin", architecture: "arm64", platform: "darwin/arm64", nodeVersion: "24.18.1" },
      docker: { status: "available", platform: "linux/arm64" }
    });
    expect(options.calls.map(([command]) => command)).toEqual(["context", "info"]);
  });

  it("uses the real process platform aliases without reporting arbitrary injected strings", async () => {
    const result = await discoverLocalExecutionEnvironment({
      ...probeOptions({ resolveDockerCommandFn: () => "" }),
      platform: "win32",
      architecture: "x64",
      nodeVersion: "v24.18.1\nlocal-detail"
    });

    expect(result.native).toEqual({
      os: "windows", architecture: "amd64", platform: "windows/amd64", nodeVersion: "unknown"
    });
    expect(result.docker).toEqual({ status: "unavailable", reasonCode: "docker_cli_missing" });
    expect(JSON.stringify(result)).not.toContain("local-detail");
  });

  it("uses the injected environment and operating system for pure Node command resolution", async () => {
    const env = { Path: "C:\\synthetic\\tools" };
    let resolvedPlatform = "";
    let resolvedPath = "";
    const result = await discoverLocalExecutionEnvironment({
      platform: "win32",
      architecture: "x64",
      nodeVersion: "v24.18.1",
      env,
      resolveDockerCommandFn: (selectedEnv, platform) => {
        resolvedPlatform = platform;
        resolvedPath = selectedEnv.PATH || "";
        return "";
      }
    });

    expect(result.docker).toEqual({ status: "unavailable", reasonCode: "docker_cli_missing" });
    expect(resolvedPlatform).toBe("win32");
    expect(resolvedPath).toBe(env.Path);
  });

  it("uses the same normalized PATH for command lookup and local Docker inspection", async () => {
    const inspectedPaths: string[] = [];
    let resolvedPath = "";
    const result = await discoverLocalExecutionEnvironment({
      platform: "win32",
      architecture: "x64",
      nodeVersion: "v24.18.1",
      env: { Path: "C:\\synthetic\\tools", DOCKER_HOST: "npipe:////./pipe/docker_engine" },
      resolveDockerCommandFn: (env) => {
        resolvedPath = env.PATH || "";
        return "C:\\synthetic\\tools\\docker.exe";
      },
      runDockerFn: async (_command, _args, env) => {
        inspectedPaths.push(env.PATH || "");
        return { status: 0, stdout: "linux/amd64" };
      }
    });

    expect(result.docker).toEqual({ status: "available", platform: "linux/amd64" });
    expect(resolvedPath).toBe("C:\\synthetic\\tools");
    expect(inspectedPaths).toEqual([resolvedPath]);
  });

  it("does not contact a configured nonlocal context", async () => {
    const options = probeOptions({ endpoint: "ssh://synthetic.invalid" });
    options.env = { DOCKER_CONTEXT: "synthetic-remote" };
    const result = await discoverLocalExecutionEnvironment(options);

    expect(result.docker).toEqual({ status: "unavailable", reasonCode: "docker_context_not_local" });
    expect(options.calls.map(([command]) => command)).toEqual(["context"]);
    expect(JSON.stringify(result)).not.toContain("synthetic");
  });

  it("does not contact a non-loopback DOCKER_HOST", async () => {
    const options = probeOptions();
    options.env = { DOCKER_HOST: "tcp://192.0.2.9:2376" };
    const result = await discoverLocalExecutionEnvironment(options);

    expect(result.docker).toEqual({ status: "unavailable", reasonCode: "docker_context_not_local" });
    expect(options.calls).toEqual([]);
  });

  it.each([
    { endpoint: "tcp://127.0.0.1:2376", daemonStatus: 1, daemonPlatform: "", reasonCode: "docker_daemon_unavailable" },
    { endpoint: "unix:///synthetic/docker.sock", daemonStatus: 0, daemonPlatform: "darwin/arm64", reasonCode: "docker_daemon_not_linux" },
    { endpoint: "unix:///synthetic/docker.sock", daemonStatus: 0, daemonPlatform: "linux/amd64", reasonCode: "docker_architecture_mismatch" },
    { endpoint: "unix:///synthetic/docker.sock", daemonStatus: 0, daemonPlatform: "linux/ppc64", reasonCode: "docker_architecture_unsupported" }
  ] as const)("reports unavailable optional Docker as $reasonCode", async ({ endpoint, daemonStatus, daemonPlatform, reasonCode }) => {
    const options = probeOptions({ endpoint, daemonStatus, daemonPlatform });
    const result = await discoverLocalExecutionEnvironment(options);

    expect(result.docker).toEqual({ status: "unavailable", reasonCode });
    expect(JSON.stringify(result)).not.toContain(endpoint);
  });

  it("omits executable and daemon details from capability facts", async () => {
    const options = probeOptions();
    const result = await discoverLocalExecutionEnvironment(options);
    const encoded = JSON.stringify(result);

    expect(encoded).not.toContain("/synthetic/docker");
    expect(encoded).not.toContain("/var/run/docker.sock");
    expect(encoded).not.toContain("DOCKER_CONTEXT");
  });
});
