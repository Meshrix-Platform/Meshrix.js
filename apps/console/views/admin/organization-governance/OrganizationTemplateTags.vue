<script setup lang="ts">
import { computed } from "vue";
import type { OrganizationTemplateTag } from "../../../lib/organization-governance-template-client";
import {
  organizationGovernanceHierarchyRank,
  organizationGovernanceNodeName,
  organizationGovernanceNodeType,
  organizationGovernanceText,
} from "../../../i18n/organization-governance";

const props = defineProps<{ tags: OrganizationTemplateTag[] }>();
const t = organizationGovernanceText;
const orderedTags = computed(() =>
  [...props.tags].sort((left, right) =>
    organizationGovernanceHierarchyRank(left.tagId) - organizationGovernanceHierarchyRank(right.tagId)
    || left.tagId.localeCompare(right.tagId),
  ),
);
</script>

<template>
  <section class="surface-card organization-governance-roles" aria-labelledby="organization-tag-title">
    <div class="section-header organization-governance-card-header">
      <div>
        <h3 id="organization-tag-title">{{ t("模板标签", "Template Tags") }}</h3>
        <p>{{ t("发布前展示 TOML 中所有明确标签及父级关系。", "Every explicit TOML tag and parent relationship is shown before publication.") }}</p>
      </div>
    </div>
    <ul class="organization-governance-role-list">
      <li v-for="tag in orderedTags" :key="tag.tagId">
        <div>
          <strong>{{ organizationGovernanceNodeName(tag.tagId, tag.label) }}</strong>
          <span>{{ tag.tagId }} · {{ organizationGovernanceNodeType(tag.kind) }}</span>
        </div>
        <span class="organization-governance-projection-state">{{
          tag.parentTagId
            ? organizationGovernanceNodeName(tag.parentTagId, tag.parentTagId)
            : t("根标签", "Root tag")
        }}</span>
      </li>
    </ul>
  </section>
</template>
