import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";
import {
  RELEASE_JOURNEY_VISUAL_CAPTURE,
  readPngDimensions
} from "./release-journey-visual-contract.ts";

export const RELEASE_JOURNEY_VISUAL_ROOT: any =
  "build/reports/upstream-service-publishing/screenshots";
export const RELEASE_JOURNEY_VISUAL_MASKING_POLICY: any = "protected-values-only";
export const RELEASE_JOURNEY_VISUAL_PROTECTED_SELECTORS: readonly any[] = Object.freeze([
  ".identity-chip",
  ".service-url-badge",
  "[data-protected]"
]);

export const RELEASE_JOURNEY_VISUAL_CHECKPOINTS: readonly any[] = Object.freeze([
  ["console-authenticated", "Authenticated Meshrix Console", "/admin/publish-upstream-service"],
  ["console-upstream-basic-config", "Upstream service basic configuration", "/admin/publish-upstream-service"],
  ["console-upstream-operation-config", "Upstream operation configuration", "/admin/publish-upstream-service"],
  ["console-upstream-published", "Published upstream service and runtime health", "/admin/publish-upstream-service"],
  ["console-published-tool", "Published operation in the tool catalog", "/admin/tool-list"],
  ["console-token-authorization-pending", "Pending MCP device authorization", "/approval"],
  ["console-token-authorization-consumed", "Completed MCP device authorization", "/approval"],
  ["console-operation-approval-pending", "Pending Operation Permission approval", "/approval"],
  ["console-operation-approval-completed", "Completed Operation Permission approval", "/approval"],
  ["console-downstream-mcp-call", "Downstream MCP call in the Console audit", "/admin/tool-stats"]
]);

export const RELEASE_JOURNEY_APPROVAL_UI: Readonly<Record<string, any>> = Object.freeze({
  card: '[data-testid="approval-request-card"], [data-approval-kind], .approval-request-card',
  authorizationCard: '[data-approval-kind="authorization"]',
  operationCard: '[data-approval-kind="pendingOperation"]',
  mcpApprove: '[data-action="mcp-approve"]',
  operationApprove: '[data-action="operation-approve"]',
  protected: "[data-protected]",
  technicalDetails: 'details[data-section="technical-details"]',
  confirmDialog: '[role="alertdialog"], [role="dialog"]',
  pendingStatus:
    '[role="tab"][data-value="pending"], [role="tab"][data-option-value="pending"], [role="tab"][value="pending"]',
  allStatus:
    '[role="tab"][data-value="all"], [role="tab"][data-option-value="all"], [role="tab"][value="all"]'
});

export function intersectReleaseJourneyMaskRectangle(rectangle?: any, clippingRegions: any = []) : any {
  if (!isUsableRectangle(rectangle) || !Array.isArray(clippingRegions)) return null;

  let left: any = rectangle.x;
  let top: any = rectangle.y;
  let right: any = rectangle.x + rectangle.width;
  let bottom: any = rectangle.y + rectangle.height;

  for (const region of clippingRegions) {
    if (!isUsableRectangle(region)) continue;
    if (region.clipX !== false) {
      left = Math.max(left, region.x);
      right = Math.min(right, region.x + region.width);
    }
    if (region.clipY !== false) {
      top = Math.max(top, region.y);
      bottom = Math.min(bottom, region.y + region.height);
    }
  }

  if (right <= left || bottom <= top) return null;
  return Object.freeze({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  });
}

const CHECKPOINT_BY_ID: any = new Map<any, any>(
  RELEASE_JOURNEY_VISUAL_CHECKPOINTS.map(([id, title, route]: any[]) : any => [id, { title, route }])
);

export async function createReleaseJourneyVisualRecorder({ repoRoot, baseUrl }: Record<string, any>) : Promise<any> {
  const root: any = path.join(repoRoot, RELEASE_JOURNEY_VISUAL_ROOT);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true, mode: 0o700 });

  const expectedOrigin: any = new URL(baseUrl).origin;
  const browser: any = await chromium.launch({ headless: true });
  const context: any = await browser.newContext({
    locale: "zh-CN",
    colorScheme: "light",
    reducedMotion: "reduce",
    viewport: RELEASE_JOURNEY_VISUAL_CAPTURE.viewport,
    deviceScaleFactor: RELEASE_JOURNEY_VISUAL_CAPTURE.deviceScaleFactor
  });
  await context.route("**/*", async (route?: any) : Promise<any> => {
    const requestUrl: any = new URL(route.request().url());
    if (requestUrl.protocol === "data:" || requestUrl.origin === expectedOrigin) {
      await route.continue();
      return;
    }
    await route.abort("blockedbyclient");
  });

  const page: any = await context.newPage();
  const evidence: any[] = [];
  const browserFindings: any[] = [];
  page.on("console", (message?: any) : any => {
    if (message.type() === "error") {
      const resourceFailure: any = /Failed to load resource|ERR_/u.test(message.text());
      let sourcePath: any = "unknown";
      try {
        sourcePath = new URL(message.location().url).pathname || "/";
      } catch {}
      if (resourceFailure && sourcePath === "/api/appearance-presets") return;
      const status: any = /status of (\d+)/u.exec(message.text())?.[1] || "unknown";
      browserFindings.push(resourceFailure
        ? `resource-load-error:${status}:${sourcePath}`
        : `console-error:${sourcePath}`);
    }
  });
  page.on("pageerror", () : any => browserFindings.push("pageerror"));

  async function gotoConsoleRoute(route?: any) : Promise<any> {
    const current: any = page.url() ? new URL(page.url()) : null;
    if (current?.origin === expectedOrigin) {
      if (current.hash !== `#${route}`) {
        await page.evaluate((nextRoute?: any) : any => {
          window.location.hash = nextRoute;
        }, route);
        await page.waitForURL((url?: any) : any => url.hash === `#${route}`);
      }
      await page.waitForTimeout(250);
    } else {
      await page.goto(`${baseUrl}/#${route}`, { waitUntil: "networkidle" });
    }
    await page.locator("body").waitFor({ state: "visible" });
  }

  async function login({ username, password }: Record<string, any>) : Promise<any> {
    await gotoConsoleRoute("/login");
    await page.locator('input[autocomplete="username"]').fill(username);
    await page.locator('input[autocomplete="current-password"]').fill(password);
    await page.locator("form.auth-form").getByRole("button").click();
    await page.waitForURL((url?: any) : any => !url.hash.includes("/login"), { timeout: 30_000 });
    await page.locator('input[type="password"]').evaluateAll((elements?: any) : any => {
      for (const element of elements) {
        element.value = "";
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await gotoConsoleRoute("/admin/publish-upstream-service");
    await page.locator(".upstream-publish-layout").waitFor({ state: "visible", timeout: 30_000 });
    return capture("console-authenticated");
  }

  async function loadAndPublishUpstreamService(descriptorDocument?: any) : Promise<any> {
    await gotoConsoleRoute("/admin/publish-upstream-service");
    const importPanel: any = page.locator("details.portable-import-panel");
    if (await importPanel.evaluate((element?: any) : any => element.open !== true)) {
      await importPanel.locator("summary").click();
    }
    if (await importPanel.evaluate((element?: any) : any => element.open !== true)) {
      throw visualError("release_journey_visual_import_panel_closed");
    }
    const descriptorInput: any = importPanel.locator("textarea");
    await descriptorInput.waitFor({ state: "attached", timeout: 30_000 });
    await descriptorInput.waitFor({ state: "visible", timeout: 30_000 });
    await descriptorInput.fill(JSON.stringify(descriptorDocument, null, 2));
    await importPanel.getByRole("button", { name: /加载草稿|Load draft/u }).click();
    await page.getByText(/草稿已加载|Draft loaded/u).waitFor();
    await importPanel.locator("summary").click();

    await page.getByRole("tab", { name: /基本信息|Basic/u }).click();
    await page.locator(".publish-form").scrollIntoViewIfNeeded();
    await capture("console-upstream-basic-config");

    await page.getByRole("tab", { name: /高级 JSON|Advanced JSON/u }).click();
    const operationDescriptors: any = page.getByRole("region", {
      name: "Imported operation descriptors"
    });
    await operationDescriptors.waitFor({ state: "visible", timeout: 30_000 });
    const operationDescriptorText: any = await operationDescriptors.locator("pre").innerText();
    if (
      !operationDescriptorText.includes('"mode": "artifact_multipart"')
      || !operationDescriptorText.includes('"maxBytes": 53477376')
    ) {
      throw visualError("release_journey_visual_operation_descriptor_incomplete");
    }
    await operationDescriptors.scrollIntoViewIfNeeded();
    await capture("console-upstream-operation-config");

    const [publishResponse] = await Promise.all([
      page.waitForResponse((response?: any) : any => {
        const url: any = new URL(response.url());
        return response.request().method() === "POST"
          && url.origin === expectedOrigin
          && url.pathname === "/api/gateway/v1/services";
      }, { timeout: 30_000 }),
      page.getByRole("button", { name: /^(发布|Publish)$/u }).click()
    ]);
    const publishPayload: any = await publishResponse.json();
    if (
      publishResponse.ok() !== true
      || typeof publishPayload?.serviceId !== "string"
      || publishPayload.serviceId.length === 0
    ) {
      throw visualError("release_journey_visual_publish_response_invalid");
    }
    await page.getByText(/运行时健康检查通过|runtime health passed/u).waitFor({
      timeout: 90_000
    });
    await page.locator(".health-result pre").evaluate((element?: any) : any => {
      element.hidden = true;
    });
    await capture("console-upstream-published");
    return Object.freeze({ serviceId: publishPayload.serviceId });
  }

  async function capturePublishedTool(serviceId?: any) : Promise<any> {
    await gotoConsoleRoute("/admin/tool-list");
    const search: any = page.getByRole("searchbox", { name: "搜索并跳转工具" });
    await search.fill(serviceId);
    await search.press("Enter");
    const row: any = page.locator(".tool-list-table [data-tool-id]").filter({ hasText: serviceId }).first();
    await row.waitFor({ state: "visible", timeout: 30_000 });
    await row.scrollIntoViewIfNeeded();
    return capture("console-published-tool");
  }

  async function approvePendingAuthorizations({ clientNames = ["Kimi"] }: Record<string, any> = {}) : Promise<any> {
    await gotoConsoleRoute("/approval");
    const cards: any[] = [];
    for (const clientName of clientNames) {
      const card: any = await approvalCard({
        kindSelector: RELEASE_JOURNEY_APPROVAL_UI.authorizationCard,
        hasText: clientName
      });
      await card.waitFor({ state: "visible", timeout: 30_000 });
      cards.push(card);
    }
    const firstCard: any = page
      .locator(RELEASE_JOURNEY_APPROVAL_UI.authorizationCard)
      .first();
    await firstCard.waitFor({ state: "visible", timeout: 30_000 });
    await expandTechnicalDetails(firstCard);
    await resetApprovalEvidenceScroll();
    const masks: any = cards.flatMap((card?: any) : any => protectedAuthorizationMasks(card));
    await capture("console-token-authorization-pending", { masks });
    for (const card of cards) {
      await approveCard({
        card,
        actionSelector: RELEASE_JOURNEY_APPROVAL_UI.mcpApprove,
        actionName:
          /^(批准|批准本次安装|批准本次授权|Approve|Approve This Installation|Approve This Authorization)$/u,
        confirmName:
          /^(批准本次安装|批准本次授权|Approve This Installation|Approve This Authorization)$/u
      });
      await card.waitFor({ state: "hidden", timeout: 30_000 });
    }
  }

  async function captureCompletedAuthorizations({ clientNames = ["Kimi"] }: Record<string, any> = {}) : Promise<any> {
    await gotoConsoleRoute("/approval");
    await selectApprovalStatus({
      stableSelector: RELEASE_JOURNEY_APPROVAL_UI.allStatus,
      name: /全部|所有|All/u
    });
    const cards: any[] = [];
    for (const clientName of clientNames) {
      const card: any = await approvalCard({
        kindSelector: RELEASE_JOURNEY_APPROVAL_UI.authorizationCard,
        hasText: clientName
      });
      await card.waitFor({ state: "visible", timeout: 30_000 });
      cards.push(card);
    }
    await resetApprovalEvidenceScroll();
    await capture("console-token-authorization-consumed", {
      masks: cards.flatMap((card?: any) : any => protectedAuthorizationMasks(card))
    });
  }

  async function approvePendingOperations({ toolName, expectedCount }: Record<string, any>) : Promise<any> {
    await gotoConsoleRoute("/approval");
    await selectApprovalStatus({
      stableSelector: RELEASE_JOURNEY_APPROVAL_UI.pendingStatus,
      name: /待决定|待审批|Pending Decision|Pending/u
    });
    const cards: any = await approvalCards({
      kindSelector: RELEASE_JOURNEY_APPROVAL_UI.operationCard,
      hasText: toolName,
      legacyText: "Operation Permission 审批"
    });
    await cards.first().waitFor({ state: "visible", timeout: 30_000 });
    if (await cards.count() !== expectedCount) {
      throw visualError("release_journey_visual_pending_operation_count_mismatch");
    }
    await expandTechnicalDetails(cards.first());
    await resetApprovalEvidenceScroll();
    await capture("console-operation-approval-pending");
    for (let index: any = 0; index < expectedCount; index += 1) {
      const countBefore: any = await cards.count();
      const card: any = cards.first();
      await approveCard({
        card,
        actionSelector: RELEASE_JOURNEY_APPROVAL_UI.operationApprove,
        actionName:
          /^(批准请求|通过当前审批层|Approve Request|Approve Current Layer)$/u,
        confirmName:
          /^(批准请求|通过当前审批层|Approve Request|Approve Current Layer)$/u
      });
      const deadline: any = Date.now() + 30_000;
      while (Date.now() < deadline && await cards.count() >= countBefore) {
        await page.waitForTimeout(100);
      }
      if (await cards.count() >= countBefore) {
        throw visualError("release_journey_visual_pending_operation_not_resolved");
      }
    }
  }

  async function captureCompletedOperations({ toolName, expectedCount }: Record<string, any>) : Promise<any> {
    await gotoConsoleRoute("/approval");
    await selectApprovalStatus({
      stableSelector: RELEASE_JOURNEY_APPROVAL_UI.allStatus,
      name: /全部|所有|All/u
    });
    const cards: any = await approvalCards({
      kindSelector: RELEASE_JOURNEY_APPROVAL_UI.operationCard,
      hasText: toolName,
      legacyText: "Operation Permission 审批"
    });
    await cards.first().waitFor({ state: "visible", timeout: 30_000 });
    if (await cards.count() !== expectedCount) {
      throw visualError("release_journey_visual_completed_operation_count_mismatch");
    }
    await resetApprovalEvidenceScroll();
    await capture("console-operation-approval-completed");
  }

  async function captureDownstreamMcpCalls({ toolNames, minimumRowCount }: Record<string, any>) : Promise<any> {
    await gotoConsoleRoute("/admin/tool-stats");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForURL((url?: any) : any => url.hash === "#/admin/tool-stats");
    await page.locator(".tool-audit-table").waitFor({ state: "visible", timeout: 30_000 });
    await page.locator(".topbar button.tool-button-icon").click();
    const rows: any = page.locator(".tool-audit-table .job-row");
    const deadline: any = Date.now() + 30_000;
    while (Date.now() < deadline && await rows.count() < minimumRowCount) {
      await page.waitForTimeout(100);
    }
    if (await rows.count() < minimumRowCount) {
      throw visualError("release_journey_visual_mcp_audit_count_mismatch");
    }
    for (const toolName of toolNames) {
      await rows.filter({ hasText: toolName }).first().waitFor({ state: "visible", timeout: 30_000 });
    }
    const masks: any[] = [];
    const rowCount: any = await rows.count();
    for (let index: any = 0; index < rowCount; index += 1) {
      masks.push(rows.nth(index).locator("span").first());
    }
    await capture("console-downstream-mcp-call", { masks });
  }

  async function capture(id?: any, { masks = [] }: Record<string, any> = {}) : Promise<any> {
    const checkpoint: any = CHECKPOINT_BY_ID.get(id);
    if (!checkpoint) {
      throw visualError("release_journey_visual_checkpoint_unknown");
    }
    if (evidence.some((item?: any) : any => item.id === id)) {
      throw visualError("release_journey_visual_checkpoint_duplicate");
    }
    const actualUrl: any = new URL(page.url());
    const actualRoute: any = actualUrl.hash.replace(/^#/u, "") || "/";
    if (actualUrl.origin !== expectedOrigin || actualRoute !== checkpoint.route) {
      throw visualError("release_journey_visual_console_route_mismatch");
    }
    const populatedPasswords: any = await page.locator('input[type="password"]').evaluateAll(
      (elements?: any) : any => elements.filter((element?: any) : any => String(element.value || "").length > 0).length
    );
    if (populatedPasswords > 0) {
      throw visualError("release_journey_visual_credential_present");
    }

    await page.evaluate(async () : Promise<any> => {
      if (document.fonts?.ready) await document.fonts.ready;
    });
    const serviceAddressMasks: any = page.locator(
      RELEASE_JOURNEY_VISUAL_PROTECTED_SELECTORS[1],
    );
    const requiredMasks: any[] = [
      page.locator(RELEASE_JOURNEY_VISUAL_PROTECTED_SELECTORS[0]),
      serviceAddressMasks,
      page.locator(RELEASE_JOURNEY_VISUAL_PROTECTED_SELECTORS[2]),
      ...masks
    ];
    const visibleMaskRectangles: any = new Map<any, any>();
    const visibleServiceAddressIds: any = new Set<any>();
    const ownedSourceIds: any = new Set<any>();
    let sourceSequence: any = 0;
    for (const locator of requiredMasks) {
      const serviceAddressLocator: any = locator === serviceAddressMasks;
      const count: any = await locator.count();
      for (let index: any = 0; index < count; index += 1) {
        const target: any = locator.nth(index);
        if (!await target.isVisible()) continue;
        const geometry: any = await target.evaluate((element?: any, suggestedId?: any) : any => {
          const sourceAttribute: any = "data-release-evidence-mask-source";
          const existingId: any = element.getAttribute(sourceAttribute);
          const sourceId: any = existingId || suggestedId;
          if (!existingId) element.setAttribute(sourceAttribute, sourceId);

          const rectangle: any = element.getBoundingClientRect();
          const clippingRegions: any[] = [{
            x: 0,
            y: 0,
            width: window.innerWidth,
            height: window.innerHeight,
            clipX: true,
            clipY: true
          }];
          const clippingOverflowValues: any = new Set<any>(["auto", "clip", "hidden", "scroll"]);
          for (let ancestor: any = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
            const style: any = window.getComputedStyle(ancestor);
            const clipX: any = clippingOverflowValues.has(style.overflowX);
            const clipY: any = clippingOverflowValues.has(style.overflowY);
            if (!clipX && !clipY) continue;
            const ancestorRectangle: any = ancestor.getBoundingClientRect();
            clippingRegions.push({
              x: ancestorRectangle.x,
              y: ancestorRectangle.y,
              width: ancestorRectangle.width,
              height: ancestorRectangle.height,
              clipX,
              clipY
            });
          }
          return {
            sourceId,
            sourceOwned: !existingId,
            rectangle: {
              x: rectangle.x,
              y: rectangle.y,
              width: rectangle.width,
              height: rectangle.height
            },
            clippingRegions
          };
        }, `release-mask-source-${sourceSequence}`);
        sourceSequence += 1;
        if (geometry.sourceOwned) ownedSourceIds.add(geometry.sourceId);
        if (visibleMaskRectangles.has(geometry.sourceId)) {
          if (serviceAddressLocator) visibleServiceAddressIds.add(geometry.sourceId);
          continue;
        }
        const visibleRectangle: any = intersectReleaseJourneyMaskRectangle(
          geometry.rectangle,
          geometry.clippingRegions
        );
        if (!visibleRectangle) continue;
        visibleMaskRectangles.set(geometry.sourceId, visibleRectangle);
        if (serviceAddressLocator) visibleServiceAddressIds.add(geometry.sourceId);
      }
    }
    if (visibleServiceAddressIds.size === 0) {
      throw visualError("release_journey_visual_service_address_mask_missing");
    }
    const maskRectangles: any = [...visibleMaskRectangles.entries()].map(
      ([sourceId, rectangle]: any[], index?: any) : any => ({
        id: `release-mask-proxy-${index}`,
        sourceId,
        ...rectangle
      })
    );
    await page.evaluate((rectangles?: any) : any => {
      document.querySelectorAll("[data-release-evidence-mask-proxy]").forEach(
        (element?: any) : any => element.remove()
      );
      const fragment: any = document.createDocumentFragment();
      for (const rectangle of rectangles) {
        const proxy: any = document.createElement("span");
        proxy.setAttribute("aria-hidden", "true");
        proxy.setAttribute("data-release-evidence-mask-proxy", rectangle.id);
        Object.assign(proxy.style, {
          position: "absolute",
          left: `${rectangle.x + window.scrollX}px`,
          top: `${rectangle.y + window.scrollY}px`,
          width: `${rectangle.width}px`,
          height: `${rectangle.height}px`,
          display: "block",
          pointerEvents: "none",
          background: "rgba(0, 0, 0, 0.001)",
          zIndex: "2147483647"
        });
        fragment.append(proxy);
      }
      document.documentElement.append(fragment);
    }, maskRectangles);
    const visibleMasks: any = maskRectangles.map(({ id }: Record<string, any>) : any =>
      page.locator(`[data-release-evidence-mask-proxy="${id}"]`)
    );
    let buffer: any;
    try {
      buffer = await page.screenshot({
        fullPage: true,
        animations: "disabled",
        type: "png",
        mask: visibleMasks,
        maskColor: "#111a16"
      });
    } finally {
      await page.evaluate(({ sourceIds }: Record<string, any>) : any => {
        document.querySelectorAll("[data-release-evidence-mask-proxy]").forEach(
          (element?: any) : any => element.remove()
        );
        for (const sourceId of sourceIds) {
          document
            .querySelector(`[data-release-evidence-mask-source="${sourceId}"]`)
            ?.removeAttribute("data-release-evidence-mask-source");
        }
      }, { sourceIds: [...ownedSourceIds] });
    }
    if (buffer.byteLength < 20_000) {
      throw visualError("release_journey_visual_screenshot_blank");
    }
    const dimensions: any = readPngDimensions(buffer);
    if (
      dimensions?.width !== RELEASE_JOURNEY_VISUAL_CAPTURE.pixelWidth
      || dimensions?.height !== RELEASE_JOURNEY_VISUAL_CAPTURE.pixelHeight
    ) {
      throw visualError("release_journey_visual_screenshot_resolution_invalid");
    }
    const relative: any = `${RELEASE_JOURNEY_VISUAL_ROOT}/${id}.png`;
    await fs.writeFile(path.join(repoRoot, relative), buffer, { mode: 0o600 });
    const item: Readonly<Record<string, any>> = Object.freeze({
      id,
      title: checkpoint.title,
      status: "passed",
      source: "meshrix-web-console",
      route: checkpoint.route,
      localOnly: true,
      maskingPolicy: RELEASE_JOURNEY_VISUAL_MASKING_POLICY,
      protectedValuesMasked: maskRectangles.length > 0,
      protectedElementCount: maskRectangles.length,
      maskedElementCount: maskRectangles.length,
      serviceAddressMasked: true,
      file: relative,
      viewportWidth: RELEASE_JOURNEY_VISUAL_CAPTURE.viewport.width,
      viewportHeight: RELEASE_JOURNEY_VISUAL_CAPTURE.viewport.height,
      deviceScaleFactor: RELEASE_JOURNEY_VISUAL_CAPTURE.deviceScaleFactor,
      pixelWidth: dimensions.width,
      pixelHeight: dimensions.height,
      byteLength: buffer.byteLength,
      sha256: createHash("sha256").update(buffer).digest("hex")
    });
    evidence.push(item);
    return item;
  }

  async function approvalCards({ kindSelector, hasText, legacyText }: Record<string, any>) : Promise<any> {
    const typedCards: any = page.locator(kindSelector).filter({ hasText });
    if (await typedCards.count()) {
      return typedCards;
    }
    let fallbackCards: any = page.locator(RELEASE_JOURNEY_APPROVAL_UI.card).filter({ hasText });
    if (legacyText) {
      fallbackCards = fallbackCards.filter({ hasText: legacyText });
    }
    return fallbackCards;
  }

  async function approvalCard(options?: any) : Promise<any> {
    return (await approvalCards(options)).first();
  }

  async function selectApprovalStatus({ stableSelector, name }: Record<string, any>) : Promise<any> {
    const stableStatus: any = page.locator(stableSelector).first();
    if (await stableStatus.count()) {
      await stableStatus.click();
      return;
    }
    for (const role of ["tab", "button"]) {
      const status: any = page.getByRole(role, { name }).first();
      if (await status.count()) {
        await status.click();
        return;
      }
    }
  }

  async function expandTechnicalDetails(card?: any) : Promise<any> {
    if (!card) return;
    const details: any = card.locator(RELEASE_JOURNEY_APPROVAL_UI.technicalDetails).first();
    if (!await details.count()) return;
    if (!await details.evaluate((element?: any) : any => element.open === true)) {
      await details.locator("summary").click();
    }
    if (!await details.evaluate((element?: any) : any => element.open === true)) {
      throw visualError("release_journey_visual_technical_details_closed");
    }
    await page.waitForTimeout(100);
  }

  async function resetApprovalEvidenceScroll() : Promise<any> {
    await page.locator(".view-content").evaluate((element?: any) : any => {
      element.scrollTo({ top: 0, left: 0, behavior: "instant" });
    });
    await page
      .locator(".approval-request-card, .approval-request-technical-grid")
      .evaluateAll((elements?: any) : any => {
        for (const element of elements) {
          element.scrollTop = 0;
          element.scrollLeft = 0;
        }
      });
    await page.waitForTimeout(100);
  }

  async function approveCard({ card, actionSelector, actionName, confirmName }: Record<string, any>) : Promise<any> {
    const stableAction: any = card.locator(actionSelector).first();
    const action: any = await stableAction.count()
      ? stableAction
      : card.getByRole("button", { name: actionName }).first();
    await action.waitFor({ state: "visible", timeout: 30_000 });
    await action.click();
    await confirmApprovalIfPresent(confirmName);
  }

  async function confirmApprovalIfPresent(confirmName?: any) : Promise<any> {
    const dialog: any = page.locator(RELEASE_JOURNEY_APPROVAL_UI.confirmDialog).last();
    const visible: any = await dialog.waitFor({ state: "visible", timeout: 1_500 })
      .then(() : any => true)
      .catch(() : any => false);
    if (!visible) return;
    const confirm: any = dialog.getByRole("button", { name: confirmName }).first();
    if (!await confirm.count()) {
      throw visualError("release_journey_visual_confirmation_action_missing");
    }
    await confirm.click();
    await dialog.waitFor({ state: "hidden", timeout: 30_000 });
  }

  async function close() : Promise<any> {
    await context.close().catch(() : any => {});
    await browser.close().catch(() : any => {});
  }

  return {
    login,
    loadAndPublishUpstreamService,
    capturePublishedTool,
    approvePendingAuthorizations,
    captureCompletedAuthorizations,
    approvePendingOperations,
    captureCompletedOperations,
    captureDownstreamMcpCalls,
    close,
    evidence,
    browserFindings
  };
}

export async function validateReleaseJourneyVisualEvidence({
  repoRoot,
  evidence,
  browserFindings = []
}: Record<string, any>) : Promise<any> {
  if (!Array.isArray(evidence) || evidence.length !== RELEASE_JOURNEY_VISUAL_CHECKPOINTS.length) {
    throw visualError("release_journey_visual_evidence_incomplete");
  }
  if (!Array.isArray(browserFindings) || browserFindings.length > 0) {
    throw visualError("release_journey_visual_browser_findings");
  }
  for (let index: any = 0; index < RELEASE_JOURNEY_VISUAL_CHECKPOINTS.length; index += 1) {
    const [expectedId, expectedTitle, expectedRoute] = RELEASE_JOURNEY_VISUAL_CHECKPOINTS[index];
    const item: any = evidence[index];
    if (
      item?.id !== expectedId
      || item?.title !== expectedTitle
      || item?.status !== "passed"
      || item?.source !== "meshrix-web-console"
      || item?.route !== expectedRoute
      || item?.localOnly !== true
      || item?.maskingPolicy !== RELEASE_JOURNEY_VISUAL_MASKING_POLICY
      || item?.protectedValuesMasked !== true
      || !Number.isSafeInteger(item?.protectedElementCount)
      || item.protectedElementCount <= 0
      || item?.maskedElementCount !== item.protectedElementCount
      || item?.serviceAddressMasked !== true
      || item?.file !== `${RELEASE_JOURNEY_VISUAL_ROOT}/${expectedId}.png`
      || item?.viewportWidth !== RELEASE_JOURNEY_VISUAL_CAPTURE.viewport.width
      || item?.viewportHeight !== RELEASE_JOURNEY_VISUAL_CAPTURE.viewport.height
      || item?.deviceScaleFactor !== RELEASE_JOURNEY_VISUAL_CAPTURE.deviceScaleFactor
      || item?.pixelWidth !== RELEASE_JOURNEY_VISUAL_CAPTURE.pixelWidth
      || item?.pixelHeight !== RELEASE_JOURNEY_VISUAL_CAPTURE.pixelHeight
      || !Number.isSafeInteger(item?.byteLength)
      || item.byteLength < 20_000
      || !/^[a-f0-9]{64}$/u.test(item?.sha256 || "")
    ) {
      throw visualError("release_journey_visual_evidence_invalid");
    }
    const bytes: any = await fs.readFile(path.join(repoRoot, item.file));
    const dimensions: any = readPngDimensions(bytes);
    if (
      bytes.byteLength !== item.byteLength
      || dimensions?.width !== item.pixelWidth
      || dimensions?.height !== item.pixelHeight
      || createHash("sha256").update(bytes).digest("hex") !== item.sha256
    ) {
      throw visualError("release_journey_visual_evidence_digest_mismatch");
    }
  }
  return Object.freeze({
    screenshotCount: evidence.length,
    source: "meshrix-web-console",
    visualEvidencePassed: true
  });
}

function protectedAuthorizationMasks(card?: any) : any {
  return [
    card.locator(".approval-request-card-meta span").filter({ hasText: /验证码/u }),
    card.locator(".approval-request-card-meta span").filter({ hasText: /^请求\s/u }),
    card.locator(".approval-request-card-meta span").filter({ hasText: /进程密钥指纹/u })
  ];
}

function isUsableRectangle(rectangle?: any) : any {
  return rectangle
    && [rectangle.x, rectangle.y, rectangle.width, rectangle.height]
      .every((value?: any) : any => Number.isFinite(value))
    && rectangle.width > 0
    && rectangle.height > 0;
}

function visualError(code?: any) : any {
  return Object.assign(new Error(code), { code });
}
