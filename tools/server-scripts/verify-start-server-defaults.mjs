#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const entrypointIndex = process.argv.indexOf("--entrypoint");
const requestedEntrypoint = entrypointIndex >= 0 ? process.argv[entrypointIndex + 1] : "";
const commandIndex = process.argv.indexOf("--command");
const requestedCommand = commandIndex >= 0 ? process.argv[commandIndex + 1] : "";
assert.equal(
  Boolean(requestedEntrypoint) && Boolean(requestedCommand),
  false,
  "entrypoint and command are mutually exclusive"
);
const startServerPath = requestedEntrypoint
  ? path.resolve(requestedEntrypoint)
  : path.join(repoRoot, "tools", "server-scripts", "start-server.mjs");
const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-start-server-defaults-"));
const readyFilePath = path.join(userDataPath, "private-ready.json");
const queryNeedle = "private-query-value-73f1";
const userAgentNeedle = "private-user-agent-91c4";
const argvNeedle = "private-server-label-5a27";
const discoveryNeedle = "http://private-discovery.invalid:4312";

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    payload: text.trim() ? JSON.parse(text) : {}
  };
}

function waitForChildExit(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ timedOut: true, code: null, signal: "SIGKILL" });
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ timedOut: false, code, signal });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(child, filePath, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("start-server exited before ready; reasonCode=startup_exited");
    }
    try {
      const payload = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (payload?.status === "ready" && Number(payload?.port) > 0) {
        return payload;
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw new Error("private ready state could not be read; reasonCode=ready_state_invalid");
      }
    }
    await delay(25);
  }
  throw new Error("start-server did not become ready; reasonCode=startup_timeout");
}

async function readRuntimeLogText(logDir) {
  const entries = await fs.readdir(logDir, { withFileTypes: true }).catch(() => []);
  const chunks = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      chunks.push(await fs.readFile(path.join(logDir, entry.name), "utf8"));
    }
  }
  return chunks.join("\n");
}

function assertAbsent(text, values, label) {
  for (let index = 0; index < values.length; index += 1) {
    assert.equal(text.includes(values[index]), false, `${label} exposed forbidden value ${index + 1}`);
  }
}

async function assertFilesExclude(rootPath, values) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await assertFilesExclude(entryPath, values);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const bytes = await fs.readFile(entryPath);
    for (let index = 0; index < values.length; index += 1) {
      assert.equal(
        bytes.includes(Buffer.from(values[index])),
        false,
        `runtime file exposed forbidden value ${index + 1}`
      );
    }
  }
}

const env = { ...process.env };
delete env.MESHRIX_EDITION;
delete env.MESHRIX_FEATURE_PROFILE;

const outputChunks = [];
const output = {
  push(chunk) {
    outputChunks.push(Buffer.from(chunk));
  },
  text() {
    return Buffer.concat(outputChunks).toString("utf8");
  }
};

let child = null;

try {
  const launchCommand = requestedCommand ? path.resolve(requestedCommand) : process.execPath;
  const launchArguments = [
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

  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));

  const ready = await waitForReady(child, readyFilePath);
  const readyStat = await fs.stat(readyFilePath);
  if (process.platform !== "win32") {
    assert.equal(readyStat.mode & 0o777, 0o600);
  }
  const text = output.text();
  assert.equal(text.includes("Server status: started"), true, "startup status is missing");
  assert.equal(text.includes("UI mode: api-only"), true, "UI mode is missing");
  assert.equal(text.includes("Runtime profile: default"), true, "runtime profile is missing");
  assert.equal(text.includes("Discovery mode: unconfigured"), true, "discovery mode is missing");
  assert.doesNotMatch(text, /Unknown edition: undefined/);
  assert.equal(/https?:\/\//i.test(text), false, "startup output exposed an endpoint URL");
  assert.equal(/(?:^|\n)\s+at\s+/m.test(text), false, "startup output exposed a stack frame");
  assertAbsent(text, [userDataPath, readyFilePath, startServerPath, argvNeedle, discoveryNeedle], "startup output");

  const serverUrl = `http://${ready.host}:${ready.port}`;

  const health = await requestJson(`${serverUrl}/api/healthz?private=${queryNeedle}`, {
    headers: { "User-Agent": userAgentNeedle }
  });
  assert.equal(health.status, 200);
  assert.ok(health.headers.get("x-meshrix-trace-id"));

  const bootstrap = await requestJson(`${serverUrl}/api/bootstrap`);
  assert.equal(bootstrap.status, 200);

  const rpcHealth = await requestJson(`${serverUrl}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "startup-health",
      method: "system.health",
      params: {}
    })
  });
  assert.equal(rpcHealth.status, 200);
  assert.equal(rpcHealth.payload.jsonrpc, "2.0");

  child.kill("SIGTERM");
  const exit = await waitForChildExit(child);
  assert.equal(exit.timedOut, false);

  const finalText = output.text();
  assert.equal(finalText.includes("Server shutdown: started"), true, "shutdown start status is missing");
  assert.equal(finalText.includes("Server shutdown: complete"), true, "shutdown completion status is missing");
  assert.equal(/https?:\/\//i.test(finalText), false, "server output exposed an endpoint URL");
  assert.equal(/(?:^|\n)\s+at\s+/m.test(finalText), false, "server output exposed a stack frame");
  assertAbsent(
    finalText,
    [userDataPath, readyFilePath, startServerPath, argvNeedle, discoveryNeedle, queryNeedle, userAgentNeedle],
    "server output"
  );

  await assert.rejects(fs.access(readyFilePath));
  const runtimeLogText = await readRuntimeLogText(path.join(userDataPath, "logs", "runtime"));
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

  const invalidPortNeedle = "private-invalid-port-4c81";
  const failureReadyFilePath = path.join(userDataPath, "failure-ready.json");
  const failureChild = spawn(launchCommand, [
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
  const failureChunks = [];
  failureChild.stdout.on("data", (chunk) => failureChunks.push(Buffer.from(chunk)));
  failureChild.stderr.on("data", (chunk) => failureChunks.push(Buffer.from(chunk)));
  const failureExit = await waitForChildExit(failureChild);
  assert.equal(failureExit.timedOut, false);
  assert.equal(failureExit.code, 1);
  const failureText = Buffer.concat(failureChunks).toString("utf8");
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

  const noReadyChild = spawn(launchCommand, [
    ...(requestedCommand ? [] : [startServerPath]),
    "--port",
    "0"
  ], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32" && Boolean(requestedCommand)
  });
  const noReadyChunks = [];
  noReadyChild.stdout.on("data", (chunk) => noReadyChunks.push(Buffer.from(chunk)));
  noReadyChild.stderr.on("data", (chunk) => noReadyChunks.push(Buffer.from(chunk)));
  const noReadyExit = await waitForChildExit(noReadyChild);
  assert.equal(noReadyExit.timedOut, false);
  assert.equal(noReadyExit.code, 1);
  const noReadyText = Buffer.concat(noReadyChunks).toString("utf8");
  assert.equal(
    noReadyText.includes("reasonCode=ready_file_required_for_dynamic_port"),
    true,
    "dynamic port did not require private readiness IPC"
  );
  assert.equal(/(?:^|\n)\s+at\s+/m.test(noReadyText), false, "dynamic port failure exposed a stack frame");
  assertAbsent(noReadyText, [userDataPath, startServerPath], "dynamic port failure output");

  console.log("start-server default edition smoke passed");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  await fs.rm(readyFilePath, { force: true });
  await fs.rm(userDataPath, { recursive: true, force: true });
}
