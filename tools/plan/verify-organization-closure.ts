import crypto from "node:crypto";
import { type JsonRecord, hasControlCharacter, isJsonRecord } from "./plan-types.ts";

const LAYERS: readonly string[] = Object.freeze([
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

const LAYER_ORDER = new Map(LAYERS.map((layer, index) => [layer, index]));
const SUPPORTED_PLATFORMS  = new Set(["any", "linux", "macos", "windows"]);
const CORE_REPOSITORY  = ".git";
const MAX_PENDING  = 256;
const SAFE_CAPABILITY  = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u;

interface EdgeDefinition {
  edge: string;
  collection: "source" | "plan" | "registry";
  field: string;
  missing: string;
  kind: "scalar" | "list";
}
interface ClosureFinding extends JsonRecord { capability: string; layer: string; code: string; edge: string; state: "pending" }
interface MappedCapability extends JsonRecord { capability: string; layer: string; state: "mapped" }

const EDGE_DEFINITIONS: readonly EdgeDefinition[] = Object.freeze([
  { edge: "code", collection: "source", field: "code_owner", missing: "missing-owner", kind: "scalar" },
  { edge: "document", collection: "source", field: "document_owner", missing: "missing-document", kind: "list" },
  { edge: "plan", collection: "plan", field: "plan_owner", missing: "missing-owner", kind: "scalar" },
  { edge: "registry", collection: "registry", field: "registry_identities", missing: "missing-registry", kind: "list" },
  { edge: "verifier", collection: "source", field: "verifier_identities", missing: "missing-verifier", kind: "list" },
  { edge: "acceptance-machine", collection: "source", field: "acceptance_machine_identity", missing: "missing-acceptance-machine", kind: "list" },
]);

function safeCapability(value: unknown): string {
  return typeof value === "string" && SAFE_CAPABILITY.test(value) ? value : "invalid-capability";
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isJsonRecord(value)) {
    const record = value;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedValues(value: unknown, kind: EdgeDefinition["kind"]): string[] {
  const input  = kind === "list" ? (Array.isArray(value) ? value : value == null ? [] : [value]) : [value];
  return [...new Set(input.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))].sort();
}

function isUnsafeOwner(value: string): boolean {
  return typeof value !== "string" || value.length === 0 || value.length > 1024 ||
    value.startsWith("/") || value.startsWith("../") || value.includes("/../") ||
    value.includes("\\") || hasControlCharacter(value);
}

function indexFacts(facts: unknown): Map<string, JsonRecord[]> {
  const index = new Map<string, JsonRecord[]>();
  for (const fact of Array.isArray(facts) ? facts : []) {
    const record = isJsonRecord(fact) ? fact : {};
    const capability = safeCapability(record.capability);
    const records = index.get(capability) ?? [];
    records.push(record);
    index.set(capability, records);
  }
  return index;
}

function layerFor(_capability: string, sourceRecords: JsonRecord[]): string {
  const layers  = [...new Set(sourceRecords
    .map((record) => record.layer)
    .filter((layer): layer is string => typeof layer === "string" && LAYER_ORDER.has(layer)))];
  if (layers.length === 1) return layers[0];
  return layers[0] ?? "cross-cutting-governance";
}

function finding(capability: string, layer: string, code: string, edge: string): ClosureFinding {
  return { capability, layer, code, edge, state: "pending" };
}

function compareEdge({ capability, layer, records, definition, pending }: {
  capability: string; layer: string; records: JsonRecord[]; definition: EdgeDefinition; pending: ClosureFinding[];
}): void {
  if (records.length === 0) {
    pending.push(finding(capability, layer, definition.missing, definition.edge));
    return;
  }

  const authorities = records.map((record) => normalizedValues(record[definition.field], definition.kind));
  if (authorities.some((values) => values.length === 0)) {
    pending.push(finding(capability, layer, definition.missing, definition.edge));
    return;
  }
  if (authorities.some((values) => values.some(isUnsafeOwner))) {
    pending.push(finding(capability, layer, "invalid-owner-path", definition.edge));
    return;
  }
  if (new Set(authorities.map(stableStringify)).size !== 1) {
    pending.push(finding(capability, layer, "contradictory-authority", definition.edge));
  }
}

function compareRegistryIdentitySets(capability: string, layer: string, sourceRecords: JsonRecord[], registryRecords: JsonRecord[], pending: ClosureFinding[]): void {
  const required = new Set(sourceRecords.flatMap((record) =>
    normalizedValues(record.required_registry_identities, "list")));
  if (required.size === 0) return;
  const observed = new Set(registryRecords.flatMap((record) =>
    normalizedValues(record.registry_identities, "list")));
  const missing = [...required].filter((identity) => !observed.has(identity));
  const unexpected = [...observed].filter((identity) => !required.has(identity));
  if (missing.length > 0) {
    pending.push(finding(capability, layer, "missing-registry", "registry"));
  } else if (unexpected.length > 0) {
    pending.push(finding(capability, layer, "contradictory-authority", "registry"));
  }
}

function comparePlanNode(capability: string, layer: string, planRecords: JsonRecord[], pending: ClosureFinding[]): void {
  if (planRecords.length === 0) return;
  const nodes = planRecords.map((record) => normalizedValues(record.plan_node, "scalar"));
  if (nodes.some((values) => values.length !== 1)) {
    pending.push(finding(capability, layer, "missing-owner", "plan"));
  } else if (new Set(nodes.map(stableStringify)).size !== 1) {
    pending.push(finding(capability, layer, "contradictory-authority", "plan"));
  }
}

function compareAdmission(capability: string, layer: string, sourceRecords: JsonRecord[], pending: ClosureFinding[]): void {
  if (sourceRecords.length === 0) return;
  const platforms = sourceRecords.map((record) => record.platform);
  if (platforms.some((platform) => typeof platform !== "string" || !SUPPORTED_PLATFORMS.has(platform))) {
    pending.push(finding(capability, layer, "invalid-platform", "platform"));
  } else if (new Set(platforms).size !== 1) {
    pending.push(finding(capability, layer, "contradictory-authority", "platform"));
  }

  const repositories = sourceRecords.map((record) => record.repository);
  if (repositories.some((repository) => repository !== CORE_REPOSITORY)) {
    pending.push(finding(capability, layer, "invalid-repository-target", "repository"));
  } else if (new Set(repositories).size !== 1) {
    pending.push(finding(capability, layer, "contradictory-authority", "repository"));
  }
}

function canonicalFacts(sourceFacts: unknown, planFacts: unknown, registries: unknown) {
  // Preserve every observed field in the fingerprint input. The canonical facts are
  // never projected into the report, so unsafe source values affect freshness without
  // becoming report content.
  const normalize = (facts: unknown): string[] => (Array.isArray(facts) ? facts : [])
    .map((fact) => stableStringify(isJsonRecord(fact) ? fact : {}))
    .sort(compareText);
  return { sourceFacts: normalize(sourceFacts), planFacts: normalize(planFacts), registries: normalize(registries) };
}

/**
 * Deterministically verifies the code-to-acceptance closure for current Core facts.
 * Inputs are observed only; this function does not mutate or retain caller-owned objects.
 */
export function verifyOrganizationClosure(sourceFacts: unknown, planFacts: unknown, registries: unknown) {
  const sourceIndex  = indexFacts(sourceFacts);
  const planIndex  = indexFacts(planFacts);
  const registryIndex  = indexFacts(registries);
  const capabilities  = [...new Set([
    ...sourceIndex.keys(),
    ...planIndex.keys(),
    ...registryIndex.keys(),
  ])].sort(compareText);

  const pending: ClosureFinding[] = [];
  const mapped: MappedCapability[] = [];
  for (const capability of capabilities) {
    const sourceRecords  = sourceIndex.get(capability) ?? [];
    const planRecords  = planIndex.get(capability) ?? [];
    const registryRecords  = registryIndex.get(capability) ?? [];
    const layer  = layerFor(capability, sourceRecords);
    const before  = pending.length;

    const declaredLayers = sourceRecords.map((record) => record.layer);
    if (sourceRecords.length === 0 ||
      declaredLayers.some((declaredLayer) => typeof declaredLayer !== "string" || !LAYER_ORDER.has(declaredLayer))) {
      pending.push(finding(capability, layer, "invalid-layer", "layer"));
    } else if (new Set(declaredLayers).size > 1) {
      pending.push(finding(capability, layer, "contradictory-authority", "layer"));
    }

    for (const definition of EDGE_DEFINITIONS) {
      const records  = definition.collection === "source"
        ? sourceRecords
        : definition.collection === "plan" ? planRecords : registryRecords;
      compareEdge({ capability, layer, records, definition, pending });
    }
    comparePlanNode(capability, layer, planRecords, pending);
    compareRegistryIdentitySets(capability, layer, sourceRecords, registryRecords, pending);
    compareAdmission(capability, layer, sourceRecords, pending);

    if (pending.length === before) mapped.push({ capability, layer, state: "mapped" });
  }

  const findingKey = (entry: ClosureFinding): string => `${LAYER_ORDER.get(entry.layer) ?? LAYERS.length}\0${entry.capability}\0${entry.edge}\0${entry.code}`;
  const uniquePending = [...new Map(pending.map((entry) => [findingKey(entry), entry])).values()]
    .sort((left, right) => compareText(findingKey(left), findingKey(right)));
  mapped.sort((left, right) => {
    const layerDifference  = (LAYER_ORDER.get(left.layer) ?? LAYERS.length) -
      (LAYER_ORDER.get(right.layer) ?? LAYERS.length);
    return layerDifference || compareText(left.capability, right.capability);
  });

  const fingerprintInput: JsonRecord = {
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
