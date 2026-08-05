import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";
import {
  RELEASE_JOURNEY_VISUAL_CAPTURE,
  RELEASE_JOURNEY_VISUAL_CHECKPOINTS,
  readPngDimensions
} from "./release-journey-visual-contract.ts";

export { RELEASE_JOURNEY_VISUAL_CHECKPOINTS } from "./release-journey-visual-contract.ts";

export const RELEASE_JOURNEY_VISUAL_ROOT: any =
  "build/reports/upstream-service-publishing/screenshots";
export const RELEASE_JOURNEY_VISUAL_MASKING_POLICY: any = "protected-values-only";
export const RELEASE_JOURNEY_VISUAL_PROTECTED_SELECTORS: readonly any[] = Object.freeze([
  ".identity-chip",
  ".service-url-badge",
  "[data-protected]"
]);

export const RELEASE_JOURNEY_APPROVAL_UI: Readonly<Record<string, any>> = Object.freeze({
  card: '[data-testid="approval-request-card"], [data-approval-kind], .approval-request-card',
  operationCard: '[data-approval-kind="pendingOperation"]',
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
  function publicBrowserFindingPath(sourcePath: any = "") : string {
    const segments: any[] = String(sourcePath || "")
      .split("/")
      .filter(Boolean);
    if (segments[0] === "api" && segments[1] === "operation-permission" && segments[2] === "v1") {
      const suffix: any = segments[3] === "api-keys" && segments[4] === "issuer-scopes"
        ? ["issuer-scopes"]
        : [];
      return `/${[...segments.slice(0, 4), ...suffix].join("/")}`;
    }
    if (segments[0] === "api") {
      return `/${segments.slice(0, 2).join("/") || "api"}`;
    }
    return segments.length > 0 ? `/${segments[0]}` : "/";
  }
  page.on("console", (message?: any) : any => {
    if (message.type() === "error") {
      const resourceFailure: any = /Failed to load resource|ERR_/u.test(message.text());
      let sourcePath: any = "unknown";
      try {
        sourcePath = new URL(message.location().url).pathname || "/";
      } catch {}
      if (resourceFailure && sourcePath === "/api/appearance-presets") return;
      const status: any = /status of (\d+)/u.exec(message.text())?.[1] || "unknown";
      const publicSourcePath: any = publicBrowserFindingPath(sourcePath);
      browserFindings.push(resourceFailure
        ? `resource-load-error:${status}:${publicSourcePath}`
        : `console-error:${publicSourcePath}`);
    }
  });
  page.on("pageerror", () : any => browserFindings.push("pageerror"));

  async function gotoConsoleRoute(route?: any) : Promise<any> {
    const current: any = page.url() ? new URL(page.url()) : null;
    if (current?.origin === expectedOrigin) {
      // The console's URL-state design (REQ-008) writes query keys into the
      // hash (tabs, selection, filters) — compare the route path only.
      const currentPath: any = current.hash.replace(/^#/u, "").split("?")[0] || "/";
      if (currentPath !== route) {
        await page.evaluate((nextRoute?: any) : any => {
          window.location.hash = nextRoute;
        }, route);
        await page.waitForURL((url?: any) : any =>
          url.hash.replace(/^#/u, "").split("?")[0] === route);
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
    await page.waitForURL((url?: any) : any => url.hash === "#/", { timeout: 30_000 });
    await page.locator(".dashboard-view").waitFor({ state: "visible", timeout: 30_000 });
    return capture("console-authenticated");
  }

  async function ensureAuthenticated({ username, password }: Record<string, any>) : Promise<any> {
    await page.goto(`${baseUrl}/#/admin/publish-upstream-service`, { waitUntil: "networkidle" });
    if (new URL(page.url()).hash.includes("/login")) {
      await page.locator('input[autocomplete="username"]').fill(username);
      await page.locator('input[autocomplete="current-password"]').fill(password);
      await page.locator("form.auth-form").getByRole("button").click();
      await page.waitForURL((url?: any) : any => !url.hash.includes("/login"), { timeout: 30_000 });
    }
    await gotoConsoleRoute("/admin/publish-upstream-service");
    await page.locator(".upstream-publish-layout").waitFor({ state: "visible", timeout: 30_000 });
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
    await importPanel.locator('[data-action="validate-service-json"]').click();
    const loadDraftButton: any = importPanel.locator('[data-action="load-service-draft"]');
    await loadDraftButton.waitFor({ state: "visible", timeout: 30_000 });
    await loadDraftButton.click();
    await page.getByText(/草稿已加载|Draft loaded/u).waitFor();
    await importPanel.locator("summary").click();

    await page.getByRole("tab", { name: /基本信息|服务信息|Service information|Basic/u }).click();
    await page.locator(".publish-form").scrollIntoViewIfNeeded();
    await capture("console-upstream-basic-config");

    await page.getByRole("tab", { name: /高级 JSON|Advanced JSON/u }).click();
    const operationDescriptors: any = page.locator(".operation-descriptor-preview");
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

  async function configureOrganizationGovernance() : Promise<any> {
    await gotoConsoleRoute("/admin/organization-governance");
    const organizationView: any = page.locator(".organization-governance-layout");
    await organizationView.waitFor({ state: "visible", timeout: 30_000 });
    if (await organizationView.getAttribute("data-server-state") !== "published") {
      await page.getByRole("button", { name: /^(集团|Group)$/u }).click();
      await page.locator(".organization-governance-workspace").waitFor({ state: "visible", timeout: 30_000 });
      await page.getByRole("button", { name: /验证有效性|Validate/u }).click();
      await page.getByText(/服务端验证通过|Server validation passed/u).waitFor({ timeout: 30_000 });
      const hierarchyText: any[] = await page.locator(".organization-governance-node-row small").allTextContents();
      const tagSection: any = page.locator("section.organization-governance-roles").filter({
        has: page.locator("#organization-tag-title")
      });
      const roleSection: any = page.locator("section.organization-governance-roles").filter({
        has: page.locator("#organization-role-title")
      });
      const tagRows: any[] = await tagSection.locator(".organization-governance-role-list li").allTextContents();
      const roleRows: any[] = await roleSection.locator(".organization-governance-role-list li").allTextContents();
      const expectedNodes: any[] = [
        "organization:group",
        "organization:primary",
        "organization:secondary",
        "group:department",
        "group:team"
      ];
      if (JSON.stringify(hierarchyText.map((value?: any) : any => value.trim())) !== JSON.stringify(expectedNodes) ||
        tagRows.length !== expectedNodes.length || roleRows.length !== expectedNodes.length ||
        expectedNodes.some((nodeId?: any) : any => !tagRows.some((row?: any) : any => row.includes(nodeId))) ||
        !roleRows.every((row?: any) : any => /管理员|administrator/iu.test(row))) {
        throw visualError("release_journey_api_key_organization_projection_incomplete");
      }
      await page.getByRole("button", { name: /^(发布|Publish)$/u }).click();
      const publishDialog: any = page.locator(".console-confirm-dialog").last();
      const publishConfirmationVisible: any = await publishDialog
        .waitFor({ state: "visible", timeout: 1_500 })
        .then(() : any => true)
        .catch(() : any => false);
      if (publishConfirmationVisible) {
        await publishDialog.getByRole("button", { name: /^(发布|Publish)$/u }).click();
      }
      await page.getByText(/模板已发布|template published/u).waitFor({ timeout: 30_000 });
      await page.waitForLoadState("networkidle");
    }
    if (!evidence.some((item?: any) : any => item.id === "console-organization-permissions")) {
      const workspace: any = page.locator(".organization-governance-workspace");
      if (!await workspace.isVisible()) {
        await organizationView.getByRole("button", {
          name: /基于已发布版本编辑|Edit from Published Version/u
        }).click();
        await workspace.waitFor({ state: "visible", timeout: 30_000 });
      }
      await page.locator(".view-content").evaluate((element?: any) : any => {
        element.scrollTo({ top: 220, left: 0, behavior: "instant" });
      });
      await capture("console-organization-permissions");
    }
    return Object.freeze({
      templateKey: "enterprise-group",
      hierarchyVerified: true,
      tagsVerified: true,
      administratorRolesVerified: true
    });
  }

  async function provisionApiKeyWorkload({
    serviceId,
    targetIds = ["codex"],
    operationKey = "convert-full-access-debug",
    organizationNodeId = "group:team",
    workloadName = "Release journey PDF workload",
    allowedTools = null,
    toolsetIds = ["meshrix.gateway.write"],
    capabilityIds = null,
    permissionScopeIds = ["gateway:read", "gateway:write", "storage:read", "storage:write", "uploads:write"],
    requestsPerMinute = 128
  }: Record<string, any> = {}) : Promise<any> {
    const organization: any = await configureOrganizationGovernance();

    await gotoConsoleRoute("/admin/api-key-distribution");
    const keyView: any = page.locator(".api-key-distribution-layout");
    await keyView.waitFor({ state: "visible", timeout: 30_000 });
    await keyView.locator(".api-key-create-card").waitFor({ state: "visible", timeout: 30_000 });
    const field: any = (label: RegExp, selector: any = "input,textarea,select") : any =>
      keyView.locator("label").filter({ hasText: label }).locator(selector).first();
    const expiresAt: any = new Date(Date.now() + 60 * 60_000);
    const localExpiresAt: any = new Date(expiresAt.getTime() - expiresAt.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
    await field(/显示名称|Display Name|工作负载名称|Workload Name/u, "input").fill(workloadName);
    await field(/所属层级|Owning Level|组织范围|Organization Scope/u, "select").selectOption(organizationNodeId);
    await field(/到期时间|Expires At/u, "input").fill(localExpiresAt);
    await field(/最高风险级别|Maximum Risk/u, "select").selectOption("medium");
    // The api-key form is toolset-driven: choosing toolsets auto-fills
    // scopes, services, capabilities, and allowed tools (the old free-form
    // textarea fields no longer exist). Select the requested toolsets, then
    // the client targets and the resource scope below.
    const serviceSection: any = keyView.locator("details.api-key-policy-section").filter({
      hasText: /服务与工具权限|Service and Tool Permissions/u
    });
    if (!await serviceSection.evaluate((element?: any) : any => element.open === true)) {
      await serviceSection.locator("summary").first().click();
    }
    const toolsetCard: any = serviceSection.locator(".multi-choice-list-card").filter({
      hasText: /工具集|Toolsets/u
    }).first();
    await toolsetCard.locator(".multi-choice-list-item").first().waitFor({
      state: "visible",
      timeout: 30_000
    });
    for (const toolsetId of toolsetIds) {
      const checkbox: any = toolsetCard.locator(`.multi-choice-list-item[title="${toolsetId}"]`).first();
      if (!(await checkbox.count())) continue;
      if (await checkbox.getAttribute("aria-checked") !== "true"
        && await checkbox.getAttribute("data-checked") !== "true") {
        await checkbox.click();
      }
    }
    const connectionSection: any = keyView.locator("details.api-key-policy-section").filter({
      hasText: /连接目标与资源|Connection Targets and Resources|连接目标与资源限制|Connection and Resource Restrictions/u
    });
    if (!await connectionSection.evaluate((element?: any) : any => element.open === true)) {
      await connectionSection.locator("summary").first().click();
    }
    const targetCard: any = connectionSection.locator(".multi-choice-list-card").filter({
      hasText: /客户端目标|Client Targets/u
    }).first();
    for (const targetId of targetIds) {
      const checkbox: any = targetCard.locator(`.multi-choice-list-item[title="${targetId}"]`).first();
      if (!(await checkbox.count())) continue;
      if (await checkbox.getAttribute("aria-checked") !== "true"
        && await checkbox.getAttribute("data-checked") !== "true") {
        await checkbox.click();
      }
    }
    const resourceSwitch: any = connectionSection.getByRole("switch");
    if (await resourceSwitch.getAttribute("aria-checked") !== "true") await resourceSwitch.click();
    const limitsSection: any = keyView.locator("details.api-key-policy-section").filter({
      hasText: /调用限制|Call Limits|进程身份与使用限制|Process Identity and Usage Limits/u
    });
    if (!await limitsSection.evaluate((element?: any) : any => element.open === true)) {
      await limitsSection.locator("summary").first().click();
    }
    await field(/每分钟调用次数|Calls per minute|每窗口请求数|Requests per Window/u, "input").fill(String(requestsPerMinute));
    await field(/最大并发量|Maximum concurrency|最多并发操作|Maximum Concurrent Effects/u, "input").fill("2");

    // The page's periodic refresh can re-filter the draft's toolsets against a
    // concurrently fetched catalog; re-assert the selection right before submit.
    for (const toolsetId of toolsetIds) {
      const checkbox: any = toolsetCard.locator(`.multi-choice-list-item[title="${toolsetId}"]`).first();
      if (!(await checkbox.count())) continue;
      if (await checkbox.getAttribute("aria-checked") !== "true"
        && await checkbox.getAttribute("data-checked") !== "true") {
        await checkbox.click();
      }
    }
    const createButton: any = keyView.getByRole("button", { name: /创建并显示一次|Create and Show Once/u });
    if (await createButton.isDisabled()) throw visualError("release_journey_api_key_draft_invalid");
    await createButton.click();
    const createDialog: any = page.locator(".console-confirm-dialog").last();
    await createDialog.waitFor({ state: "visible", timeout: 10_000 });
    const responsePromise: any = page.waitForResponse((response?: any) : any => {
      const responseUrl: any = new URL(response.url());
      return response.request().method() === "POST" && responseUrl.origin === expectedOrigin &&
        responseUrl.pathname === "/api/operation-permission/v1/api-keys";
    }, { timeout: 30_000 });
    await createDialog.getByRole("button", { name: /创建并显示一次|Create and Show Once/u }).click();
    const createResponse: any = await responsePromise;
    const created: any = await createResponse.json();
    const secretOutput: any = keyView.locator("[data-one-time-secret]");
    await secretOutput.waitFor({ state: "visible", timeout: 30_000 });
    const apiKey: any = String(await secretOutput.textContent() || "").trim();
    if (!createResponse.ok() || !/^mxak1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u.test(apiKey) ||
      apiKey !== created?.apiKey || !created?.record?.keyId ||
      created?.record?.organizationNodeId !== organizationNodeId) {
      throw visualError("release_journey_api_key_one_time_response_invalid");
    }
    // The reveal step (secret-reveal hardening) requires the storage
    // acknowledgement before the dismiss action is enabled.
    const revealConfirm: any = keyView.locator('[data-testid="api-key-reveal-confirm"] input[type="checkbox"]');
    if (await revealConfirm.count() && !await revealConfirm.isChecked()) {
      await revealConfirm.check();
    }
    await keyView.getByRole("button", { name: /关闭且不再显示|Dismiss Permanently/u }).click();
    await secretOutput.waitFor({ state: "detached", timeout: 10_000 });
    if (!evidence.some((item?: any) : any => item.id === "console-api-key-generated")) {
      const issuedRecord: any = keyView.locator(".api-key-record").filter({ hasText: workloadName }).first();
      await issuedRecord.waitFor({ state: "visible", timeout: 30_000 });
      await issuedRecord.scrollIntoViewIfNeeded();
      await capture("console-api-key-generated", {
        masks: [issuedRecord.locator(".api-key-metadata > div:nth-child(-n+2) dd")]
      });
    }
    return Object.freeze({
      apiKey,
      record: Object.freeze({
        keyId: String(created.record.keyId),
        workloadPrincipalId: String(created.record.workloadPrincipalId),
        organizationNodeId: String(created.record.organizationNodeId),
        lifecycleRevision: Number(created.record.lifecycleRevision),
        policyFingerprint: String(created.record.policyFingerprint)
      }),
      organization
    });
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

  async function captureDownstreamAgentConfigured({ installedCount = 0 }: Record<string, any> = {}) : Promise<any> {
    if (!Number.isSafeInteger(installedCount) || installedCount <= 0) {
      throw visualError("release_journey_visual_api_key_configuration_unverified");
    }
    await gotoConsoleRoute("/admin/api-key-distribution");
    const workspace: any = page.locator('[data-testid="api-key-distribution-workspace"]');
    await workspace.waitFor({ state: "visible", timeout: 30_000 });
    if (await page.locator("[data-one-time-secret]").count() > 0) {
      throw visualError("release_journey_visual_credential_present");
    }
    await workspace.scrollIntoViewIfNeeded();
    await capture("console-downstream-agent-configured");
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
      try {
        await approveCard({
          card,
          actionSelector: RELEASE_JOURNEY_APPROVAL_UI.operationApprove,
          actionName:
            /^(批准请求|通过当前审批层|Approve Request|Approve Current Layer)$/u,
          confirmName:
            /^(批准请求|通过当前审批层|Approve Request|Approve Current Layer)$/u
        });
      } catch (error: any) {
        error.code = `${String(error?.code || "release_journey_visual_approval_failed")}_item_${index + 1}`;
        error.message = `${error.code} :: ${String(error?.message || "").slice(0, 300)}`;
        throw error;
      }
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
    const refreshButton: any = page.locator(".topbar button.tool-button-icon").first();
    await refreshButton.waitFor({ state: "visible", timeout: 30_000 });
    await refreshButton.click();
    await page.locator(".tool-audit-table").waitFor({ state: "visible", timeout: 30_000 });
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
    // URL-synced console state (REQ-008) may add query keys to the hash —
    // the checkpoint contract addresses the route path only.
    const actualRoute: any = actualUrl.hash.replace(/^#/u, "").split("?")[0] || "/";
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
    const responsePromise: any = page.waitForResponse((response?: any) : any => {
      const responseUrl: any = new URL(response.url());
      return response.request().method() === "POST" && responseUrl.origin === expectedOrigin &&
        /\/(?:authorization\/requests|pending-operations)\/[^/]+\/resolve$/u.test(responseUrl.pathname);
    }, { timeout: 30_000 });
    await action.click();
    await confirmApprovalIfPresent(confirmName);
    const response: any = await responsePromise;
    if (!response.ok()) {
      let publicCode: any = "unknown";
      try {
        const responseText: any = await response.text();
        const payload: any = responseText ? JSON.parse(responseText) : {};
        publicCode = String(
          payload?.error?.code ||
          (typeof payload?.error === "string" && /\b[a-z][a-z0-9_]{3,80}\b/iu.exec(payload.error)?.[0]) ||
          payload?.reasonCode ||
          payload?.code ||
          "unknown"
        ).replace(/[^a-z0-9_]+/giu, "_").slice(0, 80) || "unknown";
      } catch {}
      if (publicCode === "unknown") {
        const requestHeaders: any = response.request().headers();
        publicCode = `unknown_csrf_${Boolean(requestHeaders["x-meshrix-csrf"])}_confirm_${Boolean(requestHeaders["x-meshrix-safety-confirm"])}`;
      }
      throw visualError(
        `release_journey_visual_approval_failed_http_${response.status()}_${publicCode}`
      );
    }
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
    // The console shell drawer also matches the generic dialog selector, so
    // wait for the confirm button itself to detach instead of a dialog hide.
    await confirm.waitFor({ state: "detached", timeout: 30_000 });
  }

  async function close() : Promise<any> {
    await context.close().catch(() : any => {});
    await browser.close().catch(() : any => {});
  }

  return {
    login,
    ensureAuthenticated,
    loadAndPublishUpstreamService,
    configureOrganizationGovernance,
    provisionApiKeyWorkload,
    capturePublishedTool,
    captureDownstreamAgentConfigured,
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
