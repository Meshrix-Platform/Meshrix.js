#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { startHttpServer } from "../../apps/server/runtime/http-server.ts";
import {
  MCP_SUPPORTED_TARGETS,
  MCP_TARGET_LABELS
} from "../../packages/protocols/mcp/adapter/mcp-release-targets.ts";
import { installAuthenticatedFetch } from "./test-auth-helper.ts";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.ts";

const execFileAsync: any = promisify(execFile);

const REPORT_PATH: any = "build/reports/mcp-release-target-scope.json";
const RELEASE_TARGETS: any = MCP_SUPPORTED_TARGETS;
const RELEASE_LABELS: any = Object.freeze(RELEASE_TARGETS.map((target?: any) : any => MCP_TARGET_LABELS[target]));
const PUBLIC_SCOPE_FILES: readonly any[] = Object.freeze([
  "packages/protocols/mcp/adapter/http-mcp-adapter.ts",
  "packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts",
  "packages/protocols/mcp/adapter/native-installer/meshrix-mcp-install.sh",
  "packages/protocols/mcp/adapter/native-installer/meshrix-mcp-install.ps1",
  "tools/server-scripts/mcp-install.ts",
  ".github/RELEASE_TEMPLATE.md",
  "packages/protocols/mcp/adapter/gateway-installer/package.json",
  "packages/protocols/mcp/adapter/gateway-installer/README.md",
  "packages/protocols/mcp/adapter/native-installer/README.md"
]);
const ADAPTER_BOUNDARY_DOCUMENT_FILES: readonly any[] = Object.freeze([
  "CHANGELOG.md",
  ".github/RELEASE_TEMPLATE.md",
  "docs/protocols/PROTOCOLS.md",
  "docs/COMPATIBILITY.md",
  "docs/architecture/MCP-NATIVE-INSTALLER.md",
  "docs/functionality/GATEWAY.md",
  "docs/functionality/AGENT-COLLABORATION.md",
  "packages/protocols/mcp/adapter/native-installer/README.md",
  "packages/protocols/mcp/adapter/gateway-installer/README.md"
]);

const restoreCapabilityKernelEnv: any = useIsolatedCapabilityKernelForVerifier();
const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-mcp-release-target-scope-"));
const report: Record<string, any> = {
  schemaVersion: "v0.0.1:mcp:release-target-scope-report-1",
  verifier: "tools/server-scripts/verify-mcp-release-target-scope.ts",
  startedAt: new Date().toISOString(),
  tests: [],
  destructiveTests: [],
  summary: {}
};

let server: any = null;

function safeEvidence(value: Record<string, any> = {}) : any {
  return JSON.parse(JSON.stringify(value, (_?: any, child?: any) : any => {
    if (typeof child !== "string") return child;
    if (child.includes(userDataPath) || child.includes(os.homedir()) || child.includes(process.cwd())) {
      return "[redacted-local-path]";
    }
    if (/Bearer\s+\S+/i.test(child) || /meshrix_[a-z0-9_-]+=/i.test(child)) {
      return "[redacted-secret]";
    }
    return child;
  }));
}

function assertNoLeakText(text: any = "", label: any = "text") : any {
  const value: any = String(text);
  assert.equal(value.includes(userDataPath), false, `${label} leaked verifier data path`);
  assert.equal(value.includes(os.homedir()), false, `${label} leaked user home path`);
  assert.equal(value.includes(process.cwd()), false, `${label} leaked workspace path`);
  assert.equal(/Bearer\s+\S+/i.test(value), false, `${label} leaked bearer token`);
  assert.equal(/meshrix_[a-z0-9_-]+=/i.test(value), false, `${label} leaked cookie`);
}

function assertNoHostPathText(text: any = "", label: any = "text") : any {
  const value: any = String(text);
  assert.equal(value.includes(userDataPath), false, `${label} leaked verifier data path`);
  assert.equal(value.includes(os.homedir()), false, `${label} leaked user home path`);
  assert.equal(value.includes(process.cwd()), false, `${label} leaked workspace path`);
}

function assertNoLeak(value?: any, label: any = "payload") : any {
  const serialized: any = JSON.stringify(value);
  assertNoHostPathText(serialized, label);
}

async function writeReport() : Promise<any> {
  report.finishedAt = new Date().toISOString();
  report.summary.testCount = report.tests.length;
  report.summary.destructiveTestCount = report.destructiveTests.length;
  report.summary.failedCount = [...report.tests, ...report.destructiveTests].filter((item?: any) : any => item.status !== "passed").length;
  report.summary.releaseReady = report.summary.failedCount === 0;
  report.summary.reportLeakScan = false;
  assertNoLeak(report, "mcp release target scope report");
  report.summary.reportLeakScan = true;
  assertNoLeak(report, "mcp release target scope report");
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function record(collection?: any, name?: any, status?: any, evidence: Record<string, any> = {}) : any {
  collection.push({ name, status, evidence: safeEvidence(evidence) });
}

function failureEvidence(error?: any) : any {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    code: String(error?.code || ""),
    status: Number(error?.status || 0) || 0
  };
}

async function test(name?: any, fn?: any) : Promise<any> {
  process.stdout.write(`  ${name} ... `);
  try {
    const evidence: any = await fn();
    record(report.tests, name, "passed", evidence);
    console.log("ok");
  } catch (error: any) {
    record(report.tests, name, "failed", failureEvidence(error));
    console.log("FAIL");
    throw error;
  }
}

async function runNode(script?: any, args: any = []) : Promise<any> {
  let result: any = null;
  let status: any = 0;
  try {
    result = await execFileAsync(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 4 * 1024 * 1024
    });
  } catch (error: any) {
    result = {
      stdout: error.stdout || "",
      stderr: error.stderr || ""
    };
    const exitCode: any = Number(error.code);
    status = Number.isFinite(exitCode) ? exitCode : 1;
  }
  const stdout: any = result.stdout || "";
  const stderr: any = result.stderr || "";
  assertNoHostPathText(stdout, `${script} stdout`);
  assertNoHostPathText(stderr, `${script} stderr`);
  return { status, stdout, stderr };
}

function parseJsonOutput(stdout: any = "", label: any = "stdout") : any {
  const text: any = String(stdout || "").trim();
  assert.ok(text, `${label} was empty`);
  const start: any = text.indexOf("{");
  assert.notEqual(start, -1, `${label} did not contain JSON`);
  const payload: any = JSON.parse(text.slice(start));
  assertNoLeak(payload, label);
  return payload;
}

async function fetchJson(route?: any, options: Record<string, any> = {}) : Promise<any> {
  const response: any = await fetch(`${server.url}${route}`, options);
  const text: any = await response.text();
  const payload: any = text.trim() ? JSON.parse(text) : {};
  assertNoLeak(payload, route);
  return { status: response.status, payload };
}

async function mcpInitialize() : Promise<any> {
  return fetchJson("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-release-target-scope", version: "1" }
      }
    })
  });
}

function assertReleaseTargets(value?: any, label?: any) : any {
  assert.deepEqual([...value].sort(), [...RELEASE_TARGETS].sort(), `${label} did not expose the release target set`);
}

function targetIds(items: any = []) : any {
  return items.map((item?: any) : any => typeof item === "string" ? item : item?.target).filter(Boolean);
}

try {
  server = await startHttpServer({
    userDataPath,
    distPath: "",
    port: 0,
    runtimeOptions: {
      profile: "minimal",
      enableFeatures: ["operation-permission-core"]
    }
  });
  await installAuthenticatedFetch(server);

  console.log("\n=== MCP Release Target Scope: public metadata and CLI verifier ===\n");

  await test("public source, package metadata, and installer docs expose only the trusted catalog", async () : Promise<any> => {
    for (const filePath of PUBLIC_SCOPE_FILES) {
      const source: any = await fs.readFile(filePath, "utf8");
      assertNoHostPathText(source, filePath);
    }
    return {
      filesChecked: PUBLIC_SCOPE_FILES.length,
      releaseTargets: RELEASE_TARGETS.length
    };
  });

  await test("documentation declares the external client-adapter boundary", async () : Promise<any> => {
    for (const filePath of ADAPTER_BOUNDARY_DOCUMENT_FILES) {
      const source: any = await fs.readFile(filePath, "utf8");
      assertNoHostPathText(source, filePath);
      assert.equal(/operator-supplied|external (?:client-)?adapter|external plugin/iu.test(source), true, `${filePath} does not declare the external adapter boundary`);
    }
    return {
      filesChecked: ADAPTER_BOUNDARY_DOCUMENT_FILES.length,
      boundary: "external-client-adapter-packages"
    };
  });

  await test("real MCP discovery metadata exposes exactly the release targets", async () : Promise<any> => {
    const discovery: any = await fetchJson("/api/mcp/discovery");
    assert.equal(discovery.status, 200);
    const connector: any = discovery.payload?.installer || {};
    assertReleaseTargets(connector.priorityTargets || [], "discovery priorityTargets");
    assertReleaseTargets(targetIds(connector.supportedTargets || []), "discovery supportedTargets");
    assert.equal(RELEASE_LABELS.every((label?: any) : any => JSON.stringify(connector).includes(label)), true);
    return {
      priorityTargetCount: connector.priorityTargets?.length || 0,
      supportedTargetCount: connector.supportedTargets?.length || 0
    };
  });

  await test("real MCP initialize metadata exposes exactly the release targets", async () : Promise<any> => {
    const initialize: any = await mcpInitialize();
    assert.equal(initialize.status, 200);
    const meta: any = initialize.payload?.result?._meta || {};
    assertReleaseTargets(meta.priorityTargets || [], "initialize priorityTargets");
    assertReleaseTargets(targetIds(meta.supportedTargets || []), "initialize supportedTargets");
    return {
      priorityTargetCount: meta.priorityTargets?.length || 0,
      supportedTargetCount: meta.supportedTargets?.length || 0
    };
  });

  await test("installer CLI help, discovery, and scan output expose only release targets", async () : Promise<any> => {
    const help: any = await runNode("packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts", ["help"]);
    assert.equal(help.status, 0);
    assert.equal(RELEASE_TARGETS.every((target?: any) : any => help.stdout.includes(target)), true);

    const discover: any = await runNode("packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts", ["discover", "--url", server.url, "--json"]);
    assert.equal(discover.status, 0);
    const discoverPayload: any = parseJsonOutput(discover.stdout, "installer discover");
    assertReleaseTargets(targetIds(discoverPayload.installer?.supportedTargets || []), "installer discover supportedTargets");

    const scan: any = await runNode("packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts", ["scan", "--url", server.url, "--no-scan", "--json"]);
    assert.equal(scan.status, 0);
    const scanPayload: any = parseJsonOutput(scan.stdout, "installer scan");
    assertReleaseTargets(targetIds(scanPayload.candidates || []), "installer scan candidates");
    return {
      helpChecked: true,
      scanCandidateCount: scanPayload.candidates?.length || 0
    };
  });

  await writeReport();
  console.log(`\n=== MCP Release Target Scope passed; report: ${REPORT_PATH} ===`);
} catch (error: any) {
  await writeReport().catch(() : any => {});
  console.error(JSON.stringify(safeEvidence({
    ok: false,
    verifier: "tools/server-scripts/verify-mcp-release-target-scope.ts",
    failure: failureEvidence(error)
  }), null, 2));
  process.exitCode = 1;
} finally {
  await server?.close?.();
  await fs.rm(userDataPath, { recursive: true, force: true }).catch(() : any => {});
  restoreCapabilityKernelEnv();
}
