export function defineArchitectureNodeFacts(layerId?: any, moduleCategory?: any, facts?: any) : any {
  return facts.map((fact?: any) : any => Object.freeze({
    layerId,
    moduleCategory,
    ...fact,
    functionItems: Object.freeze(fact.functionItems)
  }));
}
