export type GovernanceItem = Record<string, unknown>;

export type AuthorizationGovernanceSummary = {
  roles: GovernanceItem[];
  departments: GovernanceItem[];
  teams: GovernanceItem[];
  userPolicies: GovernanceItem[];
  agentBindings: GovernanceItem[];
  agentGroups: GovernanceItem[];
  approvals: GovernanceItem[];
};

export type AuthorizationGovernancePanelRow = {
  key: string;
  title: string;
  detail: string;
  meta: string;
};

export type AuthorizationGovernancePanel = {
  title: string;
  count: number;
  emptyLabel: string;
  rows: AuthorizationGovernancePanelRow[];
};

type AuthorizationGovernancePanelHelpers = {
  itemText: (item: GovernanceItem, keys: string[], fallback?: string) => string;
  policyCount: (item: GovernanceItem) => number;
  shortList: (value: unknown, fallback?: string) => string;
};

function panel(
  title: string,
  items: GovernanceItem[] = [],
  emptyLabel: string,
  row: (item: GovernanceItem) => AuthorizationGovernancePanelRow,
): AuthorizationGovernancePanel {
  return {
    title,
    count: items.length,
    emptyLabel,
    rows: items.slice(0, 6).map(row),
  };
}

export function createAuthorizationGovernancePanels(
  governance: AuthorizationGovernanceSummary,
  helpers: AuthorizationGovernancePanelHelpers,
): AuthorizationGovernancePanel[] {
  const { itemText, policyCount, shortList } = helpers;
  return [
    panel("角色", governance.roles, "暂无角色", (role) => ({
      key: itemText(role, ["roleId", "id"]),
      title: itemText(role, ["label", "roleId", "id"]),
      detail: shortList(role.scopes),
      meta: `${policyCount(role)} 个资源模板`,
    })),
    panel("部门", governance.departments, "暂无部门", (department) => ({
      key: itemText(department, ["departmentId", "id"]),
      title: itemText(department, ["label", "departmentId", "id"]),
      detail: shortList(department.teamIds || department.teams || department.memberUserIds || department.members, "无团队或成员"),
      meta: `${policyCount(department)} 个资源授权`,
    })),
    panel("团队", governance.teams, "暂无团队", (team) => ({
      key: itemText(team, ["teamId", "id"]),
      title: itemText(team, ["label", "teamId", "id"]),
      detail: shortList(team.departmentIds || team.departments || team.memberUserIds || team.members, "无部门或成员"),
      meta: `${policyCount(team)} 个资源授权`,
    })),
    panel("用户策略", governance.userPolicies, "暂无用户策略", (policy) => ({
      key: itemText(policy, ["userId", "id"]),
      title: itemText(policy, ["userId", "id"]),
      detail: shortList(policy.departmentIds || policy.departments || policy.teamIds || policy.teams, "无部门或团队"),
      meta: `${policyCount(policy)} 个资源授权`,
    })),
    panel("智能体", governance.agentBindings, "暂无智能体绑定", (binding) => ({
      key: itemText(binding, ["agentId", "id"]),
      title: itemText(binding, ["agentId", "id"]),
      detail: itemText(binding, ["boundUserId", "userId"], "未绑定用户"),
      meta: shortList(binding.groupIds || binding.groups, "无分组"),
    })),
    panel("智能体分组", governance.agentGroups, "暂无智能体分组", (group) => ({
      key: itemText(group, ["groupId", "id"]),
      title: itemText(group, ["label", "groupId", "id"]),
      detail: `${policyCount(group)} 个资源授权`,
      meta: itemText(group, ["enabled"], "true") === "false" ? "停用" : "启用",
    })),
    panel("审批", governance.approvals, "暂无审批", (approval) => ({
      key: itemText(approval, ["approvalId", "id"]),
      title: itemText(approval, ["grantKind", "kind"], "once"),
      detail: `${itemText(approval, ["agentId"], "全部智能体")} / ${itemText(approval, ["userId"], "全部用户")}`,
      meta: shortList(approval.approvalLayers || approval.layers, itemText(approval, ["resourceId"], "*")),
    })),
  ];
}
