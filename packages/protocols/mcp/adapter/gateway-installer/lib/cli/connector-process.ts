import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BOOTSTRAP_INSTALL_SCRIPT,
  PACKAGE_MANAGER_DISCOVERY_ENV
} from "./constants.ts";

export function uniqueValues(values?: any) : any {
  return [...new Set<any>(values.filter(Boolean))];
}

export function shellQuote(value?: any) : any {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function connectorLaunchSpec() : any {
  const configured: any = String(process.env.MESHRIX_MCP_CONNECTOR_COMMAND || "").trim();
  if (configured) {
    const resolved: any = path.resolve(configured);
    if (path.isAbsolute(configured) && existsSync(resolved)) {
      return { command: resolved, args: [] };
    }
    throw new Error("invalid_connector_command_path");
  }
  const entrypoint: any = path.resolve(String(process.argv[1] || ""));
  if (!existsSync(entrypoint)) {
    throw new Error("connector_entrypoint_unavailable");
  }
  return {
    command: process.execPath,
    args: [entrypoint]
  };
}

export function githubOneLineMcpInstallCommand(scriptName: any = BOOTSTRAP_INSTALL_SCRIPT) : any {
  if (!/^[A-Za-z0-9._-]+$/u.test(String(scriptName || ""))) {
    throw new Error("invalid_local_installer_name");
  }
  return `/bin/sh -c 'exec /bin/sh ./${scriptName} "$@"'`;
}

export function assertSafeEnvName(name?: any) : any {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ""))) {
    throw new Error(`Invalid environment variable name: ${name}`);
  }
  return String(name);
}

export function expandHomePath(value?: any) : any {
  const text: any = String(value || "").trim();
  if (text === "~") {
    return os.homedir();
  }
  if (text.startsWith("~/")) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

function childProcessEnv(extraEnv: Record<string, any> = {}, { clean = false }: Record<string, any> = {}) : any {
  const inherited: any = clean
    ? Object.fromEntries([
        "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
        "XDG_CONFIG_HOME", "XDG_DATA_HOME", "TMPDIR", "TMP", "TEMP",
        "SystemRoot", "ComSpec", "PATHEXT", "LANG", "LC_ALL"
      ].flatMap((name?: any) : any => typeof process.env[name] === "string" ? [[name, process.env[name]]] : []))
    : process.env;
  const env: Record<string, any> = {
    ...inherited,
    ...PACKAGE_MANAGER_DISCOVERY_ENV,
    ...(extraEnv || {})
  };
  // npm can expose a user-level `allowScripts` policy to child processes as a
  // project-scoped CLI setting. npm 11 rejects that synthesized setting before
  // an otherwise script-disabled adapter install can start, so rely on the
  // explicit `--ignore-scripts` argument and do not forward the incompatible
  // ambient setting.
  delete env.npm_config_allow_scripts;
  return env;
}

export async function run(command?: any, args: any = [], options: Record<string, any> = {}) : Promise<any> {
  return runWithInput(command, args, "", options);
}

export async function runInstallCommand(command?: any, args: any = [], options: Record<string, any> = {}) : Promise<any> {
  return run(command, args, options);
}

export async function runWithInput(command?: any, args: any = [], input: any = "", options: Record<string, any> = {}) : Promise<any> {
  return new Promise((resolve?: any, reject?: any) : any => {
    const timeoutMs: any = Number(options.timeoutMs || 0);
    const useProcessGroup: any = timeoutMs > 0 && process.platform !== "win32";
    const resolved: any = resolveLocalCommand(command, args);
    let child: any;
    try {
      child = spawn(resolved.command, resolved.args, {
        cwd: options.cwd || process.cwd(),
        env: childProcessEnv(options.env, { clean: options.cleanEnv === true }),
        stdio: ["pipe", "pipe", "pipe"],
        windowsVerbatimArguments: resolved.windowsVerbatimArguments || false,
        detached: useProcessGroup
      });
    } catch (error: any) {
      if (options.allowFailure) {
        resolve({ ok: false, stdout: "", stderr: error?.message || "" });
        return;
      }
      reject(error);
      return;
    }
    let stdout: any = "";
    let stderr: any = "";
    let timedOut: any = false;
    let settled: any = false;
    let forceKillTimer: any = null;
    const timeoutMessage: any = () : any => `command timed out after ${timeoutMs} ms`;
    const terminate: any = (signal?: any) : any => {
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
    const destroyStdio: any = () : any => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer: any = timeoutMs > 0
      ? setTimeout(() : any => {
          timedOut = true;
          const signal: any = options.killSignal || "SIGKILL";
          terminate(signal);
          forceKillTimer = setTimeout(() : any => {
            terminate("SIGKILL");
            destroyStdio();
            settle(() : any => {
              if (options.allowFailure) {
                resolve({
                  ok: false,
                  stdout,
                  stderr: stderr ? `${stderr}\n${timeoutMessage()}` : timeoutMessage(),
                  timedOut: true
                });
                return;
              }
              const error: Error & Record<string, any> = new Error(timeoutMessage());
              error.timedOut = true;
              error.stdout = stdout;
              error.stderr = stderr;
              reject(error);
            });
          }, options.killAfterMs || 2500);
        }, timeoutMs)
      : null;
    const settle: any = (callback?: any) : any => {
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
    child.stdout.on("data", (chunk?: any) : any => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk?: any) : any => {
      stderr += chunk.toString();
    });
    child.on("error", (error?: any) : any => {
      settle(() : any => {
        if (options.allowFailure) {
          resolve({ ok: false, stdout, stderr: stderr || error.message || "" });
          return;
        }
        reject(error);
      });
    });
    child.on("close", (code?: any) : any => {
      settle(() : any => {
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
          const error: Error & Record<string, any> = new Error(timeoutMessage());
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
    child.stdin.on("error", () : any => {});
    child.stdin.end(input);
  });
}

function resolveLocalCommand(command?: any, args: any = []) : any {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(String(command))) {
    const normalizedArgs: any = normalizeWindowsCmdArguments(args);
    const commandLine: any = [quoteCmd(command), ...normalizedArgs.map(quoteCmd)].join(" ");
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      windowsVerbatimArguments: true
    };
  }
  return { command, args };
}

function normalizeWindowsCmdArguments(args: any = []) : any {
  return args.map((arg?: any, index?: any) : any => {
    const shellName: any = String(args[index - 2] || "");
    const shellFlag: any = String(args[index - 1] || "");
    const value: any = String(arg);
    if ((shellName === "bash" || shellName === "sh") && shellFlag === "-lc" && /[\r\n]/.test(value)) {
      return encodedShellScript(value, shellName);
    }
    return arg;
  });
}

function encodedShellScript(script?: any, shellName?: any) : any {
  const encoded: any = Buffer.from(String(script), "utf8").toString("base64");
  return `echo ${shellQuote(encoded)} | base64 -d | ${shellName}`;
}

function quoteCmd(value?: any) : any {
  return `"${String(value).replace(/"/g, '""').replace(/%/g, "%%")}"`;
}

export async function readStdin() : Promise<any> {
  return new Promise((resolve?: any, reject?: any) : any => {
    let data: any = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk?: any) : any => {
      data += chunk;
    });
    process.stdin.on("end", () : any => resolve(data));
    process.stdin.on("error", reject);
  });
}
