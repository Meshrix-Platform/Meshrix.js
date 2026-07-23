#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARCHITECTURE_MODULE_CATEGORY_BY_LAYER,
  ARCHITECTURE_FACT_MANIFEST_VERSION,
  LICO_ARCHITECTURE_FACTS,
  buildArchitectureComponentInventory,
  listArchitectureNodeFacts,
  listDocumentationAssetsByClassification,
  listHydrationFacts
} from "../../packages/foundation/src/composition-management/architecture/manifest.mjs";
import { computeArchitectureFactsDigest } from "../generators/generate-architecture-diagram-digests.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const DIGEST_MARKER_RE =
  /<!-- architecture-facts-digest: (sha256:[a-f0-9]{64}) -->/u;

function repoPath(relativePath) {
  return path.join(repoRoot, relativePath);
}

async function read(relativePath) {
  return fs.readFile(repoPath(relativePath), "utf8");
}

async function assertPathExists(relativePath) {
  await fs.access(repoPath(relativePath));
}

function collectModuleIds(module, ids = []) {
  ids.push(module.moduleId);
  for (const child of module.childItems || []) {
    collectModuleIds(child, ids);
  }
  return ids;
}

function extractHtmlCodeValues(html) {
  return [...html.matchAll(/<code>(.*?)<\/code>/g)].map((match) => match[1].trim()).filter(Boolean);
}

function assertHydrationShape(record, context) {
  assert.ok(["essential", "optional"].includes(record.hydration), `${context} must declare essential or optional hydration`);
  assert.equal(
    record.hydratable,
    record.hydration === "optional",
    `${context} hydratable must match hydration status`
  );
}

async function verifyDocumentationClassification() {
  const promotional = listDocumentationAssetsByClassification("promotional");
  const developer = listDocumentationAssetsByClassification("developer-documentation");
  assert.ok(promotional.length >= 2, "promotional assets must be explicitly classified");
  assert.ok(developer.length >= 3, "developer documentation assets must be explicitly classified");

  for (const asset of [...promotional, ...developer]) {
    assert.ok(asset.assetId, "documentation asset must have assetId");
    assert.ok(asset.purpose, `${asset.assetId} must explain its purpose`);
    assert.ok(asset.factAuthority, `${asset.assetId} must declare fact authority`);
    for (const relativePath of asset.paths) {
      await assertPathExists(relativePath);
    }
  }

  for (const asset of promotional) {
    assert.notEqual(
      asset.factAuthority,
      "authoritative-for-architecture-hydration",
      `${asset.assetId} is promotional and must not be the hydration authority`
    );
  }
}

async function verifyManifestShape() {
  assert.equal(LICO_ARCHITECTURE_FACTS.schemaVersion, "v0.0.1:schema:definition-1");
  assert.equal(LICO_ARCHITECTURE_FACTS.protocolVersion, ARCHITECTURE_FACT_MANIFEST_VERSION);
  assert.equal(LICO_ARCHITECTURE_FACTS.authority, "packages/contracts/src/modules/manifest.mjs");
  assert.deepEqual(LICO_ARCHITECTURE_FACTS.sourceDiagrams, [
    "docs/architecture/LICOMESH-SYSTEM-ARCHITECTURE.html",
    "docs/architecture/LICOMESH-SERVICE-CAPABILITY-ARCHITECTURE.html"
  ]);

  const categoryIds = new Set();
  for (const category of LICO_ARCHITECTURE_FACTS.moduleCategoryDefinitions) {
    assert.ok(category.categoryId, "module category must have categoryId");
    assert.ok(category.label, `${category.categoryId} must have label`);
    assert.ok(category.description, `${category.categoryId} must have description`);
    categoryIds.add(category.categoryId);
  }

  for (const expectedCategory of Object.values(ARCHITECTURE_MODULE_CATEGORY_BY_LAYER)) {
    assert.equal(categoryIds.has(expectedCategory), true, `category ${expectedCategory} must be defined`);
  }

  for (const layer of LICO_ARCHITECTURE_FACTS.systemLayers) {
    assert.equal(
      layer.moduleCategory,
      ARCHITECTURE_MODULE_CATEGORY_BY_LAYER[layer.layerId],
      `layer ${layer.layerId} must use its declared module category`
    );
    assertHydrationShape(layer, `layer ${layer.layerId}`);
  }

  const layerIds = new Set(LICO_ARCHITECTURE_FACTS.systemLayers.map((layer) => layer.layerId));
  const moduleIds = [];
  for (const module of LICO_ARCHITECTURE_FACTS.systemModules) {
    assert.equal(layerIds.has(module.layerId), true, `${module.moduleId} must reference a known layer`);
    assert.equal(
      module.moduleCategory,
      ARCHITECTURE_MODULE_CATEGORY_BY_LAYER[module.layerId],
      `${module.moduleId} category must match its layer`
    );
    assertHydrationShape(module, `module ${module.moduleId}`);
    moduleIds.push(...collectModuleIds(module));
    for (const child of module.childItems || []) {
      assertHydrationShape(child, `child module ${child.moduleId}`);
    }
  }
  assert.equal(new Set(moduleIds).size, moduleIds.length, "architecture module ids must be unique");

  const nodeFacts = listArchitectureNodeFacts();
  const nodeFactIds = new Set(nodeFacts.map((node) => node.moduleId));
  assert.equal(nodeFactIds.size, nodeFacts.length, "architecture node fact ids must be unique");
  assert.ok(nodeFacts.length > moduleIds.length, "architecture node facts must cover diagram-level child nodes");
  for (const moduleId of moduleIds) {
    assert.equal(nodeFactIds.has(moduleId), true, `architecture node facts must include module tree id ${moduleId}`);
  }
  for (const node of nodeFacts) {
    assert.equal(layerIds.has(node.layerId), true, `${node.moduleId} must reference a known layer`);
    assert.equal(
      node.moduleCategory,
      ARCHITECTURE_MODULE_CATEGORY_BY_LAYER[node.layerId],
      `${node.moduleId} category must match its layer`
    );
    assertHydrationShape(node, `node ${node.moduleId}`);
    assert.ok(node.label, `node ${node.moduleId} must have label`);
    assert.ok(Array.isArray(node.functionItems), `node ${node.moduleId} must have function items`);
    assert.ok(node.functionItems.length > 0, `node ${node.moduleId} must describe at least one function item`);
    if (node.parentModuleId) {
      assert.equal(nodeFactIds.has(node.parentModuleId), true, `${node.moduleId} parent ${node.parentModuleId} must be a known node`);
    }
  }

  const serviceLayerNumbers = LICO_ARCHITECTURE_FACTS.serviceCapabilityLayers.map((layer) => layer.layerNumber);
  assert.deepEqual(serviceLayerNumbers, [1, 2, 3, 4, 5, 6], "service capability layers must be ordered from client to external applications");

  for (const field of LICO_ARCHITECTURE_FACTS.serviceCapabilityProtocolFields) {
    assert.ok(field.fieldId, "service capability protocol field must have fieldId");
    assert.ok(field.label, `${field.fieldId} must have label`);
    assert.ok(field.functionItems.length > 0, `${field.fieldId} must describe function items`);
    assert.ok(serviceLayerNumbers.includes(field.layerNumber), `${field.fieldId} must point to a known service layer`);
  }

  const hydrationFacts = listHydrationFacts();
  assert.ok(hydrationFacts.some((item) => item.hydratable === false), "manifest must include non-hydratable modules");
  assert.ok(hydrationFacts.some((item) => item.hydratable === true), "manifest must include hydratable modules");
  const inventory = buildArchitectureComponentInventory();
  assert.equal(inventory.allComponents.length, nodeFacts.length, "runtime component inventory must expose every node fact");
  assert.ok(inventory.baseComponents.length > 0, "runtime component inventory must expose base components");
  assert.ok(inventory.hydratableBaseComponents.length > 0, "runtime component inventory must expose hydratable base components");
  assert.ok(inventory.nonHydratableBaseComponents.length > 0, "runtime component inventory must expose non-hydratable base components");
  assert.ok(inventory.hydratableComponents.length > 0, "runtime component inventory must expose hydratable components");
  assert.ok(
    inventory.baseComponents.every((component) => component.moduleCategory === "foundation"),
    "base components must be foundation components"
  );
  assert.ok(
    inventory.hydratableBaseComponents.every((component) => component.moduleCategory === "foundation" && component.hydratable === true),
    "hydratable base components must be hydratable foundation components"
  );
  assert.ok(
    inventory.nonHydratableBaseComponents.every((component) => component.moduleCategory === "foundation" && component.hydratable === false),
    "non-hydratable base components must be non-hydratable foundation components"
  );
  assert.ok(
    inventory.hydratableComponents.every((component) => component.hydratable === true),
    "hydratable component list must only include hydratable components"
  );
}

async function verifyHtmlSourceCoverage() {
  const expectedDigest = computeArchitectureFactsDigest();
  const systemHtml = await read("docs/architecture/LICOMESH-SYSTEM-ARCHITECTURE.html");
  const serviceHtml = await read("docs/architecture/LICOMESH-SERVICE-CAPABILITY-ARCHITECTURE.html");

  for (const [label, html] of [
    ["system", systemHtml],
    ["service", serviceHtml]
  ]) {
    const marker = html.match(DIGEST_MARKER_RE)?.[1];
    assert.equal(
      marker,
      expectedDigest,
      `${label} architecture HTML digest must match architecture facts authority digest`
    );
    assert.match(
      html,
      /Projection-only diagram/u,
      `${label} architecture HTML must declare projection-only status`
    );
    assert.match(
      html,
      /Authority:\s*packages\/contracts\/src\/modules\/manifest\.mjs/u,
      `${label} architecture HTML must cite the architecture facts authority`
    );
  }

  for (const layer of LICO_ARCHITECTURE_FACTS.systemLayers) {
    assert.match(systemHtml, new RegExp(layer.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `system architecture HTML must include layer ${layer.label}`);
  }

  const nodeFacts = listArchitectureNodeFacts();
  const nodeFactIds = new Set(nodeFacts.map((node) => node.moduleId));
  for (const htmlCode of extractHtmlCodeValues(systemHtml)) {
    assert.equal(nodeFactIds.has(htmlCode), true, `system architecture manifest must include HTML node ${htmlCode}`);
  }
  for (const node of nodeFacts) {
    assert.equal(
      systemHtml.includes(`<code>${node.moduleId}</code>`) || systemHtml.includes(node.label),
      true,
      `system architecture HTML must include node fact ${node.moduleId}`
    );
  }

  for (const module of LICO_ARCHITECTURE_FACTS.systemModules) {
    assert.equal(systemHtml.includes(module.label), true, `system architecture HTML must include module label ${module.label}`);
    assert.equal(
      systemHtml.includes(`<code>${module.moduleId}</code>`) || systemHtml.includes(module.label),
      true,
      `system architecture HTML must include module ${module.moduleId}`
    );
    for (const child of module.childItems || []) {
      assert.equal(
        systemHtml.includes(`<code>${child.moduleId}</code>`) || systemHtml.includes(child.label),
        true,
        `system architecture HTML must include child module ${child.moduleId}`
      );
    }
  }

  const serviceProtocolFieldIds = new Set(LICO_ARCHITECTURE_FACTS.serviceCapabilityProtocolFields.map((field) => field.fieldId));
  for (const htmlCode of extractHtmlCodeValues(serviceHtml)) {
    assert.equal(serviceProtocolFieldIds.has(htmlCode), true, `service capability manifest must include protocol field ${htmlCode}`);
  }

  for (const layer of LICO_ARCHITECTURE_FACTS.serviceCapabilityLayers) {
    assert.equal(serviceHtml.includes(`<span>Layer ${layer.layerNumber}</span>`), true, `service capability HTML must include Layer ${layer.layerNumber}`);
    assert.equal(serviceHtml.includes(layer.label), true, `service capability HTML must include ${layer.label}`);
    for (const item of layer.functionItems) {
      assert.equal(serviceHtml.includes(item), true, `service capability HTML must include ${item}`);
    }
  }
}

async function main() {
  await verifyDocumentationClassification();
  await verifyManifestShape();
  await verifyHtmlSourceCoverage();
  console.log("[architecture-facts] ok");
}

await main();
