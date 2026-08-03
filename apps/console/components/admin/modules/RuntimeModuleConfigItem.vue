<script setup lang="ts">
import { computed } from "vue";
import BrowseSelectButton from "../../BrowseSelectButton.vue";
import ConsoleDescriptionList from "../../ConsoleDescriptionList.vue";
import FeatureToggle from "../../FeatureToggle.vue";
import StatusPill from "../../StatusPill.vue";
import {
  currentModulePathPlaceholder,
  moduleAvailabilityLabel,
  moduleAvailabilityTone,
  moduleCapabilityText,
  moduleStatusText,
  type RuntimeModuleRow,
} from "../../../composables/console-runtime-module-display-utils";
import { useModulesViewContext } from "../../../composables/modulesViewContext";

const props = defineProps<{
  item: RuntimeModuleRow;
}>();

const moduleDetailItems = computed(() => [
  { label: "运行实例", value: props.item.runtimeMount?.id || "未加载" },
  { label: "能力", value: moduleCapabilityText(props.item) },
  { label: "运行状态", value: moduleStatusText(props.item) },
]);

const {
  isBusy,
  canBrowseServerPaths,
  disableMountModule,
  enableMountModule,
  mountDraft,
  openMountPathPicker,
} = useModulesViewContext();
</script>

<template>
  <article
    class="mount-config-item"
    :data-enabled="item.externalEnabled"
  >
    <div class="mount-config-heading">
      <strong>{{ item.label }}</strong>
      <StatusPill
        :tone="moduleAvailabilityTone(item)"
        :label="moduleAvailabilityLabel(item)"
      />
    </div>
    <p class="mount-config-description">{{ item.description }}</p>
    <ConsoleDescriptionList :items="moduleDetailItems" />

    <div class="mount-config-controls">
      <label class="module-field">
        <span>模块路径</span>
        <div class="path-field">
          <input
            v-model="mountDraft[item.name]"
            autocomplete="off"
            :placeholder="currentModulePathPlaceholder(item)"
          />
          <BrowseSelectButton
            kind="server-file"
            button-class="path-action-button"
            button-text="浏览"
            size="small"
            :disabled="!canBrowseServerPaths"
            plain
            @browse="openMountPathPicker(item.name)"
          />
        </div>
      </label>
      <div class="mount-config-actions">
        <span class="mount-config-toggle-label">{{ item.externalEnabled ? "已开启" : "已关闭" }}</span>
        <FeatureToggle
          :model-value="item.externalEnabled"
          :aria-label="item.externalEnabled ? `关闭${item.label}` : `开启${item.label}`"
          :disabled="
            isBusy(`mount:${item.name}`) ||
            (!item.externalEnabled &&
              !String(mountDraft[item.name] || '').trim())
          "
          @update:model-value="$event ? enableMountModule(item.name) : disableMountModule(item.name)"
        />
      </div>
    </div>
  </article>
</template>

<style scoped>
.mount-config-toggle-label {
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: 600;
  white-space: nowrap;
}
</style>
