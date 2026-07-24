#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const nativeInstallPath = fileURLToPath(new URL("../../packages/protocols/mcp/adapter/native-installer/meshrix-mcp-install.sh", import.meta.url));
const nativeWindowsInstallPath = fileURLToPath(new URL("../../packages/protocols/mcp/adapter/native-installer/meshrix-mcp-install.ps1", import.meta.url));
const requestedArgs = process.argv.slice(2);
const forwardedArgs = requestedArgs[0] === "install" ? requestedArgs.slice(1) : requestedArgs;
const command = process.platform === "win32" ? "powershell" : "sh";
const commandArgs = process.platform === "win32"
  ? ["-ExecutionPolicy", "Bypass", "-File", nativeWindowsInstallPath, ...forwardedArgs]
  : [nativeInstallPath, ...forwardedArgs];

const child = spawn(command, commandArgs, {
  stdio: "inherit",
  env: process.env
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});

child.on("error", (error) => {
  console.error(JSON.stringify({
    ok: false,
    commandFailed: true,
    error: error?.code || error?.name || "spawn_failed"
  }));
  process.exitCode = 1;
});
