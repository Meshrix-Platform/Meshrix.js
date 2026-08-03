import { currentConsoleLocale, resolveEffectiveConsoleLocale } from "./console-locale-state";

export function organizationGovernanceText(zh: string, en: string): string {
  return resolveEffectiveConsoleLocale(currentConsoleLocale.value) === "en" ? en : zh;
}

export function organizationGovernanceTemplateName(templateKey: string, fallback: string): string {
  if (templateKey === "enterprise-group") {
    return organizationGovernanceText("集团", "Enterprise group");
  }
  return fallback;
}

const nodeNames: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  "organization:group": ["集团", "Group"],
  "organization:primary": ["一级机构", "Primary organization"],
  "organization:secondary": ["二级机构", "Secondary organization"],
  "group:department": ["部门", "Department"],
  "group:team": ["团队", "Team"],
});

/** Server/template English labels → localized display when nodeId is unknown. */
const nodeNamesByEnglish: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  Group: nodeNames["organization:group"],
  "Primary organization": nodeNames["organization:primary"],
  "Primary institution": ["一级机构", "Primary institution"],
  "Secondary organization": nodeNames["organization:secondary"],
  "Secondary institution": ["二级机构", "Secondary institution"],
  Department: nodeNames["group:department"],
  Team: nodeNames["group:team"],
});

const roleNames: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  "organization-administrator:group": ["集团管理员", "Group administrator"],
  "organization-administrator:primary": ["一级机构管理员", "Primary organization administrator"],
  "organization-administrator:secondary": ["二级机构管理员", "Secondary organization administrator"],
  "organization-administrator:department": ["部门管理员", "Department administrator"],
  "organization-administrator:team": ["团队管理员", "Team administrator"],
});

const roleScopeNodeIds: Readonly<Record<string, string>> = Object.freeze({
  "organization-administrator:group": "organization:group",
  "organization-administrator:primary": "organization:primary",
  "organization-administrator:secondary": "organization:secondary",
  "organization-administrator:department": "group:department",
  "organization-administrator:team": "group:team",
});

/** High-to-low display order for the enterprise-group hierarchy. */
const hierarchyRank: Readonly<Record<string, number>> = Object.freeze({
  "organization:group": 0,
  "organization:primary": 1,
  "organization:secondary": 2,
  "group:department": 3,
  "group:team": 4,
});

const hierarchyRankByLabel: Readonly<Record<string, number>> = Object.freeze((() => {
  const ranks: Record<string, number> = {};
  for (const [nodeId, rank] of Object.entries(hierarchyRank)) {
    const pair = nodeNames[nodeId];
    if (!pair) continue;
    ranks[pair[0]] = rank;
    ranks[pair[1]] = rank;
  }
  for (const [english, pair] of Object.entries(nodeNamesByEnglish)) {
    const rank = ranks[pair[0]];
    if (rank === undefined) continue;
    ranks[english] = rank;
  }
  return ranks;
})());

export function organizationGovernanceHierarchyRank(nodeOrTagId: string, name = ""): number {
  const byId = hierarchyRank[nodeOrTagId];
  if (byId !== undefined) return byId;
  const label = String(name || "").trim();
  if (label && hierarchyRankByLabel[label] !== undefined) return hierarchyRankByLabel[label];
  const named = nodeNames[nodeOrTagId];
  if (named && hierarchyRankByLabel[named[0]] !== undefined) return hierarchyRankByLabel[named[0]];
  return Number.MAX_SAFE_INTEGER;
}

export function organizationGovernanceRoleHierarchyRank(roleId: string, scopeNodeId = ""): number {
  return organizationGovernanceHierarchyRank(roleScopeNodeIds[roleId] || scopeNodeId);
}

export function organizationGovernanceNodeName(nodeId: string, fallback: string): string {
  const name = nodeNames[nodeId] || nodeNamesByEnglish[String(fallback || "").trim()];
  return name ? organizationGovernanceText(name[0], name[1]) : fallback;
}

export function organizationGovernanceRoleName(roleId: string, fallback: string): string {
  const name = roleNames[roleId];
  return name ? organizationGovernanceText(name[0], name[1]) : fallback;
}

export function organizationGovernanceTemplateDescription(templateKey: string, fallback: string): string {
  return templateKey === "enterprise-group"
    ? organizationGovernanceText("集团、两级机构、部门和团队", "Group, two institution levels, department, and team")
    : fallback;
}

export function organizationGovernanceNodeType(nodeType: string): string {
  return ({
    group: organizationGovernanceText("集团", "Group"),
    organization: organizationGovernanceText("机构", "Institution"),
    department: organizationGovernanceText("部门", "Department"),
    team: organizationGovernanceText("团队", "Team"),
  } as Record<string, string>)[nodeType] || nodeType;
}

const messagePairs: ReadonlyArray<readonly [string, string]> = [
  ["已恢复当前浏览器保存的草稿。", "Restored the draft saved in this browser."],
  ["草稿已保存到当前浏览器。", "Saved the draft in this browser."],
  ["当前浏览器无法保存本地草稿。", "This browser cannot save the local draft."],
  ["请先加载或创建草稿。", "Load or create a draft first."],
  ["标准模板尚未从服务端加载。", "The standard template has not loaded from the server."],
  ["草稿已更新，仅保存在当前浏览器。", "The draft was updated and remains only in this browser."],
  ["已加载标准模板；尚未发布，仅保存在当前浏览器。", "Loaded the standard template. It is unpublished and stored only in this browser."],
  ["已从当前已发布版本创建浏览器草稿。", "Created a browser draft from the currently published version."],
  ["组织架构已被其他操作更新。草稿已保留，请加载最新状态后重试。", "The organization structure was updated elsewhere. Your draft is safe; load the latest state and try again."],
  ["组织架构无效，请根据服务端校验提示检查层级、名称和父子关系。", "The organization structure is invalid. Check its depth, names, and parent relationships using the server validation guidance."],
  ["组织架构服务暂时不可用，浏览器草稿未受影响。", "The organization structure service is temporarily unavailable. Your browser draft is unchanged."],
  ["无法读取服务端组织架构，已保留当前浏览器草稿。", "Could not load the server organization structure. Your browser draft is preserved."],
  ["服务端验证失败，未发布任何变更。", "Server validation failed. No changes were published."],
  ["发布失败，服务端已发布状态未被覆盖，浏览器草稿已保留。", "Publishing failed. The server state was not overwritten and your browser draft is preserved."],
  ["服务端验证通过；尚未发布任何变更。", "Server validation passed. No changes have been published."],
  ["发布已完成，但规范化结果与草稿不同；草稿已保留以便比较。", "Publishing completed, but the normalized result differs from the draft. The draft was preserved for comparison."],
  ["组织架构已发布，但重新同步服务端状态失败；可稍后刷新本页。", "The organization structure was published, but the server state could not be synchronized again. Refresh this page later."],
  ["已加载最新状态；草稿内容保持不变。", "Loaded the latest state. Your draft is unchanged."],
];

export function localizeOrganizationGovernanceMessage(message: string): string {
  if (!message) return message;
  const locale = resolveEffectiveConsoleLocale(currentConsoleLocale.value);
  for (const [zh, en] of messagePairs) {
    if (message === zh || message === en) return locale === "en" ? en : zh;
  }

  const depthMatch = /^(?:机构层级必须是|Organization depth must be an integer from) (\d+)[–-](\d+)(?: 的整数。|\.)$/.exec(message);
  if (depthMatch) {
    return locale === "en"
      ? `Organization depth must be an integer from ${depthMatch[1]}–${depthMatch[2]}.`
      : `机构层级必须是 ${depthMatch[1]}–${depthMatch[2]} 的整数。`;
  }

  return message;
}
