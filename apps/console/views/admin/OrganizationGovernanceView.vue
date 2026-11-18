<script setup lang="ts">
import { computed, onMounted } from "vue";
import { usePageRefreshHandler } from "@meshrix/ui-console/page-refresh";
import ConsoleInlineAlert from "../../components/ConsoleInlineAlert.vue";
import BrowseSelectButton from "../../components/BrowseSelectButton.vue";
import { useConsoleOrganizationGovernanceController } from "../../composables/console-organization-governance-controller";
import OrganizationAdministratorRoles from "./organization-governance/OrganizationAdministratorRoles.vue";
import OrganizationHierarchyEditor from "./organization-governance/OrganizationHierarchyEditor.vue";
import OrganizationTemplateTags from "./organization-governance/OrganizationTemplateTags.vue";
import {
  organizationGovernanceTemplateName,
  localizeOrganizationGovernanceMessage,
  organizationGovernanceText,
} from "../../i18n/organization-governance";
import "../../styles/views/organization-governance.css";

defineOptions({ name: "OrganizationGovernanceView" });

const {
  adoptLatestRevision,
  cancelEditDraft,
  configured,
  draft,
  editPublishedSnapshot,
  error,
  hasDraft,
  importBuiltIn,
  importLocalFiles,
  importing,
  loading,
  persistDraft,
  preview,
  publishDraft,
  publishing,
  refresh,
  revisionConflict,
  snapshot,
  status,
  templates,
  validateDraft,
  validating,
} = useConsoleOrganizationGovernanceController();

const localizedError = computed(() => localizeOrganizationGovernanceMessage(error.value));
const localizedStatus = computed(() => localizeOrganizationGovernanceMessage(status.value));
const t = organizationGovernanceText;

onMounted(() => void refresh());

usePageRefreshHandler(
  (detail: any) => detail.viewId === "admin" && detail.adminView === "organizationGovernance",
  refresh,
);
</script>

<template>
  <section
    class="organization-governance-layout"
    :data-server-state="configured ? 'published' : 'unconfigured'"
    :data-draft-state="hasDraft ? 'draft' : 'none'"
  >
    <header class="section-header organization-governance-page-header">
      <div>
        <h2>{{ t("组织架构", "Organization Structure") }}</h2>
        <p>{{ t("创建、验证并发布组织治理基线。浏览器草稿与服务端已发布状态彼此独立。", "Create, validate, and publish the organization governance baseline. Browser drafts and published server state remain independent.") }}</p>
      </div>
    </header>

    <ConsoleInlineAlert v-if="error || revisionConflict" tone="danger">
      {{ localizedError || t("组织架构已发生变化，当前草稿没有丢失。请加载最新状态，比较后再继续发布。", "The organization structure changed while you were editing. Your draft is safe. Load the latest state and compare before publishing.") }}
      <template v-if="revisionConflict" #action>
        <button
          class="table-action"
          type="button"
          :disabled="loading || validating || publishing"
          :aria-busy="loading"
          @click="adoptLatestRevision"
        >
          {{ loading ? t("加载中", "Loading") : t("加载最新状态", "Load Latest State") }}
        </button>
      </template>
    </ConsoleInlineAlert>
    <ConsoleInlineAlert v-if="status" tone="success">{{ localizedStatus }}</ConsoleInlineAlert>

    <section class="surface-card organization-governance-state-card" aria-live="polite">
      <div class="organization-governance-state-summary">
        <div>
          <span>{{ t("服务端状态", "Server State") }}</span>
          <strong>{{ !snapshot ? t("尚未同步", "Not synchronized") : configured ? t("已发布", "Published") : t("未配置", "Unconfigured") }}</strong>
        </div>
        <div>
          <span>{{ t("机构层级", "Organization Depth") }}</span>
          <strong>{{ snapshot?.configured ? snapshot.organizationDepth : "—" }}</strong>
        </div>
        <div>
          <span>{{ t("发布时间", "Published At") }}</span>
          <strong>{{ snapshot?.publishedAt || "—" }}</strong>
        </div>
      </div>

      <div v-if="!loading && snapshot && !snapshot.configured" class="organization-governance-unconfigured">
        <div>
          <strong>{{ t("服务端尚未配置组织架构", "The server has no configured organization structure") }}</strong>
          <p>{{ t("选择内置 TOML 或导入一个本地 .toml 文件。服务端规范化后才会创建浏览器草稿。", "Choose a built-in TOML template or import one local .toml file. A browser draft is created only after server normalization.") }}</p>
        </div>
        <div class="organization-governance-actions horizontal-action-group">
          <button
            v-for="template in templates"
            :key="template.templateKey"
            class="primary-action"
            type="button"
            :disabled="importing || hasDraft"
            @click="importBuiltIn(template.templateKey)"
          >
            {{ organizationGovernanceTemplateName(template.templateKey, template.templateName) }}
          </button>
          <BrowseSelectButton
            kind="local-files"
            :multiple="false"
            accept=".toml,application/toml,text/plain"
            :disabled="importing || hasDraft"
            :loading="importing"
            :button-text="t('导入本地 TOML', 'Import Local TOML')"
            @select="importLocalFiles"
          />
        </div>
      </div>
      <div v-else-if="snapshot?.configured" class="organization-governance-published">
        <p>
          {{ t("已发布", "Published") }} {{ snapshot.nodes.length }}
          {{ t("个结构节点和", "structure nodes and") }}
          {{ snapshot.tags.length }} {{ t("个标签和", "tags and") }}
          {{ snapshot.roles.length }} {{ t("个范围管理员角色。", "scoped administrator roles.") }}
        </p>
        <button class="table-action" type="button" :disabled="hasDraft" @click="editPublishedSnapshot">
          {{ t("基于已发布版本编辑", "Edit from Published Version") }}
        </button>
      </div>
    </section>

    <div v-if="draft" class="organization-governance-workspace">
      <OrganizationHierarchyEditor
        :draft="draft"
      />
      <OrganizationTemplateTags :tags="draft.tags" />
      <OrganizationAdministratorRoles :draft="draft" :projection="preview" />
    </div>
    <OrganizationAdministratorRoles
      v-else-if="snapshot?.configured"
      :draft="null"
      :projection="snapshot"
    />
    <OrganizationTemplateTags v-if="!draft && snapshot?.configured" :tags="snapshot.tags" />

    <section v-if="draft" class="surface-card organization-governance-action-card">
      <div>
        <strong>{{ t("浏览器草稿", "Browser Draft") }}</strong>
        <p>{{ t("发布前会自动验证草稿。发布后，组织架构和各级角色将按此模板设置。", "Publishing validates the draft automatically, then applies this template to the organization structure and its roles.") }}</p>
      </div>
      <div class="organization-governance-actions horizontal-action-group">
        <button class="table-action" type="button" :disabled="validating || publishing" @click="persistDraft()">
          {{ t("保存草稿", "Save Draft") }}
        </button>
        <button class="table-action" type="button" :disabled="validating || publishing" @click="validateDraft">
          {{ validating && !publishing ? t("验证中", "Validating") : t("验证有效性", "Validate") }}
        </button>
        <button
          class="primary-action"
          type="button"
          :disabled="validating || publishing || revisionConflict"
          @click="publishDraft"
        >
          {{ publishing ? (validating ? t("验证中", "Validating") : t("发布中", "Publishing")) : t("发布", "Publish") }}
        </button>
        <button
          class="table-action organization-governance-danger-action"
          type="button"
          :disabled="validating || publishing"
          @click="cancelEditDraft"
        >
          {{ t("取消编辑", "Cancel Editing") }}
        </button>
      </div>
    </section>
  </section>
</template>
