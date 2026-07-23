export function defineArchitectureNodeFacts(layerId, moduleCategory, facts) {
  return facts.map((fact) => Object.freeze({
    layerId,
    moduleCategory,
    ...fact,
    functionItems: Object.freeze(fact.functionItems)
  }));
}
