import { computed, ref, watch, type Ref } from "vue";
import type { AgentSettings, RuntimeMountConfig, ServerConsoleState } from "../lib/types";
import type { PathPickerMode } from "../types/app";
import {
  moduleGroupDefinitions,
  moduleNameDescriptions,
  moduleNameLabels,
} from "./console-defaults";
import type { RuntimeModuleRow } from "./console-runtime-module-display-utils";

export type ConsoleRuntimeMountControllerOptions = {
  applyRemoteConsoleDraftUpdate: (update: () => void) => void;
  consoleState: Ref<ServerConsoleState | null>;
  editingMountPaths: Ref<Record<string, boolean>>;
  isApplyingRemoteConsoleDrafts: () => boolean;
  remoteDraftEquals: (left: unknown, right: unknown) => boolean;
  settingsDraft: Ref<AgentSettings>;
  openServerPathPicker: (options: {
    title: string;
    mode: PathPickerMode;
    value?: string;
    extensions?: string[];
    closeOnSelect?: boolean;
    applyPath: (nextPath: string) => void;
  }) => void;
  saveMountModules: (busy?: string) => Promise<unknown>;
};

export function createConsoleRuntimeMountController(options: ConsoleRuntimeMountControllerOptions) {
  const mountDraft = ref<Record<string, string>>({});
  const mountDraftDirty = ref(false);

  function configuredModulePath(value: unknown) {
    if (typeof value === "string") {
      return value;
    }
    if (value && typeof value === "object") {
      const record = value as { modulePath?: unknown; path?: unknown };
      return String(record.modulePath || record.path || "");
    }
    return "";
  }

  watch(
    mountDraft,
    () => {
      if (!options.isApplyingRemoteConsoleDrafts()) {
        mountDraftDirty.value = true;
      }
    },
    { deep: true, flush: "sync" },
  );

  const enabledMountCount = computed(
    () => (options.consoleState.value?.runtime?.mounts || []).filter((mount) => mount.enabled).length || 0,
  );

  const totalMountCount = computed(
    () => (options.consoleState.value?.runtime?.mounts || []).length || 0,
  );

  const moduleRows = computed<RuntimeModuleRow[]>(() => {
    const configured = options.consoleState.value?.runtime?.mountModules || {};
    const runtimeMounts = options.consoleState.value?.runtime?.mounts || [];
    const names = Array.from(
      new Set([
        ...Object.keys(moduleNameLabels),
        ...Object.keys(configured),
        ...runtimeMounts.map((mount) => mount.name),
      ]),
    );

    return names.map((name) => {
      const runtimeMount = runtimeMounts.find((mount) => mount.name === name);
      const modulePath = mountDraft.value[name] ?? configuredModulePath(configured[name]) ?? "";
      const configuredPath = String(modulePath || "").trim();
      const runtimeAvailable = Boolean(runtimeMount) && runtimeMount?.enabled !== false;

      return {
        name,
        label: moduleNameLabels[name] || name,
        description:
          moduleNameDescriptions[name] || "自定义外置能力模块，可通过路径接入。",
        modulePath,
        configuredPath,
        runtimeMount,
        externalEnabled: runtimeAvailable || configuredPath.length > 0,
        pathHint: configuredPath || (runtimeAvailable
          ? `当前使用内置模块：${runtimeMount?.id || name}`
          : "填写外置模块 .mjs 路径"),
      };
    });
  });

  const moduleGroups = computed(() => {
    const rows = moduleRows.value;
    const groupedNames = new Set(
      moduleGroupDefinitions.flatMap((group) => group.names),
    );
    const configuredGroups = moduleGroupDefinitions
      .map((group) => ({
        ...group,
        rows: group.names
          .map((name) => rows.find((row) => row.name === name))
          .filter((row): row is RuntimeModuleRow => Boolean(row)),
      }))
      .filter((group) => group.rows.length > 0);
    const customRows = rows.filter((row) => !groupedNames.has(row.name));

    if (customRows.length === 0) {
      return configuredGroups;
    }

    return [
      ...configuredGroups,
      {
        id: "custom",
        label: "自定义模块",
        description: "运行时发现的自定义外置能力模块。",
        names: customRows.map((row) => row.name),
        rows: customRows,
      },
    ];
  });

  function isMountPathEditing(name: string) {
    return options.editingMountPaths.value[name] === true;
  }

  async function toggleMountPathEdit(item: RuntimeModuleRow) {
    if (!isMountPathEditing(item.name)) {
      options.editingMountPaths.value = {
        ...options.editingMountPaths.value,
        [item.name]: true,
      };
      return;
    }

    await options.saveMountModules(`mount:${item.name}`);
    options.editingMountPaths.value = {
      ...options.editingMountPaths.value,
      [item.name]: false,
    };
  }

  function openMountPathPicker(name: string) {
    options.editingMountPaths.value = {
      ...options.editingMountPaths.value,
      [name]: true,
    };
    options.openServerPathPicker({
      title: `选择${moduleNameLabels[name] || name}模块文件`,
      mode: "file",
      value: String(mountDraft.value[name] || ""),
      extensions: [".mjs", ".js", ".cjs"],
      applyPath: (nextPath) => {
        mountDraft.value = {
          ...mountDraft.value,
          [name]: nextPath,
        };
      },
    });
  }

  function replaceMountDraftFromServer(
    value: RuntimeMountConfig["mountModules"] | null | undefined,
    replaceOptions: { markClean?: boolean } = {},
  ) {
    const nextDraft = Object.fromEntries(
      Object.entries(value || {}).map(([name, config]) => [name, configuredModulePath(config)]),
    );
    if (options.remoteDraftEquals(mountDraft.value, nextDraft)) {
      if (replaceOptions.markClean !== false) {
        mountDraftDirty.value = false;
      }
      return;
    }
    options.applyRemoteConsoleDraftUpdate(() => {
      mountDraft.value = nextDraft;
      if (replaceOptions.markClean !== false) {
        mountDraftDirty.value = false;
      }
    });
  }

  return {
    enabledMountCount,
    isMountPathEditing,
    moduleGroups,
    moduleRows,
    mountDraft,
    mountDraftDirty,
    openMountPathPicker,
    replaceMountDraftFromServer,
    toggleMountPathEdit,
    totalMountCount,
  };
}
