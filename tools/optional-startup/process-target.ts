import { spawn } from "node:child_process";

function processError(code: string) : any {
  const error: Error & Record<string, any> = new Error(code);
  error.code = code;
  return error;
}

export async function startOptionalTargetProcess(specification: Record<string, any>) : Promise<any> {
  const child: any = spawn(specification.command, specification.args || [], {
    cwd: specification.cwd,
    env: specification.env,
    shell: false,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const completion: any = new Promise((resolve?: any) : any => {
    child.once("error", () : any => resolve({ code: null, signal: null, launchError: true }));
    child.once("close", (code?: any, signal?: any) : any => resolve({ code, signal, launchError: false }));
  });
  const handle: any = Object.freeze({
    id: specification.id,
    kind: specification.kind,
    child,
    completion,
    stop(signal: NodeJS.Signals = "SIGTERM") : any {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    },
  });
  specification.registerHandle(handle);

  await new Promise((resolve?: any, reject?: any) : any => {
    child.once("spawn", resolve);
    child.once("error", () : any => reject(processError("optional_startup_process_launch_failed")));
  });

  return Object.freeze({
    id: specification.id,
    kind: specification.kind,
    status: "started",
  });
}
