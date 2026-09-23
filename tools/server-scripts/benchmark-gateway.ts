import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const prefix = resolve(root, ".cache/gateway-benchmark");
export const GATEWAY_BENCHMARK_SCHEMA = "v0.0.1:meshrix:gateway-benchmark-node-1" as const;
interface Tool {
  describeGatewayBenchmark(options: { profile: "standard" }): Record<string, unknown>;
  runGatewayBenchmark(options: { root: string; profile: "standard" | "fixture"; candidate?: {
    sutRevision: string; toolRevision: string }; signal: AbortSignal }): Promise<Record<string, unknown>>;
}

export function parseBenchmarkArgs(args: readonly string[]) {
  let evaluate = false, profile: "standard" | "fixture" = "standard", output: string | undefined;
  let help = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!["--help", "--evaluate", "--profile", "--output"].includes(argument) || seen.has(argument)) throw Error("invalid_arguments");
    seen.add(argument);
    if (argument === "--help") help = true;
    else if (argument === "--evaluate") evaluate = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw Error("invalid_arguments");
      if (argument === "--profile") {
        if (value !== "standard" && value !== "fixture") throw Error("invalid_profile");
        profile = value;
      } else output = value;
    }
  }
  if (help && seen.size > 1 || !evaluate && profile !== "standard") throw Error("invalid_arguments");
  return { help, evaluate, profile, output };
}

async function installedTool(): Promise<Tool> {
  try {
    const require = createRequire(resolve(prefix, "package.json"));
    const metadata = require("meshrix-node-benchmark/package.json") as { name?: string; version?: string };
    if (metadata.name !== "meshrix-node-benchmark" || metadata.version !== "0.1.0") throw Error("wrong_version");
    const entry = require.resolve("meshrix-node-benchmark/meshrix");
    return await import(pathToFileURL(entry).href) as Tool;
  } catch { throw Error("benchmark_tool_not_installed"); }
}

function git(...args: string[]) {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { throw Error("candidate_unavailable"); }
}

function committedCandidate() {
  const revision = git("rev-parse", "HEAD");
  if (!/^[a-f0-9]{40}$/u.test(revision) || git("status", "--porcelain", "--untracked-files=all", "--",
    "apps/mcp-gateway-installer", "packages/gateway", "packages/protocols", "packages/capabilities", "packages/foundation",
    "tools/server-scripts/benchmark-gateway.ts", "tools/server-scripts/lib/runtime-performance-observer-preload.ts"))
    throw Error("candidate_dirty");
  return revision;
}

export async function runBenchmarkCommand(args: readonly string[]) {
  const options = parseBenchmarkArgs(args);
  if (options.help) return { help: "gateway:benchmark [--evaluate --profile standard --output <local-file>]" };
  const tool = await installedTool();
  if (!options.evaluate) {
    const plan = tool.describeGatewayBenchmark({ profile: "standard" });
    if (plan.schemaVersion !== GATEWAY_BENCHMARK_SCHEMA) throw Error("benchmark_report_version_mismatch");
    return plan;
  }
  const sutRevision = options.profile === "standard" ? committedCandidate() : undefined;
  const toolRevision = process.env.MESHRIX_BENCHMARK_TOOL_COMMIT;
  if (options.profile === "standard" && (!toolRevision || !/^[a-f0-9]{40}$/u.test(toolRevision))) throw Error("tool_candidate_required");
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let report: Record<string, unknown>;
  try {
    report = await tool.runGatewayBenchmark({ root, profile: options.profile,
      candidate: sutRevision ? { sutRevision, toolRevision: toolRevision! } : undefined, signal: controller.signal });
    if (report.schemaVersion !== GATEWAY_BENCHMARK_SCHEMA) throw Error("benchmark_report_version_mismatch");
    if (sutRevision && committedCandidate() !== sutRevision) throw Error("candidate_changed");
  } finally {
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  }
  return report;
}

async function main() {
  const options = parseBenchmarkArgs(process.argv.slice(2));
  const report = await runBenchmarkCommand(process.argv.slice(2));
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    const destination = resolve(options.output);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${process.pid}.tmp`;
    try { await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" }); await rename(temporary, destination); }
    finally { await rm(temporary, { force: true }); }
  } else process.stdout.write(serialized);
  if (report.status === "qualified") process.exitCode = 1;
}
if (import.meta.main) {
  main().catch(error => { console.error(`gateway_benchmark: ${error instanceof Error && /^[a-z_]+$/u.test(error.message) ? error.message : "execution_failure"}`); process.exitCode = 1; });
}
