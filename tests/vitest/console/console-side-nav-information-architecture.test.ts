import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ADMIN_ROUTE_REGISTRY } from "../../../apps/console/router/admin-route-registry";

function source(relativePath: string): string {
  return readFileSync(new URL(`../../../apps/console/${relativePath}`, import.meta.url), "utf8");
}

describe("console side nav information architecture", () => {
  it("renders the active administration groups in the canonical order", () => {
    const sideNav = source("components/shell/ConsoleSideNav.vue");
    const sectionTags = [
      "<ConsoleSideNavServiceSection />",
      "<ConsoleSideNavToolsSection />",
      "<ConsoleSideNavPermissionSection />",
      "<ConsoleSideNavSystemSection />",
      "<ConsoleSideNavOperationsSection />",
      "<ConsoleSideNavVersionSection />",
    ];

    expect(sectionTags.every((tag) => sideNav.includes(tag))).toBe(true);
    for (let index = 1; index < sectionTags.length; index += 1) {
      expect(sideNav.indexOf(sectionTags[index - 1])).toBeLessThan(sideNav.indexOf(sectionTags[index]));
    }
  });

  it("owns tags and organization structure exclusively in the permission group", () => {
    const permissionSection = source("components/shell/side-nav/ConsoleSideNavPermissionSection.vue");
    const systemSection = source("components/shell/side-nav/ConsoleSideNavSystemSection.vue");

    for (const viewKey of ["tagManagement", "organizationGovernance", "apiKeyDistribution"]) {
      expect(permissionSection).toContain(viewKey);
      expect(systemSection).not.toContain(viewKey);
      expect(ADMIN_ROUTE_REGISTRY.find((entry) => entry.viewKey === viewKey)?.section).toBe("permission");
    }
  });

  it("places key distribution after organization structure and gates it on server issuer scope", () => {
    const permissionSection = source("components/shell/side-nav/ConsoleSideNavPermissionSection.vue");

    expect(permissionSection.indexOf("organizationGovernance")).toBeLessThan(
      permissionSection.lastIndexOf("apiKeyDistribution"),
    );
    expect(permissionSection).toContain("apiKeyDistributionEligible");
    expect(permissionSection).toContain("loadApiKeyDistributionAvailability");
    expect(ADMIN_ROUTE_REGISTRY.find((entry) => entry.viewKey === "apiKeyDistribution")).toMatchObject({
      slug: "api-key-distribution",
      section: "permission",
      requiredScopes: ["console:read"],
    });
  });

  it("uses only canonical administration section identifiers", () => {
    const sections = new Set(ADMIN_ROUTE_REGISTRY.map((entry) => entry.section));

    expect(sections).toEqual(new Set([
      "primary",
      "service",
      "tools",
      "permission",
      "system",
      "operations",
      "version",
    ]));
  });
});
