<script setup lang="ts">
import { computed, resolveComponent, type Ref } from "vue";
import MeshrixTabs, { type MeshrixTab } from "../../components/MeshrixTabs.vue";
import AuthorizationGovernanceCard from "../../components/admin/AuthorizationGovernanceCard.vue";
import GrantToolRulePanel from "../../components/admin/operation-permission/GrantToolRulePanel.vue";
import ToolGrantCreateCard from "../../components/admin/operation-permission/ToolGrantCreateCard.vue";
import ToolGrantListCard from "../../components/admin/operation-permission/ToolGrantListCard.vue";
import ToolPolicyPreviewPanel from "../../components/admin/operation-permission/ToolPolicyPreviewPanel.vue";
import { provideOperationPermissionView } from "../../composables/operationPermissionViewContext";
import { useOperationPermissionViewConsole } from "../../composables/console-operation-permission-view-controller";
import { useConsoleUrlState } from "../../composables/use-console-url-state";
import { consoleMessages, currentConsoleLocale, localizeConsoleText, resolveEffectiveConsoleLocale } from "../../i18n/console";

const operationPermissionView = useOperationPermissionViewConsole();
provideOperationPermissionView(operationPermissionView);

const activeSection: Ref<string> = useConsoleUrlState("op.section", "tokens");

const locale = computed(() => resolveEffectiveConsoleLocale(currentConsoleLocale.value));
const sectionTabs = computed<MeshrixTab[]>(() => [
  { key: "tokens", label: localizeConsoleText("工具令牌", locale.value) },
  { key: "governance", label: localizeConsoleText("治理", locale.value) },
  { key: "verify", label: localizeConsoleText("策略验证", locale.value) },
]);
const journeyMessages = computed(() => consoleMessages[currentConsoleLocale.value].journey);
// Resolved through the app registry instead of a module import: consumers that
// stub vue-router (tests) keep rendering without the links.
const RouterLink: any = resolveComponent("RouterLink");
</script>

<template>
  <section class="operation-permission-layout">
    <header class="operation-permission-header">
      <MeshrixTabs v-model="activeSection" :tabs="sectionTabs" variant="line" size="default" />
    </header>

    <p class="journey-disambiguation" data-testid="journey-disambiguation">
      {{ journeyMessages.toolTokenDecision }}
      <RouterLink to="/admin/api-key-distribution" class="journey-cross-link">
        {{ journeyMessages.clientKeyLink }}
      </RouterLink>
    </p>

    <section v-if="activeSection === 'tokens'" class="operation-permission-stack">
      <ToolGrantCreateCard />
      <ToolGrantListCard />
      <GrantToolRulePanel />
    </section>

    <AuthorizationGovernanceCard v-else-if="activeSection === 'governance'" />

    <ToolPolicyPreviewPanel v-else />
  </section>
</template>

<style scoped>
/* REQ-018 journey affordances — existing tokens only. */
.journey-disambiguation {
  margin: 0 0 var(--space-3);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}
.journey-cross-link {
  color: var(--brand);
  font-weight: var(--font-semibold);
  text-decoration: underline;
  margin-left: var(--space-2);
}
</style>
