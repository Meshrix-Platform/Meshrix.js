<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, type ComputedRef } from "vue";
import BinaryCheckbox from "@meshrix/ui-console/binary-checkbox";
import ConsoleEmptyState from "../ConsoleEmptyState.vue";
import { createConsoleOverlayController } from "../../composables/console-overlay-controller";
import { useServerConsoleShellContext } from "#meshrix/console/server-console-shell-context";
import { consoleMessages, currentConsoleLocale } from "../../i18n/console";

const {
  closeServerPathPicker,
  confirmServerPathPicker,
  openPathEntry,
  pathEntryMeta,
  pathPicker,
  pathPickerModeLabel,
  refreshServerPathBrowser,
  selectServerPath,
} = useServerConsoleShellContext().overlays;

const msg: ComputedRef<any> = computed(() : any => consoleMessages[currentConsoleLocale.value]);

const pickerOpen: ComputedRef<boolean> = computed(() : boolean => Boolean(pathPicker.open));
const dialogRef = ref<HTMLElement | null>(null);

// Escape / focus trap / autofocus on open / restore to the pre-open element.
const pickerOverlay = createConsoleOverlayController({
  root: dialogRef,
  open: pickerOpen,
  onClose: () : any => closeServerPathPicker(),
  initialFocus: "first",
});
watch(pickerOpen, (isOpen: boolean) : void => {
  if (isOpen) {
    void pickerOverlay.activate();
  } else {
    pickerOverlay.deactivate();
  }
});
onBeforeUnmount(() : void => pickerOverlay.deactivate());
</script>

<template>
  <div v-if="pathPicker.open" class="path-picker-backdrop" @click.self="closeServerPathPicker">
    <section ref="dialogRef" class="path-picker-dialog" role="dialog" aria-modal="true" :aria-label="pathPicker.title" tabindex="-1">
      <div class="path-picker-header">
        <div>
          <h3>{{ pathPicker.title }}</h3>
          <p>选择服务端可访问的{{ pathPickerModeLabel(pathPicker.mode) }}路径。</p>
        </div>
        <button
          class="path-picker-close-button dialog-close-button"
          type="button"
          aria-label="关闭"
          title="关闭"
          @click="closeServerPathPicker"
        >
          ×
        </button>
      </div>

      <div class="path-picker-roots">
        <button
          v-for="root in pathPicker.response?.roots || []"
          :key="root.path"
          class="table-action"
          type="button"
          @click="refreshServerPathBrowser(root.path)"
        >
          {{ root.label }}
        </button>
      </div>

      <div class="path-picker-toolbar">
        <input :value="pathPicker.response?.currentPath || pathPicker.value" readonly />
        <button
          class="tool-button tool-button-ghost compact-action"
          type="button"
          :disabled="!pathPicker.response?.parentPath"
          @click="refreshServerPathBrowser(pathPicker.response?.parentPath)"
        >
          上一级
        </button>
        <button class="tool-button tool-button-ghost compact-action" type="button" @click="refreshServerPathBrowser()">
          重载目录
        </button>
        <BinaryCheckbox
          v-model="pathPicker.includeHidden"
          label="显示隐藏项"
          @change="refreshServerPathBrowser()"
        />
      </div>

      <p v-if="pathPicker.extensions.length" class="module-note">
        只显示可选文件类型：{{ pathPicker.extensions.join(", ") }}
      </p>
      <p v-if="pathPicker.error" class="module-note danger-note">{{ pathPicker.error }}</p>
      <p v-if="pathPicker.response?.truncated" class="module-note">
        当前目录内容较多，只显示前 600 项。
      </p>

      <div class="path-picker-list">
        <article
          v-for="entry in pathPicker.response?.entries || []"
          :key="entry.path"
          class="path-picker-entry"
          :data-selectable="entry.selectable"
        >
          <span class="path-picker-entry-icon" :data-type="entry.type" aria-hidden="true"></span>
          <div
            class="path-picker-entry-main"
            :class="{ 'is-browsable': entry.browsable }"
            :role="entry.browsable ? 'button' : undefined"
            :tabindex="entry.browsable ? 0 : undefined"
            @click="entry.browsable ? openPathEntry(entry) : undefined"
            @keydown.enter="entry.browsable ? openPathEntry(entry) : undefined"
            @keydown.space.prevent="entry.browsable ? openPathEntry(entry) : undefined"
          >
            <strong>{{ entry.name }}</strong>
            <span>{{ entry.path }}</span>
            <small v-if="pathEntryMeta(entry)">{{ pathEntryMeta(entry) }}</small>
          </div>
          <div class="path-picker-entry-actions">
            <button
              v-if="entry.selectable"
              class="tool-button compact-action"
              type="button"
              @click="selectServerPath(entry.path)"
            >
              选择
            </button>
          </div>
        </article>
        <ConsoleEmptyState
          v-if="!pathPicker.loading && (pathPicker.response?.entries || []).length === 0"
          compact
          title="没有可显示的项目"
          description="可以切换根目录、上一级目录，或显示隐藏项。"
        />
        <p v-if="pathPicker.loading" class="module-note" role="status">{{ msg.overlay.pathPickerLoading }}</p>
      </div>

      <div class="path-picker-footer">
        <button
          v-if="!pathPicker.closeOnSelect"
          class="tool-button"
          type="button"
          @click="confirmServerPathPicker"
        >
          确认
        </button>
        <button class="tool-button tool-button-ghost" type="button" @click="closeServerPathPicker">
          取消
        </button>
      </div>
    </section>
  </div>
</template>
