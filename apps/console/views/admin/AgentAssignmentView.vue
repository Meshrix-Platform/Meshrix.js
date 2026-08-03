<script setup lang="ts">
import AgentModelOptionBar from "../../components/AgentModelOptionBar.vue";
import FeatureToggle from "../../components/FeatureToggle.vue";
import OptionBar from "@meshrix/ui-console/option-bar";
import StatusPill from "../../components/StatusPill.vue";
import "./agent-assignment/agent-assignment.css";
import { useAgentAssignmentView } from "./agent-assignment/useAgentAssignmentView";

const {
  agentAssignmentSaving,
  assignedCapabilityCount,
  capabilityAssignments,
  capabilityBatchSelectOptions,
  capabilityBatchSelectValue,
  capabilityProbeFailures,
  capabilitySaveButtonText,
  configTargetIsHighlighted,
  intelligentModuleDefinitions,
  moduleAssignmentOptions,
  moduleBatchSelectOptions,
  moduleBatchSelectValue,
  moduleModelAssignmentStats,
  moduleModelRef,
  moduleNeedsIntelligence,
  moduleProbeFailures,
  moduleRequirementLabel,
  moduleSaveButtonText,
  moduleStatus,
  applyCapabilityBatch,
  applyModuleBatch,
  saveCapabilityAssignments,
  saveModuleAssignments,
  selectedOptionStatus,
  updateModuleEnabled,
  updateModuleModelRef,
} = useAgentAssignmentView();
</script>

<template>
  <section class="agent-assignment-layout">
    <article class="surface-card agent-assignment-panel">
      <div class="section-header agent-assignment-header">
        <div>
          <h3>智能体能力</h3>
          <p>集中维护能力功能使用的默认智能体。</p>
        </div>
        <div class="agent-assignment-header-actions">
          <div class="agent-assignment-summary" aria-label="智能体分配摘要">
            <span><strong>{{ assignedCapabilityCount }}</strong> / {{ capabilityAssignments.length }} 能力功能</span>
          </div>
          <button
            class="tool-button agent-assignment-save-button"
            type="button"
            :disabled="agentAssignmentSaving"
            aria-label="保存智能体能力配置"
            @click="saveCapabilityAssignments"
          >
            {{ capabilitySaveButtonText }}
          </button>
        </div>
      </div>

      <div v-if="capabilityProbeFailures.length" class="agent-assignment-probe-alert" role="alert">
        <strong>连通性检测失败，未保存</strong>
        <ul>
          <li v-for="failure in capabilityProbeFailures" :key="failure.key">
            <span>{{ failure.label }}</span>
            <small>{{ failure.message }}</small>
          </li>
        </ul>
      </div>

      <div class="agent-assignment-list" role="list" aria-label="智能体能力默认智能体">
        <section class="agent-assignment-row agent-assignment-batch-row" role="listitem">
          <div class="agent-assignment-main">
            <div class="agent-assignment-title-row">
              <h4>默认</h4>
            </div>
          </div>
          <div class="agent-assignment-batch-control">
            <span>一键分配到</span>
            <OptionBar
              :model-value="capabilityBatchSelectValue"
              :options="capabilityBatchSelectOptions"
              @update:model-value="applyCapabilityBatch"
            />
          </div>
        </section>
        <section
          v-for="assignment in capabilityAssignments"
          :key="assignment.id"
          class="agent-assignment-row"
          role="listitem"
          :data-config-target="assignment.id"
          :data-config-highlighted="configTargetIsHighlighted(assignment.id)"
        >
          <div class="agent-assignment-main">
            <div class="agent-assignment-title-row">
              <h4>{{ assignment.title }}</h4>
              <StatusPill
                :label="selectedOptionStatus(assignment.options, assignment.value).label"
                :tone="selectedOptionStatus(assignment.options, assignment.value).tone"
              />
            </div>
            <p>{{ assignment.description }}</p>
          </div>
          <AgentModelOptionBar
            class="agent-assignment-control"
            :model-value="assignment.value"
            :options="assignment.options"
            include-empty
            empty-label="未分配智能体"
            label="默认智能体"
            @update:model-value="assignment.update(String($event))"
          />
        </section>
      </div>
    </article>

    <article class="surface-card agent-assignment-panel">
      <div class="section-header agent-assignment-header">
        <div>
          <h3>智能体辅助模块</h3>
          <p>为需要大模型参与的后台模块指定主智能体，保存后写入服务端配置。</p>
        </div>
        <div class="agent-assignment-header-actions">
          <div class="agent-assignment-summary" aria-label="智能体辅助模块摘要">
            <span><strong>{{ moduleModelAssignmentStats.assigned }}</strong> / {{ moduleModelAssignmentStats.enabled }} 模块</span>
          </div>
          <button
            class="tool-button agent-assignment-save-button"
            type="button"
            :disabled="agentAssignmentSaving"
            aria-label="保存智能体辅助模块配置"
            @click="saveModuleAssignments"
          >
            {{ moduleSaveButtonText }}
          </button>
        </div>
      </div>

      <div v-if="moduleProbeFailures.length" class="agent-assignment-probe-alert" role="alert">
        <strong>连通性检测失败，未保存</strong>
        <ul>
          <li v-for="failure in moduleProbeFailures" :key="failure.key">
            <span>{{ failure.label }}</span>
            <small>{{ failure.message }}</small>
          </li>
        </ul>
      </div>

      <div class="agent-assignment-list" role="list" aria-label="智能体辅助模块分配">
        <section class="agent-assignment-row agent-assignment-batch-row" role="listitem">
          <div class="agent-assignment-main">
            <div class="agent-assignment-title-row">
              <h4>默认</h4>
            </div>
          </div>
          <div class="agent-assignment-batch-control">
            <span>一键分配到</span>
            <OptionBar
              :model-value="moduleBatchSelectValue"
              :options="moduleBatchSelectOptions"
              @update:model-value="applyModuleBatch"
            />
          </div>
        </section>
        <section
          v-for="moduleDefinition in intelligentModuleDefinitions"
          :key="moduleDefinition.id"
          class="agent-assignment-row module-assignment-row"
          role="listitem"
          :data-config-target="`module-agent-${moduleDefinition.id}`"
          :data-config-highlighted="configTargetIsHighlighted(`module-agent-${moduleDefinition.id}`)"
        >
          <div class="agent-assignment-main">
            <div class="agent-assignment-title-row">
              <h4>{{ moduleDefinition.label }}</h4>
            </div>
            <p>{{ moduleDefinition.description }}</p>
            <div class="agent-assignment-card-tags" aria-label="模块标签">
              <StatusPill
                :label="moduleStatus(moduleDefinition.id).label"
                :tone="moduleStatus(moduleDefinition.id).tone"
              />
              <span class="agent-assignment-card-tag">{{ moduleRequirementLabel(moduleDefinition.alertRequired) }}</span>
              <span class="agent-assignment-card-tag">
                设计模块：{{ moduleDefinition.designedModule || moduleDefinition.id }}
              </span>
            </div>
          </div>
          <div class="module-assignment-controls">
            <FeatureToggle
              :model-value="moduleNeedsIntelligence(moduleDefinition.id)"
              label="启用智能体"
              :aria-label="moduleNeedsIntelligence(moduleDefinition.id) ? `停用${moduleDefinition.label}智能体` : `启用${moduleDefinition.label}智能体`"
              @update:model-value="updateModuleEnabled(moduleDefinition.id, Boolean($event))"
            />
            <OptionBar
              :model-value="moduleModelRef(moduleDefinition.id)"
              :options="moduleAssignmentOptions(moduleDefinition.id)"
              label="主智能体"
              :disabled="!moduleNeedsIntelligence(moduleDefinition.id)"
              @update:model-value="updateModuleModelRef(moduleDefinition.id, String($event))"
            />
          </div>
        </section>
      </div>
    </article>
  </section>
</template>
