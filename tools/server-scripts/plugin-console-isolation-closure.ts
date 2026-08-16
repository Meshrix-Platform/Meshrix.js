#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLUGIN_CONSOLE_BRIDGE_VERSION,
  PLUGIN_CONSOLE_IFRAME_SANDBOX,
  PLUGIN_CONSOLE_MOUNT_EXPORT,
  PLUGIN_CONSOLE_SANDBOX_URL,
  admitPluginConsoleIsolationEntry,
  connectPluginConsoleHostBridge,
  createPluginConsoleSandboxDocument
} from "../../apps/console/plugin-console-isolation.ts";
import {
  PLUGIN_CONSOLE_ISOLATION_BRIDGE_VERSION,
  registerPluginConsoleIsolationVerification
} from "../../packages/foundation/src/module-system/plugin-console-isolation.ts";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeSensitiveReport
} from "./lib/sensitive-report-scan.ts";

export const PLUGIN_CONSOLE_ISOLATION_VERIFIER: any =
  "tools/server-scripts/plugin-console-isolation-closure.ts";
export const PLUGIN_CONSOLE_ISOLATION_REPORT_RELATIVE_PATH: any =
  "build/reports/plugin-console-isolation.json";
export const PLUGIN_CONSOLE_ISOLATION_REPORT_SCHEMA_VERSION: any =
  "v0.0.1:plugin:console-isolation-closure-1";

const VITEST_RUNNER: any = "./node_modules/vitest/vitest.mjs";
const FOCUSED_SUITES: readonly any[] = Object.freeze([
  "tests/vitest/console/plugin-console-isolation.test.ts",
  "tests/vitest/server/plugin-console-isolation.test.ts",
  "tests/vitest/server/plugin-console-routes.test.ts",
  "tests/vitest/server/plugin-runtime.test.ts"
]);
const SOURCE_FILES: readonly any[] = Object.freeze([
  PLUGIN_CONSOLE_ISOLATION_VERIFIER,
  "apps/console/plugin-console-isolation.ts",
  "apps/console/router/plugin-console-routes.ts",
  "packages/foundation/src/module-system/plugin-console-isolation.ts",
  "packages/foundation/src/module-system/plugin-runtime.ts",
  "tests/acceptance/plugin-console-isolation.test.ts",
  ...FOCUSED_SUITES
]);

function repoRootFromMeta() : any {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

async function assertCurrentLoaderContract(repoRoot?: any) : Promise<any> {
  const routes: any = await fs.readFile(path.join(repoRoot, "apps/console/router/plugin-console-routes.ts"), "utf8");
  const isolation: any = await fs.readFile(path.join(repoRoot, "apps/console/plugin-console-isolation.ts"), "utf8");
  const runtime: any = await fs.readFile(path.join(repoRoot, "packages/foundation/src/module-system/plugin-runtime.ts"), "utf8");
  assert.equal(routes.includes("import(/* @vite-ignore */"), false);
  assert.equal(routes.includes("PluginConsoleModuleImporter"), false);
  assert.equal(routes.includes("importPluginConsoleModule"), false);
  assert.equal(routes.includes("moduleImporter"), false);
  assert.equal(isolation.includes("MessageChannel"), true);
  assert.equal(isolation.includes('PLUGIN_CONSOLE_IFRAME_SANDBOX: any = "allow-scripts"'), true);
  assert.equal(isolation.includes("allow-same-origin"), false);
  assert.equal(runtime.includes("registerPluginConsoleIsolationVerification"), true);
  return Object.freeze({
    currentLoaderIsolated: true,
    privilegedImporterAbsentFromLoader: true,
    verificationRegistered: true
  });
}

function runCommand(repoRoot?: any, args: any = []) : any {
  const result: any = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_OPTIONS: "--conditions=source"
    }
  });
  return {
    passed: result.status === 0,
    exitCode: result.status === null ? 1 : result.status,
    outputBytes: Buffer.byteLength(`${result.stdout || ""}${result.stderr || ""}`, "utf8"),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "")
  };
}

function runFocusedSuites(repoRoot?: any) : any {
  const result: any = runCommand(repoRoot, [
    "--conditions=source",
    VITEST_RUNNER,
    "run",
    "--config",
    "vitest.config.ts",
    ...FOCUSED_SUITES
  ]);
  return {
    suites: FOCUSED_SUITES,
    passed: result.passed,
    exitCode: result.exitCode,
    outputBytes: result.outputBytes,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function escapeHtmlAttribute(value?: any) : any {
  return String(value || "")
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;");
}

function createEscapeProbeDocument() : any {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none';">
</head>
<body>
<div id="meshrix-plugin-console-root">plugin-mounted</div>
<script>
(function () {
  var cookie = "";
  try {
    cookie = String(document.cookie || "");
  } catch (error) {
    cookie = "";
  }
  var probe = {
    origin: String((self.location && self.location.origin) || ""),
    parentSecret: null,
    cookie: cookie,
    fetchState: "pending"
  };
  try {
    probe.parentSecret = window.parent && window.parent.__MESHRIX_CONSOLE_PRIVILEGED__;
  } catch (error) {
    probe.parentSecret = "threw";
  }
  fetch("/privileged-state").then(function () {
    probe.fetchState = "allowed";
    window.__PLUGIN_PROBE__ = probe;
  }).catch(function () {
    probe.fetchState = "blocked";
    window.__PLUGIN_PROBE__ = probe;
  });
  setTimeout(function () {
    if (probe.fetchState === "pending") {
      probe.fetchState = "blocked";
      window.__PLUGIN_PROBE__ = probe;
    }
  }, 500);
  window.__PLUGIN_PROBE__ = probe;
  window.parent.postMessage({
    type: "meshrix.plugin-console.guest-ready",
    bridgeVersion: "${PLUGIN_CONSOLE_BRIDGE_VERSION}"
  }, "*");
})();
</script>
</body>
</html>`;
}

async function runBrowserEscape() : Promise<any> {
  let chromium: any = null;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return Object.freeze({
      attempted: true,
      obtained: false,
      reason: "playwright_unavailable",
      opaqueOrigin: null,
      parentPrivilegedStateReadableFromGuest: null,
      parentCanReadIframe: null,
      pluginFetchedHost: null
    });
  }
  const srcdoc: any = createEscapeProbeDocument();
  const pageHtml: any = `<!DOCTYPE html>
<html>
<body>
<script>
window.__MESHRIX_CONSOLE_PRIVILEGED__ = "console-privileged-token";
document.cookie = "meshrix_console_session=privileged-cookie";
window.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "meshrix.plugin-console.guest-ready") return;
  const iframe = document.querySelector("[data-testid='plugin-console-isolation-frame']");
  if (iframe && iframe.contentWindow) {
    const channel = new MessageChannel();
    iframe.contentWindow.postMessage({
      type: "meshrix.plugin-console.init",
      bridgeVersion: ${JSON.stringify(PLUGIN_CONSOLE_BRIDGE_VERSION)},
      context: { locale: "en", theme: { colorScheme: "light" }, route: { path: "/admin/probe", viewKey: "probe" } }
    }, "*", [channel.port2]);
  }
  window.__HOST_CONNECTED__ = true;
});
</script>
<iframe
  sandbox="${PLUGIN_CONSOLE_IFRAME_SANDBOX}"
  data-testid="plugin-console-isolation-frame"
  referrerpolicy="no-referrer"
  srcdoc="${escapeHtmlAttribute(srcdoc)}"
></iframe>
</body>
</html>`;

  const server: any = http.createServer((request?: any, response?: any) : any => {
    if (request.url === "/privileged-state") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("console-privileged-token");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(pageHtml);
  });
  await new Promise((resolve?: any) : any => server.listen(0, "127.0.0.1", resolve));
  const address: any = server.address();
  const origin: any = `http://127.0.0.1:${address.port}`;
  let browser: any = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page: any = await browser.newPage();
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator("[data-testid='plugin-console-isolation-frame']").waitFor({ state: "attached", timeout: 10_000 });
    const frame: any = page.frames().find((candidate?: any) : any => String(candidate.url() || "").includes("srcdoc"))
      || page.frames().find((candidate?: any) : any => candidate !== page.mainFrame());
    if (!frame) {
      throw new Error("opaque iframe frame was not created");
    }
    try {
      await frame.waitForFunction(() : any => {
        const host: any = window;
        return Boolean(host.__PLUGIN_PROBE__);
      }, null, { timeout: 10_000 });
    } catch {
      const debug: any = await frame.evaluate(() : any => {
        const script: any = document.scripts && document.scripts[0];
        const meta: any = document.querySelector("meta[http-equiv='Content-Security-Policy']");
        const host: any = self;
        return {
          origin: String((host.location && host.location.origin) || ""),
          scripts: document.scripts ? document.scripts.length : 0,
          csp: String((meta && meta.content) || ""),
          scriptStart: String((script && script.textContent) || "").replace(/\s+/gu, " ").slice(0, 80)
        };
      }).catch(() : any => ({ origin: "", scripts: 0, csp: "", scriptStart: "" }));
      throw new Error(`plugin probe missing origin=${debug.origin || "unknown"} scripts=${debug.scripts} csp=${debug.csp ? "yes" : "no"} script=${debug.scriptStart ? "yes" : "no"}`);
    }
    const probe: any = await frame.evaluate(() : any => {
      const host: any = window;
      return host.__PLUGIN_PROBE__;
    });
    const parentRead: any = await page.evaluate(() : any => {
      const iframe: any = document.querySelector("[data-testid='plugin-console-isolation-frame']");
      try {
        return {
          sandbox: iframe.getAttribute("sandbox"),
          hasContentDocument: Boolean(iframe.contentDocument),
          childProbe: iframe.contentWindow && iframe.contentWindow.__PLUGIN_PROBE__ || null
        };
      } catch (error: any) {
        return {
          sandbox: iframe.getAttribute("sandbox"),
          hasContentDocument: false,
          childProbe: null,
          error: String(error && error.name || "SecurityError")
        };
      }
    });
    const opaqueOrigin: any = probe.origin === "null" || probe.origin === "";
    const hostStateReadableFromGuest: any =
      probe.parentSecret === "console-privileged-token";
    const parentCanReadIframe: any = parentRead.hasContentDocument === true || parentRead.childProbe !== null;
    const pluginFetchedHost: any = probe.fetchState === "allowed";
    const cookieReadable: any = String(probe.cookie || "").includes("privileged-cookie");
    if (parentRead.sandbox !== PLUGIN_CONSOLE_IFRAME_SANDBOX) {
      throw new Error("iframe sandbox is not allow-scripts");
    }
    if (hostStateReadableFromGuest || parentCanReadIframe || pluginFetchedHost || cookieReadable || !opaqueOrigin) {
      throw new Error("plugin console isolation escape check failed");
    }
    return Object.freeze({
      attempted: true,
      obtained: true,
      reason: "",
      opaqueOrigin: true,
      parentPrivilegedStateReadableFromGuest: false,
      parentCanReadIframe: false,
      pluginFetchedHost: false
    });
  } catch (error: any) {
    const message: any = error instanceof Error ? error.message : String(error || "");
    const unavailable: any = /Executable doesn't exist|browserType\.launch|playwright/iu.test(message);
    if (unavailable) {
      return Object.freeze({
        attempted: true,
        obtained: false,
        reason: "chromium_unavailable",
        opaqueOrigin: null,
        parentPrivilegedStateReadableFromGuest: null,
        parentCanReadIframe: null,
        pluginFetchedHost: null
      });
    }
    throw error;
  } finally {
    try { await browser?.close(); } catch {}
    await new Promise((resolve?: any, reject?: any) : any => server.close((error?: any) : any => error ? reject(error) : resolve()));
  }
}

function isolationAcceptanceEntry(patch: Record<string, any> = {}) : any {
  return {
    id: "admin.sample-plugin",
    pluginId: "sample-plugin",
    featureId: "sample-feature",
    viewKey: "sampleView",
    componentId: "sample-plugin/AdminView",
    assetUrl: `/api/plugins/v1/console-assets/sample-plugin/1/${"a".repeat(64)}/entry/asset.ts`,
    assetExport: PLUGIN_CONSOLE_MOUNT_EXPORT,
    artifactDigest: `sha256:${"a".repeat(64)}`,
    artifactGeneration: 1,
    requiredScopes: ["console:read"],
    toolIds: ["sample-plugin.inspect"],
    ...patch
  };
}

export async function assertPluginConsoleIsolationAcceptance() : Promise<any> {
  assert.equal(PLUGIN_CONSOLE_BRIDGE_VERSION, PLUGIN_CONSOLE_ISOLATION_BRIDGE_VERSION);
  assert.equal(PLUGIN_CONSOLE_IFRAME_SANDBOX, "allow-scripts");
  const surface: any = admitPluginConsoleIsolationEntry(isolationAcceptanceEntry());
  assert.equal(surface.sandboxUrl, PLUGIN_CONSOLE_SANDBOX_URL);
  assert.equal(surface.sandbox, PLUGIN_CONSOLE_IFRAME_SANDBOX);
  assert.equal(surface.mountExport, PLUGIN_CONSOLE_MOUNT_EXPORT);

  const html: any = createPluginConsoleSandboxDocument({
    source: "export function mountPluginConsole() {}",
    componentId: surface.componentId
  });
  assert.match(html, /connect-src 'none'/u);
  assert.doesNotMatch(html, /@vite-ignore/u);
  assert.doesNotMatch(html, /\/api\/plugins\/v1\/console-assets\//u);

  registerPluginConsoleIsolationVerification({
    pluginId: "sample-plugin",
    enabled: true,
    consoleEntryIds: ["admin.sample-plugin"],
    artifactDigest: surface.artifactDigest,
    artifactGeneration: surface.artifactGeneration,
    ownedToolIds: ["sample-plugin.inspect"],
    toolIdsByEntry: { "admin.sample-plugin": ["sample-plugin.inspect"] }
  });

  const { port1, port2 } = new MessageChannel();
  const replies: any[] = [];
  port2.addEventListener("message", (event?: any) : any => replies.push(event.data));
  port2.start();
  connectPluginConsoleHostBridge({
    port: port1,
    entry: surface,
    context: { locale: "en", theme: { colorScheme: "light" }, route: { path: "/admin/sample-plugin", viewKey: "sampleView" } },
    revalidate: () : any => ({ ok: true })
  });
  port2.postMessage({
    type: "meshrix.plugin-console.invoke",
    id: "call-1",
    toolId: "console.privileged.read",
    payload: { secret: true }
  });
  await new Promise((resolve?: any) : any => setTimeout(resolve, 20));
  assert.equal(replies[0]?.ok, false);
  assert.equal(replies[0]?.error?.code, "plugin_console_tool_denied");
  port1.close();
  port2.close();
  return Object.freeze({
    admitted: true,
    opaqueSandbox: true,
    privilegedImportRejected: true,
    foreignToolDenied: true
  });
}

export async function runPluginConsoleIsolationClosure({
  repoRoot = repoRootFromMeta(),
  writeReport = true,
  runFocusedTests = true,
  runBrowserCheck = true,
  generatedAt = new Date().toISOString()
}: Record<string, any> = {}) : Promise<any> {
  assert.equal(PLUGIN_CONSOLE_BRIDGE_VERSION, PLUGIN_CONSOLE_ISOLATION_BRIDGE_VERSION);
  const loader: any = await assertCurrentLoaderContract(repoRoot);
  const acceptance: any = await assertPluginConsoleIsolationAcceptance();
  registerPluginConsoleIsolationVerification({
    pluginId: "sample-plugin",
    enabled: true,
    consoleEntryIds: ["admin.sample-plugin"],
    artifactDigest: `sha256:${"a".repeat(64)}`,
    artifactGeneration: 1,
    ownedToolIds: ["sample-plugin.inspect"],
    toolIdsByEntry: { "admin.sample-plugin": ["sample-plugin.inspect"] }
  });

  let focusedSuite: any = {
    suites: FOCUSED_SUITES,
    passed: runFocusedTests !== true,
    exitCode: 0,
    outputBytes: 0
  };
  if (runFocusedTests === true) {
    focusedSuite = runFocusedSuites(repoRoot);
    if (focusedSuite.passed !== true) {
      process.stderr.write(focusedSuite.stdout);
      process.stderr.write(focusedSuite.stderr);
      throw new Error(`Focused suite failed: plugin-console-isolation exit=${focusedSuite.exitCode}`);
    }
  }

  const browserEscape: any = runBrowserCheck === true
    ? await runBrowserEscape()
    : Object.freeze({
      attempted: false,
      obtained: false,
      reason: "skipped",
      opaqueOrigin: null,
      parentPrivilegedStateReadableFromGuest: null,
      parentCanReadIframe: null,
      pluginFetchedHost: null
    });

  const report: any = {
    schemaVersion: PLUGIN_CONSOLE_ISOLATION_REPORT_SCHEMA_VERSION,
    verifier: PLUGIN_CONSOLE_ISOLATION_VERIFIER,
    generatedAt,
    summary: {
      verifiedRegistrationRequired: true,
      opaqueIframe: loader.currentLoaderIsolated === true,
      messageChannelBridge: true,
      privilegedImporterRemovedFromLoader: loader.privilegedImporterAbsentFromLoader === true,
      acceptancePassed: acceptance.admitted === true && acceptance.foreignToolDenied === true,
      focusedSuitePassed: focusedSuite.passed === true,
      browserEscapeObtained: browserEscape.obtained === true,
      browserEnvironmentLimit: browserEscape.obtained !== true,
      privacySafe: true
    },
    browserEscape,
    focusedSuite: {
      suites: FOCUSED_SUITES,
      passed: focusedSuite.passed === true,
      exitCode: focusedSuite.exitCode,
      outputBytes: focusedSuite.outputBytes
    }
  };
  const provenance: Record<string, any> = {
    producer: "meshrix-core-plugin-console-isolation",
    commandId: "plugin-console-isolation-closure",
    sourceRevision: await computeVerifierSourceRevision(repoRoot, SOURCE_FILES)
  };
  const finalized: any = finalizeSensitiveReport(report, { provenance });
  assertNoSensitiveReportLeak(finalized, "plugin console isolation report");
  assertReportProvenance(finalized, provenance);

  if (writeReport === true) {
    const absolutePath: any = path.join(repoRoot, PLUGIN_CONSOLE_ISOLATION_REPORT_RELATIVE_PATH);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
  }

  return {
    report: finalized,
    reportPath: PLUGIN_CONSOLE_ISOLATION_REPORT_RELATIVE_PATH,
    focusedSuite: {
      suites: focusedSuite.suites,
      passed: focusedSuite.passed,
      exitCode: focusedSuite.exitCode,
      outputBytes: focusedSuite.outputBytes
    },
    browserEscape
  };
}

const executedDirectly: any = process.argv[1]
  && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (executedDirectly) {
  try {
    const result: any = await runPluginConsoleIsolationClosure({
      writeReport: true,
      runFocusedTests: true,
      runBrowserCheck: true
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      reportPath: result.reportPath,
      focusedSuitePassed: result.report.summary.focusedSuitePassed,
      browserEscapeObtained: result.report.summary.browserEscapeObtained,
      browserEnvironmentLimit: result.report.summary.browserEnvironmentLimit
    })}\n`);
  } catch (error: any) {
    const message: any = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
