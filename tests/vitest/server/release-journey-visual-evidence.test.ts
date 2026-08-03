import { describe, expect, it } from "vitest";

import {
  intersectReleaseJourneyMaskRectangle,
  RELEASE_JOURNEY_APPROVAL_UI,
  RELEASE_JOURNEY_VISUAL_CHECKPOINTS,
  RELEASE_JOURNEY_VISUAL_MASKING_POLICY,
  RELEASE_JOURNEY_VISUAL_PROTECTED_SELECTORS,
  RELEASE_JOURNEY_VISUAL_ROOT
} from "../../../tools/server-scripts/lib/release-journey-visual-evidence.ts";
import {
  RELEASE_JOURNEY_VISUAL_CAPTURE,
  readPngDimensions
} from "../../../tools/server-scripts/lib/release-journey-visual-contract.ts";
import {
  RELEASE_JOURNEY_STACK_UP_ARGS,
  RELEASE_JOURNEY_STACK_UP_COMMAND
} from "../../../tools/server-scripts/lib/release-journey-compose.ts";

describe("release journey visual evidence contract", () : any => {
  it("requires real Console pages from configuration through MCP invocation", () : any => {
    expect(RELEASE_JOURNEY_VISUAL_ROOT).toBe(
      "build/reports/upstream-service-publishing/screenshots"
    );
    expect(RELEASE_JOURNEY_VISUAL_MASKING_POLICY).toBe("protected-values-only");
    expect(RELEASE_JOURNEY_VISUAL_CAPTURE).toEqual({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 2,
      pixelWidth: 2880,
      pixelHeight: 2000
    });
    expect(RELEASE_JOURNEY_VISUAL_CHECKPOINTS.map(([id]: any[]) : any => id)).toEqual([
      "console-authenticated",
      "console-organization-permissions",
      "console-upstream-basic-config",
      "console-upstream-operation-config",
      "console-upstream-published",
      "console-published-tool",
      "console-api-key-generated",
      "console-downstream-agent-configured",
      "console-operation-approval-pending",
      "console-operation-approval-completed",
      "console-downstream-mcp-call"
    ]);
    expect(RELEASE_JOURNEY_VISUAL_CHECKPOINTS.map(([, , route]: any[]) : any => route)).toEqual([
      "/",
      "/admin/organization-governance",
      "/admin/publish-upstream-service",
      "/admin/publish-upstream-service",
      "/admin/publish-upstream-service",
      "/admin/tool-list",
      "/admin/api-key-distribution",
      "/admin/api-key-distribution",
      "/approval",
      "/approval",
      "/admin/tool-stats"
    ]);
  });

  it("reads physical PNG dimensions from the IHDR contract", () : any => {
    const bytes: any = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
    Buffer.from("IHDR", "ascii").copy(bytes, 12);
    bytes.writeUInt32BE(2880, 16);
    bytes.writeUInt32BE(2000, 20);
    expect(readPngDimensions(bytes)).toEqual({ width: 2880, height: 2000 });
    expect(readPngDimensions(Buffer.alloc(24))).toBeNull();
  });

  it("binds approval screenshots to the stable card, action, disclosure, and masking contract", () : any => {
    expect(Object.isFrozen(RELEASE_JOURNEY_APPROVAL_UI)).toBe(true);
    expect(RELEASE_JOURNEY_APPROVAL_UI).toEqual({
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
    expect(RELEASE_JOURNEY_VISUAL_PROTECTED_SELECTORS).toEqual([
      ".identity-chip",
      ".service-url-badge",
      "[data-protected]"
    ]);
  });

  it("binds the first screenshot to the exact compose command argv", () : any => {
    expect(RELEASE_JOURNEY_STACK_UP_ARGS).toEqual([
      "--profile",
      "format-convert",
      "up",
      "-d"
    ]);
    expect(RELEASE_JOURNEY_STACK_UP_COMMAND).toBe(
      "docker compose --profile format-convert up -d"
    );
  });

  it("masks only the visible intersection with the viewport and clipping ancestors", () : any => {
    expect(intersectReleaseJourneyMaskRectangle(
      { x: 10, y: 20, width: 100, height: 80 },
      [{ x: 0, y: 0, width: 1440, height: 1000, clipX: true, clipY: true }]
    )).toEqual({ x: 10, y: 20, width: 100, height: 80 });

    expect(intersectReleaseJourneyMaskRectangle(
      { x: 20, y: 80, width: 200, height: 300 },
      [
        { x: 0, y: 0, width: 1440, height: 1000, clipX: true, clipY: true },
        { x: 10, y: 100, width: 300, height: 120, clipX: false, clipY: true }
      ]
    )).toEqual({ x: 20, y: 100, width: 200, height: 120 });

    expect(intersectReleaseJourneyMaskRectangle(
      { x: 20, y: 1200, width: 200, height: 60 },
      [{ x: 0, y: 0, width: 1440, height: 1000, clipX: true, clipY: true }]
    )).toBeNull();

    expect(intersectReleaseJourneyMaskRectangle(
      { x: 20, y: 400, width: 200, height: 60 },
      [
        { x: 0, y: 0, width: 1440, height: 1000, clipX: true, clipY: true },
        { x: 10, y: 100, width: 300, height: 120, clipX: true, clipY: true }
      ]
    )).toBeNull();
  });

  it("accepts both request-level and layered approval labels without conflating execution", async () : Promise<any> => {
    const source: any = await import("node:fs/promises").then((fs?: any) : any =>
      fs.readFile(
        new URL(
          "../../../tools/server-scripts/lib/release-journey-visual-evidence.ts",
          import.meta.url,
        ),
        { encoding: "utf8" },
      ),
    );

    expect(source).toContain("批准请求");
    expect(source).toContain("Approve Request");
    expect(source).toContain("通过当前审批层");
    expect(source).toContain("resetApprovalEvidenceScroll");
    expect(source).toContain('element.scrollTo({ top: 220, left: 0, behavior: "instant" })');
    expect(source).toContain("element.scrollLeft = 0");
    expect(source).not.toContain("批准并仅执行一次|Approve and Execute Once)$/");
  });

  it("requires privacy-safe screenshots for organization governance and one-time API key issuance", async () : Promise<any> => {
    const source: any = await import("node:fs/promises").then((fs?: any) : any =>
      fs.readFile(new URL(
        "../../../tools/server-scripts/lib/release-journey-visual-evidence.ts",
        import.meta.url
      ), "utf8")
    );
    expect(source).toContain("provisionApiKeyWorkload");
    expect(source).toContain("/admin/organization-governance");
    expect(source).toContain("/admin/api-key-distribution");
    expect(source).toContain("[data-one-time-secret]");
    expect(source).toContain('/^(集团|Group)$/u');
    expect(source).toContain('/管理员|administrator/iu');
    expect(source).toContain("getTimezoneOffset()");
    expect(source).toContain('capture("console-organization-permissions")');
    expect(source).toContain('element.scrollTo({ top: 0, left: 0, behavior: "instant" })');
    expect(source).toContain("Edit from Published Version");
    expect(source).not.toContain("document.documentElement.style.zoom");
    expect(source).toContain('capture("console-api-key-generated"');
    expect(source.lastIndexOf('waitFor({ state: "detached"')).toBeLessThan(
      source.indexOf('capture("console-api-key-generated"')
    );
    expect(source).not.toContain('"meshrix.discovery",\n      "meshrix.gateway",');
    expect(source).toContain("captureDownstreamAgentConfigured");
    expect(source).toContain('data-testid="api-key-distribution-workspace"');
    expect(source).not.toContain("console-token-authorization");
    expect(RELEASE_JOURNEY_VISUAL_CHECKPOINTS).toHaveLength(11);
  });
});
