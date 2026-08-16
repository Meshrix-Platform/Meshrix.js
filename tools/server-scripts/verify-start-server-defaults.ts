#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const entrypointIndex: any = process.argv.indexOf("--entrypoint");
const requestedEntrypoint: any = entrypointIndex >= 0 ? process.argv[entrypointIndex + 1] : "";
const commandIndex: any = process.argv.indexOf("--command");
const requestedCommand: any = commandIndex >= 0 ? process.argv[commandIndex + 1] : "";
assert.equal(
  Boolean(requestedEntrypoint) && Boolean(requestedCommand),
  false,
  "entrypoint and command are mutually exclusive"
);
const startServerPath: any = requestedEntrypoint
  ? path.resolve(requestedEntrypoint)
  : path.join(repoRoot, "tools", "server-scripts", "start-server.ts");
const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-start-server-defaults-"));
const readyFilePath: any = path.join(userDataPath, "private-ready.json");
const queryNeedle: any = "private-query-value-73f1";
const userAgentNeedle: any = "private-user-agent-91c4";
const argvNeedle: any = "private-server-label-5a27";
const discoveryNeedle: any = "http://private-discovery.invalid:4312";

async function requestJson(url?: any, options: Record<string, any> = {}) : Promise<any> {
  const response: any = await fetch(url, options);
  const text: any = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    payload: text.trim() ? JSON.parse(text) : {}
  };
}

function waitForChildExit(child?: any, timeoutMs: any = 5000) : any {
  return new Promise((resolve?: any) : any => {
    const timeout: any = setTimeout(() : any => {
      child.kill("SIGKILL");
      resolve({ timedOut: true, code: null, signal: "SIGKILL" });
    }, timeoutMs);
    child.once("exit", (code?: any, signal?: any) : any => {
      clearTimeout(timeout);
      resolve({ timedOut: false, code, signal });
    });
  });
}

function delay(ms?: any) : any {
  return new Promise((resolve?: any) : any => setTimeout(resolve, ms));
}

async function waitForReady(child?: any, filePath?: any, timeoutMs: any = 15000) : Promise<any> {
  const deadline: any = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("start-server exited before ready; reasonCode=startup_exited");
    }
    try {
      const payload: any = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (payload?.status === "ready" && Number(payload?.port) > 0) {
        return payload;
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw new Error("private ready state could not be read; reasonCode=ready_state_invalid");
      }
    }
    await delay(25);
  }
  throw new Error("start-server did not become ready; reasonCode=startup_timeout");
}

async function readRuntimeLogText(logDir?: any) : Promise<any> {
  const entries: any = await fs.readdir(logDir, { withFileTypes: true }).catch(() : any => []);
  const chunks: any[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      chunks.push(await fs.readFile(path.join(logDir, entry.name), "utf8"));
    }
  }
  return chunks.join("\n");
}

function assertAbsent(text?: any, values?: any, label?: any) : any {
  for (let index: any = 0; index < values.length; index += 1) {
    assert.equal(text.includes(values[index]), false, `${label} exposed forbidden value ${index + 1}`);
  }
}

async function assertFilesExclude(rootPath?: any, values?: any) : Promise<any> {
  const entries: any = await fs.readdir(rootPath, { withFileTypes: true }).catch(() : any => []);
  for (const entry of entries) {
    const entryPath: any = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await assertFilesExclude(entryPath, values);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const bytes: any = await fs.readFile(entryPath);
    for (let index: any = 0; index < values.length; index += 1) {
      assert.equal(
        bytes.includes(Buffer.from(values[index])),
        false,
        `runtime file exposed forbidden value ${index + 1}`
      );
    }
  }
}

const env: Record<string, any> = { ...process.env };
delete env.MESHRIX_EDITION;
delete env.MESHRIX_FEATURE_PROFILE;

const outputChunks: any[] = [];
const output: Record<string, any> = {
  push(chunk?: any) : any {
    outputChunks.push(Buffer.from(chunk));
  },
  text() : any {
    return Buffer.concat(outputChunks).toString("utf8");
  }
};

let child: any = null;
let smokeStage = "launch";

try {
  const launchCommand: any = requestedCommand ? path.resolve(requestedCommand) : process.execPath;
  const launchArguments: any[] = [
    ...(requestedCommand ? [] : [startServerPath]),
    "--port",
    "0",
    "--ready-file",
    readyFilePath,
    "--profile",
    "default",
    "--data-dir",
    userDataPath,
    "--server-label",
    argvNeedle,
    "--active-service-url",
    discoveryNeedle,
    "--advertised-base-url",
    discoveryNeedle
  ];
  child = spawn(launchCommand, launchArguments, {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32" && Boolean(requestedCommand)
  });

  child.stdout.on("data", (chunk?: any) : any => output.push(chunk));
  child.stderr.on("data", (chunk?: any) : any => output.push(chunk));

  const ready: any = await waitForReady(child, readyFilePath);
  smokeStage = "startup_contract";
  const readyStat: any = await fs.stat(readyFilePath);
  if (process.platform !== "win32") {
    assert.equal(readyStat.mode & 0o777, 0o600);
  }
  const text: any = output.text();
  assert.equal(text.includes("Server status: started"), true, "startup status is missing");
  assert.equal(text.includes("UI mode: api-only"), true, "UI mode is missing");
  assert.equal(text.includes("Runtime profile: default"), true, "runtime profile is missing");
  assert.equal(text.includes("Discovery mode: unconfigured"), true, "discovery mode is missing");
  assert.doesNotMatch(text, /Unknown edition: undefined/);
  assert.equal(/https?:\/\//i.test(text), false, "startup output exposed an endpoint URL");
  assert.equal(/(?:^|\n)\s+at\s+/m.test(text), false, "startup output exposed a stack frame");
  assertAbsent(text, [userDataPath, readyFilePath, startServerPath, argvNeedle, discoveryNeedle], "startup output");

  const serverUrl: any = `http://${ready.host}:${ready.port}`;

  smokeStage = "health_request";
  const health: any = await requestJson(`${serverUrl}/api/healthz?private=${queryNeedle}`, {
    headers: { "User-Agent": userAgentNeedle }
  });
  smokeStage = "health_status";
  assert.equal(health.status, 200);
  smokeStage = "health_trace";
  assert.ok(health.headers.get("x-meshrix-trace-id"));

  smokeStage = "bootstrap_request";
  const bootstrap: any = await requestJson(`${serverUrl}/api/bootstrap`);
  smokeStage = "bootstrap_status";
  assert.equal(bootstrap.status, 200);

  smokeStage = "rpc_health_request";
  const rpcHealth: any = await requestJson(`${serverUrl}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "startup-health",
      method: "system.health",
      params: {}
    })
  });
  smokeStage = "rpc_health_status";
  assert.equal(rpcHealth.status, 200);
  smokeStage = "rpc_health_payload";
  assert.equal(rpcHealth.payload.jsonrpc, "2.0");

  smokeStage = "shutdown_contract";
  if (process.platform === "win32") {
    // Windows has no POSIX signal delivery; terminate the launcher process
    // tree instead of awaiting a signal-driven graceful shutdown.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
  const exit: any = await waitForChildExit(child);
  assert.equal(exit.timedOut, false);

  const finalText: any = output.text();
  if (process.platform !== "win32") {
    assert.equal(finalText.includes("Server shutdown: started"), true, "shutdown start status is missing");
    assert.equal(finalText.includes("Server shutdown: complete"), true, "shutdown completion status is missing");
  }
  assert.equal(/https?:\/\//i.test(finalText), false, "server output exposed an endpoint URL");
  assert.equal(/(?:^|\n)\s+at\s+/m.test(finalText), false, "server output exposed a stack frame");
  assertAbsent(
    finalText,
    [userDataPath, readyFilePath, startServerPath, argvNeedle, discoveryNeedle, queryNeedle, userAgentNeedle],
    "server output"
  );

  if (process.platform !== "win32") {
    // A hard-killed Windows server cannot remove its readiness file.
    await assert.rejects(fs.access(readyFilePath));
  }
  smokeStage = "runtime_log_contract";
  const runtimeLogText: any = await readRuntimeLogText(path.join(userDataPath, "logs", "runtime"));
  assert.ok(runtimeLogText.length > 0, "runtime log output is missing");
  assertAbsent(
    runtimeLogText,
    [
      userDataPath,
      readyFilePath,
      startServerPath,
      argvNeedle,
      discoveryNeedle,
      queryNeedle,
      userAgentNeedle,
      "127.0.0.1"
    ],
    "runtime log"
  );
  await assertFilesExclude(userDataPath, [queryNeedle, userAgentNeedle]);

  smokeStage = "invalid_port_contract";
  const invalidPortNeedle: any = "private-invalid-port-4c81";
  const failureReadyFilePath: any = path.join(userDataPath, "failure-ready.json");
  const failureChild: any = spawn(launchCommand, [
    ...(requestedCommand ? [] : [startServerPath]),
    "--port",
    invalidPortNeedle,
    "--ready-file",
    failureReadyFilePath
  ], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32" && Boolean(requestedCommand)
  });
  const failureChunks: any[] = [];
  failureChild.stdout.on("data", (chunk?: any) : any => failureChunks.push(Buffer.from(chunk)));
  failureChild.stderr.on("data", (chunk?: any) : any => failureChunks.push(Buffer.from(chunk)));
  const failureExit: any = await waitForChildExit(failureChild);
  assert.equal(failureExit.timedOut, false);
  assert.equal(failureExit.code, 1);
  const failureText: any = Buffer.concat(failureChunks).toString("utf8");
  assert.equal(
    failureText.includes("Server failure: uncaught_exception; reasonCode=server_runtime_failed"),
    true,
    "sanitized startup failure status is missing"
  );
  assert.equal(/(?:^|\n)\s+at\s+/m.test(failureText), false, "startup failure exposed a stack frame");
  assert.equal(/https?:\/\//i.test(failureText), false, "startup failure exposed an endpoint URL");
  assertAbsent(
    failureText,
    [invalidPortNeedle, userDataPath, failureReadyFilePath, startServerPath],
    "startup failure output"
  );
  await assert.rejects(fs.access(failureReadyFilePath));

  smokeStage = "dynamic_port_contract";
  const noReadyChild: any = spawn(launchCommand, [
    ...(requestedCommand ? [] : [startServerPath]),
    "--port",
    "0"
  ], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32" && Boolean(requestedCommand)
  });
  const noReadyChunks: any[] = [];
  noReadyChild.stdout.on("data", (chunk?: any) : any => noReadyChunks.push(Buffer.from(chunk)));
  noReadyChild.stderr.on("data", (chunk?: any) : any => noReadyChunks.push(Buffer.from(chunk)));
  const noReadyExit: any = await waitForChildExit(noReadyChild);
  assert.equal(noReadyExit.timedOut, false);
  assert.equal(noReadyExit.code, 1);
  const noReadyText: any = Buffer.concat(noReadyChunks).toString("utf8");
  assert.equal(
    noReadyText.includes("reasonCode=ready_file_required_for_dynamic_port"),
    true,
    "dynamic port did not require private readiness IPC"
  );
  assert.equal(/(?:^|\n)\s+at\s+/m.test(noReadyText), false, "dynamic port failure exposed a stack frame");
  assertAbsent(noReadyText, [userDataPath, startServerPath], "dynamic port failure output");

  console.log("start-server default edition smoke passed");
} catch (error) {
  console.error(`[start-server-smoke] failed reasonCode=${smokeStage}`);
  throw error;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  await fs.rm(readyFilePath, { force: true });
  await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
