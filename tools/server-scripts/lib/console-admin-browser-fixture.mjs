import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startHttpServer } from "../../../apps/server/runtime/http-server.mjs";
import { readInitialOwnerCredentials } from "../test-auth-helper.mjs";

export const CONSOLE_ADMIN_BROWSER_PLUGIN_IDS = Object.freeze([]);
export const CONSOLE_ADMIN_BROWSER_ROUTE_SLUGS = Object.freeze([]);
export const CONSOLE_ADMIN_BROWSER_WORKSPACE_SLOT_IDS = Object.freeze([]);

export function adminRouteUrl(serverUrl, slug) {
  return `${serverUrl}/#/admin/${slug}`;
}

export async function ensureBuiltConsole(distPath) {
  try {
    await fs.access(path.join(distPath, "index.html"));
  } catch {
    throw new Error("Built console assets are missing. Run `npm run build` before browser visual verification.");
  }
}

function splitSetCookie(value = "") {
  return String(value || "")
    .split(/,(?=\s*[^;,=\s]+=[^;,]*;)/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function setCookiesFrom(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  return splitSetCookie(response.headers.get("set-cookie") || "");
}

function cookieForBrowser(setCookie = "", origin = "") {
  const [nameValue, ...attributes] = String(setCookie || "").split(";").map((item) => item.trim());
  const [name, ...valueParts] = nameValue.split("=");
  const url = new URL(origin);
  const cookie = {
    name,
    value: valueParts.join("="),
    domain: url.hostname,
    path: "/"
  };
  for (const attribute of attributes) {
    const [rawKey, ...rawValue] = attribute.split("=");
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.join("=").trim();
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

export async function loginBrowserContext({ context, server }) {
  const credentials = await readInitialOwnerCredentials(server);
  assert.ok(credentials.username, "initial owner username must be available");
  assert.ok(credentials.password, "initial owner password must be available for browser verifier login");
  const response = await fetch(`${server.url}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: credentials.username,
      password: credentials.password
    })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, "owner login must succeed before browser navigation");
  const cookies = setCookiesFrom(response).map((cookie) => cookieForBrowser(cookie, server.url));
  assert.ok(cookies.length > 0, "owner login must issue browser cookies");
  await context.addCookies(cookies);
  return {
    cookieCount: cookies.length,
    csrfTokenIssued: Boolean(payload.csrfToken)
  };
}

export async function loadPluginConsoleDeployment(context, server) {
  const response = await context.request.get(`${server.url}/api/interfaces`);
  assert.equal(response.status(), 200, "authenticated interface discovery must succeed");
  const payload = await response.json();
  const plugins = payload?.features?.plugins || {};
  const enabledPluginIds = (plugins.enabledPlugins || []).map((plugin) => plugin.id).sort();
  const consoleEntries = Array.isArray(plugins.consoleEntries) ? plugins.consoleEntries : [];
  return { enabledPluginIds, consoleEntries };
}

export function dynamicAdminRouteEntries(consoleEntries = []) {
  return consoleEntries
    .filter((entry) => String(entry.routePath || "").startsWith("/admin/"))
    .map((entry) => ({
      viewKey: entry.viewKey,
      slug: entry.routePath.slice("/admin/".length),
      componentName: entry.componentId,
      requiredScopes: entry.requiredScopes || [],
      requiredFeatureIds: [entry.featureId],
      description: entry.label || entry.id,
      pluginId: entry.pluginId
    }));
}

export async function verifyEmptyPluginSelection({ browser, distPath, repoRoot }) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-console-empty-plugins-"));
  let server = null;
  let context = null;
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
    const deployment = await loadPluginConsoleDeployment(context, server);
    assert.deepEqual(deployment.enabledPluginIds, [], "empty deployment must not enable plugins");
    assert.deepEqual(deployment.consoleEntries, [], "empty deployment must not publish plugin console entries");
    const page = await context.newPage();
    await page.goto(`${server.url}/#/`, { waitUntil: "domcontentloaded" });
    await page.locator(".dashboard-shell").waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await page.locator(".side-nav-section[aria-label='Plugins']").count(), 0, "empty deployment must not render plugin navigation");
    const rejectedAdminRoutes = [...CONSOLE_ADMIN_BROWSER_ROUTE_SLUGS];
    for (const slug of rejectedAdminRoutes) {
      await page.goto(adminRouteUrl(server.url, slug), { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.location.hash.includes("/welcome"), null, { timeout: 10_000 });
      assert.notEqual(await page.evaluate(() => window.location.hash), `#/admin/${slug}`);
    }
    return {
      enabledPluginCount: 0,
      consoleEntryCount: 0,
      pluginNavigationVisible: false,
      rejectedAdminRoutes
    };
  } finally {
    await context?.close().catch(() => {});
    await server?.close().catch(() => {});
    await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {});
  }
}
