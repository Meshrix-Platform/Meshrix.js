#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeVerificationArtifacts } from "../server-scripts/localize-verify-failure.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Job identifiers select the real workflows; engineering commands live only there
// and in the existing test registry. Never copy their command sequences here.
export const LOCAL_CI_JOBS = {
  branch: { workflow: "branch-flow.yml", job: "branch-flow", event: "pull_request" },
  regression: { workflow: "ci.yml", job: "pull-request-verify", event: "pull_request" },
  node22: { workflow: "ci.yml", job: "node-22-compatibility", event: "workflow_dispatch" },
  gateway: { workflow: "gateway-preview.yml", job: "focused-candidate", event: "pull_request" },
  distribution: { workflow: "gateway-preview.yml", job: "product-distribution", event: "pull_request" },
  portability: { workflow: "ci.yml", job: "npm-package-portability", event: "workflow_dispatch" },
  sandbox: { workflow: "nightly-controlled-sandbox.yml", job: "controlled-sandbox", event: "workflow_dispatch" },
} as const;
type JobName = keyof typeof LOCAL_CI_JOBS;
type JobResult = { job: JobName; status: "incomplete" | "passed" | "failed"; exitCode: number | null; reason?: string };

export function parseLocalCiArguments(argv: string[]): { jobs: JobName[]; list: boolean; baseRef: string } {
  const jobs: JobName[] = [];
  let list = false;
  let baseRef = "nightly";
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--list") list = true;
    else if (argument === "--base") {
      baseRef = argv[++index];
      if (!["nightly", "stable", "release"].includes(baseRef)) throw new Error("local_ci_invalid_base");
    }
    else if (Object.hasOwn(LOCAL_CI_JOBS, argument)) jobs.push(argument as JobName);
    else throw new Error("local_ci_unknown_job");
  }
  return { jobs: jobs.length ? [...new Set(jobs)] : Object.keys(LOCAL_CI_JOBS) as JobName[], list, baseRef };
}

function readCommand(command: string, args: string[], cwd = repoRoot): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) throw new Error(`local_ci_${command}_failed`);
  return result.stdout.trim();
}

export function decodeActLog(raw: string): string {
  return raw.split(/\r?\n/u).map((line) => {
    try {
      const record: unknown = JSON.parse(line);
      if (typeof record === "object" && record !== null && "msg" in record && typeof record.msg === "string") {
        return record.msg;
      }
    } catch { /* act startup diagnostics may precede JSON logging. */ }
    return line;
  }).join("\n");
}

export function hasSuccessfulActJob(raw: string, jobId: string): boolean {
  let result: unknown;
  for (const line of raw.split(/\r?\n/u)) {
    try {
      const record = JSON.parse(line);
      if (record?.jobID === jobId && typeof record.jobResult === "string") {
        result = record.dryrun === true ? "dryrun" : record.jobResult;
      }
    } catch { /* Non-JSON startup output cannot establish job completion. */ }
  }
  return result === "success";
}

async function runAct(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string): Promise<number> {
  const file = await fs.open(log, "w", 0o600);
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(binary, args, { cwd, env, stdio: ["ignore", file.fd, file.fd] });
      let interrupted = false;
      const interrupt = () => { interrupted = true; child.kill("SIGINT"); };
      process.once("SIGINT", interrupt);
      child.once("error", (error) => { process.off("SIGINT", interrupt); reject(error); });
      child.once("close", (code) => { process.off("SIGINT", interrupt); resolve(interrupted ? 130 : code ?? 1); });
    });
  } finally {
    await file.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const options = parseLocalCiArguments(argv);
  if (options.list) {
    for (const name of options.jobs) console.log(`${name}: .github/workflows/${LOCAL_CI_JOBS[name].workflow} / ${LOCAL_CI_JOBS[name].job}`);
    return;
  }
  const binary = process.env.MESHRIX_CI_ACT_BINARY || "act";
  const actVersion = readCommand(binary, ["--version"]);
  const candidate = readCommand("git", ["rev-parse", "HEAD"]);
  const headRef = readCommand("git", ["symbolic-ref", "--short", "HEAD"]);
  const origin = readCommand("git", ["remote", "get-url", "origin"]);
  const headRepository = origin.match(/(?:github\.com[:/])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u)?.[1];
  if (!headRepository) throw new Error("local_ci_requires_github_origin");
  if (readCommand("git", ["diff", "HEAD", "--name-only"])) throw new Error("local_ci_commit_changes_before_snapshot");
  const dockerHost = process.env.DOCKER_HOST || readCommand("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  if (!dockerHost.startsWith("unix://")) throw new Error("local_ci_requires_local_docker_socket");
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-local-ci-"));
  await fs.chmod(scratch, 0o700);
  const home = path.join(scratch, "home");
  const temporary = path.join(scratch, "tmp");
  const checkout = path.join(scratch, "source");
  const diagnostics = path.join(repoRoot, "build/local-ci", new Date().toISOString().replaceAll(":", "-"));
  await Promise.all([home, temporary, diagnostics].map((directory) => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
  const userConfig = path.join(home, "user.npmrc");
  const globalConfig = path.join(home, "global.npmrc");
  await Promise.all([userConfig, globalConfig].map((file) => fs.writeFile(file, "", { mode: 0o600 })));
  const results: JobResult[] = [];
  try {
    readCommand("git", ["clone", "--quiet", "--no-hardlinks", "--no-checkout", repoRoot, checkout]);
    readCommand("git", ["checkout", "--quiet", "--detach", candidate], checkout);
    // The snapshot contains tracked source only, including real Git identity;
    // no local build, ignored cache, untracked private evidence, or npmrc is copied.
    readCommand("git", ["remote", "set-url", "origin", `https://github.com/${headRepository}.git`], checkout);
    const event = path.join(scratch, "event.json");
    await fs.writeFile(event, JSON.stringify({
      act: true,
      pull_request: { head: { ref: headRef, sha: candidate, repo: { full_name: headRepository } }, base: { ref: options.baseRef } },
      repository: { default_branch: "nightly", full_name: "Meshrix-Platform/Meshrix.js" },
    }), { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home,
      TMPDIR: temporary, DOCKER_HOST: dockerHost,
    };
    for (const name of options.jobs) {
      const job = LOCAL_CI_JOBS[name];
      const result: JobResult = { job: name, status: "incomplete", exitCode: null };
      results.push(result);
      try {
        // Each job receives a new checkout and empty dependency/cache volumes.
        readCommand("git", ["reset", "--hard", candidate], checkout);
        readCommand("git", ["clean", "-ffdx"], checkout);
        const log = path.join(scratch, `${name}.log`);
        const directory = path.join(diagnostics, name);
        console.log(`[local-ci] ${name}: started (${candidate.slice(0, 12)})`);
        const exitCode = await runAct(binary, [job.event,
          "--workflows", `.github/workflows/${job.workflow}`, "--job", job.job,
          "--eventpath", event, "--actor", "local-ci", "--defaultbranch", "nightly",
          "--platform", "ubuntu-latest=ghcr.io/catthehacker/ubuntu:act-24.04",
          "--platform", "ubuntu-24.04=ghcr.io/catthehacker/ubuntu:act-24.04",
          "--container-architecture", "linux/amd64",
          "--container-daemon-socket", dockerHost,
          "--container-options", `--volume ${scratch}:${scratch}`,
          "--env", `TMPDIR=${temporary}`, "--env", "CI=true",
          "--env", `npm_config_cache=${temporary}/${name}-npm-cache`,
          "--env", `npm_config_userconfig=${userConfig}`, "--env", `npm_config_globalconfig=${globalConfig}`,
          "--env-file", "/dev/null", "--secret-file", "/dev/null", "--var-file", "/dev/null", "--input-file", "/dev/null",
          "--action-cache-path", path.join(scratch, "actions"), "--action-offline-mode",
          "--no-cache-server", "--pull=false", "--bind", "--rm", "--json",
        ], checkout, env, log);
        result.exitCode = exitCode;
        const raw = await fs.readFile(log, "utf8");
        await writeVerificationArtifacts(decodeActLog(raw), path.join(directory, "runner"));
        const requiredDiagnostics: string[] = [];
        const innerDiagnostics = name === "regression" ? "build/ci-diagnostics"
          : name === "distribution" ? "build/ci-distribution-diagnostics" : undefined;
        // Redirected workflow output is complete only in its own diagnostics owner;
        // the act console contains at most its tail. Preserve both before cleanup.
        if (innerDiagnostics) {
          requiredDiagnostics.push("verification.log", "regression.json");
          const source = path.join(checkout, innerDiagnostics);
          if (await fs.stat(source).then(() => true, () => false)) {
            await fs.cp(source, directory, { recursive: true });
          }
          // The command may have been interrupted before its workflow export.
          // Raw output stays in the private snapshot; only its sanitized copy survives.
          const rawLog = path.join(checkout, name === "regression"
            ? "build/ci-private/pr-regression.log" : "build/ci-private/product-distribution.log");
          const report = path.join(checkout, name === "regression"
            ? "build/test-reports/latest.json" : "build/reports/product-distribution.json");
          const partial = await fs.readFile(rawLog, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (partial !== null) await writeVerificationArtifacts(partial, directory, report);
        }
        const reports = name === "sandbox"
          ? ["controlled-execution-sandbox", "execution-sandbox-oci-conformance", "opaque-sandbox-custody", "execution-launcher-boundary"]
          : name === "portability" ? ["npm-package-installability"] : [];
        if (reports.length) {
          await fs.mkdir(directory, { recursive: true });
          for (const report of reports) {
            requiredDiagnostics.push(`${report}.json`);
            const source = path.join(checkout, `build/reports/${report}.json`);
            if (await fs.stat(source).then(() => true, () => false)) await fs.copyFile(source, path.join(directory, `${report}.json`));
          }
        }
        const completeDiagnostics = (await Promise.all(requiredDiagnostics.map((file) =>
          fs.stat(path.join(directory, file)).then((stat) => stat.isFile() && stat.size > 0, () => false)))).every(Boolean);
        result.reason = exitCode !== 0 ? "executor_failed"
          : !hasSuccessfulActJob(raw, job.job) ? "successful_job_terminal_missing"
          : !completeDiagnostics ? "required_diagnostics_missing" : undefined;
        result.status = result.reason ? "failed" : "passed";
      } catch {
        result.status = "failed";
        result.reason = "job_setup_or_diagnostics_failed";
      }
      console.log(`[local-ci] ${name}: ${result.status}${result.reason ? ` (${result.reason})` : ""}; ${path.relative(repoRoot, path.join(diagnostics, name))}`);
      if (result.exitCode === 130) break;
    }
  } finally {
    await fs.writeFile(path.join(diagnostics, "results.json"), JSON.stringify({ candidate, executor: actVersion,
      environment: "local Ubuntu 24.04 linux/amd64 containers (emulated on non-amd64 hosts)", selectedJobs: options.jobs,
      unexecutedJobs: options.jobs.filter((name) => !results.some((result) => result.job === name)),
      results }, null, 2) + "\n", { mode: 0o600 });
    await fs.rm(scratch, { recursive: true, force: true });
  }
  process.exitCode = results.length !== options.jobs.length || results.some((result) => result.status !== "passed") ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const code = error instanceof Error && /^local_ci_[a-z_]+$/u.test(error.message)
      ? error.message : "local_ci_setup_or_diagnostics_failed";
    console.error(`[local-ci] ${code}; check act, Docker, and a committed local candidate`);
    process.exitCode = 1;
  });
}
