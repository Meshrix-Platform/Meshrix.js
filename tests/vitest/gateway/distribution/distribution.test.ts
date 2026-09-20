import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const WORKSPACES = ["@meshrix/contracts", "@meshrix/gateway"] as const;

interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface PackedArtifact {
  readonly workspace: string;
  readonly tarball: string;
  readonly bytes: number;
  readonly sha256: string;
}

function consumerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, npm_config_audit: "false", npm_config_fund: "false", npm_config_progress: "false" };
  // `npm run` exports the parent harness's npm configuration into this process. npm 11 rejects
  // CLI-only entries such as `allow-scripts` in a project-scoped install, and the consumer must
  // be installed with its own configuration rather than the repository harness's.
  delete environment.npm_config_allow_scripts;
  delete environment.NPM_CONFIG_ALLOW_SCRIPTS;
  return environment;
}

function run(command: string, args: readonly string[], cwd: string): CommandResult {
  try {
    const stdout = execFileSync(command, [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      env: consumerEnvironment()
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string };
    return { status: typeof failure.status === "number" ? failure.status : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function packRecords(stdout: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(stdout || "[]") as unknown;
  if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
  return Object.values(parsed as Record<string, unknown>).flatMap((value) => (Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []));
}

function consumerScript(): string {
  return [
    'import { createGateway } from "@meshrix/gateway";',
    "const upstream = { invoke: async () => ({ status: 200, headers: { \"content-type\": \"application/json\" }, body: { content: [{ type: \"text\", text: \"ok\" }] } }) };",
    'const route = { logicalRoute: "route.demo", upstreamIdentity: "upstream.demo", endpointIdentity: "endpoint.demo", protocolVersion: "2026-07-28", schemaDigest: "schema-demo", policyRef: "policy-demo", revision: "route-1", effectClass: "read", operation: "tools/call", upstreamName: "demo" };',
    'const descriptor = { kind: "tool", publicName: "demo", upstreamName: "demo", description: "Demo tool", inputSchema: { type: "object" }, route };',
    'const context = { tenant: "tenant-demo", principal: "principal-demo", authGeneration: "auth-1", grant: { revision: "grant-1" }, trace: { traceparent: "00-demo" } };',
    "const gateway = createGateway({ upstream, descriptors: [descriptor] });",
    "await gateway.start();",
    'const page = gateway.catalog(context, { kind: "tool", limit: 10 });',
    'const outcome = await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} });',
    "await gateway.close();",
    'process.stdout.write(JSON.stringify({ catalogNames: page.items.map((item) => item.publicName), kind: outcome.kind }) + "\\n");'
  ].join("\n");
}

describe("gateway distribution candidate", () => {
  let packDir = "";
  let scratchDir = "";
  let artifacts: PackedArtifact[] = [];

  beforeAll(() => {
    packDir = mkdtempSync(join(tmpdir(), "meshrix-gateway-pack-"));
    scratchDir = mkdtempSync(join(tmpdir(), "meshrix-gateway-consumer-"));
    // `dist/` is gitignored build output that can lag behind `src/`; rebuild so the
    // packed candidate is the reviewed source rather than a stale artifact.
    const build = run("npm", ["run", "build:node"], repoRoot);
    expect(build.status, `npm run build:node failed:\n${build.stderr}`).toBe(0);
    const packed = run("npm", ["pack", "--workspace", WORKSPACES[0], "--workspace", WORKSPACES[1], "--pack-destination", packDir, "--json", "--ignore-scripts", "--silent"], repoRoot);
    expect(packed.status, `npm pack failed:\n${packed.stderr}`).toBe(0);
    artifacts = packRecords(packed.stdout).map((record) => {
      const tarball = join(packDir, String(record.filename));
      const bytes = readFileSync(tarball);
      return {
        workspace: String(record.name),
        tarball,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex")
      };
    });
    expect(artifacts).toHaveLength(WORKSPACES.length);
  }, 600_000);

  afterAll(() => {
    for (const directory of [packDir, scratchDir]) {
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("[CASE-U06] packs both candidate artifacts and records their digests without publishing", () => {
    expect(artifacts.map((artifact) => artifact.workspace).sort()).toEqual([...WORKSPACES].sort());
    for (const artifact of artifacts) {
      expect(artifact.bytes).toBeGreaterThan(0);
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(artifact.tarball)).toBe(true);
    }
    const recorded = artifacts.map((artifact) => `${artifact.workspace}@0.0.1 ${artifact.bytes} bytes sha256:${artifact.sha256}`);
    console.log(`[distribution] ${recorded.join("\n[distribution] ")}`);
    // The candidate flow produces artifacts only; it must not publish.
    expect(recorded).toHaveLength(2);
  }, 120_000);

  it("[CASE-U04] fails explicitly when only the gateway artifact is installed", () => {
    const gateway = artifacts.find((artifact) => artifact.workspace === "@meshrix/gateway");
    expect(gateway).toBeDefined();
    const consumer = mkdtempSync(join(scratchDir, "gateway-only-"));
    const installed = run("npm", ["install", gateway!.tarball, "--no-audit", "--no-fund"], consumer);
    expect(installed.status).not.toBe(0);
    expect(`${installed.stdout}${installed.stderr}`).toMatch(/@meshrix\/contracts/);
    expect(existsSync(join(consumer, "node_modules/@meshrix/gateway"))).toBe(false);
  }, 300_000);

  it("[CASE-U04 CASE-A01 CASE-U01] installs both artifacts in an empty consumer and calls the public entry", () => {
    const consumer = mkdtempSync(join(scratchDir, "consumer-"));
    const install = run("npm", ["install", ...artifacts.map((artifact) => artifact.tarball), "--no-audit", "--no-fund"], consumer);
    expect(install.status, `consumer install failed:\n${install.stderr}`).toBe(0);
    expect(`${install.stdout}${install.stderr}`).not.toMatch(/EBADENGINE/);
    const installedScript = join(consumer, "consumer.mjs");
    writeFileSync(installedScript, consumerScript(), "utf8");
    const executed = run(process.execPath, [installedScript], consumer);
    expect(executed.status, `consumer run failed:\n${executed.stderr}`).toBe(0);
    expect(JSON.parse(executed.stdout.trim())).toEqual({ catalogNames: ["demo"], kind: "complete" });
    // The installed gateway consumes the contract from the sibling artifact, not from repo source.
    const installedContracts = JSON.parse(readFileSync(join(consumer, "node_modules/@meshrix/contracts/package.json"), "utf8")) as { engines?: { node?: string } };
    const repo = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { engines?: { node?: string } };
    expect(installedContracts.engines?.node).toBe(repo.engines?.node);
  }, 300_000);
});
