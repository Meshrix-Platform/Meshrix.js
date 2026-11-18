import { computed, onMounted, ref, type Ref } from "vue";
import { usePageRefreshHandler } from "@meshrix/ui-console/page-refresh";
import { buildRuntimeAssembly, getRuntimeInfo } from "../../../lib/runtime-info-client";
import type {
  FeatureRuntimeSummary,
  RuntimeAssemblyArtifact,
  RuntimeArchitectureComponent,
  RuntimeArchitectureLayer,
  RuntimeInfoResponse,
  RuntimeMountInfo,
} from "../../../lib/types";

type AssemblySelection = Record<string, boolean>;
type SelectionBucket = Ref<AssemblySelection>;

type AssemblyItem = {
  id: string;
  label: string;
  detail: string;
  enabled: boolean;
  statusLabel: string;
  locked?: boolean;
};

type RuntimeEvidenceGroup = {
  id: string;
  title: string;
  description: string;
  emptyLabel: string;
  items: AssemblyItem[];
};

type ArchitectureTreeNode = RuntimeArchitectureComponent & {
  children: ArchitectureTreeNode[];
  depth: number;
};

type ArchitectureLayerGroup = {
  layerId: string;
  label: string;
  moduleCategory: string;
  description: string;
  roots: ArchitectureTreeNode[];
  componentCount: number;
  hydratableCount: number;
  lockedCount: number;
  selectedCount: number;
};

const defaultArchitectureLayers: RuntimeArchitectureLayer[] = [
  {
    layerId: "appearance",
    moduleCategory: "appearance",
    label: "外观层",
    hydration: "optional",
    hydratable: true,
    functionItems: ["控制面板展示网关、工作空间、审批和系统管理界面"],
  },
  {
    layerId: "platform-capabilities",
    moduleCategory: "core-capability",
    label: "平台能力",
    hydration: "essential",
    hydratable: false,
    functionItems: ["汇聚平台能力、通信服务、协作治理、智能体运行能力和策略管理"],
  },
  {
    layerId: "application",
    moduleCategory: "application",
    label: "应用层",
    hydration: "optional",
    hydratable: true,
    functionItems: ["工作空间共享、服务网关控制面板和通用工具管理"],
  },
  {
    layerId: "aspect",
    moduleCategory: "aspect",
    label: "切面层",
    hydration: "optional",
    hydratable: true,
    functionItems: ["协议适配、请求归一化、能力投影和 route intent"],
  },
  {
    layerId: "foundation",
    moduleCategory: "foundation",
    label: "基建层",
    hydration: "essential",
    hydratable: false,
    functionItems: ["平台运行和模块脱水机制的不可剥离底座"],
  },
];

const categoryLabelFallback: Record<string, string> = {
  appearance: "外观入口",
  "core-capability": "核心能力",
  application: "应用模块",
  aspect: "切面模块",
  foundation: "基础模块",
};

export function useVersionAssemblyView() : any {
  const runtimeInfo: any = ref<RuntimeInfoResponse | null>(null);
  const loading: any = ref(false);
  const loadError: any = ref("");
  const buildingAssembly: any = ref(false);
  const assemblyError: any = ref("");
  const assemblyArtifact: any = ref<RuntimeAssemblyArtifact | null>(null);

  const selectedArchitectureComponents: any = ref<AssemblySelection>({});
  const expandedModuleIds: any = ref<Set<string>>(new Set<any>());

  function mountCapabilityText(mount: RuntimeMountInfo) : any {
    const capabilities: any = [
      mount.supportsStructuredDocument ? "结构化输入" : "",
      mount.supportsTextExtraction ? "文本输入" : "",
      mount.supportsBatchHook ? "批次回调" : "",
    ].filter(Boolean);
    return capabilities.length > 0 ? capabilities.join("，") : "基础运行";
  }

  function capabilityItemsFromFeatures(features: FeatureRuntimeSummary | null | undefined): AssemblyItem[] {
    if (!features) {
      return [];
    }
    if (features.activeFeatures?.length) {
      return features.activeFeatures.map((feature?: any) : any => ({
        id: feature.featureId,
        label: feature.label || feature.featureId,
        detail: [feature.group, feature.reason].filter(Boolean).join("，") || "已启用能力",
        enabled: true,
        statusLabel: feature.required ? "必选" : "已启用",
        locked: feature.required,
      }));
    }
    return (features.activeFeatureIds || []).map((featureId?: any) : any => ({
      id: featureId,
      label: featureId,
      detail: features.profileName || features.edition || "已启用能力",
      enabled: true,
      statusLabel: "已启用",
    }));
  }

  const capabilityItems: any = computed<AssemblyItem[]>(() : any =>
    capabilityItemsFromFeatures(runtimeInfo.value?.features),
  );

  const moduleItems: any = computed<AssemblyItem[]>(() : any =>
    (runtimeInfo.value?.runtime.mounts || []).map((mount?: any) : any => {
      const enabled: any = mount.enabled !== false;
      return {
        id: mount.id || mount.name,
        label: mount.name || mount.id,
        detail: `${mount.kind || "mount"}，${mountCapabilityText(mount)}`,
        enabled,
        statusLabel: enabled ? "可用" : mount.reason || "不可用",
      };
    }),
  );

  const architectureInventory: any = computed(() : any => runtimeInfo.value?.runtime.architectureComponents || null);
  const architectureComponents: any = computed<RuntimeArchitectureComponent[]>(() : any =>
    architectureInventory.value?.allComponents || [],
  );

  const categoryDefinitionMap: any = computed(() : any => {
    const definitions: any = architectureInventory.value?.moduleCategoryDefinitions || [];
    return new Map<any, any>(definitions.map((definition?: any) : any => [definition.categoryId, definition]));
  });

  const architectureLayerDefinitions: any = computed<RuntimeArchitectureLayer[]>(() : any => {
    const configuredLayers: any = architectureInventory.value?.layers?.length
      ? architectureInventory.value.layers
      : defaultArchitectureLayers;
    const layerIds: any = new Set<any>(configuredLayers.map((layer?: any) : any => layer.layerId));
    const missingLayers: any = architectureComponents.value
      .filter((component?: any) : any => !layerIds.has(component.layerId))
      .map((component?: any) : any => component.layerId);
    return [
      ...configuredLayers,
      ...Array.from(new Set<any>(missingLayers)).map((layerId?: any) : any => ({
        layerId,
        moduleCategory: architectureComponents.value.find((component?: any) : any => component.layerId === layerId)?.moduleCategory || layerId,
        label: layerId,
        hydration: "optional",
        hydratable: true,
        functionItems: [],
      })),
    ];
  });

  function componentKey(component: RuntimeArchitectureComponent) : any {
    return component.componentId || component.moduleId;
  }

  function categoryLabel(categoryId: string) : any {
    return categoryDefinitionMap.value.get(categoryId)?.label || categoryLabelFallback[categoryId] || categoryId;
  }

  function hydrationLabel(hydratable: boolean) : any {
    return hydratable ? "可脱水" : "不可脱水";
  }

  function architectureItemFromComponent(component: RuntimeArchitectureComponent): AssemblyItem {
    return {
      id: componentKey(component),
      label: component.label || component.moduleId,
      detail: component.functionItems?.join("，") || component.moduleId,
      enabled: true,
      statusLabel: hydrationLabel(component.hydratable),
      locked: !component.hydratable,
    };
  }

  const architectureItems: any = computed<AssemblyItem[]>(() : any =>
    architectureComponents.value.map(architectureItemFromComponent),
  );

  const selectedArchitectureComponentIds: any = computed(() : any =>
    architectureComponents.value
      .filter((component?: any) : any => Boolean(selectedArchitectureComponents.value[componentKey(component)]))
      .map(componentKey)
      .filter(Boolean),
  );

  const architectureRootNodes: any = computed<ArchitectureTreeNode[]>(() : any => {
    const nodeMap: any = new Map<string, ArchitectureTreeNode>();
    for (const component of architectureComponents.value) {
      nodeMap.set(componentKey(component), {
        ...component,
        parentModuleId: component.parentModuleId || "",
        children: [],
        depth: 0,
      });
    }

    const roots: ArchitectureTreeNode[] = [];
    for (const node of nodeMap.values()) {
      const parent: any = node.parentModuleId ? nodeMap.get(node.parentModuleId) : null;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }

    function assignDepth(node: ArchitectureTreeNode, depth: number) : any {
      node.depth = depth;
      for (const child of node.children) {
        assignDepth(child, depth + 1);
      }
    }

    for (const root of roots) {
      assignDepth(root, 0);
    }
    return roots;
  });

  function layerDescription(layer: RuntimeArchitectureLayer) : any {
    if (layer.functionItems?.length) {
      return layer.functionItems.join("，");
    }
    return categoryDefinitionMap.value.get(layer.moduleCategory)?.description || "";
  }

  function isArchitectureComponentSelected(component: RuntimeArchitectureComponent) : any {
    return Boolean(selectedArchitectureComponents.value[componentKey(component)]);
  }

  function collectArchitectureNodes(node: ArchitectureTreeNode) : any {
    const nodes: ArchitectureTreeNode[] = [node];
    for (const child of node.children) {
      nodes.push(...collectArchitectureNodes(child));
    }
    return nodes;
  }

  function flattenArchitectureChildren(node: ArchitectureTreeNode) : any {
    return node.children.flatMap((child?: any) : any => collectArchitectureNodes(child));
  }

  function architectureTreeRowStyle(node: ArchitectureTreeNode) : any {
    return {
      "--tree-indent": `${Math.min(Math.max(node.depth, 1), 5) * 18}px`,
    };
  }

  function moduleSummaryText(node: ArchitectureTreeNode) : any {
    return node.functionItems?.slice(0, 3).join("，") || node.moduleId;
  }

  function architectureChildDetail(node: ArchitectureTreeNode) : any {
    return node.functionItems?.join("，") || node.moduleId;
  }

  function architectureNodeCount(node: ArchitectureTreeNode) : any {
    return collectArchitectureNodes(node).length;
  }

  function selectedArchitectureNodeCount(node: ArchitectureTreeNode) : any {
    return collectArchitectureNodes(node).filter(isArchitectureComponentSelected).length;
  }

  function hydratableArchitectureNodeCount(node: ArchitectureTreeNode) : any {
    return collectArchitectureNodes(node).filter((component?: any) : any => component.hydratable).length;
  }

  function architectureSubtreeToggleDisabled(node: ArchitectureTreeNode) : any {
    return collectArchitectureNodes(node).every((component?: any) : any => !component.hydratable);
  }

  function isArchitectureSubtreeSelected(node: ArchitectureTreeNode) : any {
    const nodes: any = collectArchitectureNodes(node);
    return nodes.length > 0 && nodes.every(isArchitectureComponentSelected);
  }

  const architectureLayerGroups: any = computed<ArchitectureLayerGroup[]>(() : any =>
    architectureLayerDefinitions.value
      .map((layer?: any) : any => {
        const layerComponents: any = architectureComponents.value.filter((component?: any) : any => component.layerId === layer.layerId);
        const roots: any = architectureRootNodes.value.filter((node?: any) : any => node.layerId === layer.layerId);
        return {
          layerId: layer.layerId,
          label: layer.label || layer.layerId,
          moduleCategory: layer.moduleCategory,
          description: layerDescription(layer),
          roots,
          componentCount: layerComponents.length,
          hydratableCount: layerComponents.filter((component?: any) : any => component.hydratable).length,
          lockedCount: layerComponents.filter((component?: any) : any => !component.hydratable).length,
          selectedCount: layerComponents.filter(isArchitectureComponentSelected).length,
        };
      })
      .filter((layer?: any) : any => layer.componentCount > 0 || layer.roots.length > 0),
  );

  const runtimeEvidenceGroups: any = computed<RuntimeEvidenceGroup[]>(() : any => [
    {
      id: "capabilities",
      title: "运行时能力",
      description: "当前版本 Profile 启用的功能能力。",
      emptyLabel: "暂无能力",
      items: capabilityItems.value,
    },
    {
      id: "mounts",
      title: "运行时挂载",
      description: "服务启动后发现的 mount 模块。",
      emptyLabel: "暂无模块",
      items: moduleItems.value,
    },
  ]);

  function itemMustStaySelected(item: AssemblyItem) : any {
    return item.locked || item.statusLabel === "必选";
  }

  function syncSelection(bucket: SelectionBucket, items: AssemblyItem[]) : any {
    const next: AssemblySelection = {};
    for (const item of items) {
      next[item.id] = itemMustStaySelected(item) || (item.enabled && (bucket.value[item.id] ?? item.enabled));
    }
    bucket.value = next;
  }

  function syncAllSelections() : any {
    syncSelection(selectedArchitectureComponents, architectureItems.value);
  }

  function selectedCount(bucket: AssemblySelection, items: AssemblyItem[]) : any {
    return items.filter((item?: any) : any => Boolean(bucket[item.id])).length;
  }

  const selectedArchitectureCount: any = computed(() : any =>
    selectedCount(selectedArchitectureComponents.value, architectureItems.value),
  );
  const hydratableArchitectureCount: any = computed(() : any =>
    architectureComponents.value.filter((component?: any) : any => component.hydratable).length,
  );
  const nonHydratableArchitectureCount: any = computed(() : any =>
    architectureComponents.value.filter((component?: any) : any => !component.hydratable).length,
  );
  const foundationArchitectureCount: any = computed(() : any =>
    architectureComponents.value.filter((component?: any) : any => component.moduleCategory === "foundation").length,
  );
  const selectedHydratableArchitectureCount: any = computed(() : any =>
    architectureComponents.value.filter((component?: any) : any =>
      component.hydratable && selectedArchitectureComponents.value[componentKey(component)],
    ).length,
  );
  const runtimeEvidenceCount: any = computed(() : any =>
    capabilityItems.value.length + moduleItems.value.length,
  );

  const canBuildRuntimeAssembly: any = computed(() : any =>
    !loading.value && !buildingAssembly.value && selectedArchitectureComponentIds.value.length > 0,
  );

  function clearAssemblyResult() : any {
    assemblyArtifact.value = null;
    assemblyError.value = "";
  }

  function setArchitectureComponentSelection(component: RuntimeArchitectureComponent, value: boolean) : any {
    const item: any = architectureItemFromComponent(component);
    clearAssemblyResult();
    selectedArchitectureComponents.value = {
      ...selectedArchitectureComponents.value,
      [item.id]: itemMustStaySelected(item) || (value && item.enabled),
    };
  }

  function setArchitectureSubtreeSelection(node: ArchitectureTreeNode, value: boolean) : any {
    const next: Record<string, any> = { ...selectedArchitectureComponents.value };
    clearAssemblyResult();
    for (const component of collectArchitectureNodes(node)) {
      const item: any = architectureItemFromComponent(component);
      next[item.id] = itemMustStaySelected(item) || (value && item.enabled);
    }
    selectedArchitectureComponents.value = next;
  }

  function setArchitectureLayerSelection(layer: ArchitectureLayerGroup, value: boolean) : any {
    const next: Record<string, any> = { ...selectedArchitectureComponents.value };
    clearAssemblyResult();
    const layerComponentIds: any = new Set<any>(
      architectureComponents.value
        .filter((component?: any) : any => component.layerId === layer.layerId)
        .map(componentKey),
    );
    for (const component of architectureComponents.value) {
      if (!layerComponentIds.has(componentKey(component))) {
        continue;
      }
      const item: any = architectureItemFromComponent(component);
      next[item.id] = itemMustStaySelected(item) || (value && item.enabled);
    }
    selectedArchitectureComponents.value = next;
  }

  function isModuleExpanded(componentId: string) : any {
    return expandedModuleIds.value.has(componentId);
  }

  function toggleModuleExpanded(componentId: string) : any {
    const next: any = new Set<any>(expandedModuleIds.value);
    if (next.has(componentId)) {
      next.delete(componentId);
    } else {
      next.add(componentId);
    }
    expandedModuleIds.value = next;
  }

  async function refreshVersionAssembly() : Promise<any> {
    loading.value = true;
    loadError.value = "";
    try {
      runtimeInfo.value = await getRuntimeInfo();
      loadError.value = "";
      syncAllSelections();
      clearAssemblyResult();
    } catch {
      loadError.value = "运行时信息读取失败";
    } finally {
      loading.value = false;
    }
  }

  async function buildRuntimeAssemblyPackage() : Promise<any> {
    if (!canBuildRuntimeAssembly.value) {
      return;
    }
    buildingAssembly.value = true;
    assemblyError.value = "";
    assemblyArtifact.value = null;
    try {
      const response: any = await buildRuntimeAssembly({
        selectedComponentIds: selectedArchitectureComponentIds.value,
      });
      assemblyArtifact.value = response.artifact;
    } catch (error: any) {
      assemblyError.value = error instanceof Error ? error.message : "装配清单生成失败";
    } finally {
      buildingAssembly.value = false;
    }
  }

  onMounted(() : any => {
    void refreshVersionAssembly();
  });

  usePageRefreshHandler(
    (detail?: any) : any => detail.viewId === "admin" && detail.adminView === "versionAssembly",
    refreshVersionAssembly,
  );

  return {
    architectureItems,
    architectureLayerGroups,
    hydratableArchitectureCount,
    foundationArchitectureCount,
    loadError,
    loading,
    nonHydratableArchitectureCount,
    runtimeEvidenceCount,
    runtimeEvidenceGroups,
    selectedArchitectureCount,
    selectedArchitectureComponentIds,
    selectedHydratableArchitectureCount,
    assemblyArtifact,
    assemblyError,
    buildingAssembly,
    canBuildRuntimeAssembly,
    architectureChildDetail,
    architectureNodeCount,
    architectureSubtreeToggleDisabled,
    architectureTreeRowStyle,
    categoryLabel,
    flattenArchitectureChildren,
    hydratableArchitectureNodeCount,
    hydrationLabel,
    isArchitectureComponentSelected,
    isArchitectureSubtreeSelected,
    isModuleExpanded,
    moduleSummaryText,
    selectedArchitectureNodeCount,
    setArchitectureComponentSelection,
    setArchitectureLayerSelection,
    setArchitectureSubtreeSelection,
    buildRuntimeAssemblyPackage,
    toggleModuleExpanded,
  };
}
