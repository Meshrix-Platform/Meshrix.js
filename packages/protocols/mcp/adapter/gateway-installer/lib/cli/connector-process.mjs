import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BOOTSTRAP_INSTALL_SCRIPT,
  INSTALL_COMMAND_TIMEOUT_MS,
  PACKAGE_MANAGER_DISCOVERY_ENV
} from "./constants.mjs";

export function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function connectorLaunchSpec() {
  const configured = String(process.env.LICO_MCP_CONNECTOR_COMMAND || "").trim();
  if (configured) {
    const resolved = path.resolve(configured);
    if (path.isAbsolute(configured) && existsSync(resolved)) {
      return { command: resolved, args: [] };
    }
    throw new Error("invalid_connector_command_path");
  }
  const entrypoint = path.resolve(String(process.argv[1] || ""));
  if (!existsSync(entrypoint)) {
    throw new Error("connector_entrypoint_unavailable");
  }
  return {
    command: process.execPath,
    args: [entrypoint]
  };
}

export function githubOneLineMcpInstallCommand(scriptName = BOOTSTRAP_INSTALL_SCRIPT) {
  if (!/^[A-Za-z0-9._-]+$/u.test(String(scriptName || ""))) {
    throw new Error("invalid_local_installer_name");
  }
  return `/bin/sh -c 'exec /bin/sh ./${scriptName} "$@"'`;
}

export function assertSafeEnvName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ""))) {
    throw new Error(`Invalid environment variable name: ${name}`);
  }
  return String(name);
}

export function expandHomePath(value) {
  const text = String(value || "").trim();
  if (text === "~") {
    return os.homedir();
  }
  if (text.startsWith("~/")) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

function childProcessEnv(extraEnv = {}, { clean = false } = {}) {
  const inherited = clean
    ? Object.fromEntries([
        "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
        "XDG_CONFIG_HOME", "XDG_DATA_HOME", "TMPDIR", "TMP", "TEMP",
        "SystemRoot", "ComSpec", "PATHEXT", "LANG", "LC_ALL"
      ].flatMap((name) => typeof process.env[name] === "string" ? [[name, process.env[name]]] : []))
    : process.env;
  return {
    ...inherited,
    ...PACKAGE_MANAGER_DISCOVERY_ENV,
    ...(extraEnv || {})
  };
}

export async function run(command, args = [], options = {}) {
  return runWithInput(command, args, "", options);
}

export async function runInstallCommand(command, args = [], options = {}) {
  return run(command, args, {
    ...options,
    timeoutMs: options.timeoutMs || INSTALL_COMMAND_TIMEOUT_MS
  });
}

export async function runWithInput(command, args = [], input = "", options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Number(options.timeoutMs || 0);
    const useProcessGroup = timeoutMs > 0 && process.platform !== "win32";
    const resolved = resolveLocalCommand(command, args);
    let child;
    try {
      child = spawn(resolved.command, resolved.args, {
        cwd: options.cwd || process.cwd(),
        env: childProcessEnv(options.env, { clean: options.cleanEnv === true }),
        stdio: ["pipe", "pipe", "pipe"],
        windowsVerbatimArguments: resolved.windowsVerbatimArguments || false,
        detached: useProcessGroup
      });
    } catch (error) {
      if (options.allowFailure) {
        resolve({ ok: false, stdout: "", stderr: error?.message || "" });
        return;
      }
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forceKillTimer = null;
    const timeoutMessage = () => `command timed out after ${timeoutMs} ms`;
    const terminate = (signal) => {
      try {
        if (useProcessGroup && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {
          // The process may have exited between timeout firing and signal delivery.
        }
      }
    };
    const destroyStdio = () => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          const signal = options.killSignal || "SIGKILL";
          terminate(signal);
          forceKillTimer = setTimeout(() => {
            terminate("SIGKILL");
            destroyStdio();
            settle(() => {
              if (options.allowFailure) {
                resolve({
                  ok: false,
                  stdout,
                  stderr: stderr ? `${stderr}\n${timeoutMessage()}` : timeoutMessage(),
                  timedOut: true
                });
                return;
              }
              const error = new Error(timeoutMessage());
              error.timedOut = true;
              error.stdout = stdout;
              error.stderr = stderr;
              reject(error);
            });
          }, options.killAfterMs || 2500);
        }, timeoutMs)
      : null;
    const settle = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      callback();
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      settle(() => {
        if (options.allowFailure) {
          resolve({ ok: false, stdout, stderr: stderr || error.message || "" });
          return;
        }
        reject(error);
      });
    });
    child.on("close", (code) => {
      settle(() => {
        if (timedOut) {
          if (options.allowFailure) {
            resolve({
              ok: false,
              stdout,
              stderr: stderr ? `${stderr}\n${timeoutMessage()}` : timeoutMessage(),
              timedOut: true
            });
            return;
          }
          const error = new Error(timeoutMessage());
          error.timedOut = true;
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        if (code === 0) {
          resolve({ ok: true, stdout, stderr });
          return;
        }
        if (options.allowFailure) {
          resolve({ ok: false, stdout, stderr });
          return;
        }
        reject(new Error(`${command} exited with ${code}: ${stderr || stdout}`));
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function resolveLocalCommand(command, args = []) {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(String(command))) {
    const normalizedArgs = normalizeWindowsCmdArguments(args);
    const commandLine = [quoteCmd(command), ...normalizedArgs.map(quoteCmd)].join(" ");
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      windowsVerbatimArguments: true
    };
  }
  return { command, args };
}

function normalizeWindowsCmdArguments(args = []) {
  return args.map((arg, index) => {
    const shellName = String(args[index - 2] || "");
    const shellFlag = String(args[index - 1] || "");
    const value = String(arg);
    if ((shellName === "bash" || shellName === "sh") && shellFlag === "-lc" && /[\r\n]/.test(value)) {
      return encodedShellScript(value, shellName);
    }
    return arg;
  });
}

function encodedShellScript(script, shellName) {
  const encoded = Buffer.from(String(script), "utf8").toString("base64");
  return `echo ${shellQuote(encoded)} | base64 -d | ${shellName}`;
}

function quoteCmd(value) {
  return `"${String(value).replace(/"/g, '""').replace(/%/g, "%%")}"`;
}

export async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
