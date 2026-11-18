import assert from "node:assert/strict";
import { spawn } from "node:child_process";

function runProcess(command?: any, args: any = [], options: Record<string, any> = {}) : any {
  return new Promise((resolve?: any) : any => {
    const env: Record<string, any> = { ...process.env, ...(options.env || {}) };
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
    let child: any;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error: any) {
      resolve({
        status: 1,
        stdout: "",
        stderr: error?.message || "process launch failed",
        errorCode: String(error?.code || "")
      });
      return;
    }
    let stdout: any = "";
    let stderr: any = "";
    let settled: any = false;
    const finish: any = (result?: any) : any => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on("data", (chunk?: any) : any => { stdout += chunk; });
    child.stderr.on("data", (chunk?: any) : any => { stderr += chunk; });
    child.on("error", (error?: any) : any => {
      finish({ status: 1, stdout, stderr: error.message });
    });
    child.on("close", (code?: any) : any => {
      finish({
        status: Number(code ?? 1),
        stdout,
        stderr
      });
    });
    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function parseJsonOutput(stdout: any = "", label: any = "stdout") : any {
  const text: any = String(stdout || "").trim();
  assert.ok(text, `${label} was empty`);
  const start: any = text.indexOf("{");
  assert.notEqual(start, -1, `${label} did not contain JSON`);
  return JSON.parse(text.slice(start));
}

export function createMcpClientInstallProcessRunner({ connectorScript, redactText, repoRoot }: Record<string, any>) : any {
  return {
    runProcess(command?: any, args: any = [], options: Record<string, any> = {}) : any {
      return runProcess(command, args, { cwd: repoRoot, ...options });
    },
    async runConnector(args: any = [], options: Record<string, any> = {}) : Promise<any> {
      const result: any = await runProcess(process.execPath, [connectorScript, ...args], {
        cwd: repoRoot,
        input: options.input || "",
        env: options.env || {}
      });
      if (result.status !== 0) {
        const verboseOutput: any = process.env.MESHRIX_VERIFY_VERBOSE
          ? ` stdout=${redactText(result.stdout)} stderr=${redactText(result.stderr)}`
          : "";
        const error: Error & Record<string, any> = new Error(`connector failed status=${result.status} stdoutBytes=${result.stdout.length} stderrBytes=${result.stderr.length}${verboseOutput}`);
        error.status = result.status;
        error.stdout = result.stdout;
        error.stderr = result.stderr;
        throw error;
      }
      return parseJsonOutput(result.stdout, `meshrix-mcp ${args[0] || ""}`);
    }
  };
}
