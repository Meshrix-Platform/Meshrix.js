// Release journey compose stack lifecycle.
//
// Starts the isolated release-journey compose project (meshrix-server plus the
// format-convert profile) exactly like the documented operator flow, with a
// gate-specific server image tag so nothing shared is clobbered, and tears it
// down with `down -v` because the volume is always created fresh by the gate.
import { spawnSync } from "node:child_process";
import net from "node:net";

export const RELEASE_JOURNEY_COMPOSE_PROJECT: any = "meshrix-release-journey";
export const RELEASE_JOURNEY_SERVER_CONTAINER: any = "meshrix-release-server";
export const RELEASE_JOURNEY_CONVERTER_CONTAINER: any = "meshrix-release-format-convert";
export const RELEASE_JOURNEY_SERVER_IMAGE: any = "meshrix-server:release-journey-gate";
export const DEFAULT_CONVERTER_IMAGE: any = "meshrix-js-format-convert:local";
export const RELEASE_JOURNEY_STACK_UP_ARGS: readonly any[] = Object.freeze([
  "--profile",
  "format-convert",
  "up",
  "-d"
]);
export const RELEASE_JOURNEY_STACK_UP_COMMAND: any =
  `docker compose ${RELEASE_JOURNEY_STACK_UP_ARGS.join(" ")}`;
export const RELEASE_JOURNEY_SAFE_START_CONFIGURATION: Readonly<Record<string, any>> = Object.freeze({
  command: RELEASE_JOURNEY_STACK_UP_COMMAND,
  composeProfile: "format-convert",
  buildTarget: "runtime-ui",
  consoleEnabled: true
});

export function composeEnv({ hostPort, converterImage }: Record<string, any>) : any {
  return {
    ...process.env,
    DOCKER_BUILDKIT: "1",
    COMPOSE_DOCKER_CLI_BUILD: "1",
    COMPOSE_PROJECT_NAME: RELEASE_JOURNEY_COMPOSE_PROJECT,
    MESHRIX_CONTAINER_NAME: RELEASE_JOURNEY_SERVER_CONTAINER,
    MESHRIX_FORMAT_CONVERT_CONTAINER_NAME: RELEASE_JOURNEY_CONVERTER_CONTAINER,
    MESHRIX_IMAGE_NAME: RELEASE_JOURNEY_SERVER_IMAGE,
    MESHRIX_BUILD_TARGET: "runtime-ui",
    MESHRIX_SERVER_WITH_UI: "1",
    MESHRIX_HOST_PORT: String(hostPort),
    MESHRIX_ADVERTISED_BASE_URL: `http://127.0.0.1:${hostPort}`,
    MESHRIX_FORMAT_CONVERT_IMAGE_NAME: converterImage
  };
}

export function runCompose(args?: any, { cwd, env, redact = (value?: any) : any => value, allowFailure = false }: Record<string, any> = {}) : any {
  const result: any = spawnSync("docker", ["compose", ...args], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  const stdout: any = redact(result.stdout || "");
  const stderr: any = redact(result.stderr || "");
  if (!allowFailure && result.status !== 0) {
    const error: Error & Record<string, any> = new Error(`docker compose ${args.join(" ")} failed with status ${result.status}: ${stderr.slice(-1200)}`);
    error.code = "release_journey_compose_failed";
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }
  return { status: result.status ?? 1, stdout, stderr };
}

export function runDocker(args?: any, { env, redact = (value?: any) : any => value, allowFailure = false, input = undefined }: Record<string, any> = {}) : any {
  const result: any = spawnSync("docker", args, {
    env,
    encoding: "utf8",
    input,
    maxBuffer: 16 * 1024 * 1024
  });
  const stdout: any = redact(result.stdout || "");
  const stderr: any = redact(result.stderr || "");
  if (!allowFailure && result.status !== 0) {
    const error: Error & Record<string, any> = new Error(`docker ${args.join(" ")} failed with status ${result.status}: ${stderr.slice(-1200)}`);
    error.code = "release_journey_docker_failed";
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }
  return { status: result.status ?? 1, stdout, stderr };
}

export async function assertDockerAvailable(run: any = runDocker) : Promise<any> {
  const probe: any = run(["info", "--format", "{{.ServerVersion}}"], { allowFailure: true });
  if (probe.status !== 0 || !probe.stdout.trim()) {
    const error: Error & Record<string, any> = new Error("Docker engine is not available; the release journey gate requires a running container engine.");
    error.code = "release_journey_docker_unavailable";
    throw error;
  }
  return probe.stdout.trim().split("\n")[0];
}

export function dockerImageExists(imageName?: any, run: any = runDocker) : any {
  const probe: any = run(["image", "inspect", imageName, "--format", "{{.Id}}"], { allowFailure: true });
  return probe.status === 0 && Boolean(probe.stdout.trim());
}

export async function isPortFree(port?: any, host: any = "127.0.0.1") : Promise<any> {
  return new Promise((resolve?: any) : any => {
    const server: any = net.createServer();
    server.once("error", () : any => resolve(false));
    server.listen(port, host, () : any => {
      server.close(() : any => resolve(true));
    });
  });
}

export async function chooseHostPort({ explicitPort = 0, candidates = [8228, 18228, 28228] }: Record<string, any> = {}) : Promise<any> {
  if (explicitPort) {
    if (!(await isPortFree(explicitPort))) {
      const error: Error & Record<string, any> = new Error(`Requested host port ${explicitPort} is not free.`);
      error.code = "release_journey_port_busy";
      throw error;
    }
    return explicitPort;
  }
  for (const candidate of candidates) {
    if (await isPortFree(candidate)) return candidate;
  }
  for (let attempt: any = 0; attempt < 25; attempt += 1) {
    const candidate: any = 20000 + Math.floor(Math.random() * 20000);
    if (await isPortFree(candidate)) return candidate;
  }
  const error: Error & Record<string, any> = new Error("No free loopback host port found for the release journey stack.");
  error.code = "release_journey_port_unavailable";
  throw error;
}

export async function waitForHttpOk(url?: any, { timeoutMs = 120000, intervalMs = 1000, fetchImpl = fetch }: Record<string, any> = {}) : Promise<any> {
  const deadline: any = Date.now() + timeoutMs;
  let lastStatus: any = 0;
  while (Date.now() < deadline) {
    try {
      const response: any = await fetchImpl(url, { signal: AbortSignal.timeout(3000) });
      lastStatus = response.status;
      if (response.ok) {
        return { ok: true, status: response.status, attemptsMs: 0 };
      }
    } catch {
      lastStatus = 0;
    }
    await new Promise((resolve?: any) : any => setTimeout(resolve, intervalMs));
  }
  const error: Error & Record<string, any> = new Error(`Timed out waiting for HTTP 200 from ${url} (last status ${lastStatus || "none"}).`);
  error.code = "release_journey_health_timeout";
  throw error;
}

export async function waitForConverterReady({ containerName, timeoutMs = 90000, intervalMs = 2000, run = runDocker, env }: Record<string, any> = {}) : Promise<any> {
  const deadline: any = Date.now() + timeoutMs;
  const script: any = 'exec 3<>/dev/tcp/127.0.0.1/8080 && printf "GET /readyz HTTP/1.0\\r\\n\\r\\n" >&3 && head -n 1 <&3';
  while (Date.now() < deadline) {
    const probe: any = run(["exec", containerName, "bash", "-c", script], { env, allowFailure: true });
    if (probe.status === 0 && / 200/.test(probe.stdout)) {
      return { ok: true };
    }
    await new Promise((resolve?: any) : any => setTimeout(resolve, intervalMs));
  }
  const error: Error & Record<string, any> = new Error("Timed out waiting for the format-convert container /readyz.");
  error.code = "release_journey_converter_timeout";
  throw error;
}
