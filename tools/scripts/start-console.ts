import { spawn } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

function forwardSignals(childProcess?: any) : any {
  const relay: any = (signal?: any) : any => {
    if (childProcess.killed) {
      return;
    }

    childProcess.kill(signal);
  };

  process.on("SIGINT", () : any => relay("SIGINT"));
  process.on("SIGTERM", () : any => relay("SIGTERM"));
}

function runCommand(command?: any, args?: any, options: Record<string, any> = {}) : any {
  return new Promise((resolve?: any, reject?: any) : any => {
    const childProcess: any = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      stdio: "inherit",
      env: options.env || process.env
    });

    childProcess.on("error", (error?: any) : any => {
      reject(error);
    });

    childProcess.on("exit", (code?: any, signal?: any) : any => {
      if (signal) {
        reject(new Error(`${command} ${args.join(" ")} 被信号 ${signal} 终止`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} 退出码为 ${code}`));
        return;
      }

      resolve();
    });
  });
}

export function buildServerStartupArgs(passthroughArgs: any = []) : any {
  return ["apps/server/bin/meshrix.ts", ...passthroughArgs, "--with-ui"];
}

export async function startConsole({ argv = process.argv.slice(2), cwd = process.cwd(), env = process.env }: Record<string, any> = {}) : Promise<any> {
  console.log("Building Meshrix.js server console...");
  await runCommand("npm", ["run", "build"], { cwd, env });

  const finalArgs: any = buildServerStartupArgs(argv);

  console.log("Starting Meshrix.js server with console...");
  const serverProcess: any = spawn("node", finalArgs, {
    cwd,
    stdio: "inherit",
    env
  });

  forwardSignals(serverProcess);

  return await new Promise((resolve?: any, reject?: any) : any => {
    serverProcess.on("error", (error?: any) : any => {
      reject(error);
    });

    serverProcess.on("exit", (code?: any, signal?: any) : any => {
      if (signal) {
        reject(new Error(`node ${finalArgs.join(" ")} 被信号 ${signal} 终止`));
        return;
      }

      resolve(code || 0);
    });
  });
}

function isMainModule() : any {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const exitCode: any = await startConsole();
  process.exit(exitCode);
}
