import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { adminRouteUrl } from "./console-admin-browser-fixture.mjs";

export const CONSOLE_ADMIN_WORKFLOW_CHECKS = Object.freeze({
  "upstream-services": Object.freeze({
    id: "upstream-gateway",
    selector: ".upstream-gateway-layout",
    terms: ["上游服务", "发布来源", "审计"],
    interaction: "refresh"
  }),
  "version-assembly": Object.freeze({
    id: "version-assembly",
    selector: "[data-testid='version-assembly-view']",
    terms: ["版本装配", "装配输出", "生成装配目录包"],
    interaction: "expand-runtime-evidence"
  })
});

export const CONSOLE_ADMIN_VIEWPORTS = Object.freeze({
  desktop: Object.freeze({ width: 1366, height: 900 }),
  mobile: Object.freeze({ width: 390, height: 844, isMobile: true })
});

const SENSITIVE_REPORT_PATTERNS = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\/u],
  ["bearer_token", /Bearer\s+(?!\[redacted\]|<redacted-secret>)\S+/u],
  ["secret_token", /\bsk-[A-Za-z0-9._-]{8,}\b|upstream-secret-value/u],
  ["runtime_id", /\bgrant_[a-z0-9]{6,}_[a-f0-9]{8,}\b|\b(?:tool_exec|pending_op)_[A-Za-z0-9_-]{8,}\b|\btrace_[A-Fa-f0-9]{8,}\b/u],
  ["raw_payload", /raw prompt body|private file content/u]
]);

function classifyConsoleErrors({ consoleErrors = [] } = {}) {
  return { consoleErrors, expectedConsoleErrors: [] };
}

async function waitForStableRoute(page, entry, serverUrl) {
  await page.goto(adminRouteUrl(serverUrl, entry.slug), { waitUntil: "domcontentloaded" });
  await page.locator(".dashboard-shell").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(
    () => document.body && document.body.innerText.trim().length > 40,
    null,
    { timeout: 10_000 }
  );
  const hash = await page.evaluate(() => window.location.hash);
  assert.equal(hash, `#/admin/${entry.slug}`, `route hash must stay on /admin/${entry.slug}`);
}

async function readLayoutMetrics(page) {
  return page.evaluate(() => {
    const root = document.querySelector("#root");
    const rootRect = root?.getBoundingClientRect();
    const visibleControlCount = Array.from(document.querySelectorAll("button,input,textarea,select,a"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }).length;
    return {
      bodyTextLength: document.body.innerText.trim().length,
      rootVisible: Boolean(rootRect && rootRect.width > 100 && rootRect.height > 100),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      visibleControlCount
    };
  });
}

async function assertGenericAdminRoute(page, entry) {
  const bodyText = await page.locator("body").innerText({ timeout: 5_000 });
  assert.ok(!bodyText.includes("Admin view component not found"), `${entry.slug} must not use MissingAdminView`);
  assert.equal(await page.locator(".admin-error").count(), 0, `${entry.slug} must not render admin-error`);
  const metrics = await readLayoutMetrics(page);
  assert.ok(metrics.rootVisible, `${entry.slug} root must be visible`);
  assert.ok(metrics.bodyTextLength > 40, `${entry.slug} must render meaningful text`);
  return metrics;
}

async function runWorkflowInteraction(page, check) {
  const root = page.locator(check.selector).first();
  await root.waitFor({ state: "visible", timeout: 10_000 });
  if (check.interaction === "refresh") {
    const refreshButton = root.getByRole("button", { name: /^刷新(?:中)?$/u }).first();
    if (await refreshButton.count()) {
      const buttonHandle = await refreshButton.elementHandle();
      assert.ok(buttonHandle, `${check.id} refresh button must be attached`);
      await page.waitForFunction(
        (button) => !button.disabled && String(button.textContent || "").trim() === "刷新",
        buttonHandle,
        { timeout: 15_000 }
      );
      await refreshButton.click();
      await page.waitForFunction(
        (button) => !button.disabled && !/\u5237\u65b0\u4e2d|\u52a0\u8f7d\u4e2d/u.test(String(button.textContent || "")),
        buttonHandle,
        { timeout: 15_000 }
      );
    }
  } else if (check.interaction === "expand-runtime-evidence") {
    const summary = root.locator("details.version-assembly-runtime-evidence summary").first();
    if (await summary.count()) {
      await summary.click();
      await page.waitForTimeout(150);
    }
  }
}

async function assertWorkflow(page, entry, check) {
  await runWorkflowInteraction(page, check);
  const bodyText = await page.locator("body").innerText({ timeout: 5_000 });
  const matchedTerms = check.terms.filter((term) => bodyText.includes(term));
  assert.deepEqual(matchedTerms, check.terms, `${entry.slug} must render all expected workflow terms`);
  return {
    id: check.id,
    selector: check.selector,
    matchedTerms,
    interaction: check.interaction
  };
}

export function createConsoleAdminBrowserAssertions({ repoRoot, screenshotRoot }) {
  const dynamicRedactionNeedles = new Set([repoRoot, os.homedir()].filter(Boolean));

  function redactText(value = "") {
    let text = String(value || "");
    for (const needle of dynamicRedactionNeedles) {
      text = text.split(needle).join("[redacted-path]");
    }
    text = text.replace(/(?:\/Users\/|\/private\/|\/var\/folders\/)[^\s"'`]+/gu, "[redacted-path]");
    text = text.replace(/[A-Za-z]:\\[^\s"'`]+/gu, "[redacted-path]");
    text = text.replace(/Bearer\s+\S+/giu, "Bearer [redacted]");
    text = text.replace(/"token"\s*:\s*"[^"]+"/giu, "\"token\":\"[redacted]\"");
    text = text.replace(/meshrix_[A-Za-z0-9_-]{12,}/gu, "meshrix_[redacted]");
    text = text.replace(/\bgrant_[a-z0-9]{6,}_[a-f0-9]{8,}\b/giu, "grant_[redacted]");
    text = text.replace(/\b(?:tool_exec|pending_op)_[A-Za-z0-9_-]{8,}\b/gu, "[redacted-runtime-id]");
    text = text.replace(/\btrace_[A-Fa-f0-9]{8,}\b/gu, "trace_[redacted]");
    text = text.replace(/127\.0\.0\.1:\d+/gu, "127.0.0.1:[redacted-port]");
    text = text.replace(/localhost:\d+/gu, "localhost:[redacted-port]");
    return text;
  }

  function assertNoLeak(value, label) {
    const text = JSON.stringify(value);
    for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
      if (pattern.test(text)) {
        throw new Error(`${label} contains sensitive local or runtime data: ${kind}`);
      }
    }
  }

  async function captureScreenshot(page, entry, viewportName) {
    const screenshotPath = `${screenshotRoot}/${viewportName}/${entry.slug}.png`;
    const buffer = await page.screenshot({ fullPage: true, animations: "disabled" });
    assert.ok(buffer.byteLength > 6_000, `${entry.slug} ${viewportName} screenshot must not be blank`);
    await fs.mkdir(path.join(repoRoot, path.dirname(screenshotPath)), { recursive: true });
    await fs.writeFile(path.join(repoRoot, screenshotPath), buffer);
    return { path: screenshotPath, byteLength: buffer.byteLength };
  }

  async function verifyPluginRoutesRequireAuthentication({ browser, serverUrl, entries }) {
    const context = await browser.newContext({ locale: "zh-CN", reducedMotion: "reduce" });
    const deniedRoutes = [];
    try {
      const page = await context.newPage();
      for (const entry of entries) {
        await page.goto(adminRouteUrl(serverUrl, entry.slug), { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.location.hash.includes("/welcome"), null, { timeout: 10_000 });
        const hash = await page.evaluate(() => window.location.hash);
        assert.ok(hash.includes("/welcome"), `${entry.slug} must redirect unauthenticated navigation to welcome`);
        const selector = CONSOLE_ADMIN_WORKFLOW_CHECKS[entry.slug]?.selector;
        if (selector) assert.equal(await page.locator(selector).count(), 0, `${entry.slug} must not load before authorization`);
        deniedRoutes.push(entry.slug);
      }
    } finally {
      await context.close();
    }
    return deniedRoutes;
  }

  async function verifyRouteInViewport({ context, serverUrl, entry, viewportName, viewport, fullRoute }) {
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const apiFailures = [];
    const resourceFailures = [];
    const expectedApiResponses = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(redactText(message.text()).slice(0, 400));
    });
    page.on("pageerror", (error) => {
      pageErrors.push(redactText(error?.stack || error?.message || error).slice(0, 800));
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (response.status() >= 400 && !url.pathname.startsWith("/api/")) {
        resourceFailures.push({ status: response.status(), path: url.pathname });
      }
      if (url.pathname.startsWith("/api/") && response.status() >= 400 && url.pathname !== "/api/auth/login") {
        const apiResponse = { status: response.status(), path: url.pathname };
        apiFailures.push(apiResponse);
      }
    });
    page.on("requestfailed", (request) => {
      const url = new URL(request.url());
      resourceFailures.push({
        status: 0,
        path: url.pathname,
        reason: redactText(request.failure()?.errorText || "request-failed")
      });
    });

    try {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await waitForStableRoute(page, entry, serverUrl);
      const layout = await assertGenericAdminRoute(page, entry);
      const emulation = await page.evaluate(() => ({
        coarsePointer: window.matchMedia("(pointer: coarse)").matches,
        hoverNone: window.matchMedia("(hover: none)").matches,
        maxTouchPoints: navigator.maxTouchPoints
      }));
      if (viewport.isMobile === true) {
        assert.equal(emulation.coarsePointer, true, `${entry.slug} mobile run must emulate a coarse pointer`);
        assert.equal(emulation.hoverNone, true, `${entry.slug} mobile run must emulate hover:none`);
        assert.ok(emulation.maxTouchPoints > 0, `${entry.slug} mobile run must expose touch input`);
        assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `${entry.slug} mobile document must not overflow horizontally`);
      }
      const workflowCheck = CONSOLE_ADMIN_WORKFLOW_CHECKS[entry.slug] || null;
      const workflow = workflowCheck ? await assertWorkflow(page, entry, workflowCheck) : null;
      const screenshot = await captureScreenshot(page, entry, viewportName);
      const consoleClassification = classifyConsoleErrors({ entry, consoleErrors, expectedApiResponses });
      return {
        slug: entry.slug,
        viewKey: entry.viewKey,
        componentName: entry.componentName,
        viewport: viewportName,
        routeCoverage: fullRoute ? "registry-route" : "workflow-check",
        layout,
        emulation,
        workflow,
        screenshot,
        consoleErrors: consoleClassification.consoleErrors,
        expectedConsoleErrors: consoleClassification.expectedConsoleErrors,
        pageErrors,
        apiFailures,
        expectedApiResponses
      };
    } catch (error) {
      const pageState = await page.evaluate(() => ({
        hash: window.location.hash,
        rootChildCount: document.querySelector("#root")?.childElementCount || 0,
        rootTextLength: document.querySelector("#root")?.textContent?.trim().length || 0,
        scriptCount: document.scripts.length
      })).catch(() => ({ hash: "", rootChildCount: 0, rootTextLength: 0, scriptCount: 0 }));
      throw new Error(`${entry.slug} ${viewportName} route did not stabilize: ${JSON.stringify({
        ...pageState,
        consoleErrors,
        pageErrors,
        apiFailures,
        resourceFailures
      })}`, { cause: error });
    } finally {
      await page.close().catch(() => {});
    }
  }

  return { assertNoLeak, verifyPluginRoutesRequireAuthentication, verifyRouteInViewport };
}
