#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const nativeInstallPath: any = fileURLToPath(new URL("../../packages/protocols/mcp/adapter/native-installer/meshrix-mcp-install.sh", import.meta.url));
const nativeWindowsInstallPath: any = fileURLToPath(new URL("../../packages/protocols/mcp/adapter/native-installer/meshrix-mcp-install.ps1", import.meta.url));
const requestedArgs: any = process.argv.slice(2);
const forwardedArgs: any = requestedArgs[0] === "install" ? requestedArgs.slice(1) : requestedArgs;
const command: any = process.platform === "win32" ? "powershell" : "sh";
const commandArgs: any = process.platform === "win32"
  ? ["-ExecutionPolicy", "Bypass", "-File", nativeWindowsInstallPath, ...forwardedArgs]
  : [nativeInstallPath, ...forwardedArgs];

const child: any = spawn(command, commandArgs, {
  stdio: "inherit",
  env: process.env
});

child.on("exit", (code?: any, signal?: any) : any => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});

child.on("error", (error?: any) : any => {
  console.error(JSON.stringify({
    ok: false,
    commandFailed: true,
    error: error?.code || error?.name || "spawn_failed"
  }));
  process.exitCode = 1;
});
