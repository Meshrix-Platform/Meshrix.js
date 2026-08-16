export interface ArchitectureNodeFactInput {
  moduleId: string;
  parentModuleId?: string;
  featureId?: string;
  pluginId?: string;
  label: string;
  hydration: string;
  hydratable: boolean;
  functionItems: readonly string[];
}

export function defineArchitectureNodeFacts<T extends ArchitectureNodeFactInput>(
  layerId: string,
  moduleCategory: string,
  facts: readonly T[]
) {
  return facts.map((fact) => Object.freeze({
    layerId,
    moduleCategory,
    ...fact,
    functionItems: Object.freeze(fact.functionItems)
  }));
}
