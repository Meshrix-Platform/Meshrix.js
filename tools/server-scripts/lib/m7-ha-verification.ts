import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath: any = fileURLToPath(import.meta.url);
export const REPO_ROOT: any = path.resolve(path.dirname(modulePath), "../../..");

export function spawnFreshChild(childEntry?: any, timeoutMs: any = 120_000) : any {
  const runRoot: any = path.join(os.tmpdir(), `meshrix-m7-ha-${process.pid}-${Date.now()}`);
  const privateReportPath: any = path.join(runRoot, "child-report.json");
  return new Promise((resolve?: any, reject?: any) : any => {
    const child: any = spawn(process.execPath, [path.join(REPO_ROOT, childEntry), privateReportPath], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NO_COLOR: "1",
        MESHRIX_HA_PROFILE: "ha",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout: any = "";
    let stderr: any = "";
    child.stdout.on("data", (chunk?: any) : any => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk?: any) : any => {
      stderr += chunk;
    });
    const timer: any = setTimeout(() : any => {
      child.kill("SIGKILL");
      reject(new Error(`Fresh child verification timed out for ${childEntry}`));
    }, timeoutMs);
    child.on("error", (error?: any) : any => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", async (code?: any) : Promise<any> => {
      clearTimeout(timer);
      let childReport: any = null;
      try {
        childReport = JSON.parse(await fs.readFile(privateReportPath, "utf8"));
      } catch {
        childReport = null;
      }
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() : any => undefined);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        childPid: child.pid,
        childReport,
      });
    });
  });
}
