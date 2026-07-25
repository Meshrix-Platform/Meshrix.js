// Release journey compose stack lifecycle.
//
// Starts the isolated release-journey compose project (meshrix-server plus the
// format-convert profile) exactly like the documented operator flow, with a
// gate-specific server image tag so nothing shared is clobbered, and tears it
// down with `down -v` because the volume is always created fresh by the gate.
import { spawnSync } from "node:child_process";
import net from "node:net";

export const RELEASE_JOURNEY_COMPOSE_PROJECT = "meshrix-release-journey";
export const RELEASE_JOURNEY_SERVER_CONTAINER = "meshrix-release-server";
export const RELEASE_JOURNEY_CONVERTER_CONTAINER = "meshrix-release-format-convert";
export const RELEASE_JOURNEY_SERVER_IMAGE = "meshrix-server:release-journey-gate";
export const DEFAULT_CONVERTER_IMAGE = "meshrix-format-convert:local";
export const DEFAULT_FORMAT_CONVERTER_BUILD_DIR = "../Meshrix-Services/file-parser/format-convert";

export function composeEnv({ hostPort, converterImage }) {
  return {
    ...process.env,
    DOCKER_BUILDKIT: "1",
    COMPOSE_DOCKER_CLI_BUILD: "1",
    COMPOSE_PROJECT_NAME: RELEASE_JOURNEY_COMPOSE_PROJECT,
    MESHRIX_CONTAINER_NAME: RELEASE_JOURNEY_SERVER_CONTAINER,
    MESHRIX_FORMAT_CONVERT_CONTAINER_NAME: RELEASE_JOURNEY_CONVERTER_CONTAINER,
    MESHRIX_IMAGE_NAME: RELEASE_JOURNEY_SERVER_IMAGE,
    MESHRIX_HOST_PORT: String(hostPort),
    MESHRIX_ADVERTISED_BASE_URL: `http://127.0.0.1:${hostPort}`,
    MESHRIX_FORMAT_CONVERT_IMAGE_NAME: converterImage
  };
}

export function runCompose(args, { cwd, env, redact = (value) => value, allowFailure = false } = {}) {
  const result = spawnSync("docker", ["compose", ...args], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  const stdout = redact(result.stdout || "");
  const stderr = redact(result.stderr || "");
  if (!allowFailure && result.status !== 0) {
    const error = new Error(`docker compose ${args.join(" ")} failed with status ${result.status}: ${stderr.slice(-1200)}`);
    error.code = "release_journey_compose_failed";
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }
  return { status: result.status ?? 1, stdout, stderr };
}

export function runDocker(args, { env, redact = (value) => value, allowFailure = false, input = undefined } = {}) {
  const result = spawnSync("docker", args, {
    env,
    encoding: "utf8",
    input,
    maxBuffer: 16 * 1024 * 1024
  });
  const stdout = redact(result.stdout || "");
  const stderr = redact(result.stderr || "");
  if (!allowFailure && result.status !== 0) {
    const error = new Error(`docker ${args.join(" ")} failed with status ${result.status}: ${stderr.slice(-1200)}`);
    error.code = "release_journey_docker_failed";
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }
  return { status: result.status ?? 1, stdout, stderr };
}

export async function assertDockerAvailable(run = runDocker) {
  const probe = run(["info", "--format", "{{.ServerVersion}}"], { allowFailure: true });
  if (probe.status !== 0 || !probe.stdout.trim()) {
    const error = new Error("Docker engine is not available; the release journey gate requires a running container engine.");
    error.code = "release_journey_docker_unavailable";
    throw error;
  }
  return probe.stdout.trim().split("\n")[0];
}

export function dockerImageExists(imageName, run = runDocker) {
  const probe = run(["image", "inspect", imageName, "--format", "{{.Id}}"], { allowFailure: true });
  return probe.status === 0 && Boolean(probe.stdout.trim());
}

export async function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function chooseHostPort({ explicitPort = 0, candidates = [8228, 18228, 28228] } = {}) {
  if (explicitPort) {
    if (!(await isPortFree(explicitPort))) {
      const error = new Error(`Requested host port ${explicitPort} is not free.`);
      error.code = "release_journey_port_busy";
      throw error;
    }
    return explicitPort;
  }
  for (const candidate of candidates) {
    if (await isPortFree(candidate)) return candidate;
  }
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = 20000 + Math.floor(Math.random() * 20000);
    if (await isPortFree(candidate)) return candidate;
  }
  const error = new Error("No free loopback host port found for the release journey stack.");
  error.code = "release_journey_port_unavailable";
  throw error;
}

export async function waitForHttpOk(url, { timeoutMs = 120000, intervalMs = 1000, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(3000) });
      lastStatus = response.status;
      if (response.ok) {
        return { ok: true, status: response.status, attemptsMs: 0 };
      }
    } catch {
      lastStatus = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const error = new Error(`Timed out waiting for HTTP 200 from ${url} (last status ${lastStatus || "none"}).`);
  error.code = "release_journey_health_timeout";
  throw error;
}

export async function waitForConverterReady({ containerName, timeoutMs = 90000, intervalMs = 2000, run = runDocker, env } = {}) {
  const deadline = Date.now() + timeoutMs;
  const script = 'exec 3<>/dev/tcp/127.0.0.1/8080 && printf "GET /readyz HTTP/1.0\\r\\n\\r\\n" >&3 && head -n 1 <&3';
  while (Date.now() < deadline) {
    const probe = run(["exec", containerName, "bash", "-c", script], { env, allowFailure: true });
    if (probe.status === 0 && / 200/.test(probe.stdout)) {
      return { ok: true };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const error = new Error("Timed out waiting for the format-convert container /readyz.");
  error.code = "release_journey_converter_timeout";
  throw error;
}
