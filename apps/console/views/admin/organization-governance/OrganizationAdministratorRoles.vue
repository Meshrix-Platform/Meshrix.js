<script setup lang="ts">
import { computed } from "vue";
import HelpTooltip from "../../../components/HelpTooltip.vue";
import type {
  OrganizationGovernancePreview,
  OrganizationGovernanceSnapshot,
  OrganizationGovernanceTemplateDraft,
} from "../../../lib/organization-governance-template-client";
import {
  organizationGovernanceNodeName,
  organizationGovernanceRoleHierarchyRank,
  organizationGovernanceRoleName,
  organizationGovernanceText,
} from "../../../i18n/organization-governance";

const props = defineProps<{
  draft: OrganizationGovernanceTemplateDraft | null;
  projection: OrganizationGovernancePreview | OrganizationGovernanceSnapshot | null;
}>();

const nodeNames = computed(() => new Map([
  ...(props.draft?.nodes || []),
  ...(props.projection?.nodes || []),
].map((node) => [node.nodeId, organizationGovernanceNodeName(node.nodeId, node.name)])));

const rows = computed(() => {
  const source = props.projection?.roles || props.draft?.roles || [];
  const state = props.projection
    ? (props.draft ? "validated" : "published")
    : "imported";
  return [...source]
    .map((role) => ({
      key: role.roleId,
      name: organizationGovernanceRoleName(role.roleId, role.name),
      scope: nodeNames.value.get(role.scopeNodeId) || role.scopeNodeId,
      scopeType: role.scopeNodeType,
      state,
      rank: organizationGovernanceRoleHierarchyRank(role.roleId, role.scopeNodeId),
    }))
    .sort((left, right) => left.rank - right.rank || left.key.localeCompare(right.key));
});

const t = organizationGovernanceText;
const scopeLabel = (scopeType: string) => ({
  group: t("集团范围", "Group scope"),
  organization: t("机构范围", "Organization scope"),
  department: t("部门范围", "Department scope"),
  team: t("团队范围", "Team scope"),
}[scopeType] || scopeType);
</script>

<template>
  <section class="surface-card organization-governance-roles" aria-labelledby="organization-role-title">
    <div class="section-header organization-governance-card-header">
      <div>
        <h3 id="organization-role-title" class="organization-governance-title-with-help">
          {{ t("范围管理员角色", "Scoped Administrator Roles") }}
          <HelpTooltip
            :aria-label="t('范围管理员角色说明', 'Scoped administrator role guidance')"
            :text="t('角色由 TOML 明确声明并由服务端严格验证。角色名称不授予权限，也不会自动绑定任何用户。', 'Roles are declared explicitly in TOML and validated strictly by the server. A role name grants no authority and binds no user automatically.')"
          />
        </h3>
        <p>{{ t("仅包含组织结构读取、成员读取与成员管理操作。", "Includes only structure read, membership read, and membership management operations.") }}</p>
      </div>
    </div>

    <div class="organization-governance-security-note" role="note">
      <strong>{{ t("业务资源权限始终为空", "Business-resource permissions are always empty") }}</strong>
      <span>{{ t("这些角色不会授予文件、任务、工具或其他业务资源访问权，也不会自动绑定人员。", "These roles grant no access to files, tasks, tools, or other business resources, and bind no person automatically.") }}</span>
    </div>

    <ul v-if="rows.length" class="organization-governance-role-list">
      <li v-for="row in rows" :key="row.key">
        <div>
          <strong>{{ row.name }}</strong>
          <span>{{ row.scope }} · {{ scopeLabel(row.scopeType) }}</span>
        </div>
        <span class="organization-governance-projection-state">
          {{ row.state === "published" ? t("已发布", "Published") : row.state === "validated" ? t("已验证", "Validated") : t("已导入", "Imported") }}
        </span>
      </li>
    </ul>
    <p v-else class="organization-governance-empty-copy">{{ t("加载草稿或已发布架构后显示范围角色。", "Scoped roles appear after loading a draft or published structure.") }}</p>
  </section>
</template>
