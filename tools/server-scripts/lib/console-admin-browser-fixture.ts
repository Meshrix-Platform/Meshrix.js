import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startHttpServer } from "../../../apps/server/runtime/http-server.ts";
import { readInitialOwnerCredentials } from "../test-auth-helper.ts";

export const CONSOLE_ADMIN_BROWSER_PLUGIN_IDS: readonly any[] = Object.freeze([]);
export const CONSOLE_ADMIN_BROWSER_ROUTE_SLUGS: readonly any[] = Object.freeze([]);
export const CONSOLE_ADMIN_BROWSER_WORKSPACE_SLOT_IDS: readonly any[] = Object.freeze([]);

export function adminRouteUrl(serverUrl?: any, slug?: any) : any {
  return `${serverUrl}/#/admin/${slug}`;
}

export async function ensureBuiltConsole(distPath?: any) : Promise<any> {
  try {
    await fs.access(path.join(distPath, "index.html"));
  } catch {
    throw new Error("Built console assets are missing. Run `npm run build` before browser visual verification.");
  }
}

function splitSetCookie(value: any = "") : any {
  return String(value || "")
    .split(/,(?=\s*[^;,=\s]+=[^;,]*;)/u)
    .map((item?: any) : any => item.trim())
    .filter(Boolean);
}

function setCookiesFrom(response?: any) : any {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  return splitSetCookie(response.headers.get("set-cookie") || "");
}

function cookieForBrowser(setCookie: any = "", origin: any = "") : any {
  const [nameValue, ...attributes] = String(setCookie || "").split(";").map((item?: any) : any => item.trim());
  const [name, ...valueParts] = nameValue.split("=");
  const url: any = new URL(origin);
  const cookie: Record<string, any> = {
    name,
    value: valueParts.join("="),
    domain: url.hostname,
    path: "/"
  };
  for (const attribute of attributes) {
    const [rawKey, ...rawValue] = attribute.split("=");
    const key: any = rawKey.trim().toLowerCase();
    const value: any = rawValue.join("=").trim();
    if (key === "path" && value) {
      cookie.path = value;
    } else if (key === "domain" && value) {
      cookie.domain = value.replace(/^\./u, "");
    } else if (key === "httponly") {
      cookie.httpOnly = true;
    } else if (key === "secure") {
      cookie.secure = true;
    } else if (key === "samesite" && value) {
      cookie.sameSite = value.toLowerCase() === "none"
        ? "None"
        : value.toLowerCase() === "strict"
          ? "Strict"
          : "Lax";
    }
  }
  return cookie;
}

export async function loginBrowserContext({ context, server }: Record<string, any>) : Promise<any> {
  const credentials: any = await readInitialOwnerCredentials(server);
  assert.ok(credentials.username, "initial owner username must be available");
  assert.ok(credentials.password, "initial owner password must be available for browser verifier login");
  const response: any = await fetch(`${server.url}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: credentials.username,
      password: credentials.password
    })
  });
  const payload: any = await response.json();
  assert.equal(response.status, 200, "owner login must succeed before browser navigation");
  const cookies: any = setCookiesFrom(response).map((cookie?: any) : any => cookieForBrowser(cookie, server.url));
  assert.ok(cookies.length > 0, "owner login must issue browser cookies");
  await context.addCookies(cookies);
  return {
    cookieCount: cookies.length,
    csrfTokenIssued: Boolean(payload.csrfToken)
  };
}

export async function loadPluginConsoleDeployment(context?: any, server?: any) : Promise<any> {
  const response: any = await context.request.get(`${server.url}/api/interfaces`);
  assert.equal(response.status(), 200, "authenticated interface discovery must succeed");
  const payload: any = await response.json();
  const plugins: any = payload?.features?.plugins || {};
  const enabledPluginIds: any = (plugins.enabledPlugins || []).map((plugin?: any) : any => plugin.id).sort();
  const consoleEntries: any = Array.isArray(plugins.consoleEntries) ? plugins.consoleEntries : [];
  return { enabledPluginIds, consoleEntries };
}

export function dynamicAdminRouteEntries(consoleEntries: any = []) : any {
  return consoleEntries
    .filter((entry?: any) : any => String(entry.routePath || "").startsWith("/admin/"))
    .map((entry?: any) : any => ({
      viewKey: entry.viewKey,
      slug: entry.routePath.slice("/admin/".length),
      componentName: entry.componentId,
      requiredScopes: entry.requiredScopes || [],
      requiredFeatureIds: [entry.featureId],
      description: entry.label || entry.id,
      pluginId: entry.pluginId
    }));
}

export async function verifyEmptyPluginSelection({ browser, distPath, repoRoot }: Record<string, any>) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-console-empty-plugins-"));
  let server: any = null;
  let context: any = null;
  try {
    server = await startHttpServer({
      userDataPath,
      distPath,
      port: 0,
      runtimeOptions: {
        edition: "core",
        workspaceRoot: repoRoot,
        enabledPlugins: []
      }
    });
    context = await browser.newContext({ locale: "zh-CN", reducedMotion: "reduce" });
    await loginBrowserContext({ context, server });
    const deployment: any = await loadPluginConsoleDeployment(context, server);
    assert.deepEqual(deployment.enabledPluginIds, [], "empty deployment must not enable plugins");
    assert.deepEqual(deployment.consoleEntries, [], "empty deployment must not publish plugin console entries");
    const page: any = await context.newPage();
    await page.goto(`${server.url}/#/`, { waitUntil: "domcontentloaded" });
    await page.locator(".dashboard-shell").waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await page.locator(".side-nav-section[aria-label='Plugins']").count(), 0, "empty deployment must not render plugin navigation");
    const rejectedAdminRoutes: any[] = [...CONSOLE_ADMIN_BROWSER_ROUTE_SLUGS];
    for (const slug of rejectedAdminRoutes) {
      await page.goto(adminRouteUrl(server.url, slug), { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() : any => window.location.hash.includes("/welcome"), null, { timeout: 10_000 });
      assert.notEqual(await page.evaluate(() : any => window.location.hash), `#/admin/${slug}`);
    }
    return {
      enabledPluginCount: 0,
      consoleEntryCount: 0,
      pluginNavigationVisible: false,
      rejectedAdminRoutes
    };
  } finally {
    await context?.close().catch(() : any => {});
    await server?.close().catch(() : any => {});
    await fs.rm(userDataPath, { recursive: true, force: true }).catch(() : any => {});
  }
}
