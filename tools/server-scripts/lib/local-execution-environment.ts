import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveCommandCandidate } from "../../../packages/foundation/src/environment-compatibility/host-runtime.ts";

const execFileAsync = promisify(execFile);
const DOCKER_PROBE_TIMEOUT_MS = 5_000;
const DOCKER_CONTEXT_ENDPOINT_TEMPLATE = "{{json .Endpoints.docker.Host}}";
const DOCKER_INFO_PLATFORM_TEMPLATE = "{{.OSType}}/{{.Architecture}}";

export type LocalEnvironmentOs = "linux" | "darwin" | "windows" | "other";
export type LocalEnvironmentArchitecture = "amd64" | "arm64" | "other";

export type DockerUnavailableReason =
  | "docker_cli_missing"
  | "docker_context_unavailable"
  | "docker_context_not_local"
  | "docker_daemon_unavailable"
  | "docker_daemon_not_linux"
  | "docker_architecture_unsupported"
  | "docker_architecture_mismatch";

export interface LocalEnvironmentNativeFacts {
  os: LocalEnvironmentOs;
  architecture: LocalEnvironmentArchitecture;
  platform: `${LocalEnvironmentOs}/${LocalEnvironmentArchitecture}`;
  nodeVersion: string;
}

export type LocalEnvironmentDockerFacts =
  | { status: "available"; platform: "linux/amd64" | "linux/arm64" }
  | { status: "unavailable"; reasonCode: DockerUnavailableReason };

export interface LocalExecutionEnvironment {
  native: LocalEnvironmentNativeFacts;
  docker: LocalEnvironmentDockerFacts;
}

export interface DockerProbeCommandResult {
  status: number | null;
  stdout: string;
}

export interface LocalEnvironmentProbeOptions {
  platform?: string;
  architecture?: string;
  nodeVersion?: string;
  env?: NodeJS.ProcessEnv;
  resolveDockerCommandFn?: (env: NodeJS.ProcessEnv, platform: string) => string;
  runDockerFn?: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<DockerProbeCommandResult>;
}

type DockerResult = { status: number | null; stdout?: string; stderr?: string };
type DockerRunner = (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<DockerResult>;

const OS_ALIASES: Readonly<Record<string, LocalEnvironmentOs>> = Object.freeze({
  linux: "linux",
  darwin: "darwin",
  win32: "windows"
});

const ARCHITECTURE_ALIASES: Readonly<Record<string, LocalEnvironmentArchitecture>> = Object.freeze({
  x64: "amd64",
  amd64: "amd64",
  x86_64: "amd64",
  arm64: "arm64",
  aarch64: "arm64"
});

function normalizedOs(value: unknown): LocalEnvironmentOs {
  return OS_ALIASES[String(value ?? "").trim().toLowerCase()] || "other";
}

function normalizedArchitecture(value: unknown): LocalEnvironmentArchitecture {
  return ARCHITECTURE_ALIASES[String(value ?? "").trim().toLowerCase()] || "other";
}

function safeNodeVersion(value: unknown): string {
  const version = String(value ?? "").trim().replace(/^v(?=\d)/u, "");
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) ? version : "unknown";
}

function nativeFacts({ platform, architecture, nodeVersion }: Required<Pick<LocalEnvironmentProbeOptions, "platform" | "architecture" | "nodeVersion">>): LocalEnvironmentNativeFacts {
  const os = normalizedOs(platform);
  const arch = normalizedArchitecture(architecture);
  return {
    os,
    architecture: arch,
    platform: `${os}/${arch}`,
    nodeVersion: safeNodeVersion(nodeVersion)
  };
}

function endpointIsLocal(endpoint: string): boolean {
  const value = endpoint.trim();
  if (/^unix:\/\//iu.test(value) || /^npipe:\/\//iu.test(value)) return true;
  if (!/^tcp:\/\//iu.test(value)) return false;
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function endpointFromInspection(stdout: string): string {
  const value = stdout.trim();
  if (!value) return "";
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed.trim() : "";
  } catch {
    return "";
  }
}

function commandEnvironment(env: NodeJS.ProcessEnv, platform: string): NodeJS.ProcessEnv {
  const pathValue = env.PATH || env.Path || env.path;
  if (!pathValue) return { ...env };
  const selected: NodeJS.ProcessEnv = { ...env, PATH: pathValue };
  if (platform === "win32") delete selected.Path;
  return selected;
}

async function defaultRunDocker(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<DockerResult> {
  try {
    const result = await execFileAsync(command, [...args], {
      env,
      encoding: "utf8",
      timeout: DOCKER_PROBE_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
      windowsHide: true
    });
    return { status: 0, stdout: String(result.stdout || "") };
  } catch (error: unknown) {
    const childError = error as NodeJS.ErrnoException & { code?: string | number; stdout?: string };
    return {
      status: typeof childError.code === "number" ? childError.code : null,
      stdout: String(childError.stdout || "")
    };
  }
}

async function selectedDockerEndpoint(
  command: string,
  env: NodeJS.ProcessEnv,
  runDocker: DockerRunner
): Promise<{ endpoint: string } | { reasonCode: DockerUnavailableReason }> {
  const selectedContext = String(env.DOCKER_CONTEXT || "").trim();
  if (!selectedContext) {
    const configuredHost = String(env.DOCKER_HOST || "").trim();
    if (configuredHost) return { endpoint: configuredHost };
  }

  const args = ["context", "inspect", "--format", DOCKER_CONTEXT_ENDPOINT_TEMPLATE];
  if (selectedContext) args.push(selectedContext);
  const inspected = await runDocker(command, args, env).catch(() => ({ status: null, stdout: "" }));
  if (inspected.status !== 0) return { reasonCode: "docker_context_unavailable" };
  const endpoint = endpointFromInspection(inspected.stdout || "");
  if (!endpoint) return { reasonCode: "docker_context_unavailable" };
  return { endpoint };
}

async function discoverDockerFacts(
  native: LocalEnvironmentNativeFacts,
  env: NodeJS.ProcessEnv,
  platform: string,
  resolveDockerCommand: LocalEnvironmentProbeOptions["resolveDockerCommandFn"],
  runDocker: DockerRunner
): Promise<LocalEnvironmentDockerFacts> {
  const commandEnv = commandEnvironment(env, platform);
  let command = "";
  try {
    command = resolveDockerCommand
      ? resolveDockerCommand(commandEnv, platform)
      : resolveCommandCandidate("docker", {
          env: commandEnv,
          platform,
          includeDefaultLocalBin: false
        }).path;
  } catch {
    return { status: "unavailable", reasonCode: "docker_cli_missing" };
  }
  if (!command) return { status: "unavailable", reasonCode: "docker_cli_missing" };

  const selected = await selectedDockerEndpoint(command, commandEnv, runDocker);
  if ("reasonCode" in selected) return { status: "unavailable", reasonCode: selected.reasonCode };
  if (!endpointIsLocal(selected.endpoint)) return { status: "unavailable", reasonCode: "docker_context_not_local" };
  if (native.architecture !== "amd64" && native.architecture !== "arm64") {
    return { status: "unavailable", reasonCode: "docker_architecture_unsupported" };
  }

  const inspected = await runDocker(command, ["info", "--format", DOCKER_INFO_PLATFORM_TEMPLATE], commandEnv)
    .catch(() => ({ status: null, stdout: "" }));
  if (inspected.status !== 0) return { status: "unavailable", reasonCode: "docker_daemon_unavailable" };

  const [daemonOs, rawArchitecture] = String(inspected.stdout || "").trim().toLowerCase().split("/");
  if (!daemonOs || !rawArchitecture) return { status: "unavailable", reasonCode: "docker_daemon_unavailable" };
  if (daemonOs !== "linux") return { status: "unavailable", reasonCode: "docker_daemon_not_linux" };

  const architecture = normalizedArchitecture(rawArchitecture);
  if (architecture !== "amd64" && architecture !== "arm64") {
    return { status: "unavailable", reasonCode: "docker_architecture_unsupported" };
  }
  if (architecture !== native.architecture) {
    return { status: "unavailable", reasonCode: "docker_architecture_mismatch" };
  }
  return { status: "available", platform: `linux/${architecture}` };
}

/**
 * Discover only the current process platform and a same-architecture local Linux
 * Docker daemon. Unavailable Docker is descriptive capability data, never a pass.
 */
export async function discoverLocalExecutionEnvironment(
  options: LocalEnvironmentProbeOptions = {}
): Promise<LocalExecutionEnvironment> {
  const native = nativeFacts({
    platform: options.platform ?? process.platform,
    architecture: options.architecture ?? process.arch,
    nodeVersion: options.nodeVersion ?? process.version
  });
  const env = options.env ?? process.env;
  const runDocker: DockerRunner = options.runDockerFn || defaultRunDocker;
  return {
    native,
    docker: await discoverDockerFacts(native, env, options.platform ?? process.platform, options.resolveDockerCommandFn, runDocker)
  };
}
