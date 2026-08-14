#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isConsoleDocument } from "./offline-delivery-vm-target.ts";
import { runOfflineDeliveryLocalUp } from "./offline-delivery-local-up.ts";

export const INSTANCE_LIFECYCLE_ACTIONS: readonly any[] = Object.freeze(["start", "stop", "restart"]);
export const INSTANCE_LIFECYCLE_MODES: readonly any[] = Object.freeze([
  "dev",
  "server",
  "console",
  "compose",
  "compose-ui",
  "offline",
]);
export const INSTANCE_LIFECYCLE_PORT: any = 7228;
export const INSTANCE_LIFECYCLE_VITE_PORT: any = 5173;
export const INSTANCE_LIFECYCLE_OFFLINE_PROJECT: any = "meshrix-offline-vm";

function repoRootFromMeta() : any {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

export function failInstanceLifecycle(code?: any, message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  throw error;
}

function runCommand({
  executable,
  args = [],
  cwd,
  env,
  timeout = 60_000,
  inherit = false,
}: Record<string, any> = {}) : any {
  return spawnSync(executable, args.map(String), {
    cwd: cwd || repoRootFromMeta(),
    env: env || process.env,
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
}

export function parseInstanceLifecycleArgs(argv?: any) : any {
  const args: any[] = Array.isArray(argv) ? argv.map(String) : [];
  const action: any = String(args[0] || "").trim();
  const mode: any = String(args[1] || "").trim();
  if (!INSTANCE_LIFECYCLE_ACTIONS.includes(action)) {
    failInstanceLifecycle(
      "instance_lifecycle_action_unknown",
      "Use start, stop, or restart.",
    );
  }
  if (!INSTANCE_LIFECYCLE_MODES.includes(mode)) {
    failInstanceLifecycle(
      "instance_lifecycle_mode_unknown",
      "Use dev, server, console, compose, compose-ui, or offline.",
    );
  }
  return Object.freeze({ action, mode });
}

export async function probeInstancePort(port?: any) : Promise<any> {
  const origin: any = `http://127.0.0.1:${Number(port)}`;
  try {
    const health: any = await fetch(`${origin}/api/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    if (health.ok !== true) {
      return Object.freeze({
        listening: true,
        healthOk: false,
        consoleOk: false,
        healthz: Number(health.status),
        console: 0,
      });
    }
    const root: any = await fetch(`${origin}/`, {
      signal: AbortSignal.timeout(2000),
    });
    const body: any = await root.text();
    const consoleOk: any = isConsoleDocument({
      status: root.status,
      contentType: root.headers.get("content-type"),
      body,
    }) === true;
    return Object.freeze({
      listening: true,
      healthOk: true,
      consoleOk,
      healthz: 200,
      console: consoleOk ? 200 : Number(root.status),
    });
  } catch {
    return Object.freeze({
      listening: false,
      healthOk: false,
      consoleOk: false,
      healthz: 0,
      console: 0,
    });
  }
}

function inspectServerContainer() : any {
  const result: any = runCommand({
    executable: "docker",
    args: [
      "inspect",
      "--format",
      "{{.State.Running}} {{index .Config.Labels \"com.docker.compose.project\"}} {{range .Config.Env}}{{println .}}{{end}}",
      "meshrix-server",
    ],
    timeout: 10_000,
  });
  if (result.status !== 0) {
    return Object.freeze({ present: false, running: false, project: "", withUi: false });
  }
  const text: any = String(result.stdout || "");
  const first: any = String(text.split(/\r?\n/)[0] || "");
  const parts: any = first.split(/\s+/);
  return Object.freeze({
    present: true,
    running: parts[0] === "true",
    project: String(parts[1] || "").trim(),
    withUi: /(?:^|\n)MESHRIX_SERVER_WITH_UI=1(?:\n|$)/u.test(text),
  });
}

function sourceProcessCommand() : any {
  const result: any = runCommand({
    executable: "ps",
    args: ["-Ao", "command="],
    timeout: 10_000,
  });
  return String(result.stdout || "");
}

function classifySourceProcess(commandText?: any) : any {
  const text: any = String(commandText || "");
  if (!text.includes("tools/server-scripts/start-server.ts") && !text.includes("tools/scripts/start-all.ts")) {
    return "";
  }
  if (text.includes("--dev")) return "dev";
  if (text.includes("--with-ui") || text.includes("start-all.ts")) return "console";
  return "server";
}

export function classifyRunningInstance({
  container,
  sourceProcess,
}: Record<string, any> = {}) : any {
  if (container?.running === true && container.project === INSTANCE_LIFECYCLE_OFFLINE_PROJECT) {
    return "offline";
  }
  if (container?.running === true) {
    return container.withUi === true ? "compose-ui" : "compose";
  }
  if (typeof sourceProcess === "string" && sourceProcess) {
    return sourceProcess;
  }
  if (sourceProcess === true) {
    return "server";
  }
  return "";
}

export function containerMatchesMode(container?: any, mode?: any) : any {
  if (container?.present !== true) return false;
  if (mode === "offline") {
    return container.project === INSTANCE_LIFECYCLE_OFFLINE_PROJECT;
  }
  if (mode === "compose") {
    return container.project !== INSTANCE_LIFECYCLE_OFFLINE_PROJECT
      && container.withUi !== true;
  }
  if (mode === "compose-ui") {
    return container.project !== INSTANCE_LIFECYCLE_OFFLINE_PROJECT
      && container.withUi === true;
  }
  return false;
}

export function planInstanceRestart({
  current,
  mode,
  container,
}: Record<string, any> = {}) : any {
  if (current && current !== mode) {
    return Object.freeze({
      ok: false,
      code: "instance_lifecycle_wrong_mode",
    });
  }
  return Object.freeze({
    ok: true,
    start: containerMatchesMode(container, mode) === true ? "existing" : "fresh",
  });
}

function assertPortFreeOrSameMode(probe?: any, mode?: any, current?: any, container?: any) : any {
  if (probe?.listening !== true) return;
  if (current === mode) return;
  if (containerMatchesMode(container, mode) === true) return;
  failInstanceLifecycle(
    "instance_lifecycle_port_conflict",
    "Default host port is occupied by a different Meshrix.js mode or another process.",
  );
}

function assertContainerOwnsMode(container?: any, mode?: any) : any {
  if (container?.present !== true) return;
  if (containerMatchesMode(container, mode) === true) return;
  failInstanceLifecycle(
    "instance_lifecycle_container_conflict",
    "A different Meshrix.js container stack already owns the server container name.",
  );
}

function modeRequiresConsole(mode?: any) : any {
  return mode === "offline" || mode === "compose-ui" || mode === "console";
}

async function waitForHealth(port?: any, timeoutMs?: any, mode?: any) : Promise<any> {
  const deadline: any = Date.now() + Number(timeoutMs || 90_000);
  const needConsole: any = modeRequiresConsole(mode);
  while (Date.now() < deadline) {
    const probe: any = await probeInstancePort(port);
    if (probe.healthOk === true && (needConsole !== true || probe.consoleOk === true)) {
      return probe;
    }
    await new Promise((resolve?: any) : any => setTimeout(resolve, 1000));
  }
  failInstanceLifecycle(
    "instance_lifecycle_start_failed",
    "The instance did not become healthy.",
  );
}

function startExistingServerContainer() : any {
  const result: any = runCommand({
    executable: "docker",
    args: ["start", "meshrix-server"],
    timeout: 60_000,
  });
  if (result.status !== 0) {
    failInstanceLifecycle(
      "instance_lifecycle_start_failed",
      "Existing container start failed.",
    );
  }
}

function startSourceProcess(args?: any) : any {
  const child: any = spawn(process.execPath, [
    path.join(repoRootFromMeta(), "tools", "server-scripts", "start-server.ts"),
    ...args,
  ], {
    cwd: repoRootFromMeta(),
    env: {
      ...process.env,
      NODE_OPTIONS: "--conditions=source",
    },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function stopSourceProcesses(includeVite?: any) : any {
  const args: any[] = [
    path.join(repoRootFromMeta(), "tools", "scripts", "clean-existing-service.ts"),
    "--quiet",
    "--port",
    String(INSTANCE_LIFECYCLE_PORT),
  ];
  if (includeVite === true) {
    args.push("--vite-port", String(INSTANCE_LIFECYCLE_VITE_PORT));
  }
  const result: any = runCommand({
    executable: process.execPath,
    args,
    env: {
      ...process.env,
      NODE_OPTIONS: "--conditions=source",
    },
    timeout: 60_000,
  });
  if (result.status !== 0) {
    failInstanceLifecycle(
      "instance_lifecycle_stop_failed",
      "Source instance stop refused an unrelated process or failed closed.",
    );
  }
}

function startSourceCompose(withUi?: any) : any {
  const env: any = {
    ...process.env,
    MESHRIX_BUILD_TARGET: withUi === true ? "runtime-ui" : "runtime",
    MESHRIX_SERVER_WITH_UI: withUi === true ? "1" : "0",
  };
  const args: any[] = ["compose", "up", "-d", "--wait", "meshrix-server"];
  if (withUi === true) args.splice(2, 0, "--build");
  const result: any = runCommand({
    executable: "docker",
    args,
    env,
    timeout: 600_000,
  });
  if (result.status !== 0) {
    failInstanceLifecycle(
      "instance_lifecycle_start_failed",
      "Source compose start failed.",
    );
  }
}

function stopSourceCompose() : any {
  const result: any = runCommand({
    executable: "docker",
    args: ["compose", "stop", "meshrix-server"],
    timeout: 120_000,
  });
  if (result.status !== 0) {
    failInstanceLifecycle(
      "instance_lifecycle_stop_failed",
      "Source compose stop failed.",
    );
  }
}

function stopOfflineCompose() : any {
  const labeled: any = runCommand({
    executable: "docker",
    args: [
      "inspect",
      "--format",
      "{{index .Config.Labels \"com.docker.compose.project\"}}",
      "meshrix-server",
    ],
    timeout: 10_000,
  });
  if (labeled.status !== 0) return;
  if (String(labeled.stdout || "").trim() !== INSTANCE_LIFECYCLE_OFFLINE_PROJECT) {
    failInstanceLifecycle(
      "instance_lifecycle_wrong_mode",
      "The running container is not the offline stack.",
    );
  }
  const result: any = runCommand({
    executable: "docker",
    args: ["compose", "-p", INSTANCE_LIFECYCLE_OFFLINE_PROJECT, "stop", "meshrix-server"],
    timeout: 120_000,
  });
  if (result.status !== 0) {
    failInstanceLifecycle(
      "instance_lifecycle_stop_failed",
      "Offline compose stop failed.",
    );
  }
}

function resultPayload({
  action,
  mode,
  reused = false,
  alreadyStopped = false,
  restarted = false,
  probe,
}: Record<string, any> = {}) : any {
  return Object.freeze({
    ok: true,
    action,
    mode,
    reused: reused === true,
    alreadyStopped: alreadyStopped === true,
    restarted: restarted === true,
    url: `http://127.0.0.1:${INSTANCE_LIFECYCLE_PORT}`,
    healthz: Number(probe?.healthz || 0),
    console: Number(probe?.console || 0),
  });
}

function inspectCurrentInstance() : any {
  const container: any = inspectServerContainer();
  return Object.freeze({
    probe: null,
    container,
    current: classifyRunningInstance({
      container,
      sourceProcess: classifySourceProcess(sourceProcessCommand()),
    }),
  });
}

async function startInstance(mode?: any, { force = false } = {}) : Promise<any> {
  const probe: any = await probeInstancePort(INSTANCE_LIFECYCLE_PORT);
  const snapshot: any = inspectCurrentInstance();
  if (force !== true && snapshot.current === mode && probe.healthOk === true) {
    return resultPayload({
      action: "start",
      mode,
      reused: true,
      probe,
    });
  }
  assertPortFreeOrSameMode(probe, mode, snapshot.current, snapshot.container);
  assertContainerOwnsMode(snapshot.container, mode);
  if (containerMatchesMode(snapshot.container, mode) === true) {
    if (snapshot.container.running !== true) {
      startExistingServerContainer();
    }
    const ready: any = await waitForHealth(INSTANCE_LIFECYCLE_PORT, 90_000, mode);
    return resultPayload({
      action: "start",
      mode,
      probe: ready,
    });
  }
  if (mode === "offline") {
    const started: any = await runOfflineDeliveryLocalUp();
    return resultPayload({
      action: "start",
      mode: "offline",
      reused: started.reused === true,
      probe: {
        healthz: started.healthz,
        console: started.console,
      },
    });
  }
  if (mode === "compose" || mode === "compose-ui") {
    startSourceCompose(mode === "compose-ui");
  } else if (mode === "dev") {
    startSourceProcess(["--profile", "core", "--dev"]);
  } else if (mode === "console") {
    startSourceProcess(["--profile", "core", "--with-ui"]);
  } else {
    startSourceProcess(["--profile", "core"]);
  }
  const ready: any = await waitForHealth(INSTANCE_LIFECYCLE_PORT, 90_000, mode);
  return resultPayload({
    action: "start",
    mode,
    probe: ready,
  });
}

async function stopInstance(mode?: any) : Promise<any> {
  const probe: any = await probeInstancePort(INSTANCE_LIFECYCLE_PORT);
  const snapshot: any = inspectCurrentInstance();
  if (!snapshot.current) {
    return resultPayload({
      action: "stop",
      mode,
      alreadyStopped: true,
      probe,
    });
  }
  if (snapshot.current !== mode) {
    failInstanceLifecycle(
      "instance_lifecycle_wrong_mode",
      "The running instance is a different startup mode.",
    );
  }
  if (mode === "offline") {
    stopOfflineCompose();
  } else if (mode === "compose" || mode === "compose-ui") {
    stopSourceCompose();
  } else {
    stopSourceProcesses(mode === "dev");
  }
  return resultPayload({
    action: "stop",
    mode,
    probe: await probeInstancePort(INSTANCE_LIFECYCLE_PORT),
  });
}

export async function runInstanceLifecycle({
  action,
  mode,
}: Record<string, any> = {}) : Promise<any> {
  const parsed: any = parseInstanceLifecycleArgs([action, mode]);
  if (parsed.action === "start") {
    return startInstance(parsed.mode);
  }
  if (parsed.action === "stop") {
    return stopInstance(parsed.mode);
  }
  const snapshot: any = inspectCurrentInstance();
  if (snapshot.current && snapshot.current !== parsed.mode) {
    failInstanceLifecycle(
      "instance_lifecycle_wrong_mode",
      "The running instance is a different startup mode.",
    );
  }
  if (snapshot.current === parsed.mode) {
    await stopInstance(parsed.mode);
  }
  const started: any = await startInstance(parsed.mode, { force: true });
  return resultPayload({
    action: "restart",
    mode: parsed.mode,
    restarted: true,
    probe: {
      healthz: started.healthz,
      console: started.console,
    },
  });
}

const invokedDirectly: any = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runInstanceLifecycle(parseInstanceLifecycleArgs(process.argv.slice(2))).then((result?: any) : any => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error?: any) : any => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code || "instance_lifecycle_failed",
    })}\n`);
    process.exitCode = 1;
  });
}
