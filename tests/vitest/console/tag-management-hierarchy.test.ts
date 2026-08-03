// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { buildTreeRows } from "../../../apps/console/composables/console-tag-management-controller.ts";
import { setConsoleLocaleState } from "../../../apps/console/i18n/console-locale-state.ts";
import {
  isEnterpriseTemplateTag,
  tagManagementTreeTypeName,
  tagManagementKindName,
  tagManagementTagName,
} from "../../../apps/console/i18n/tag-management.ts";

const tag = (tagId: string, kind: string, label: string, parentTagId = "") => ({
  tagId,
  kind,
  label,
  parentTagId,
  description: "",
  enabled: true,
  system: false,
  status: "active" as const,
  scopePrerequisites: [],
  metadata: {},
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
});

afterEach(() => setConsoleLocaleState("zh-CN"));

describe("enterprise group tag hierarchy", () => {
  it("places each administrator role at the same indentation level as its scope", () => {
    const rows = buildTreeRows([
      tag("role:viewer", "role", "Viewer"),
      tag("role:maintainer", "role", "Maintainer"),
      tag("role:owner", "role", "Owner"),
      tag("organization:group", "organization", "Group"),
      tag("organization:primary", "organization", "Primary organization", "organization:group"),
      tag("organization:secondary", "organization", "Secondary organization", "organization:primary"),
      tag("group:department", "group", "Department", "organization:secondary"),
      tag("group:team", "group", "Team", "group:department"),
      // Represents data published before role parent projection was added.
      tag("role:organization-administrator:department", "role", "Department administrator"),
    ]);
    const depth = (tagId: string) => rows.find((row) => row.tag.tagId === tagId)?.depth;
    expect(depth("role:organization-administrator:department")).toBe(depth("group:department"));
    expect(rows[0].tag.tagId).toBe("role:owner");
    expect(rows.slice(0, 3).map((row) => row.tag.tagId)).toEqual([
      "role:owner", "role:maintainer", "role:viewer",
    ]);
    expect(rows[3].tag.tagId).toBe("organization:group");
    expect(rows.findIndex((row) => row.tag.tagId === "role:organization-administrator:department"))
      .toBe(rows.findIndex((row) => row.tag.tagId === "group:department") + 1);
  });

  it("uses stable IDs for independent Chinese and English names", () => {
    setConsoleLocaleState("zh-CN");
    expect(tagManagementTagName("group:department", "Department")).toBe("部门");
    expect(tagManagementTagName("role:organization-administrator:department", "Department administrator")).toBe("部门管理员");
    expect(tagManagementKindName("role")).toBe("角色");
    expect(tagManagementTreeTypeName("role")).toBe("用户角色");
    expect(tagManagementTreeTypeName("group")).toBe("组织层级");
    expect(tagManagementTagName("role:owner", "Owner")).toBe("超级管理员");
    expect(tagManagementTagName("role:maintainer", "Maintainer")).toBe("维护者");
    expect(tagManagementTagName("role:viewer", "Viewer")).toBe("审计员");
    expect(isEnterpriseTemplateTag("group:department")).toBe(true);
    expect(isEnterpriseTemplateTag("custom:department")).toBe(false);

    setConsoleLocaleState("en");
    expect(tagManagementTagName("group:department", "部门")).toBe("Department");
    expect(tagManagementTagName("role:organization-administrator:department", "部门管理员")).toBe("Department administrator");
    expect(tagManagementKindName("role")).toBe("Role");
    expect(tagManagementTagName("role:owner", "Owner")).toBe("Super administrator");
    expect(tagManagementTagName("role:maintainer", "Maintainer")).toBe("Maintainer");
    expect(tagManagementTagName("role:viewer", "Viewer")).toBe("Auditor");
  });
});
