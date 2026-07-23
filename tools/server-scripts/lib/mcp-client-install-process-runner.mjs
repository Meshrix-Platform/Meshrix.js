import assert from "node:assert/strict";
import { spawn } from "node:child_process";

function terminateChildProcess(child, signal = "SIGTERM") {
  if (!child?.pid) {
    return;
  }
  try {
    if (process.platform === "win32") {
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may have exited between the timeout and signal delivery.
    }
  }
}

function runProcess(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...(options.env || {}) };
    for (const name of options.envUnset || []) {
      delete env[name];
    }
    for (const prefix of options.envUnsetPrefixes || []) {
      for (const name of Object.keys(env)) {
        if (name.startsWith(prefix)) {
          delete env[name];
        }
      }
    }
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({
        status: 1,
        stdout: "",
        stderr: error?.message || "process launch failed",
        timedOut: false,
        errorCode: String(error?.code || "")
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forceKillTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      resolve(result);
    };
    const finishTimeout = () => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ status: 124, stdout, stderr, timedOut: true });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildProcess(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        terminateChildProcess(child, "SIGKILL");
        finishTimeout();
      }, options.killAfterMs || 2500);
    }, options.timeoutMs || 30000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      finish({ status: 1, stdout, stderr: error.message, timedOut: false });
    });
    child.on("close", (code) => {
      finish({
        status: timedOut ? 124 : Number(code ?? 1),
        stdout,
        stderr,
        timedOut
      });
    });
    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function parseJsonOutput(stdout = "", label = "stdout") {
  const text = String(stdout || "").trim();
  assert.ok(text, `${label} was empty`);
  const start = text.indexOf("{");
  assert.notEqual(start, -1, `${label} did not contain JSON`);
  return JSON.parse(text.slice(start));
}

export function createMcpClientInstallProcessRunner({ connectorScript, redactText, repoRoot }) {
  return {
    runProcess(command, args = [], options = {}) {
      return runProcess(command, args, { cwd: repoRoot, ...options });
    },
    async runConnector(args = [], options = {}) {
      const result = await runProcess(process.execPath, [connectorScript, ...args], {
        cwd: repoRoot,
        input: options.input || "",
        env: options.env || {},
        timeoutMs: options.timeoutMs || 60000
      });
      if (result.status !== 0) {
        const verboseOutput = process.env.LICO_VERIFY_VERBOSE
          ? ` stdout=${redactText(result.stdout)} stderr=${redactText(result.stderr)}`
          : "";
        const error = new Error(`connector failed status=${result.status} stdoutBytes=${result.stdout.length} stderrBytes=${result.stderr.length} timedOut=${result.timedOut}${verboseOutput}`);
        error.status = result.status;
        error.stdout = result.stdout;
        error.stderr = result.stderr;
        error.timedOut = result.timedOut;
        throw error;
      }
      return parseJsonOutput(result.stdout, `lico-mcp ${args[0] || ""}`);
    }
  };
}
