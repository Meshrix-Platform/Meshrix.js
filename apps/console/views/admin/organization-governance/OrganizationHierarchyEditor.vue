<script setup lang="ts">
import { computed } from "vue";
import type { OrganizationGovernanceTemplateDraft } from "../../../lib/organization-governance-template-client";
import {
  organizationGovernanceHierarchyRank,
  organizationGovernanceNodeName,
  organizationGovernanceNodeType,
  organizationGovernanceTemplateDescription,
  organizationGovernanceTemplateName,
  organizationGovernanceText,
} from "../../../i18n/organization-governance";

const props = defineProps<{ draft: OrganizationGovernanceTemplateDraft }>();
const t = organizationGovernanceText;
const rows = computed(() => {
  const byId = new Map(props.draft.nodes.map((node) => [node.nodeId, node]));
  const depthOf = (nodeId: string, seen = new Set<string>()): number => {
    const node = byId.get(nodeId);
    if (!node?.parentId) return 0;
    if (seen.has(nodeId)) return 0;
    seen.add(nodeId);
    return depthOf(node.parentId, seen) + 1;
  };
  return [...props.draft.nodes]
    .map((node) => ({ node, depth: depthOf(node.nodeId) }))
    .sort((left, right) =>
      left.depth - right.depth
      || organizationGovernanceHierarchyRank(left.node.nodeId) - organizationGovernanceHierarchyRank(right.node.nodeId)
      || left.node.nodeId.localeCompare(right.node.nodeId),
    );
});
</script>

<template>
  <section class="surface-card organization-governance-editor" aria-labelledby="organization-editor-title">
    <div class="section-header organization-governance-card-header">
      <div>
        <h3 id="organization-editor-title">{{ t("规范化组织层级", "Normalized Organization Hierarchy") }}</h3>
        <p>{{ organizationGovernanceTemplateName(draft.templateKey, draft.templateName) }} · {{ organizationGovernanceTemplateDescription(draft.templateKey, draft.description) }}</p>
      </div>
      <span class="organization-governance-local-badge">{{ t("仅当前浏览器", "This browser only") }}</span>
    </div>
    <div class="organization-governance-hierarchy">
      <div
        v-for="{ node, depth } in rows"
        :key="node.nodeId"
        class="organization-governance-node-row"
        :style="{ '--node-depth': depth }"
      >
        <span class="organization-governance-node-type">{{ organizationGovernanceNodeType(node.nodeType) }}</span>
        <strong>{{ organizationGovernanceNodeName(node.nodeId, node.name) }}</strong>
        <small>{{ node.nodeId }}</small>
      </div>
    </div>
  </section>
</template>
