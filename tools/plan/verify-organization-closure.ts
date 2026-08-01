import crypto from "node:crypto";

const LAYERS: readonly any[] = Object.freeze([
  "application-entry",
  "runtime-composition",
  "contracts",
  "foundation",
  "domain-capabilities",
  "agents-and-protocols",
  "optional-plugins",
  "ui-console",
  "deployment-and-operations",
  "cross-cutting-governance",
]);

const LAYER_ORDER: any = new Map<any, any>(LAYERS.map((layer?: any, index?: any) : any => [layer, index]));
const SUPPORTED_PLATFORMS: any = new Set<any>(["any", "linux", "macos", "windows"]);
const CORE_REPOSITORY: any = ".git";
const MAX_PENDING: any = 256;
const SAFE_CAPABILITY: any = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u;

const EDGE_DEFINITIONS: readonly any[] = Object.freeze([
  { edge: "code", collection: "source", field: "code_owner", missing: "missing-owner", kind: "scalar" },
  { edge: "document", collection: "source", field: "document_owner", missing: "missing-document", kind: "list" },
  { edge: "plan", collection: "plan", field: "plan_owner", missing: "missing-owner", kind: "scalar" },
  { edge: "registry", collection: "registry", field: "registry_identities", missing: "missing-registry", kind: "list" },
  { edge: "verifier", collection: "source", field: "verifier_identities", missing: "missing-verifier", kind: "list" },
  { edge: "acceptance-machine", collection: "source", field: "acceptance_machine_identity", missing: "missing-acceptance-machine", kind: "list" },
]);

function safeCapability(value?: any) : any {
  return typeof value === "string" && SAFE_CAPABILITY.test(value) ? value : "invalid-capability";
}

function stableStringify(value?: any) : any {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key?: any) : any =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareText(left?: any, right?: any) : any {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedValues(value?: any, kind?: any) : any {
  const input: any = kind === "list" ? (Array.isArray(value) ? value : value == null ? [] : [value]) : [value];
  return [...new Set<any>(input.filter((entry?: any) : any => typeof entry === "string" && entry.length > 0))].sort();
}

function isUnsafeOwner(value?: any) : any {
  return typeof value !== "string" || value.length === 0 || value.length > 1024 ||
    value.startsWith("/") || value.startsWith("../") || value.includes("/../") ||
    value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value);
}

function indexFacts(facts?: any) : any {
  const index: any = new Map<any, any>();
  for (const fact of Array.isArray(facts) ? facts : []) {
    const capability: any = safeCapability(fact?.capability);
    const records: any = index.get(capability) ?? [];
    records.push(fact && typeof fact === "object" ? fact : {});
    index.set(capability, records);
  }
  return index;
}

function layerFor(capability?: any, sourceRecords?: any) : any {
  const layers: any[] = [...new Set<any>(sourceRecords
    .map((record?: any) : any => record?.layer)
    .filter((layer?: any) : any => typeof layer === "string" && LAYER_ORDER.has(layer)))];
  if (layers.length === 1) return layers[0];
  return layers[0] ?? "cross-cutting-governance";
}

function finding(capability?: any, layer?: any, code?: any, edge?: any) : any {
  return { capability, layer, code, edge, state: "pending" };
}

function compareEdge({ capability, layer, records, definition, pending }: Record<string, any>) : any {
  if (records.length === 0) {
    pending.push(finding(capability, layer, definition.missing, definition.edge));
    return;
  }

  const authorities: any = records.map((record?: any) : any => normalizedValues(record?.[definition.field], definition.kind));
  if (authorities.some((values?: any) : any => values.length === 0)) {
    pending.push(finding(capability, layer, definition.missing, definition.edge));
    return;
  }
  if (authorities.some((values?: any) : any => values.some(isUnsafeOwner))) {
    pending.push(finding(capability, layer, "invalid-owner-path", definition.edge));
    return;
  }
  if (new Set<any>(authorities.map(stableStringify)).size !== 1) {
    pending.push(finding(capability, layer, "contradictory-authority", definition.edge));
  }
}

function compareRegistryIdentitySets(capability?: any, layer?: any, sourceRecords?: any, registryRecords?: any, pending?: any) : any {
  const required: any = new Set<any>(sourceRecords.flatMap((record?: any) : any =>
    normalizedValues(record?.required_registry_identities, "list")));
  if (required.size === 0) return;
  const observed: any = new Set<any>(registryRecords.flatMap((record?: any) : any =>
    normalizedValues(record?.registry_identities, "list")));
  const missing: any = [...required].filter((identity?: any) : any => !observed.has(identity));
  const unexpected: any = [...observed].filter((identity?: any) : any => !required.has(identity));
  if (missing.length > 0) {
    pending.push(finding(capability, layer, "missing-registry", "registry"));
  } else if (unexpected.length > 0) {
    pending.push(finding(capability, layer, "contradictory-authority", "registry"));
  }
}

function comparePlanNode(capability?: any, layer?: any, planRecords?: any, pending?: any) : any {
  if (planRecords.length === 0) return;
  const nodes: any = planRecords.map((record?: any) : any => normalizedValues(record?.plan_node, "scalar"));
  if (nodes.some((values?: any) : any => values.length !== 1)) {
    pending.push(finding(capability, layer, "missing-owner", "plan"));
  } else if (new Set<any>(nodes.map(stableStringify)).size !== 1) {
    pending.push(finding(capability, layer, "contradictory-authority", "plan"));
  }
}

function compareAdmission(capability?: any, layer?: any, sourceRecords?: any, pending?: any) : any {
  if (sourceRecords.length === 0) return;
  const platforms: any = sourceRecords.map((record?: any) : any => record?.platform);
  if (platforms.some((platform?: any) : any => !SUPPORTED_PLATFORMS.has(platform))) {
    pending.push(finding(capability, layer, "invalid-platform", "platform"));
  } else if (new Set<any>(platforms).size !== 1) {
    pending.push(finding(capability, layer, "contradictory-authority", "platform"));
  }

  const repositories: any = sourceRecords.map((record?: any) : any => record?.repository);
  if (repositories.some((repository?: any) : any => repository !== CORE_REPOSITORY)) {
    pending.push(finding(capability, layer, "invalid-repository-target", "repository"));
  } else if (new Set<any>(repositories).size !== 1) {
    pending.push(finding(capability, layer, "contradictory-authority", "repository"));
  }
}

function canonicalFacts(sourceFacts?: any, planFacts?: any, registries?: any) : any {
  // Preserve every observed field in the fingerprint input. The canonical facts are
  // never projected into the report, so unsafe source values affect freshness without
  // becoming report content.
  const normalize: any = (facts?: any) : any => (Array.isArray(facts) ? facts : [])
    .map((fact?: any) : any => stableStringify(fact && typeof fact === "object" ? fact : {}))
    .sort(compareText);
  return { sourceFacts: normalize(sourceFacts), planFacts: normalize(planFacts), registries: normalize(registries) };
}

/**
 * Deterministically verifies the code-to-acceptance closure for current Core facts.
 * Inputs are observed only; this function does not mutate or retain caller-owned objects.
 */
export function verifyOrganizationClosure(sourceFacts?: any, planFacts?: any, registries?: any) : any {
  const sourceIndex: any = indexFacts(sourceFacts);
  const planIndex: any = indexFacts(planFacts);
  const registryIndex: any = indexFacts(registries);
  const capabilities: any = [...new Set<any>([
    ...sourceIndex.keys(),
    ...planIndex.keys(),
    ...registryIndex.keys(),
  ])].sort(compareText);

  const pending: any[] = [];
  const mapped: any[] = [];
  for (const capability of capabilities) {
    const sourceRecords: any = sourceIndex.get(capability) ?? [];
    const planRecords: any = planIndex.get(capability) ?? [];
    const registryRecords: any = registryIndex.get(capability) ?? [];
    const layer: any = layerFor(capability, sourceRecords);
    const before: any = pending.length;

    const declaredLayers: any = sourceRecords.map((record?: any) : any => record?.layer);
    if (sourceRecords.length === 0 ||
      declaredLayers.some((declaredLayer?: any) : any => !LAYER_ORDER.has(declaredLayer))) {
      pending.push(finding(capability, layer, "invalid-layer", "layer"));
    } else if (new Set<any>(declaredLayers).size > 1) {
      pending.push(finding(capability, layer, "contradictory-authority", "layer"));
    }

    for (const definition of EDGE_DEFINITIONS) {
      const records: any = definition.collection === "source"
        ? sourceRecords
        : definition.collection === "plan" ? planRecords : registryRecords;
      compareEdge({ capability, layer, records, definition, pending });
    }
    comparePlanNode(capability, layer, planRecords, pending);
    compareRegistryIdentitySets(capability, layer, sourceRecords, registryRecords, pending);
    compareAdmission(capability, layer, sourceRecords, pending);

    if (pending.length === before) mapped.push({ capability, layer, state: "mapped" });
  }

  const findingKey: any = (entry?: any) : any => `${LAYER_ORDER.get(entry.layer) ?? LAYERS.length}\0${entry.capability}\0${entry.edge}\0${entry.code}`;
  const uniquePending: any = [...new Map<any, any>(pending.map((entry?: any) : any => [findingKey(entry), entry])).values()]
    .sort((left?: any, right?: any) : any => compareText(findingKey(left), findingKey(right)));
  mapped.sort((left?: any, right?: any) : any => {
    const layerDifference: any = (LAYER_ORDER.get(left.layer) ?? LAYERS.length) -
      (LAYER_ORDER.get(right.layer) ?? LAYERS.length);
    return layerDifference || compareText(left.capability, right.capability);
  });

  const fingerprintInput: Record<string, any> = {
    layers: LAYERS,
    facts: canonicalFacts(sourceFacts, planFacts, registries),
    mapped,
    pending: uniquePending,
  };
  return {
    schema_version: "v0.0.1:meshrix:organization-closure-1",
    accepted: uniquePending.length === 0,
    layers: [...LAYERS],
    mapped,
    pending: uniquePending.slice(0, MAX_PENDING),
    pending_total: uniquePending.length,
    pending_truncated: Math.max(0, uniquePending.length - MAX_PENDING),
    fingerprint: crypto.createHash("sha256").update(stableStringify(fingerprintInput)).digest("hex"),
  };
}
