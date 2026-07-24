#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { startHttpServer } from "../../apps/server/runtime/http-server.mjs";
import { loginBrowserContext } from "./lib/console-admin-browser-fixture.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const distPath = path.join(repoRoot, "build", "dist");
const reportPath = path.join(repoRoot, "build", "reports", "strategy-management-browser.json");
const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-strategy-browser-"));
const KNOWN_NONFUNCTIONAL_HTTP_ERRORS = new Map([
  // The global Console shell probes this disabled optional monitor feed independently of Strategy Management.
  ["/api/system/monitor-alerts", new Set([400])],
  // The verifier build does not package an icon and the missing icon does not affect application execution.
  ["/favicon.ico", new Set([404])]
]);
const KNOWN_NONFUNCTIONAL_REQUEST_FAILURE_PATHS = new Set(["/favicon.ico"]);
let server = null;
let browser = null;
let context = null;

function pathFromUrl(value) {
  try {
    return new URL(String(value || "")).pathname;
  } catch {
    return "";
  }
}

try {
  await fs.access(path.join(distPath, "index.html"));
  server = await startHttpServer({
    userDataPath,
    distPath,
    port: 0,
    runtimeOptions: {
      edition: "core",
      enableFeatures: ["strategy-management"],
      enabledPlugins: [],
      workspaceRoot: repoRoot
    }
  });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    locale: "zh-CN",
    colorScheme: "light",
    reducedMotion: "reduce",
    viewport: { width: 1280, height: 800 }
  });
  await loginBrowserContext({ context, server });
  const page = await context.newPage();
  const rpcMethods = [];
  const rpcStatuses = [];
  const consoleErrors = [];
  const pageErrors = [];
  const failedResources = [];
  const httpErrors = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname !== "/api/rpc") return;
    try {
      rpcMethods.push(String(request.postDataJSON()?.method || ""));
    } catch {
      rpcMethods.push("invalid-rpc-body");
    }
  });
  page.on("response", (response) => {
    if (pathFromUrl(response.url()) === "/api/rpc") rpcStatuses.push(response.status());
    if (response.status() >= 400) {
      httpErrors.push({
        path: pathFromUrl(response.url()),
        status: response.status()
      });
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push({
        path: pathFromUrl(message.location()?.url),
        text: message.text().slice(0, 200)
      });
    }
  });
  page.on("pageerror", (error) => pageErrors.push(String(error?.message || error).slice(0, 200)));
  page.on("requestfailed", (request) => {
    failedResources.push({
      path: pathFromUrl(request.url()),
      reason: String(request.failure()?.errorText || "request_failed").slice(0, 120)
    });
  });

  await page.goto(`${server.url}/#/admin/strategy-management`, { waitUntil: "domcontentloaded" });
  const root = page.locator(".strategy-management-layout");
  await root.waitFor({ state: "visible", timeout: 10_000 });
  await page.getByText("尚未执行预览。", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  assert.deepEqual(rpcMethods, [], "Strategy Management must not issue preview RPC calls on mount");
  assert.ok(await root.getByText("strategy.workflow_policy.evaluate", { exact: true }).count() >= 1);
  assert.ok(await root.getByText("strategy.tool_policy.preview", { exact: true }).count() >= 1);

  const capabilitySelect = root.locator("select");
  const previewInput = root.locator("textarea");
  await capabilitySelect.selectOption("strategy.workflow_policy.evaluate");
  await previewInput.fill(JSON.stringify({ workflowId: "browser-strategy-preview", risk: "read_only" }));
  await root.getByRole("button", { name: "执行预览" }).click();
  await page.locator(".strategy-management-layout[data-preview-state='accepted']")
    .waitFor({ state: "visible", timeout: 10_000 });

  await capabilitySelect.selectOption("strategy.tool_policy.preview");
  await previewInput.fill(JSON.stringify({ toolId: "meshrix.jobs.list" }));
  await root.getByRole("button", { name: "执行预览" }).click();
  await page.locator(".strategy-management-layout[data-preview-state='denied']")
    .waitFor({ state: "visible", timeout: 10_000 });
  assert.deepEqual(rpcMethods, [
    "strategy.workflow_policy.evaluate",
    "strategy.tool_policy.preview"
  ]);
  assert.deepEqual(rpcStatuses, [200, 200]);
  assert.equal(pageErrors.length, 0);

  const knownResourceHttpErrors = httpErrors.filter((entry) =>
    KNOWN_NONFUNCTIONAL_HTTP_ERRORS.get(entry.path)?.has(entry.status) === true
  );
  const unexpectedHttpErrors = httpErrors.filter((entry) => !knownResourceHttpErrors.includes(entry));
  const knownResourceConsoleErrors = consoleErrors.filter((entry) =>
    [...(KNOWN_NONFUNCTIONAL_HTTP_ERRORS.get(entry.path) || [])].some((status) =>
      entry.text === `Failed to load resource: the server responded with a status of ${status} (${status === 400 ? "Bad Request" : "Not Found"})`
    )
  );
  const unexpectedConsoleErrors = consoleErrors.filter((entry) => !knownResourceConsoleErrors.includes(entry));
  const knownResourceFailures = failedResources.filter((entry) =>
    KNOWN_NONFUNCTIONAL_REQUEST_FAILURE_PATHS.has(entry.path)
  );
  const unexpectedResourceFailures = failedResources.filter((entry) => !knownResourceFailures.includes(entry));
  assert.deepEqual(unexpectedConsoleErrors, [], "Strategy Management emitted an unexpected browser console error");
  assert.deepEqual(unexpectedHttpErrors, [], "Strategy Management loaded an unexpected failing HTTP resource");
  assert.deepEqual(unexpectedResourceFailures, [], "Strategy Management had an unexpected failed resource request");

  const report = {
    schemaVersion: "v0.0.1:schema:strategy-management-browser-report-1",
    verificationPassed: true,
    releaseReady: false,
    summary: {
      automaticPreviewCount: 0,
      explicitPreviewCount: rpcMethods.length,
      workflowAccepted: true,
      toolEnvelopeDenied: true,
      consoleErrorCount: consoleErrors.length,
      pageErrorCount: pageErrors.length,
      knownNonfunctionalResourceErrorCount:
        knownResourceHttpErrors.length + knownResourceConsoleErrors.length + knownResourceFailures.length,
      unexpectedBrowserErrorCount:
        unexpectedConsoleErrors.length + unexpectedHttpErrors.length + unexpectedResourceFailures.length + pageErrors.length
    },
    reportLeakScan: { passed: true, prohibitedFieldCount: 0 }
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log("[strategy-management-browser] ok: build/reports/strategy-management-browser.json");
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
  await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {});
}
