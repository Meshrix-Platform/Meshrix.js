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
  parseConsoleAdminViewSelection,
  verifyEmptyPluginSelection
} from "./lib/console-admin-browser-fixture.ts";
import { stagePluginArtifactVerificationFixture } from "./lib/plugin-artifact-verification-fixture.ts";
import { provisionVerifierLocalSecretKey } from "./lib/local-secret-verifier-key.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const distPath: any = path.join(repoRoot, "build", "dist");
const selectedViewKeys: readonly string[] = parseConsoleAdminViewSelection(
  process.argv.slice(2),
  ADMIN_ROUTE_REGISTRY
);
const scopedRun: boolean = selectedViewKeys.length > 0;
const selectedRouteEntries: readonly any[] = scopedRun
  ? Object.freeze(
      ADMIN_ROUTE_REGISTRY.filter((entry: any) => selectedViewKeys.includes(entry.viewKey))
    )
  : ADMIN_ROUTE_REGISTRY;
const reportPath: any = scopedRun
  ? "build/reports/console-admin-browser-visual-scoped.json"
  : "build/reports/console-admin-browser-visual.json";
const screenshotRoot: any = scopedRun
  ? "build/reports/console-admin-browser-visual-scoped/screenshots"
  : "build/reports/console-admin-browser-visual/screenshots";
const adminRouteFeatureIds: readonly any[] = Object.freeze([
  ...new Set<any>(selectedRouteEntries.flatMap((entry?: any) : any => entry.requiredFeatureIds || []))
]);
const {
  assertNoLeak,
  verifyPluginRoutesRequireAuthentication,
  verifyRouteInViewport
} = createConsoleAdminBrowserAssertions({ repoRoot, screenshotRoot });

async function main() : Promise<any> {
  const localSecretKeyCustody: any = await provisionVerifierLocalSecretKey();
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
    if (!scopedRun) {
      pluginArtifactFixture = await stagePluginArtifactVerificationFixture({
        sourcePluginRoot: path.join(repoRoot, "plugins"),
        userDataPath
      });
    }
    server = await startHttpServer({
      userDataPath,
      distPath,
      port: 0,
      runtimeOptions: {
        edition: "core",
        enableFeatures: adminRouteFeatureIds,
        enabledPlugins: scopedRun ? [] : CONSOLE_ADMIN_BROWSER_PLUGIN_IDS,
        workspaceRoot: repoRoot
      },
      pluginHostPorts: scopedRun
        ? undefined
        : { artifactAuthority: pluginArtifactFixture.authority }
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
    let pluginDeployment: any = null;
    let pluginAdminRoutes: any[] = [];
    let deniedPluginRoutes: any = [];
    if (!scopedRun) {
      pluginDeployment = await loadPluginConsoleDeployment(desktopContext, server);
      assert.deepEqual(pluginDeployment.enabledPluginIds, [...CONSOLE_ADMIN_BROWSER_PLUGIN_IDS].sort());
      pluginAdminRoutes = dynamicAdminRouteEntries(pluginDeployment.consoleEntries);
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
      deniedPluginRoutes = await verifyPluginRoutesRequireAuthentication({
        browser,
        serverUrl: server.url,
        entries: pluginAdminRoutes
      });
    }
    const allAdminRoutes: any[] = scopedRun
      ? [...selectedRouteEntries]
      : [...ADMIN_ROUTE_REGISTRY, ...pluginAdminRoutes];

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
    const emptySelection: any = scopedRun
      ? null
      : await verifyEmptyPluginSelection({ browser, distPath, repoRoot });
    // Successful functional evidence includes normal shutdown. Cleanup failures
    // must fail this command before dependent profiling work can be scheduled.
    await browser.close();
    browser = null;
    await server.close();
    server = null;
    await pluginArtifactFixture?.close();
    pluginArtifactFixture = null;

    const failedRoutes: any = routeResults.filter((result?: any) : any =>
      result.consoleErrors.length || result.pageErrors.length || result.apiFailures.length
    );
    const workflowResults: any = routeResults.filter((result?: any) : any => result.workflow);
    const report: Record<string, any> = {
      schemaVersion: "v0.0.1:console:admin-browser-visual-report-2",
      generatedAt: new Date().toISOString(),
      startedAt: startedAt.toISOString(),
      verifier: "tools/server-scripts/verify-console-admin-browser-visual.ts",
      scope: {
        selectedViewKeys: [...selectedViewKeys],
        scoped: scopedRun
      },
      browser: {
        engine: "chromium",
        headless: true,
        viewportCoverage: [
          scopedRun ? "desktop:selected-admin-routes" : "desktop:all-admin-routes",
          scopedRun ? "mobile:selected-admin-routes" : "mobile:all-admin-routes"
        ]
      },
      server: {
        distPath: "build/dist",
        dataRoot: "temporary-redacted",
        normalShutdown: true,
        auth: {
          method: "owner-login-api-cookie",
          cookieCount: auth.cookieCount,
          csrfTokenIssued: auth.csrfTokenIssued
        }
      },
      pluginDeployment: pluginDeployment
        ? {
            enabledPluginIds: pluginDeployment.enabledPluginIds,
            consoleEntryCount: pluginDeployment.consoleEntries.length,
            adminRouteCount: pluginAdminRoutes.length,
            workspaceSlotCount: pluginDeployment.consoleEntries.filter((entry?: any) : any => entry.slotId).length,
            unauthenticatedDeniedRoutes: deniedPluginRoutes
          }
        : { skipped: "scoped-run" },
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
        ...(scopedRun
          ? { scopedReady: failedRoutes.length === 0 }
          : { releaseReady: failedRoutes.length === 0 }),
        reportLeakScan: true
      }
    };

    const expectedWorkflowCount: any = allAdminRoutes.filter(
      (entry: any) : any => CONSOLE_ADMIN_WORKFLOW_CHECKS[entry.slug]
    ).length * 2;
    assert.equal(workflowResults.length, expectedWorkflowCount);
    assertNoLeak(report, "console admin browser visual report");
    await fs.mkdir(path.join(repoRoot, path.dirname(reportPath)), { recursive: true });
    await fs.writeFile(path.join(repoRoot, reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");

    const scopeReady: any = scopedRun ? report.summary.scopedReady : report.summary.releaseReady;
    if (!scopeReady) {
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
    console.log(
      `[console-admin-browser-visual] ${scopedRun ? "scopedReady" : "releaseReady"}=true report=${reportPath}`
    );
  } finally {
    await desktopContext?.close().catch(() : any => {});
    await mobileContext?.close().catch(() : any => {});
    await browser?.close().catch(() : any => {});
    await server?.close().catch(() : any => {});
    await pluginArtifactFixture?.close().catch(() : any => {});
    await localSecretKeyCustody.close().catch(() : any => {});
    await fs.rm(userDataPath, { recursive: true, force: true }).catch(() : any => {});
  }
}

await main();
