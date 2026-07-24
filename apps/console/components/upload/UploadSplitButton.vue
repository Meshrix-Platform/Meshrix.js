<script setup lang="ts">
import { computed, ref } from "vue";
import BrowseSelectButton from "../BrowseSelectButton.vue";
import { uploadFileListIcons } from "../../lib/upload-file-list";
import { useConsoleDocumentDismissController } from "../../composables/console-document-dismiss-controller";
import { currentConsoleLocale, localizeConsoleText, resolveEffectiveConsoleLocale } from "../../i18n/console";

withDefaults(defineProps<{
  disabled?: boolean;
}>(), {
  disabled: false,
});

const emit = defineEmits<{
  select: [files: File[]];
}>();

const uploadIconUrl = uploadFileListIcons.upload;
const folderIconUrl = uploadFileListIcons.folder;
const chevronDownIconUrl = uploadFileListIcons.chevronDown;
const uploadMenuOpen = ref(false);
const uploadMenuRoot = ref<HTMLElement | null>(null);
const locale = computed(() => resolveEffectiveConsoleLocale(currentConsoleLocale.value));
function t(value: string) {
  return localizeConsoleText(value, locale.value);
}

function closeUploadMenu() {
  uploadMenuOpen.value = false;
}

function toggleUploadMenu() {
  if (uploadMenuOpen.value) {
    closeUploadMenu();
    return;
  }
  uploadMenuOpen.value = true;
}

function handleDirectorySelected(files: File[]) {
  closeUploadMenu();
  emit("select", files);
}

useConsoleDocumentDismissController({
  active: uploadMenuOpen,
  root: uploadMenuRoot,
  onDismiss: closeUploadMenu,
});
</script>

<template>
  <div ref="uploadMenuRoot" class="upload-split-button" :aria-label="t('上传文件')">
    <BrowseSelectButton
      kind="local-files"
      button-class="upload-split-main"
      :button-text="t('上传文件')"
      :disabled="disabled"
      :multiple="true"
      @select="emit('select', $event)"
    >
      <img :src="uploadIconUrl" alt="" aria-hidden="true" />
      <span>{{ t("上传文件") }}</span>
    </BrowseSelectButton>
    <button
      class="upload-split-arrow"
      type="button"
      :disabled="disabled"
      aria-haspopup="menu"
      :aria-expanded="uploadMenuOpen"
      :aria-label="t('展开上传选项')"
      @click="toggleUploadMenu"
    >
      <img :src="chevronDownIconUrl" alt="" aria-hidden="true" />
    </button>
    <div v-if="uploadMenuOpen" class="upload-split-menu" role="menu">
      <BrowseSelectButton
        kind="local-directory"
        button-class="upload-split-menu-item"
        :button-text="t('上传文件夹')"
        :disabled="disabled"
        @select="handleDirectorySelected"
      >
        <img :src="folderIconUrl" alt="" aria-hidden="true" />
        <span>{{ t("上传文件夹") }}</span>
      </BrowseSelectButton>
    </div>
  </div>
</template>

<style scoped>
.upload-split-button {
  --upload-split-control-height: 40px;
  --upload-split-control-bg: var(--success);
  --upload-split-control-bg-hover: #15803d;
  --upload-split-control-color: #ffffff;
  --upload-split-control-icon-size: 18px;
  --upload-split-control-font-size: var(--text-lg);
  --upload-split-control-font-weight: 800;
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  min-width: 0;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
}

.upload-split-button :deep(.browse-select-button) {
  display: inline-flex;
}

.upload-split-button :deep(.upload-split-main.el-button),
.upload-split-arrow {
  height: var(--upload-split-control-height);
  margin-left: 0;
  padding: 0 16px;
  border-color: var(--upload-split-control-bg);
  background: var(--upload-split-control-bg);
  color: var(--upload-split-control-color);
  font-size: var(--upload-split-control-font-size);
  font-weight: var(--upload-split-control-font-weight);
  line-height: 1;
}

.upload-split-button :deep(.upload-split-main.el-button:hover),
.upload-split-button :deep(.upload-split-main.el-button:focus-visible),
.upload-split-arrow:hover,
.upload-split-arrow:focus-visible {
  border-color: var(--upload-split-control-bg-hover);
  background: var(--upload-split-control-bg-hover);
  color: var(--upload-split-control-color);
  outline: none;
}

.upload-split-button :deep(.upload-split-main.el-button.is-disabled),
.upload-split-button :deep(.upload-split-main.el-button.is-disabled:hover),
.upload-split-arrow:disabled,
.upload-split-arrow:disabled:hover {
  border-color: var(--border-strong);
  background: var(--bg-inset);
  color: var(--text-muted);
  cursor: not-allowed;
}

.upload-split-button :deep(.upload-split-main.el-button) {
  gap: var(--space-2);
  min-width: 132px;
  border-radius: var(--radius-md) 0 0 var(--radius-md);
}

.upload-split-arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  padding: 0;
  border-width: 1px;
  border-style: solid;
  border-inline-start-color: rgba(255, 255, 255, 0.3);
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
}

.upload-split-button :deep(.upload-split-main.el-button img),
.upload-split-arrow > img,
.upload-split-menu :deep(.upload-split-menu-item.el-button img) {
  width: var(--upload-split-control-icon-size);
  height: var(--upload-split-control-icon-size);
  flex: 0 0 auto;
  filter: brightness(0) invert(1);
}

.upload-split-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: var(--z-dropdown);
  width: 100%;
  min-width: 100%;
  padding: 0;
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  box-shadow: none;
  overflow: visible;
}

.upload-split-menu :deep(.browse-select-button) {
  display: flex;
  width: 100%;
}

.upload-split-menu :deep(.upload-split-menu-item.el-button) {
  justify-content: center;
  gap: var(--space-2);
  width: 100%;
  height: var(--upload-split-control-height);
  margin-left: 0;
  padding: 0 16px;
  border: 1px solid var(--upload-split-control-bg);
  border-radius: var(--radius-md);
  background: var(--upload-split-control-bg);
  color: var(--upload-split-control-color);
  font-size: var(--upload-split-control-font-size);
  font-weight: var(--upload-split-control-font-weight);
  line-height: 1;
  box-shadow: var(--shadow-xs);
}

.upload-split-menu :deep(.upload-split-menu-item.el-button:hover),
.upload-split-menu :deep(.upload-split-menu-item.el-button:focus-visible) {
  border-color: var(--upload-split-control-bg-hover);
  background: var(--upload-split-control-bg-hover);
  color: var(--upload-split-control-color);
  outline: none;
}

.upload-split-menu :deep(.upload-split-menu-item.el-button.is-disabled),
.upload-split-menu :deep(.upload-split-menu-item.el-button.is-disabled:hover) {
  border-color: var(--border-strong);
  background: var(--bg-inset);
  color: var(--text-muted);
  cursor: not-allowed;
}

@media (max-width: 880px) {
  .upload-split-button {
    width: 100%;
  }

  .upload-split-button :deep(.browse-select-button:first-child) {
    flex: 1 1 auto;
  }

  .upload-split-button :deep(.upload-split-main.el-button) {
    width: 100%;
  }
}
</style>
