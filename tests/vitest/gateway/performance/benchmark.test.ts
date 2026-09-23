import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../../../..");
const entry = resolve(root, "tools/server-scripts/benchmark-gateway.ts");

describe("installed benchmark command", () => {
  it("rejects malformed arguments without loading children", () => {
    for (const args of [["--evaluate", "--evaluate"], ["--profile"], ["--evaluate", "--profile", "unknown"]]) {
      const child = spawnSync(process.execPath, [entry, ...args], { cwd: root, encoding: "utf8", timeout: 5000 });
      expect(child.status).toBe(1);
      expect(child.stderr).toMatch(/invalid_arguments|invalid_profile/u);
      expect(child.stdout).toBe("");
    }
  });

  it("has a side-effect-free help view and a nonmeasured installed plan", () => {
    const help = spawnSync(process.execPath, [entry, "--help"], { cwd: root, encoding: "utf8", timeout: 5000 });
    expect(help.status).toBe(0);
    expect(JSON.parse(help.stdout).help).toContain("gateway:benchmark");
    const plan = spawnSync(process.execPath, [entry], { cwd: root, encoding: "utf8", timeout: 5000 });
    expect(plan.status).toBe(0);
    expect(JSON.parse(plan.stdout)).toMatchObject({ evaluated: false, measurements: null, schemaVersion: "v0.0.1:meshrix:gateway-benchmark-node-1" });
  });

  it("runs a tiny real source CLI over separate mock and generator with matched effects", async () => {
    const require = createRequire(resolve(root, ".cache/gateway-benchmark/package.json"));
    const api = await import(pathToFileURL(require.resolve("meshrix-node-benchmark/meshrix")).href);
    const report = await api.runGatewayBenchmark({ root, profile: "fixture" });
    expect(report).toMatchObject({ evaluated: true, profile: "fixture", source: "unchanged_source_cli",
      cleanup: { allExited: true, scratchRemoved: true } });
    expect(report.legs).toHaveLength(2);
    for (const leg of report.legs) {
      expect(leg.terminals.validSuccess).toBeGreaterThan(0);
      expect(leg.effects.validSuccessesMatched).toBe(leg.terminals.validSuccess);
      expect(leg.validRtt.count).toBe(leg.terminals.validSuccess);
    }
    expect(report.processObservations.gateway.sampleCount).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toMatch(/127\.0\.0\.1|\/Users\/|"pid"|"key"/u);
  }, 45000);

  it("the original executable entry delegates explicit fixture evaluation to the installed package", () => {
    const child = spawnSync(process.execPath, [entry, "--evaluate", "--profile", "fixture"], {
      cwd: root, encoding: "utf8", timeout: 20000 });
    expect(child.status).toBe(0);
    const report = JSON.parse(child.stdout);
    expect(report).toMatchObject({ profile: "fixture", evaluated: true,
      cleanup: { allExited: true, scratchRemoved: true } });
    expect(report.legs).toHaveLength(2);
    for (const leg of report.legs) expect(leg.effects.validSuccessesMatched).toBe(leg.terminals.validSuccess);
    expect(child.stderr).toBe("");
    expect(child.stdout).not.toMatch(/127\.0\.0\.1|\/Users\/|"pid"|"key"/u);
  }, 30000);

  it("requires a committed standard tool provenance before network", () => {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect(revision).toMatch(/^[a-f0-9]{40}$/u);
    const child = spawnSync(process.execPath, [entry, "--evaluate", "--profile", "standard"], {
      cwd: root, encoding: "utf8", timeout: 5000, env: { ...process.env, MESHRIX_BENCHMARK_TOOL_COMMIT: "" } });
    expect(child.status).toBe(1);
    expect(child.stderr).toMatch(/candidate_dirty|tool_candidate_required/u);
    expect(child.stdout).toBe("");
  });

  it.each(["wrongId", "wrongContent", "rpcError", "toolError", "duplicateSse", "oversize", "truncated"])(
    "classifies %s from a separate real peer without successful latency or orphan children", async fault => {
      const require = createRequire(resolve(root, ".cache/gateway-benchmark/package.json"));
      const api = await import(pathToFileURL(require.resolve("meshrix-node-benchmark/meshrix")).href);
      const report = await api.runGatewayBenchmark({ root, profile: "fixture", fault });
      expect(report.evaluated).toBe(false);
      expect(report.cleanup).toMatchObject({ allExited: true, scratchRemoved: true });
      const direct = report.legs.find((leg: { path: string }) => leg.path === "direct");
      expect(direct?.terminals.validSuccess).toBe(0);
      expect(direct?.validRtt).toBe(null);
      expect(direct?.started).toBe(Object.values(direct.terminals).reduce((sum: number, count) => sum + Number(count), 0));
      expect(JSON.stringify(report)).not.toMatch(/127\.0\.0\.1|\/Users\/|"pid"|"key"/u);
    }, 45000);

  it.each(["noResponse", "die"])("retires owned children after a %s peer", async fault => {
    const require = createRequire(resolve(root, ".cache/gateway-benchmark/package.json"));
    const api = await import(pathToFileURL(require.resolve("meshrix-node-benchmark/meshrix")).href);
    const report = await api.runGatewayBenchmark({ root, profile: "fixture", fault });
    expect(report.evaluated).toBe(false);
    expect(report.cleanup).toMatchObject({ allExited: true, scratchRemoved: true });
    expect(report.legs.every((leg: { terminals: { validSuccess: number } }) => leg.terminals.validSuccess === 0)).toBe(true);
  }, 45000);

  it("cancellation cleans up the same public process topology", async () => {
    const require = createRequire(resolve(root, ".cache/gateway-benchmark/package.json"));
    const api = await import(pathToFileURL(require.resolve("meshrix-node-benchmark/meshrix")).href);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    const report = await api.runGatewayBenchmark({ root, profile: "fixture", signal: controller.signal });
    clearTimeout(timer);
    expect(report.evaluated).toBe(false);
    expect(report.cleanup).toMatchObject({ allExited: true, scratchRemoved: true });
  }, 30000);
});
