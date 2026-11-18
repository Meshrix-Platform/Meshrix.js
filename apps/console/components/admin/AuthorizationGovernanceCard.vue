<script setup lang="ts">
import { useOperationPermissionViewContext } from "../../composables/operationPermissionViewContext";
import { createAuthorizationGovernanceCardContext, provideAuthorizationGovernanceCardContext } from "../../composables/authorizationGovernanceCardContext";
import "./authorization-governance/AuthorizationGovernanceCard.css";
import ConsoleInlineAlert from "../ConsoleInlineAlert.vue";
import AuthorizationGovernanceEditor from "./authorization-governance/AuthorizationGovernanceEditor.vue";
import AuthorizationGovernanceGrid from "./authorization-governance/AuthorizationGovernanceGrid.vue";
import AuthorizationGovernanceMetrics from "./authorization-governance/AuthorizationGovernanceMetrics.vue";

const operationPermissionView = useOperationPermissionViewContext();
const { authorizationGovernanceError } = operationPermissionView;

provideAuthorizationGovernanceCardContext(
  createAuthorizationGovernanceCardContext(operationPermissionView),
);
</script>

<template>
  <article class="surface-card authorization-governance-card">
    <div class="section-header">
      <div>
        <h3>统一权限治理</h3>
        <p>团队权限作为上限，用户策略与审批、智能体绑定与分组共同形成最终裁决。</p>
      </div>
    </div>
    <section class="authorization-governance-priority" aria-label="权限裁决顺序">
      <div><span>边界</span><strong>团队权限上限</strong></div>
      <div><span>覆盖</span><strong>用户策略与审批</strong></div>
      <div><span>执行</span><strong>智能体绑定</strong></div>
    </section>
    <AuthorizationGovernanceMetrics />
    <ConsoleInlineAlert v-if="authorizationGovernanceError" tone="danger">
      {{ authorizationGovernanceError }}
    </ConsoleInlineAlert>
    <details class="authorization-governance-advanced">
      <summary>
        <span>高级策略编辑</span>
        <small>JSON</small>
      </summary>
      <AuthorizationGovernanceEditor />
    </details>
    <AuthorizationGovernanceGrid />
  </article>
</template>
