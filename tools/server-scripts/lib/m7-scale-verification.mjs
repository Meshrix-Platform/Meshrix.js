import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(modulePath), "../../..");

export function spawnFreshChild(childEntry, timeoutMs = 120_000) {
  const runRoot = path.join(os.tmpdir(), `meshrix-m7-scale-${process.pid}-${Date.now()}`);
  const privateReportPath = path.join(runRoot, "child-report.json");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, childEntry), privateReportPath], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NO_COLOR: "1",
        MESHRIX_SCALE_PROFILE: "scale",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Fresh child verification timed out for ${childEntry}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      let childReport = null;
      try {
        childReport = JSON.parse(await fs.readFile(privateReportPath, "utf8"));
      } catch {
        childReport = null;
      }
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
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
