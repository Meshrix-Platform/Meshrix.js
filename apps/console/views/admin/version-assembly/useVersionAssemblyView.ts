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

export function useVersionAssemblyView() {
  const runtimeInfo = ref<RuntimeInfoResponse | null>(null);
  const loading = ref(false);
  const loadError = ref("");
  const buildingAssembly = ref(false);
  const assemblyError = ref("");
  const assemblyArtifact = ref<RuntimeAssemblyArtifact | null>(null);

  const selectedArchitectureComponents = ref<AssemblySelection>({});
  const expandedModuleIds = ref<Set<string>>(new Set());

  function mountCapabilityText(mount: RuntimeMountInfo) {
    const capabilities = [
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
      return features.activeFeatures.map((feature) => ({
        id: feature.featureId,
        label: feature.label || feature.featureId,
        detail: [feature.group, feature.reason].filter(Boolean).join("，") || "已启用能力",
        enabled: true,
        statusLabel: feature.required ? "必选" : "已启用",
        locked: feature.required,
      }));
    }
    return (features.activeFeatureIds || []).map((featureId) => ({
      id: featureId,
      label: featureId,
      detail: features.profileName || features.edition || "已启用能力",
      enabled: true,
      statusLabel: "已启用",
    }));
  }

  const capabilityItems = computed<AssemblyItem[]>(() =>
    capabilityItemsFromFeatures(runtimeInfo.value?.features),
  );

  const moduleItems = computed<AssemblyItem[]>(() =>
    (runtimeInfo.value?.runtime.mounts || []).map((mount) => {
      const enabled = mount.enabled !== false;
      return {
        id: mount.id || mount.name,
        label: mount.name || mount.id,
        detail: `${mount.kind || "mount"}，${mountCapabilityText(mount)}`,
        enabled,
        statusLabel: enabled ? "可用" : mount.reason || "不可用",
      };
    }),
  );

  const architectureInventory = computed(() => runtimeInfo.value?.runtime.architectureComponents || null);
  const architectureComponents = computed<RuntimeArchitectureComponent[]>(() =>
    architectureInventory.value?.allComponents || [],
  );

  const categoryDefinitionMap = computed(() => {
    const definitions = architectureInventory.value?.moduleCategoryDefinitions || [];
    return new Map(definitions.map((definition) => [definition.categoryId, definition]));
  });

  const architectureLayerDefinitions = computed<RuntimeArchitectureLayer[]>(() => {
    const configuredLayers = architectureInventory.value?.layers?.length
      ? architectureInventory.value.layers
      : defaultArchitectureLayers;
    const layerIds = new Set(configuredLayers.map((layer) => layer.layerId));
    const missingLayers = architectureComponents.value
      .filter((component) => !layerIds.has(component.layerId))
      .map((component) => component.layerId);
    return [
      ...configuredLayers,
      ...Array.from(new Set(missingLayers)).map((layerId) => ({
        layerId,
        moduleCategory: architectureComponents.value.find((component) => component.layerId === layerId)?.moduleCategory || layerId,
        label: layerId,
        hydration: "optional",
        hydratable: true,
        functionItems: [],
      })),
    ];
  });

  function componentKey(component: RuntimeArchitectureComponent) {
    return component.componentId || component.moduleId;
  }

  function categoryLabel(categoryId: string) {
    return categoryDefinitionMap.value.get(categoryId)?.label || categoryLabelFallback[categoryId] || categoryId;
  }

  function hydrationLabel(hydratable: boolean) {
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

  const architectureItems = computed<AssemblyItem[]>(() =>
    architectureComponents.value.map(architectureItemFromComponent),
  );

  const selectedArchitectureComponentIds = computed(() =>
    architectureComponents.value
      .filter((component) => Boolean(selectedArchitectureComponents.value[componentKey(component)]))
      .map(componentKey)
      .filter(Boolean),
  );

  const architectureRootNodes = computed<ArchitectureTreeNode[]>(() => {
    const nodeMap = new Map<string, ArchitectureTreeNode>();
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
      const parent = node.parentModuleId ? nodeMap.get(node.parentModuleId) : null;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }

    function assignDepth(node: ArchitectureTreeNode, depth: number) {
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

  function layerDescription(layer: RuntimeArchitectureLayer) {
    if (layer.functionItems?.length) {
      return layer.functionItems.join("，");
    }
    return categoryDefinitionMap.value.get(layer.moduleCategory)?.description || "";
  }

  function isArchitectureComponentSelected(component: RuntimeArchitectureComponent) {
    return Boolean(selectedArchitectureComponents.value[componentKey(component)]);
  }

  function collectArchitectureNodes(node: ArchitectureTreeNode) {
    const nodes: ArchitectureTreeNode[] = [node];
    for (const child of node.children) {
      nodes.push(...collectArchitectureNodes(child));
    }
    return nodes;
  }

  function flattenArchitectureChildren(node: ArchitectureTreeNode) {
    return node.children.flatMap((child) => collectArchitectureNodes(child));
  }

  function architectureTreeRowStyle(node: ArchitectureTreeNode) {
    return {
      "--tree-indent": `${Math.min(Math.max(node.depth, 1), 5) * 18}px`,
    };
  }

  function moduleSummaryText(node: ArchitectureTreeNode) {
    return node.functionItems?.slice(0, 3).join("，") || node.moduleId;
  }

  function architectureChildDetail(node: ArchitectureTreeNode) {
    return node.functionItems?.join("，") || node.moduleId;
  }

  function architectureNodeCount(node: ArchitectureTreeNode) {
    return collectArchitectureNodes(node).length;
  }

  function selectedArchitectureNodeCount(node: ArchitectureTreeNode) {
    return collectArchitectureNodes(node).filter(isArchitectureComponentSelected).length;
  }

  function hydratableArchitectureNodeCount(node: ArchitectureTreeNode) {
    return collectArchitectureNodes(node).filter((component) => component.hydratable).length;
  }

  function architectureSubtreeToggleDisabled(node: ArchitectureTreeNode) {
    return collectArchitectureNodes(node).every((component) => !component.hydratable);
  }

  function isArchitectureSubtreeSelected(node: ArchitectureTreeNode) {
    const nodes = collectArchitectureNodes(node);
    return nodes.length > 0 && nodes.every(isArchitectureComponentSelected);
  }

  const architectureLayerGroups = computed<ArchitectureLayerGroup[]>(() =>
    architectureLayerDefinitions.value
      .map((layer) => {
        const layerComponents = architectureComponents.value.filter((component) => component.layerId === layer.layerId);
        const roots = architectureRootNodes.value.filter((node) => node.layerId === layer.layerId);
        return {
          layerId: layer.layerId,
          label: layer.label || layer.layerId,
          moduleCategory: layer.moduleCategory,
          description: layerDescription(layer),
          roots,
          componentCount: layerComponents.length,
          hydratableCount: layerComponents.filter((component) => component.hydratable).length,
          lockedCount: layerComponents.filter((component) => !component.hydratable).length,
          selectedCount: layerComponents.filter(isArchitectureComponentSelected).length,
        };
      })
      .filter((layer) => layer.componentCount > 0 || layer.roots.length > 0),
  );

  const runtimeEvidenceGroups = computed<RuntimeEvidenceGroup[]>(() => [
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

  function itemMustStaySelected(item: AssemblyItem) {
    return item.locked || item.statusLabel === "必选";
  }

  function syncSelection(bucket: SelectionBucket, items: AssemblyItem[]) {
    const next: AssemblySelection = {};
    for (const item of items) {
      next[item.id] = itemMustStaySelected(item) || (item.enabled && (bucket.value[item.id] ?? item.enabled));
    }
    bucket.value = next;
  }

  function syncAllSelections() {
    syncSelection(selectedArchitectureComponents, architectureItems.value);
  }

  function selectedCount(bucket: AssemblySelection, items: AssemblyItem[]) {
    return items.filter((item) => Boolean(bucket[item.id])).length;
  }

  const selectedArchitectureCount = computed(() =>
    selectedCount(selectedArchitectureComponents.value, architectureItems.value),
  );
  const hydratableArchitectureCount = computed(() =>
    architectureComponents.value.filter((component) => component.hydratable).length,
  );
  const nonHydratableArchitectureCount = computed(() =>
    architectureComponents.value.filter((component) => !component.hydratable).length,
  );
  const foundationArchitectureCount = computed(() =>
    architectureComponents.value.filter((component) => component.moduleCategory === "foundation").length,
  );
  const selectedHydratableArchitectureCount = computed(() =>
    architectureComponents.value.filter((component) =>
      component.hydratable && selectedArchitectureComponents.value[componentKey(component)],
    ).length,
  );
  const runtimeEvidenceCount = computed(() =>
    capabilityItems.value.length + moduleItems.value.length,
  );

  const canBuildRuntimeAssembly = computed(() =>
    !loading.value && !buildingAssembly.value && selectedArchitectureComponentIds.value.length > 0,
  );

  function clearAssemblyResult() {
    assemblyArtifact.value = null;
    assemblyError.value = "";
  }

  function setArchitectureComponentSelection(component: RuntimeArchitectureComponent, value: boolean) {
    const item = architectureItemFromComponent(component);
    clearAssemblyResult();
    selectedArchitectureComponents.value = {
      ...selectedArchitectureComponents.value,
      [item.id]: itemMustStaySelected(item) || (value && item.enabled),
    };
  }

  function setArchitectureSubtreeSelection(node: ArchitectureTreeNode, value: boolean) {
    const next = { ...selectedArchitectureComponents.value };
    clearAssemblyResult();
    for (const component of collectArchitectureNodes(node)) {
      const item = architectureItemFromComponent(component);
      next[item.id] = itemMustStaySelected(item) || (value && item.enabled);
    }
    selectedArchitectureComponents.value = next;
  }

  function setArchitectureLayerSelection(layer: ArchitectureLayerGroup, value: boolean) {
    const next = { ...selectedArchitectureComponents.value };
    clearAssemblyResult();
    const layerComponentIds = new Set(
      architectureComponents.value
        .filter((component) => component.layerId === layer.layerId)
        .map(componentKey),
    );
    for (const component of architectureComponents.value) {
      if (!layerComponentIds.has(componentKey(component))) {
        continue;
      }
      const item = architectureItemFromComponent(component);
      next[item.id] = itemMustStaySelected(item) || (value && item.enabled);
    }
    selectedArchitectureComponents.value = next;
  }

  function isModuleExpanded(componentId: string) {
    return expandedModuleIds.value.has(componentId);
  }

  function toggleModuleExpanded(componentId: string) {
    const next = new Set(expandedModuleIds.value);
    if (next.has(componentId)) {
      next.delete(componentId);
    } else {
      next.add(componentId);
    }
    expandedModuleIds.value = next;
  }

  async function refreshVersionAssembly() {
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

  async function buildRuntimeAssemblyPackage() {
    if (!canBuildRuntimeAssembly.value) {
      return;
    }
    buildingAssembly.value = true;
    assemblyError.value = "";
    assemblyArtifact.value = null;
    try {
      const response = await buildRuntimeAssembly({
        selectedComponentIds: selectedArchitectureComponentIds.value,
      });
      assemblyArtifact.value = response.artifact;
    } catch (error) {
      assemblyError.value = error instanceof Error ? error.message : "装配清单生成失败";
    } finally {
      buildingAssembly.value = false;
    }
  }

  onMounted(() => {
    void refreshVersionAssembly();
  });

  usePageRefreshHandler(
    (detail) => detail.viewId === "admin" && detail.adminView === "versionAssembly",
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
