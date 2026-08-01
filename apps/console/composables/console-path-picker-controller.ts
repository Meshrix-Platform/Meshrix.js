import { ref } from "vue";
import { browseServerPath } from "../lib/runtime-info-client";
import type { ServerPathBrowseEntry } from "../lib/types";
import type { PathPickerMode, PathPickerState } from "../types/app";
import { formatBytes, formatCompactDate } from "./console-format-utils";

export function createConsolePathPickerController() : any {
  const pathPicker: any = ref<PathPickerState>({
    open: false,
    title: "选择路径",
    mode: "directory",
    value: "",
    extensions: [],
    includeHidden: false,
    loading: false,
    error: "",
    response: null,
    closeOnSelect: true,
    applyPath: () : any => {
      throw new Error("路径选择器尚未配置目标字段。");
    },
  });

  function pathPickerModeLabel(mode: PathPickerMode) : any {
    return mode === "file" ? "文件" : "目录";
  }

  function pathEntryMeta(entry: ServerPathBrowseEntry) : any {
    if (entry.type === "directory") {
      return "";
    }
    return `${formatBytes(entry.byteSize)} / ${formatCompactDate(entry.modifiedAt)}`;
  }

  function openServerPathPicker(pickerOptions: {
    title: string;
    mode: PathPickerMode;
    value?: string;
    extensions?: string[];
    closeOnSelect?: boolean;
    applyPath: (nextPath: string) => void;
  }) : any {
    pathPicker.value = {
      open: true,
      title: pickerOptions.title,
      mode: pickerOptions.mode,
      value: pickerOptions.value || "",
      extensions: pickerOptions.extensions || [],
      includeHidden: false,
      loading: false,
      error: "",
      response: null,
      closeOnSelect: pickerOptions.closeOnSelect !== false,
      applyPath: pickerOptions.applyPath,
    };
    void refreshServerPathBrowser(pickerOptions.value || "");
  }

  async function refreshServerPathBrowser(nextPath?: string) : Promise<any> {
    const current: any = pathPicker.value;
    current.loading = true;
    current.error = "";
    try {
      const response: any = await browseServerPath({
        path: nextPath ?? current.response?.currentPath ?? current.value,
        mode: current.mode,
        extensions: current.extensions,
        includeHidden: current.includeHidden,
      });
      pathPicker.value = {
        ...current,
        loading: false,
        response,
        error: response.error || "",
      };
    } catch (nextError: any) {
      pathPicker.value = {
        ...current,
        loading: false,
        error: nextError instanceof Error ? nextError.message : "打开路径浏览器失败。",
      };
    }
  }

  function closeServerPathPicker() : any {
    pathPicker.value = {
      ...pathPicker.value,
      open: false,
    };
  }

  function selectServerPath(nextPath: string) : any {
    if (!nextPath) {
      return;
    }
    pathPicker.value.applyPath(nextPath);
    if (pathPicker.value.closeOnSelect) {
      closeServerPathPicker();
    }
  }

  function confirmServerPathPicker() : any {
    const currentPath: any = String(pathPicker.value.response?.currentPath || pathPicker.value.value || "").trim();
    if (pathPicker.value.mode === "directory" && currentPath) {
      pathPicker.value.applyPath(currentPath);
    }
    closeServerPathPicker();
  }

  function openPathEntry(entry: ServerPathBrowseEntry) : any {
    if (!entry.browsable) {
      return;
    }
    void refreshServerPathBrowser(entry.path);
  }

  return {
    closeServerPathPicker,
    confirmServerPathPicker,
    openPathEntry,
    openServerPathPicker,
    pathEntryMeta,
    pathPicker,
    pathPickerModeLabel,
    refreshServerPathBrowser,
    selectServerPath,
  };
}
