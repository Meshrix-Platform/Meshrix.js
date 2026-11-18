export {
  ARCHITECTURE_FACT_MANIFEST_VERSION,
  ARCHITECTURE_MODULE_CATEGORY_DEFINITIONS,
  ARCHITECTURE_MODULE_CATEGORY_BY_LAYER,
  DOCUMENTATION_ASSET_CLASSIFICATIONS,
  SYSTEM_ARCHITECTURE_LAYERS
} from "./manifest-categories.ts";
export { SYSTEM_ARCHITECTURE_MODULES } from "./manifest-system-modules.ts";
export { SYSTEM_ARCHITECTURE_NODE_FACTS } from "./manifest-node-facts.ts";
export {
  SERVICE_CAPABILITY_LAYERS,
  SERVICE_CAPABILITY_PROTOCOL_FIELDS
} from "./manifest-service-capability.ts";

import {
  ARCHITECTURE_FACT_MANIFEST_VERSION,
  ARCHITECTURE_MODULE_CATEGORY_DEFINITIONS,
  DOCUMENTATION_ASSET_CLASSIFICATIONS,
  SYSTEM_ARCHITECTURE_LAYERS
} from "./manifest-categories.ts";
import { SYSTEM_ARCHITECTURE_MODULES } from "./manifest-system-modules.ts";
import { SYSTEM_ARCHITECTURE_NODE_FACTS } from "./manifest-node-facts.ts";
import {
  SERVICE_CAPABILITY_LAYERS,
  SERVICE_CAPABILITY_PROTOCOL_FIELDS
} from "./manifest-service-capability.ts";
import type { ArchitectureNodeFactInput } from "./manifest-node-facts-support.ts";

export const MESHRIX_ARCHITECTURE_FACTS = Object.freeze({
  schemaVersion: "v0.0.1:schema:definition-1",
  protocolVersion: ARCHITECTURE_FACT_MANIFEST_VERSION,
  authority: "packages/contracts/src/modules/manifest.ts",
  sourceDiagrams: Object.freeze([
    "docs/architecture/MESHRIX-SYSTEM-ARCHITECTURE.html",
    "docs/architecture/MESHRIX-SERVICE-CAPABILITY-ARCHITECTURE.html"
  ]),
  documentationAssets: DOCUMENTATION_ASSET_CLASSIFICATIONS,
  moduleCategoryDefinitions: ARCHITECTURE_MODULE_CATEGORY_DEFINITIONS,
  systemLayers: SYSTEM_ARCHITECTURE_LAYERS,
  systemModules: SYSTEM_ARCHITECTURE_MODULES,
  systemNodeFacts: SYSTEM_ARCHITECTURE_NODE_FACTS,
  serviceCapabilityLayers: SERVICE_CAPABILITY_LAYERS,
  serviceCapabilityProtocolFields: SERVICE_CAPABILITY_PROTOCOL_FIELDS
});

export function listDocumentationAssetsByClassification(classification?: string) {
  return DOCUMENTATION_ASSET_CLASSIFICATIONS.filter((asset) => asset.classification === classification);
}

export function listArchitectureModules() {
  return SYSTEM_ARCHITECTURE_MODULES;
}

export function listArchitectureNodeFacts() {
  return SYSTEM_ARCHITECTURE_NODE_FACTS;
}

type ArchitectureNodeFact = ArchitectureNodeFactInput & {
  layerId: string;
  moduleCategory: string;
};
type ArchitectureModule = typeof SYSTEM_ARCHITECTURE_MODULES[number];

export function toRuntimeArchitectureComponent(node: ArchitectureNodeFact) {
  return Object.freeze({
    componentId: node.moduleId,
    moduleId: node.moduleId,
    parentModuleId: node.parentModuleId || "",
    label: node.label,
    layerId: node.layerId,
    moduleCategory: node.moduleCategory,
    featureId: node.featureId || "",
    pluginId: node.pluginId || "",
    hydration: node.hydration,
    hydratable: node.hydratable,
    functionItems: [...(node.functionItems || [])]
  });
}

export function buildArchitectureComponentInventory({
  activeFeatureIds = null
}: { activeFeatureIds?: readonly string[] | null } = {}) {
  const activeFeatures = activeFeatureIds === null ? null : new Set(activeFeatureIds);
  const allComponents = SYSTEM_ARCHITECTURE_NODE_FACTS
    .filter((node: ArchitectureNodeFact) => !activeFeatures || !node.featureId || activeFeatures.has(node.featureId))
    .map(toRuntimeArchitectureComponent);
  const baseComponents = allComponents.filter((component) => component.moduleCategory === "foundation");
  const hydratableComponents = allComponents.filter((component) => component.hydratable);
  const nonHydratableComponents = allComponents.filter((component) => !component.hydratable);
  const hydratableBaseComponents = baseComponents.filter((component) => component.hydratable);
  const nonHydratableBaseComponents = baseComponents.filter((component) => !component.hydratable);
  return Object.freeze({
    protocolVersion: ARCHITECTURE_FACT_MANIFEST_VERSION,
    source: "packages/contracts/src/modules/manifest.ts",
    layers: SYSTEM_ARCHITECTURE_LAYERS.map((layer) => Object.freeze({
      layerId: layer.layerId,
      moduleCategory: layer.moduleCategory,
      label: layer.label,
      hydration: layer.hydration,
      hydratable: layer.hydratable,
      functionItems: [...(layer.functionItems || [])]
    })),
    moduleCategoryDefinitions: ARCHITECTURE_MODULE_CATEGORY_DEFINITIONS.map((definition) => Object.freeze({
      categoryId: definition.categoryId,
      label: definition.label,
      description: definition.description
    })),
    baseComponents,
    foundationComponents: baseComponents,
    hydratableBaseComponents,
    nonHydratableBaseComponents,
    hydratableComponents,
    nonHydratableComponents,
    componentsByCategory: Object.freeze({
      foundation: baseComponents,
      "core-capability": allComponents.filter((component) => component.moduleCategory === "core-capability"),
      application: allComponents.filter((component) => component.moduleCategory === "application"),
      aspect: allComponents.filter((component) => component.moduleCategory === "aspect"),
      appearance: allComponents.filter((component) => component.moduleCategory === "appearance")
    }),
    allComponents
  });
}

export function listBaseArchitectureComponents() {
  return buildArchitectureComponentInventory().baseComponents;
}

export function listHydratableArchitectureComponents() {
  return buildArchitectureComponentInventory().hydratableComponents;
}

export function listNonHydratableArchitectureComponents() {
  return buildArchitectureComponentInventory().nonHydratableComponents;
}

export function listHydrationFacts() {
  return SYSTEM_ARCHITECTURE_NODE_FACTS.map((node) => ({
    moduleId: node.moduleId,
    label: node.label,
    layerId: node.layerId,
    moduleCategory: node.moduleCategory,
    hydration: node.hydration,
    hydratable: node.hydratable,
    functionItems: node.functionItems
  }));
}

export function getArchitectureModule(moduleId?: string): ArchitectureModule | null {
  return SYSTEM_ARCHITECTURE_MODULES.find((module) => module.moduleId === moduleId) || null;
}

export function getArchitectureNodeFact(moduleId?: string): ArchitectureNodeFact | null {
  return SYSTEM_ARCHITECTURE_NODE_FACTS.find((node) => node.moduleId === moduleId) || null;
}
