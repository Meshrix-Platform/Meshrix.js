#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { ADMIN_ROUTE_REGISTRY } from "../../apps/console/router/admin-route-registry.ts";
import { startHttpServer } from "../../apps/server/runtime/http-server.ts";
import {
  CONSOLE_ADMIN_WORKFLOW_CHECKS,
  CONSOLE_ADMIN_VIEWPORTS,
  createConsoleAdminBrowserAssertions
} from "./lib/console-admin-browser-assertions.ts";
import {
  CONSOLE_ADMIN_BROWSER_PLUGIN_IDS,
  CONSOLE_ADMIN_BROWSER_ROUTE_SLUGS,
  CONSOLE_ADMIN_BROWSER_WORKSPACE_SLOT_IDS,
  dynamicAdminRouteEntries,
  ensureBuiltConsole,
  loadPluginConsoleDeployment,
  loginBrowserContext,
  verifyEmptyPluginSelection
} from "./lib/console-admin-browser-fixture.ts";
import { stagePluginArtifactVerificationFixture } from "./lib/plugin-artifact-verification-fixture.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const distPath: any = path.join(repoRoot, "build", "dist");
const reportPath: any = "build/reports/console-admin-browser-visual.json";
const screenshotRoot: any = "build/reports/console-admin-browser-visual/screenshots";
const adminRouteFeatureIds: readonly any[] = Object.freeze([
  ...new Set<any>(ADMIN_ROUTE_REGISTRY.flatMap((entry?: any) : any => entry.requiredFeatureIds || []))
]);
const {
  assertNoLeak,
  verifyPluginRoutesRequireAuthentication,
  verifyRouteInViewport
} = createConsoleAdminBrowserAssertions({ repoRoot, screenshotRoot });

async function main() : Promise<any> {
  await ensureBuiltConsole(distPath);
  await fs.rm(path.join(repoRoot, screenshotRoot), { recursive: true, force: true });

  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-console-admin-browser-"));
  let server: any = null;
  let browser: any = null;
  let desktopContext: any = null;
  let mobileContext: any = null;
  let pluginArtifactFixture: any = null;
  const startedAt: any = new Date();

  try {
    pluginArtifactFixture = await stagePluginArtifactVerificationFixture({
      sourcePluginRoot: path.join(repoRoot, "plugins"),
      userDataPath
    });
    server = await startHttpServer({
      userDataPath,
      distPath,
      port: 0,
      runtimeOptions: {
        edition: "core",
        enableFeatures: adminRouteFeatureIds,
        enabledPlugins: CONSOLE_ADMIN_BROWSER_PLUGIN_IDS,
        workspaceRoot: repoRoot
      },
      pluginHostPorts: { artifactAuthority: pluginArtifactFixture.authority }
    });

    browser = await chromium.launch({ headless: true });
    desktopContext = await browser.newContext({
      locale: "zh-CN",
      colorScheme: "light",
      reducedMotion: "reduce",
      viewport: CONSOLE_ADMIN_VIEWPORTS.desktop
    });
    mobileContext = await browser.newContext({
      locale: "zh-CN",
      colorScheme: "light",
      reducedMotion: "reduce",
      viewport: CONSOLE_ADMIN_VIEWPORTS.mobile,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2
    });
    const auth: any = await loginBrowserContext({ context: desktopContext, server });
    const monitorProbe: any = await desktopContext.request.get(`${server.url}/api/system/monitor-alerts`);
    if (monitorProbe.status() !== 200) {
      const payload: any = await monitorProbe.json().catch(() : any => ({}));
      throw new Error(`monitor alerts preflight failed: ${JSON.stringify({
        status: monitorProbe.status(),
        code: payload?.code || "",
        reasonCode: payload?.reasonCode || ""
      })}`);
    }
    await mobileContext.addCookies(await desktopContext.cookies(server.url));
    const pluginDeployment: any = await loadPluginConsoleDeployment(desktopContext, server);
    assert.deepEqual(pluginDeployment.enabledPluginIds, [...CONSOLE_ADMIN_BROWSER_PLUGIN_IDS].sort());
    const pluginAdminRoutes: any = dynamicAdminRouteEntries(pluginDeployment.consoleEntries);
    assert.deepEqual(
      pluginAdminRoutes.map((entry?: any) : any => entry.slug).sort(),
      [...CONSOLE_ADMIN_BROWSER_ROUTE_SLUGS].sort(),
      "selected plugins must contribute the complete current admin route set"
    );
    assert.deepEqual(
      pluginDeployment.consoleEntries
        .filter((entry?: any) : any => entry.slotId && !entry.routePath)
        .map((entry?: any) : any => entry.slotId)
        .sort(),
      [...CONSOLE_ADMIN_BROWSER_WORKSPACE_SLOT_IDS].sort(),
      "selected plugins must contribute the complete current workspace slot set"
    );
    const allAdminRoutes: any[] = [...ADMIN_ROUTE_REGISTRY, ...pluginAdminRoutes];
    const deniedPluginRoutes: any = await verifyPluginRoutesRequireAuthentication({
      browser,
      serverUrl: server.url,
      entries: pluginAdminRoutes
    });

    const routeResults: any[] = [];
    for (const entry of allAdminRoutes) {
      routeResults.push(await verifyRouteInViewport({
        context: desktopContext,
        serverUrl: server.url,
        entry,
        viewportName: "desktop",
        viewport: CONSOLE_ADMIN_VIEWPORTS.desktop,
        fullRoute: true
      }));
    }
    for (const entry of allAdminRoutes) {
      routeResults.push(await verifyRouteInViewport({
        context: mobileContext,
        serverUrl: server.url,
        entry,
        viewportName: "mobile",
        viewport: CONSOLE_ADMIN_VIEWPORTS.mobile,
        fullRoute: true
      }));
    }

    await desktopContext.close();
    desktopContext = null;
    await mobileContext.close();
    mobileContext = null;
    const emptySelection: any = await verifyEmptyPluginSelection({ browser, distPath, repoRoot });

    const failedRoutes: any = routeResults.filter((result?: any) : any =>
      result.consoleErrors.length || result.pageErrors.length || result.apiFailures.length
    );
    const workflowResults: any = routeResults.filter((result?: any) : any => result.workflow);
    const report: Record<string, any> = {
      schemaVersion: "v0.0.1:console:admin-browser-visual-report-2",
      generatedAt: new Date().toISOString(),
      startedAt: startedAt.toISOString(),
      verifier: "tools/server-scripts/verify-console-admin-browser-visual.ts",
      browser: {
        engine: "chromium",
        headless: true,
        viewportCoverage: ["desktop:all-admin-routes", "mobile:all-admin-routes"]
      },
      server: {
        distPath: "build/dist",
        dataRoot: "temporary-redacted",
        auth: {
          method: "owner-login-api-cookie",
          cookieCount: auth.cookieCount,
          csrfTokenIssued: auth.csrfTokenIssued
        }
      },
      pluginDeployment: {
        enabledPluginIds: pluginDeployment.enabledPluginIds,
        consoleEntryCount: pluginDeployment.consoleEntries.length,
        adminRouteCount: pluginAdminRoutes.length,
        workspaceSlotCount: pluginDeployment.consoleEntries.filter((entry?: any) : any => entry.slotId).length,
        unauthenticatedDeniedRoutes: deniedPluginRoutes
      },
      emptySelection,
      routeResults,
      summary: {
        desktopRouteCount: allAdminRoutes.length,
        mobileRouteCount: allAdminRoutes.length,
        workflowViewportCount: workflowResults.length,
        screenshotCount: routeResults.length,
        consoleErrorCount: routeResults.reduce((sum?: any, item?: any) : any => sum + item.consoleErrors.length, 0),
        expectedConsoleErrorCount: routeResults.reduce((sum?: any, item?: any) : any => sum + (item.expectedConsoleErrors || []).length, 0),
        pageErrorCount: routeResults.reduce((sum?: any, item?: any) : any => sum + item.pageErrors.length, 0),
        apiFailureCount: routeResults.reduce((sum?: any, item?: any) : any => sum + item.apiFailures.length, 0),
        expectedApiResponseCount: routeResults.reduce((sum?: any, item?: any) : any => sum + (item.expectedApiResponses || []).length, 0),
        failedRouteCount: failedRoutes.length,
        failedRoutes: failedRoutes.map((item?: any) : any => `${item.viewport}:${item.slug}`),
        releaseReady: failedRoutes.length === 0,
        reportLeakScan: true
      }
    };

    assert.equal(workflowResults.length, Object.keys(CONSOLE_ADMIN_WORKFLOW_CHECKS).length * 2);
    assertNoLeak(report, "console admin browser visual report");
    await fs.mkdir(path.join(repoRoot, path.dirname(reportPath)), { recursive: true });
    await fs.writeFile(path.join(repoRoot, reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");

    if (!report.summary.releaseReady) {
      console.error(`[console-admin-browser-visual] report=${reportPath}`);
      for (const route of failedRoutes) {
        console.error(`- ${route.viewport}:${route.slug} ${JSON.stringify({
          consoleErrors: route.consoleErrors,
          pageErrors: route.pageErrors,
          apiFailures: route.apiFailures
        })}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`[console-admin-browser-visual] releaseReady=true report=${reportPath}`);
  } finally {
    await desktopContext?.close().catch(() : any => {});
    await mobileContext?.close().catch(() : any => {});
    await browser?.close().catch(() : any => {});
    await server?.close().catch(() : any => {});
    await pluginArtifactFixture?.close().catch(() : any => {});
    await fs.rm(userDataPath, { recursive: true, force: true }).catch(() : any => {});
  }
}

await main();
