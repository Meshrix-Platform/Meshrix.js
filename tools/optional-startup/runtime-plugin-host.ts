import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startOptionalTargetProcess } from "./process-target.ts";

function hostError(code: string) : any {
  const error: Error & Record<string, any> = new Error(code);
  error.code = code;
  return error;
}

const wait = () : any => new Promise((resolve?: any) : any => setTimeout(resolve, 50));

async function waitForReadyFile(filePath: string, completion: Promise<any>) : Promise<any> {
  let completed: any = null;
  void completion.then((result?: any) : any => { completed = result; });
  while (true) {
    try {
      await fs.access(filePath);
      return;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw hostError("optional_startup_plugin_host_readiness_failed");
    }
    if (completed) throw hostError("optional_startup_plugin_host_exited_before_ready");
    await wait();
  }
}

export async function startOptionalRuntimePluginHost(options: Record<string, any>) : Promise<any> {
  const privateDirectory: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-optional-startup-"));
  const readyFile: any = path.join(privateDirectory, "ready.json");
  let handle: any = null;
  try {
    const result: any = await startOptionalTargetProcess({
      id: "plugin-host",
      kind: "plugin-host",
      command: process.execPath,
      args: [
        options.resolveRepoPath("tools/server-scripts/start-server.ts"),
        "--profile",
        "core",
        "--runtime-config",
        options.runtimeConfigPath,
        "--strict-port",
        "--ready-file",
        readyFile,
      ],
      cwd: options.repoRoot,
      env: process.env,
      registerHandle(candidate?: any) : any {
        handle = candidate;
        options.registerHandle(candidate);
      },
    });
    await waitForReadyFile(readyFile, handle.completion);
    void handle.completion.then(() : any => (
      fs.rm(privateDirectory, { recursive: true, force: true }).catch(() : any => {})
    ));
    return result;
  } catch (error: any) {
    handle?.stop();
    await fs.rm(privateDirectory, { recursive: true, force: true });
    throw error;
  }
}
