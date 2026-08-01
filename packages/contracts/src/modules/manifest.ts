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
  ARCHITECTURE_MODULE_CATEGORY_BY_LAYER,
  DOCUMENTATION_ASSET_CLASSIFICATIONS,
  SYSTEM_ARCHITECTURE_LAYERS
} from "./manifest-categories.ts";
import { SYSTEM_ARCHITECTURE_MODULES } from "./manifest-system-modules.ts";
import { SYSTEM_ARCHITECTURE_NODE_FACTS } from "./manifest-node-facts.ts";
import {
  SERVICE_CAPABILITY_LAYERS,
  SERVICE_CAPABILITY_PROTOCOL_FIELDS
} from "./manifest-service-capability.ts";

export const MESHRIX_ARCHITECTURE_FACTS: Readonly<Record<string, any>> = Object.freeze({
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

export function listDocumentationAssetsByClassification(classification?: any) : any {
  return DOCUMENTATION_ASSET_CLASSIFICATIONS.filter((asset?: any) : any => asset.classification === classification);
}

export function listArchitectureModules() : any {
  return SYSTEM_ARCHITECTURE_MODULES;
}

export function listArchitectureNodeFacts() : any {
  return SYSTEM_ARCHITECTURE_NODE_FACTS;
}

export function toRuntimeArchitectureComponent(node?: any) : any {
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

export function buildArchitectureComponentInventory({ activeFeatureIds = null }: Record<string, any> = {}) : any {
  const activeFeatures: any = activeFeatureIds === null ? null : new Set<any>(activeFeatureIds || []);
  const allComponents: any = SYSTEM_ARCHITECTURE_NODE_FACTS
    .filter((node?: any) : any => !activeFeatures || !node.featureId || activeFeatures.has(node.featureId))
    .map(toRuntimeArchitectureComponent);
  const baseComponents: any = allComponents.filter((component?: any) : any => component.moduleCategory === "foundation");
  const hydratableComponents: any = allComponents.filter((component?: any) : any => component.hydratable);
  const nonHydratableComponents: any = allComponents.filter((component?: any) : any => !component.hydratable);
  const hydratableBaseComponents: any = baseComponents.filter((component?: any) : any => component.hydratable);
  const nonHydratableBaseComponents: any = baseComponents.filter((component?: any) : any => !component.hydratable);
  return Object.freeze({
    protocolVersion: ARCHITECTURE_FACT_MANIFEST_VERSION,
    source: "packages/contracts/src/modules/manifest.ts",
    layers: SYSTEM_ARCHITECTURE_LAYERS.map((layer?: any) : any => Object.freeze({
      layerId: layer.layerId,
      moduleCategory: layer.moduleCategory,
      label: layer.label,
      hydration: layer.hydration,
      hydratable: layer.hydratable,
      functionItems: [...(layer.functionItems || [])]
    })),
    moduleCategoryDefinitions: ARCHITECTURE_MODULE_CATEGORY_DEFINITIONS.map((definition?: any) : any => Object.freeze({
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
      "core-capability": allComponents.filter((component?: any) : any => component.moduleCategory === "core-capability"),
      application: allComponents.filter((component?: any) : any => component.moduleCategory === "application"),
      aspect: allComponents.filter((component?: any) : any => component.moduleCategory === "aspect"),
      appearance: allComponents.filter((component?: any) : any => component.moduleCategory === "appearance")
    }),
    allComponents
  });
}

export function listBaseArchitectureComponents() : any {
  return buildArchitectureComponentInventory().baseComponents;
}

export function listHydratableArchitectureComponents() : any {
  return buildArchitectureComponentInventory().hydratableComponents;
}

export function listNonHydratableArchitectureComponents() : any {
  return buildArchitectureComponentInventory().nonHydratableComponents;
}

export function listHydrationFacts() : any {
  return SYSTEM_ARCHITECTURE_NODE_FACTS.map((node?: any) : any => ({
    moduleId: node.moduleId,
    label: node.label,
    layerId: node.layerId,
    moduleCategory: node.moduleCategory,
    hydration: node.hydration,
    hydratable: node.hydratable,
    functionItems: node.functionItems
  }));
}

export function getArchitectureModule(moduleId?: any) : any {
  return SYSTEM_ARCHITECTURE_MODULES.find((module?: any) : any => module.moduleId === moduleId) || null;
}

export function getArchitectureNodeFact(moduleId?: any) : any {
  return SYSTEM_ARCHITECTURE_NODE_FACTS.find((node?: any) : any => node.moduleId === moduleId) || null;
}
