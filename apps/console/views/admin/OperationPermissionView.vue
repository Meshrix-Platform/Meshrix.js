<script setup lang="ts">
import { computed, ref } from "vue";
import LicoTabs, { type LicoTab } from "../../components/LicoTabs.vue";
import AuthorizationGovernanceCard from "../../components/admin/AuthorizationGovernanceCard.vue";
import GrantToolRulePanel from "../../components/admin/operation-permission/GrantToolRulePanel.vue";
import ToolGrantCreateCard from "../../components/admin/operation-permission/ToolGrantCreateCard.vue";
import ToolGrantListCard from "../../components/admin/operation-permission/ToolGrantListCard.vue";
import ToolPolicyPreviewPanel from "../../components/admin/operation-permission/ToolPolicyPreviewPanel.vue";
import { provideOperationPermissionView } from "../../composables/operationPermissionViewContext";
import { useOperationPermissionViewConsole } from "../../composables/console-operation-permission-view-controller";
import { currentConsoleLocale, localizeConsoleText, resolveEffectiveConsoleLocale } from "../../i18n/console";

const operationPermissionView = useOperationPermissionViewConsole();
provideOperationPermissionView(operationPermissionView);

const activeSection = ref("tokens");

const locale = computed(() => resolveEffectiveConsoleLocale(currentConsoleLocale.value));
const sectionTabs = computed<LicoTab[]>(() => [
  { key: "tokens", label: localizeConsoleText("工具令牌", locale.value) },
  { key: "governance", label: localizeConsoleText("治理", locale.value) },
  { key: "verify", label: localizeConsoleText("策略验证", locale.value) },
]);
</script>

<template>
  <section class="operation-permission-layout">
    <header class="operation-permission-header">
      <LicoTabs v-model="activeSection" :tabs="sectionTabs" variant="line" size="default" />
    </header>

    <section v-if="activeSection === 'tokens'" class="operation-permission-stack">
      <ToolGrantCreateCard />
      <ToolGrantListCard />
      <GrantToolRulePanel />
    </section>

    <AuthorizationGovernanceCard v-else-if="activeSection === 'governance'" />

    <ToolPolicyPreviewPanel v-else />
  </section>
</template>
