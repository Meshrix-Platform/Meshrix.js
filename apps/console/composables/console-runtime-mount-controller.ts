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

export function createConsoleRuntimeMountController(options: ConsoleRuntimeMountControllerOptions) : any {
  const mountDraft: any = ref<Record<string, string>>({});
  const mountDraftDirty: any = ref(false);

  function configuredModulePath(value: unknown) : any {
    if (typeof value === "string") {
      return value;
    }
    if (value && typeof value === "object") {
      const record: any = value as { modulePath?: unknown; path?: unknown };
      return String(record.modulePath || record.path || "");
    }
    return "";
  }

  watch(
    mountDraft,
    () : any => {
      if (!options.isApplyingRemoteConsoleDrafts()) {
        mountDraftDirty.value = true;
      }
    },
    { deep: true, flush: "sync" },
  );

  const enabledMountCount: any = computed(
    () : any => (options.consoleState.value?.runtime?.mounts || []).filter((mount?: any) : any => mount.enabled).length || 0,
  );

  const totalMountCount: any = computed(
    () : any => (options.consoleState.value?.runtime?.mounts || []).length || 0,
  );

  const moduleRows: any = computed<RuntimeModuleRow[]>(() : any => {
    const configured: any = options.consoleState.value?.runtime?.mountModules || {};
    const runtimeMounts: any = options.consoleState.value?.runtime?.mounts || [];
    const names: any = Array.from(
      new Set<any>([
        ...Object.keys(moduleNameLabels),
        ...Object.keys(configured),
        ...runtimeMounts.map((mount?: any) : any => mount.name),
      ]),
    );

    return names.map((name?: any) : any => {
      const runtimeMount: any = runtimeMounts.find((mount?: any) : any => mount.name === name);
      const modulePath: any = mountDraft.value[name] ?? configuredModulePath(configured[name]) ?? "";
      const configuredPath: any = String(modulePath || "").trim();
      const runtimeAvailable: any = Boolean(runtimeMount) && runtimeMount?.enabled !== false;

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
          : "填写外置模块 .ts 路径"),
      };
    });
  });

  const moduleGroups: any = computed(() : any => {
    const rows: any = moduleRows.value;
    const groupedNames: any = new Set<any>(
      moduleGroupDefinitions.flatMap((group?: any) : any => group.names),
    );
    const configuredGroups: any = moduleGroupDefinitions
      .map((group?: any) : any => ({
        ...group,
        rows: group.names
          .map((name?: any) : any => rows.find((row?: any) : any => row.name === name))
          .filter((row?: any): row is RuntimeModuleRow => Boolean(row)),
      }))
      .filter((group?: any) : any => group.rows.length > 0);
    const customRows: any = rows.filter((row?: any) : any => !groupedNames.has(row.name));

    if (customRows.length === 0) {
      return configuredGroups;
    }

    return [
      ...configuredGroups,
      {
        id: "custom",
        label: "自定义模块",
        description: "运行时发现的自定义外置能力模块。",
        names: customRows.map((row?: any) : any => row.name),
        rows: customRows,
      },
    ];
  });

  function isMountPathEditing(name: string) : any {
    return options.editingMountPaths.value[name] === true;
  }

  async function toggleMountPathEdit(item: RuntimeModuleRow) : Promise<any> {
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

  function openMountPathPicker(name: string) : any {
    options.editingMountPaths.value = {
      ...options.editingMountPaths.value,
      [name]: true,
    };
    options.openServerPathPicker({
      title: `选择${moduleNameLabels[name] || name}模块文件`,
      mode: "file",
      value: String(mountDraft.value[name] || ""),
      extensions: [".ts", ".js", ".cjs"],
      applyPath: (nextPath?: any) : any => {
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
  ) : any {
    const nextDraft: any = Object.fromEntries(
      (Object.entries(value || {}) as [string, any][]).map(([name, config]: any[]) : any => [name, configuredModulePath(config)]),
    );
    if (options.remoteDraftEquals(mountDraft.value, nextDraft)) {
      if (replaceOptions.markClean !== false) {
        mountDraftDirty.value = false;
      }
      return;
    }
    options.applyRemoteConsoleDraftUpdate(() : any => {
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
