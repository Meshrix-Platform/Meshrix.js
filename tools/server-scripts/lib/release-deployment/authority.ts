import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { validateReleaseExecutionEnvironment } from "./contract.ts";

const SHA1 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
export const RELEASE_DEPLOYMENT_CLEANUP_STATE_SCHEMA = "meshrix.release-deployment.cleanup/2";
const CLEANUP_STATE_KEYS = Object.freeze([
  "backupVolume",
  "candidateDigest",
  "containerName",
  "dataVolume",
  "fixtureContainerName",
  "imageName",
  "networkName",
  "resourceId",
  "schemaVersion",
  "sourceRevision",
  "tempRoot",
]);
const MAX_CLEANUP_STATE_BYTES = 16 * 1024;
const MAX_CLEANUP_PROBE_BYTES = 16 * 1024;

function fail(code: string, detail = code): never {
  throw Object.assign(new Error(detail), { code });
}

function osReleaseFields(source: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of source.split(/\r?\n/u)) {
    const match = /^(ID|VERSION_ID)=(.*)$/u.exec(line);
    if (!match) continue;
    if (Object.prototype.hasOwnProperty.call(fields, match[1])) {
      fail("release_deployment_environment_os_release_invalid");
    }
    const raw = match[2];
    const quoted = /^"([A-Za-z0-9._-]+)"$/u.exec(raw);
    const plain = /^([A-Za-z0-9._-]+)$/u.exec(raw);
    const value = quoted?.[1] || plain?.[1];
    if (!value) fail("release_deployment_environment_os_release_invalid");
    fields[match[1]] = value;
  }
  return fields;
}

export function classifyReleaseDeploymentEnvironment({
  platform = "",
  architecture = "",
  nodeVersion = "",
  osRelease = "",
  githubActions = "",
  runnerEnvironment = "",
  runnerOs = "",
  runnerArchitecture = "",
}: Record<string, string> = {}): any {
  const os = osReleaseFields(osRelease);
  const environment = {
    architecture,
    nodeVersion,
    platform,
    runner: os.ID && os.VERSION_ID ? `${os.ID}-${os.VERSION_ID}` : "",
    runnerEnvironment: "local",
  };
  // GitHub runner variables describe the process context; they are not signed provenance.
  if (githubActions === "true") {
    if (runnerEnvironment !== "github-hosted" || runnerOs !== "Linux" || runnerArchitecture !== "X64") {
      fail("release_deployment_environment_runner_context_invalid");
    }
    environment.runnerEnvironment = "github-hosted";
  } else if ((githubActions !== "" && githubActions !== "false") ||
    runnerEnvironment || runnerOs || runnerArchitecture) {
    fail("release_deployment_environment_runner_context_invalid");
  }
  const reasons = validateReleaseExecutionEnvironment(environment);
  if (reasons.length > 0) fail(reasons[0]);
  return Object.freeze(environment);
}

export async function observeReleaseDeploymentEnvironment(): Promise<any> {
  let osRelease: string;
  try {
    osRelease = await fs.readFile("/etc/os-release", "utf8");
  } catch {
    fail("release_deployment_environment_os_release_unavailable");
  }
  return classifyReleaseDeploymentEnvironment({
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.versions.node,
    osRelease,
    githubActions: process.env.GITHUB_ACTIONS || "",
    runnerEnvironment: process.env.RUNNER_ENVIRONMENT || "",
    runnerOs: process.env.RUNNER_OS || "",
    runnerArchitecture: process.env.RUNNER_ARCH || "",
  });
}

export async function requireCurrentReleaseDeploymentEnvironment(value: any): Promise<any> {
  const current = await observeReleaseDeploymentEnvironment();
  const reasons = validateReleaseExecutionEnvironment(value);
  if (reasons.length > 0) fail(reasons[0]);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(Object.keys(current).sort()) ||
    Object.keys(current).some((key) => value[key] !== current[key])) {
    fail("release_deployment_environment_mismatch");
  }
  return current;
}

function isRecord(value: any): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: any, keys: readonly string[]): boolean {
  return isRecord(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export function validateReleaseDeploymentCleanupState(value: any): any {
  if (!hasExactKeys(value, CLEANUP_STATE_KEYS) ||
    value.schemaVersion !== RELEASE_DEPLOYMENT_CLEANUP_STATE_SCHEMA ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      String(value.resourceId || ""),
    ) ||
    !SHA1.test(String(value.sourceRevision || "")) ||
    !SHA256.test(String(value.candidateDigest || ""))) {
    fail("release_deployment_cleanup_state_invalid");
  }
  const id = value.resourceId;
  const expected = {
    containerName: `meshrix-release-smoke-${id}`,
    fixtureContainerName: `meshrix-release-fixture-${id}`,
    imageName: `meshrix-release-smoke:${id}`,
    networkName: `meshrix-release-network-${id}`,
    dataVolume: `meshrix-release-data-${id}`,
    backupVolume: `meshrix-release-backup-${id}`,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) fail("release_deployment_cleanup_state_invalid");
  }
  const expectedRoot = path.join(os.tmpdir(), `meshrix-release-deployment-${id}`);
  if (value.tempRoot !== expectedRoot) fail("release_deployment_cleanup_state_invalid");
  return value;
}

export async function readReleaseDeploymentCleanupState(filePath: string): Promise<any> {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_CLEANUP_STATE_BYTES) {
    fail("release_reducer_cleanup_state_invalid");
  }
  try {
    return validateReleaseDeploymentCleanupState(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch (error: any) {
    if (error?.code === "release_deployment_cleanup_state_invalid") {
      fail("release_reducer_cleanup_state_invalid");
    }
    fail("release_reducer_cleanup_state_invalid");
  }
}

function dockerCleanupProbe(args: string[], captureStdout = false): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    let bytes = 0;
    let overflow = false;
    child.once("error", () => reject(Object.assign(new Error("cleanup probe unavailable"), {
      code: "release_reducer_cleanup_verification_unavailable",
    })));
    if (captureStdout && child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_CLEANUP_PROBE_BYTES) {
          overflow = true;
          child.kill("SIGKILL");
          return;
        }
        stdout += chunk.toString("utf8");
      });
    }
    child.once("close", (code) => {
      if (overflow) {
        reject(Object.assign(new Error("cleanup probe output exceeded bound"), {
          code: "release_reducer_cleanup_verification_unavailable",
        }));
        return;
      }
      resolve({ code, stdout });
    });
  });
}

export async function assertReleaseDeploymentResourcesRemoved(state: any): Promise<void> {
  validateReleaseDeploymentCleanupState(state);
  if ((await dockerCleanupProbe(["info"])).code !== 0) {
    fail("release_reducer_cleanup_verification_unavailable");
  }
  const resources = [
    {
      name: state.containerName,
      args: ["container", "ls", "--all", "--filter", `name=${state.containerName}`, "--format", "{{.Names}}"],
    },
    {
      name: state.fixtureContainerName,
      args: ["container", "ls", "--all", "--filter", `name=${state.fixtureContainerName}`, "--format", "{{.Names}}"],
    },
    {
      name: state.dataVolume,
      args: ["volume", "ls", "--filter", `name=${state.dataVolume}`, "--format", "{{.Name}}"],
    },
    {
      name: state.backupVolume,
      args: ["volume", "ls", "--filter", `name=${state.backupVolume}`, "--format", "{{.Name}}"],
    },
    {
      name: state.imageName,
      args: ["image", "ls", "--all", "--filter", `reference=${state.imageName}`, "--format", "{{.Repository}}:{{.Tag}}"],
    },
    {
      name: state.networkName,
      args: ["network", "ls", "--filter", `name=${state.networkName}`, "--format", "{{.Name}}"],
    },
  ];
  for (const resource of resources) {
    const probe = await dockerCleanupProbe(resource.args, true);
    if (probe.code !== 0) fail("release_reducer_cleanup_verification_unavailable");
    if (probe.stdout.split(/\r?\n/u).some((line) => line.trim() === resource.name)) {
      fail("release_reducer_cleanup_incomplete");
    }
  }
}
