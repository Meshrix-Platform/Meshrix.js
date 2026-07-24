<script setup lang="ts">
import { computed, ref } from "vue";

type BrowseSelectKind =
  | "local-files"
  | "local-directory"
  | "server-file"
  | "server-directory";
type DirectoryMode = "files" | "path";
type DirectorySelection = {
  name: string;
  path: string;
};

const props = withDefaults(
  defineProps<{
    kind: BrowseSelectKind;
    directoryMode?: DirectoryMode;
    buttonText?: string;
    buttonType?: string;
    buttonClass?: string;
    size?: string;
    disabled?: boolean;
    loading?: boolean;
    plain?: boolean;
    multiple?: boolean;
    accept?: string;
  }>(),
  {
    directoryMode: "files",
    buttonText: "",
    buttonType: "",
    buttonClass: "",
    size: "default",
    disabled: false,
    loading: false,
    plain: false,
    multiple: true,
    accept: "",
  },
);

const emit = defineEmits<{
  browse: [];
  select: [files: File[]];
  directory: [directory: DirectorySelection];
}>();

const fileInput = ref<HTMLInputElement | null>(null);
const directoryInput = ref<HTMLInputElement | null>(null);

const isLocalFiles = computed(() => props.kind === "local-files");
const isLocalDirectory = computed(() => props.kind === "local-directory");
const isLocal = computed(() => isLocalFiles.value || isLocalDirectory.value);
const resolvedButtonText = computed(() => {
  if (props.buttonText) {
    return props.buttonText;
  }
  if (props.kind === "local-directory") {
    return "选择文件夹";
  }
  if (props.kind === "local-files") {
    return "选择文件";
  }
  return "浏览";
});

function openLocalPicker() {
  const input = isLocalDirectory.value ? directoryInput.value : fileInput.value;
  if (!input) {
    return;
  }
  input.value = "";
  input.click();
}

type BrowserDirectoryHandle = {
  kind: "directory";
  name: string;
  values?: () => AsyncIterable<BrowserFileHandle | BrowserDirectoryHandle>;
  entries?: () => AsyncIterable<[string, BrowserFileHandle | BrowserDirectoryHandle]>;
};

type BrowserFileHandle = {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
};

function fileWithRelativePath(file: File, relativePath: string) {
  try {
    Object.defineProperty(file, "webkitRelativePath", {
      configurable: true,
      value: relativePath,
    });
    return file;
  } catch {
    const clone = new File([file], file.name, {
      lastModified: file.lastModified,
      type: file.type,
    });
    Object.defineProperty(clone, "webkitRelativePath", {
      configurable: true,
      value: relativePath,
    });
    return clone;
  }
}

async function collectDirectoryFiles(
  directoryHandle: BrowserDirectoryHandle,
  prefix = directoryHandle.name,
): Promise<File[]> {
  const files: File[] = [];
  const iterable = directoryHandle.values
    ? directoryHandle.values()
    : directoryHandle.entries
      ? (async function* () {
          for await (const [, entry] of directoryHandle.entries?.() || []) {
            yield entry;
          }
        })()
      : null;
  if (!iterable) {
    return files;
  }
  for await (const entry of iterable) {
    if (entry.kind === "file") {
      const file = await entry.getFile();
      files.push(fileWithRelativePath(file, `${prefix}/${file.name}`));
      continue;
    }
    files.push(...await collectDirectoryFiles(entry, `${prefix}/${entry.name}`));
  }
  return files;
}

async function openLocalDirectoryPicker() {
  const picker = (window as Window & {
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<BrowserDirectoryHandle>;
  }).showDirectoryPicker;
  if (!picker) {
    openLocalPicker();
    return;
  }
  try {
    const directoryHandle = await picker({ mode: "read" });
    emit("directory", {
      name: directoryHandle.name,
      path: directoryHandle.name,
    });
    if (props.directoryMode === "path") {
      return;
    }
    emit("select", await collectDirectoryFiles(directoryHandle));
  } catch (nextError) {
    if (nextError instanceof DOMException && nextError.name === "AbortError") {
      return;
    }
    openLocalPicker();
  }
}

function onClick() {
  if (props.disabled || props.loading) {
    return;
  }
  if (isLocalDirectory.value) {
    void openLocalDirectoryPicker();
    return;
  }
  if (isLocal.value) {
    openLocalPicker();
    return;
  }
  emit("browse");
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  if (isLocalDirectory.value && props.directoryMode === "path") {
    const firstRelativePath = String(
      (files[0] as File & { webkitRelativePath?: string } | undefined)?.webkitRelativePath ||
        files[0]?.name ||
        "",
    );
    const rootPath = firstRelativePath.split(/[\\/]/g)[0] || firstRelativePath;
    emit("directory", {
      name: rootPath || "本地文件夹",
      path: rootPath || `local-directory-${Date.now()}`,
    });
    return;
  }
  emit("select", files);
}
</script>

<template>
  <span class="browse-select-button">
    <el-button
      :class="buttonClass"
      :type="buttonType"
      :plain="plain"
      :size="size"
      :disabled="disabled"
      :loading="loading"
      @click="onClick"
    >
      <slot>{{ resolvedButtonText }}</slot>
    </el-button>
    <input
      v-if="isLocalDirectory"
      ref="directoryInput"
      class="native-file-input"
      type="file"
      multiple
      webkitdirectory
      directory
      tabindex="-1"
      aria-hidden="true"
      @change="onFileChange"
    />
    <input
      v-else-if="isLocalFiles"
      ref="fileInput"
      class="native-file-input"
      type="file"
      :multiple="multiple"
      :accept="accept"
      tabindex="-1"
      aria-hidden="true"
      @change="onFileChange"
    />
  </span>
</template>
