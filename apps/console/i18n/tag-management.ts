import { currentConsoleLocale, resolveEffectiveConsoleLocale } from "./console-locale-state";
import type { TagManagementTag } from "../lib/tag-management-client";

type LocalizedName = Readonly<{ zh: string; en: string }>;

const tagNames: Readonly<Record<string, LocalizedName>> = Object.freeze({
  "organization:group": { zh: "集团", en: "Group" },
  "organization:primary": { zh: "一级机构", en: "Primary organization" },
  "organization:secondary": { zh: "二级机构", en: "Secondary organization" },
  "group:department": { zh: "部门", en: "Department" },
  "group:team": { zh: "团队", en: "Team" },
  "role:organization-administrator:group": { zh: "集团管理员", en: "Group administrator" },
  "role:organization-administrator:primary": { zh: "一级机构管理员", en: "Primary organization administrator" },
  "role:organization-administrator:secondary": { zh: "二级机构管理员", en: "Secondary organization administrator" },
  "role:organization-administrator:department": { zh: "部门管理员", en: "Department administrator" },
  "role:organization-administrator:team": { zh: "团队管理员", en: "Team administrator" },
  "role:maintainer": { zh: "维护者", en: "Maintainer" },
  "role:owner": { zh: "超级管理员", en: "Super administrator" },
  "role:viewer": { zh: "审计员", en: "Auditor" },
});

const kindNames: Readonly<Record<string, LocalizedName>> = Object.freeze({
  organization: { zh: "机构", en: "Institution" },
  group: { zh: "分组", en: "Group" },
  role: { zh: "角色", en: "Role" },
  character: { zh: "特征", en: "Character" },
  custom: { zh: "自定义", en: "Custom" },
});

const enterpriseRoleScopeTags: Readonly<Record<string, string>> = Object.freeze({
  "role:organization-administrator:group": "organization:group",
  "role:organization-administrator:primary": "organization:primary",
  "role:organization-administrator:secondary": "organization:secondary",
  "role:organization-administrator:department": "group:department",
  "role:organization-administrator:team": "group:team",
});

const enterpriseTemplateTagIds: ReadonlySet<string> = new Set([
  "organization:group",
  "organization:primary",
  "organization:secondary",
  "group:department",
  "group:team",
  ...Object.keys(enterpriseRoleScopeTags),
]);

function localizedName(value: LocalizedName): string {
  return resolveEffectiveConsoleLocale(currentConsoleLocale.value) === "en" ? value.en : value.zh;
}

export function tagManagementText(zh: string, en: string): string {
  return localizedName({ zh, en });
}

export function tagManagementTagName(tagId: string, fallback: string): string {
  const name: any = tagNames[tagId];
  return name ? localizedName(name) : fallback;
}

export function tagManagementKindName(kind: string): string {
  const name: any = kindNames[kind];
  return name ? localizedName(name) : kind;
}

export function tagManagementTreeTypeName(kind: string): string {
  if (kind === "organization" || kind === "group") {
    return tagManagementText("组织层级", "Organization Level");
  }
  if (kind === "role") {
    return tagManagementText("用户角色", "User Role");
  }
  return tagManagementText("标签", "Tag");
}

export function isEnterpriseTemplateTag(tagId: string): boolean {
  return enterpriseTemplateTagIds.has(tagId);
}

export function tagManagementRoleScopeTagId(tagId: string): string {
  return enterpriseRoleScopeTags[tagId] || "";
}

export function tagManagementTreeParentId(tag: TagManagementTag, tagsById: ReadonlyMap<string, TagManagementTag>): string {
  if (tag.parentTagId && tagsById.has(tag.parentTagId)) {
    return tag.parentTagId;
  }
  const scopeTagId: any = enterpriseRoleScopeTags[tag.tagId];
  const scopeTag: any = scopeTagId ? tagsById.get(scopeTagId) : null;
  return scopeTag?.parentTagId && tagsById.has(scopeTag.parentTagId) ? scopeTag.parentTagId : "";
}
