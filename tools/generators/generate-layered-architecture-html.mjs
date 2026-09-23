#!/usr/bin/env node
/**
 * Generate docs/architecture/MESHRIX-LAYERED-ARCHITECTURE.html from the repo's
 * package/plugin/service layout and inter-module dependency edges.
 *
 * Inputs (workspace package manifests, plugin manifests, dependency-rules registry):
 *   - packages/<name>/package.json, services/<name>/package.json, apps/<name>/package.json
 *   - plugins/.../package.json and plugins/.../plugin.json
 *   - tools/registry/dependency-rules.registry.json
 *
 * Usage:
 *   node tools/generators/generate-layered-architecture-html.mjs
 *   node tools/generators/generate-layered-architecture-html.mjs --check
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const OUT_REL = "docs/architecture/MESHRIX-LAYERED-ARCHITECTURE.html";
const OUT_PATH = path.resolve(ROOT, OUT_REL);
const DEPENDENCY_RULES_REL = "tools/registry/dependency-rules.registry.json";
const GENERATOR_REL = "tools/generators/generate-layered-architecture-html.mjs";
/** Fixed for deterministic regeneration (matches other generators). */
const GENERATED_AT = "1970-01-01T00:00:00.000Z";
const DOC_SCHEMA = "v0.1.0:docs:layered-architecture-html-1";

const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  "vendor",
  "test",
  "tests",
  "__tests__",
]);

/** Conceptual layers (top → bottom). */
const LAYER_DEFS = [
  {
    id: "upstream-services",
    title: "1. External / upstream services",
    subtitle:
      "Services that register into the Meshrix gateway (model, skill, file parsing).",
    color: "#c45c26",
  },
  {
    id: "gateway-internal",
    title: "2. Gateway-internal layers",
    subtitle:
      "Kernel (contracts/foundation), permissions (capabilities), and adapters (agents).",
    color: "#2f6fed",
  },
  {
    id: "mcp-relay",
    title: "3. MCP service layer and relay layer",
    subtitle:
      "Protocols (MCP/HTTP), server-runtime composition, and the server app entry.",
    color: "#2aa66a",
  },
  {
    id: "external-gateways",
    title: "4. External gateways (supplements)",
    subtitle:
      "Optional LB/proxy-facing plugins. Meshrix does not reimplement Nginx/Caddy; these only supplement edge transport.",
    color: "#8a6fdf",
  },
  {
    id: "client-plugins",
    title: "5. Client-side plugins / console",
    subtitle:
      "Agent client adapters, operator plugins, ui-console, and the console app.",
    color: "#c9a227",
  },
];

/**
 * Path → conceptual layer (+ optional gateway-internal strip).
 * Heuristics are grounded in repo roots; legend documents them.
 */
const MODULE_RULES = [
  {
    match: (p) => p === "services/model-gateway" || p.startsWith("services/model-gateway/"),
    layer: "upstream-services",
    label: "model-gateway",
    role: "Upstream model service",
  },
  {
    match: (p) => p === "services/skill-hub" || p.startsWith("services/skill-hub/"),
    layer: "upstream-services",
    label: "skill-hub",
    role: "Upstream skill service",
  },
  {
    match: (p) => p === "services/file-parser" || p.startsWith("services/file-parser/"),
    layer: "upstream-services",
    label: "file-parser",
    role: "Upstream file-parser service",
  },
  {
    match: (p) => p === "packages/contracts",
    layer: "gateway-internal",
    strip: "kernel",
    label: "contracts",
    role: "Operation/module contracts",
  },
  {
    match: (p) => p === "packages/foundation",
    layer: "gateway-internal",
    strip: "kernel",
    label: "foundation",
    role: "Kernel: security, proof, pactium host, storage",
  },
  {
    match: (p) => p === "packages/capabilities",
    layer: "gateway-internal",
    strip: "permissions",
    label: "capabilities",
    role: "Permissions / Operation Permission",
  },
  {
    match: (p) => p === "packages/agents",
    layer: "gateway-internal",
    strip: "adapters",
    label: "agents",
    role: "Agent gateway adapters & workspace",
  },
  {
    match: (p) => p === "plugins/model-gateway",
    layer: "gateway-internal",
    strip: "adapters",
    label: "plugin-model-gateway",
    role: "Registers model-gateway into Core (adapter plugin)",
  },
  {
    match: (p) => p === "packages/protocols",
    layer: "mcp-relay",
    label: "protocols",
    role: "MCP / HTTP / pubsub protocol facades",
  },
  {
    match: (p) => p === "packages/server-runtime",
    layer: "mcp-relay",
    label: "server-runtime",
    role: "Runtime composition & relay host",
  },
  {
    match: (p) => p === "apps/server",
    layer: "mcp-relay",
    label: "apps/server",
    role: "Server process entry (MCP + HTTP)",
  },
  {
    match: (p) => p === "plugins/external-gateway",
    layer: "external-gateways",
    label: "external-gateway",
    role: "Supplement: operator Caddy/Nginx/direct endpoints (not a Meshrix proxy product)",
  },
  {
    match: (p) => p === "packages/ui-console",
    layer: "client-plugins",
    label: "ui-console",
    role: "Reusable console components",
  },
  {
    match: (p) => p === "apps/console",
    layer: "client-plugins",
    label: "apps/console",
    role: "Operator console app",
  },
  {
    match: (p) => p === "plugins/shared-space",
    layer: "client-plugins",
    label: "shared-space",
    role: "Shared-space operator plugin",
  },
  {
    match: (p) => p === "plugins/skill-hub",
    layer: "client-plugins",
    label: "skill-hub-plugin",
    role: "Skill-hub UI / operator plugin",
  },
  {
    match: (p) => p === "plugins/agents/client-adapter-kit",
    layer: "client-plugins",
    label: "client-adapter-kit",
    role: "Shared client-adapter standard (hub)",
    hub: true,
  },
  {
    match: (p) => p.startsWith("plugins/agents/") && p.split("/").length === 3,
    layer: "client-plugins",
    label: null, // derive from basename
    role: "Agent client-side adapter plugin",
  },
];

const GATEWAY_STRIPS = [
  { id: "kernel", title: "Kernel" },
  { id: "permissions", title: "Permissions" },
  { id: "adapters", title: "Adapters" },
];

function toPosix(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function sha256Text(text) {
  return `sha256:${createHash("sha256").update(String(text), "utf8").digest("hex")}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.resolve(ROOT, relPath), "utf8"));
}

function pathExists(abs) {
  try {
    fs.accessSync(abs);
    return true;
  } catch {
    return false;
  }
}

function listDirs(absDir) {
  if (!pathExists(absDir)) return [];
  return fs
    .readdirSync(absDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !EXCLUDED_DIR_NAMES.has(e.name) && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

function workspacePackageDeps(manifest) {
  const all = {
    ...(manifest.dependencies || {}),
    ...(manifest.peerDependencies || {}),
    ...(manifest.optionalDependencies || {}),
  };
  return Object.keys(all)
    .filter((name) => name.startsWith("@meshrix/") || name === "model-gateway-service")
    .sort((a, b) => a.localeCompare(b));
}

function discoverModules() {
  /** @type {Map<string, object>} */
  const byPath = new Map();

  function addModule({ modulePath, packageName, packageJsonRel, pluginId, kind }) {
    const normalized = modulePath.replace(/\\/gu, "/").replace(/\/$/u, "");
    if (byPath.has(normalized)) {
      const existing = byPath.get(normalized);
      if (packageName && !existing.packageName) existing.packageName = packageName;
      if (packageJsonRel && !existing.packageJsonRel) existing.packageJsonRel = packageJsonRel;
      if (pluginId && !existing.pluginId) existing.pluginId = pluginId;
      return;
    }
    const rule = MODULE_RULES.find((r) => r.match(normalized));
    if (!rule) {
      // Skip unknown trees (registry schemas, LICENSE dirs, etc.)
      return;
    }
    const basename = normalized.split("/").pop();
    const label = rule.label || basename;
    byPath.set(normalized, {
      id: normalized,
      path: normalized,
      label,
      role: rule.role,
      layer: rule.layer,
      strip: rule.strip || null,
      hub: Boolean(rule.hub),
      packageName: packageName || null,
      packageJsonRel: packageJsonRel || null,
      pluginId: pluginId || null,
      kind,
      deps: [],
    });
  }

  // packages/*
  for (const name of listDirs(path.join(ROOT, "packages"))) {
    const rel = `packages/${name}`;
    const pj = path.join(ROOT, rel, "package.json");
    if (!pathExists(pj)) continue;
    const manifest = JSON.parse(fs.readFileSync(pj, "utf8"));
    addModule({
      modulePath: rel,
      packageName: manifest.name,
      packageJsonRel: `${rel}/package.json`,
      kind: "package",
    });
  }

  // apps/*
  for (const name of listDirs(path.join(ROOT, "apps"))) {
    const rel = `apps/${name}`;
    const pj = path.join(ROOT, rel, "package.json");
    if (!pathExists(pj)) continue;
    const manifest = JSON.parse(fs.readFileSync(pj, "utf8"));
    addModule({
      modulePath: rel,
      packageName: manifest.name,
      packageJsonRel: `${rel}/package.json`,
      kind: "app",
    });
  }

  // services/* (directory is the module even without package.json)
  for (const name of listDirs(path.join(ROOT, "services"))) {
    const rel = `services/${name}`;
    const pj = path.join(ROOT, rel, "package.json");
    let packageName = null;
    let packageJsonRel = null;
    if (pathExists(pj)) {
      const manifest = JSON.parse(fs.readFileSync(pj, "utf8"));
      packageName = manifest.name;
      packageJsonRel = `${rel}/package.json`;
    }
    addModule({
      modulePath: rel,
      packageName,
      packageJsonRel,
      kind: "service",
    });
  }

  // Top-level plugins with package.json or plugin.json
  for (const name of listDirs(path.join(ROOT, "plugins"))) {
    if (name === "agents" || name === "registry" || name === "schemas") continue;
    const rel = `plugins/${name}`;
    const pj = path.join(ROOT, rel, "package.json");
    const pl = path.join(ROOT, rel, "plugin.json");
    if (!pathExists(pj) && !pathExists(pl)) continue;
    let packageName = null;
    let packageJsonRel = null;
    let pluginId = null;
    if (pathExists(pj)) {
      const manifest = JSON.parse(fs.readFileSync(pj, "utf8"));
      packageName = manifest.name;
      packageJsonRel = `${rel}/package.json`;
    }
    if (pathExists(pl)) {
      const plugin = JSON.parse(fs.readFileSync(pl, "utf8"));
      pluginId = plugin.id || plugin.name || plugin.pluginId || name;
    }
    addModule({
      modulePath: rel,
      packageName,
      packageJsonRel,
      pluginId,
      kind: "plugin",
    });
  }

  // plugins/agents/*
  for (const name of listDirs(path.join(ROOT, "plugins", "agents"))) {
    const rel = `plugins/agents/${name}`;
    const pj = path.join(ROOT, rel, "package.json");
    const pl = path.join(ROOT, rel, "plugin.json");
    if (!pathExists(pj) && !pathExists(pl)) continue;
    let packageName = null;
    let packageJsonRel = null;
    let pluginId = null;
    if (pathExists(pj)) {
      const manifest = JSON.parse(fs.readFileSync(pj, "utf8"));
      packageName = manifest.name;
      packageJsonRel = `${rel}/package.json`;
    }
    if (pathExists(pl)) {
      const plugin = JSON.parse(fs.readFileSync(pl, "utf8"));
      pluginId = plugin.id || plugin.name || plugin.pluginId || name;
    }
    addModule({
      modulePath: rel,
      packageName,
      packageJsonRel,
      pluginId,
      kind: "agent-plugin",
    });
  }

  // Fill package.json dependency names
  for (const mod of byPath.values()) {
    if (!mod.packageJsonRel) continue;
    const manifest = readJson(mod.packageJsonRel);
    mod.deps = workspacePackageDeps(manifest);
    if (!mod.packageName) mod.packageName = manifest.name || null;
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function buildPackageNameIndex(modules) {
  /** @type {Map<string, object>} */
  const byName = new Map();
  for (const mod of modules) {
    if (mod.packageName) byName.set(mod.packageName, mod);
  }
  return byName;
}

function buildEdges(modules, dependencyRules) {
  const byName = buildPackageNameIndex(modules);
  const byPath = new Map(modules.map((m) => [m.path, m]));
  /** @type {Array<{from:string,to:string,kind:string}>} */
  const edges = [];
  const seen = new Set();

  function pushEdge(fromPath, toPath, kind) {
    if (!fromPath || !toPath || fromPath === toPath) return;
    if (!byPath.has(fromPath) || !byPath.has(toPath)) return;
    const key = `${fromPath}->${toPath}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from: fromPath, to: toPath, kind });
  }

  // package.json workspace dependency edges
  for (const mod of modules) {
    for (const depName of mod.deps || []) {
      const target = byName.get(depName);
      if (target) pushEdge(mod.path, target.path, "package.json");
    }
  }

  // dependency-rules.registry.json allowedDependsOn between registered directories
  const ruleLayers = dependencyRules.layers || [];
  const ruleByDir = new Map(
    ruleLayers
      .filter((l) => typeof l.directory === "string" && !l.directory.includes("*"))
      .map((l) => [l.directory.replace(/\\/gu, "/"), l])
  );
  for (const [dir, layer] of ruleByDir) {
    if (!byPath.has(dir)) continue;
    for (const allowedId of layer.allowedDependsOn || []) {
      const targetLayer = ruleLayers.find((l) => l.id === allowedId);
      if (!targetLayer || !targetLayer.directory) continue;
      const targetDir = String(targetLayer.directory).replace(/\\/gu, "/");
      if (targetDir.includes("*")) continue;
      if (byPath.has(targetDir)) {
        pushEdge(dir, targetDir, "dependency-rules");
      }
    }
  }

  return edges.sort((a, b) => {
    const left = `${a.from}\0${a.to}\0${a.kind}`;
    const right = `${b.from}\0${b.to}\0${b.kind}`;
    return left.localeCompare(right);
  });
}

function adjacencyForLayer(modules, edges, layerId) {
  const inLayer = new Set(modules.filter((m) => m.layer === layerId).map((m) => m.path));
  const internal = [];
  const outbound = [];
  for (const edge of edges) {
    if (!inLayer.has(edge.from)) continue;
    const label = `${edge.from.split("/").pop()} → ${edge.to.split("/").pop()} (${edge.kind})`;
    if (inLayer.has(edge.to)) internal.push(label);
    else outbound.push(label);
  }
  return {
    internal: [...new Set(internal)].sort((a, b) => a.localeCompare(b)),
    outbound: [...new Set(outbound)].sort((a, b) => a.localeCompare(b)),
  };
}

function inferLayerShape(modules, edges, layerId) {
  const layerMods = modules.filter((m) => m.layer === layerId);
  if (layerMods.length === 0) return "empty";
  if (layerId === "gateway-internal") return "strips";
  const hubs = layerMods.filter((m) => m.hub);
  const inLayer = new Set(layerMods.map((m) => m.path));
  const internalEdges = edges.filter((e) => inLayer.has(e.from) && inLayer.has(e.to));
  if (hubs.length > 0 && internalEdges.some((e) => hubs.some((h) => e.to === h.path))) {
    return "tree";
  }
  if (internalEdges.length === 0 && layerMods.length > 1) return "parallel";
  if (layerMods.length === 1) return "strip";
  return "parallel";
}

function renderModuleSquare(mod, edges, modules) {
  const inbound = edges.filter((e) => e.to === mod.path).length;
  const outbound = edges.filter((e) => e.from === mod.path).length;
  const hubClass = mod.hub ? " hub" : "";
  const pkg = mod.packageName ? `<div class="pkg">${escapeHtml(mod.packageName)}</div>` : "";
  const plugin = mod.pluginId ? `<div class="pkg">plugin:${escapeHtml(mod.pluginId)}</div>` : "";
  return `<div class="module${hubClass}" title="${escapeHtml(mod.role)}">
  <div class="mod-label">${escapeHtml(mod.label)}</div>
  <div class="mod-path">${escapeHtml(mod.path)}</div>
  ${pkg}${plugin}
  <div class="mod-meta">in:${inbound} out:${outbound}</div>
</div>`;
}

function renderLayerBody(layerDef, modules, edges) {
  const layerMods = modules.filter((m) => m.layer === layerDef.id);
  const shape = inferLayerShape(modules, edges, layerDef.id);
  const adj = adjacencyForLayer(modules, edges, layerDef.id);

  let body = "";
  if (layerDef.id === "gateway-internal") {
    body = GATEWAY_STRIPS.map((strip) => {
      const stripMods = layerMods
        .filter((m) => m.strip === strip.id)
        .sort((a, b) => a.label.localeCompare(b.label));
      const squares = stripMods.map((m) => renderModuleSquare(m, edges, modules)).join("\n");
      return `<div class="strip" data-strip="${escapeHtml(strip.id)}">
  <div class="strip-title">${escapeHtml(strip.title)}</div>
  <div class="modules-row">${squares || '<div class="empty">—</div>'}</div>
</div>`;
    }).join("\n");
  } else if (shape === "tree") {
    const hubs = layerMods.filter((m) => m.hub).sort((a, b) => a.label.localeCompare(b.label));
    const hubPaths = new Set(hubs.map((h) => h.path));
    const dependents = layerMods
      .filter((m) => !hubPaths.has(m.path))
      .sort((a, b) => a.label.localeCompare(b.label));
    // Order dependents L→R; place hub first as standard module many depend on
    const ordered = [...hubs, ...dependents];
    body = `<div class="modules-row tree-shape">${ordered.map((m) => renderModuleSquare(m, edges, modules)).join("\n")}</div>
<p class="shape-note">Shape: tree — agent adapters depend on <code>client-adapter-kit</code> (hub).</p>`;
  } else {
    const ordered = [...layerMods].sort((a, b) => a.label.localeCompare(b.label));
    body = `<div class="modules-row">${ordered.map((m) => renderModuleSquare(m, edges, modules)).join("\n")}</div>
<p class="shape-note">Shape: ${escapeHtml(shape)} — modules left → right from path/label order; edges listed below.</p>`;
  }

  const internalList =
    adj.internal.length > 0
      ? `<ul class="adj">${adj.internal.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`
      : `<p class="adj-empty">No intra-layer package edges.</p>`;
  const outboundList =
    adj.outbound.length > 0
      ? `<ul class="adj">${adj.outbound.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`
      : `<p class="adj-empty">No outbound package edges from this layer.</p>`;

  return `${body}
<div class="adjacency">
  <div class="adj-col"><h4>Intra-layer edges</h4>${internalList}</div>
  <div class="adj-col"><h4>Outbound edges</h4>${outboundList}</div>
</div>`;
}

function buildCanonicalPayload(modules, edges) {
  return {
    schema: DOC_SCHEMA,
    modules: modules.map((m) => ({
      path: m.path,
      label: m.label,
      layer: m.layer,
      strip: m.strip,
      packageName: m.packageName,
      pluginId: m.pluginId,
      deps: m.deps,
      hub: m.hub,
    })),
    edges,
  };
}

function renderHtml({ modules, edges, sourceDigest, sourceInputs }) {
  const counts = Object.fromEntries(
    LAYER_DEFS.map((l) => [l.id, modules.filter((m) => m.layer === l.id).length])
  );
  const layersHtml = LAYER_DEFS.map((layer) => {
    const n = counts[layer.id];
    return `<section class="layer-block" data-layer="${escapeHtml(layer.id)}" style="--layer-accent:${layer.color}">
  <header class="layer-header">
    <h2>${escapeHtml(layer.title)}</h2>
    <p class="layer-sub">${escapeHtml(layer.subtitle)}</p>
    <p class="layer-count">${n} module${n === 1 ? "" : "s"}</p>
  </header>
  <div class="layer-body">
${renderLayerBody(layer, modules, edges)}
  </div>
</section>`;
  }).join("\n");

  const legend = `<section class="legend band">
  <h2>Layer assignment heuristics</h2>
  <ol>
    <li><strong>Upstream services</strong> — <code>services/*</code> directories that register into the gateway (model-gateway, skill-hub, file-parser).</li>
    <li><strong>Gateway-internal</strong> — <code>packages/contracts</code> + <code>foundation</code> (kernel), <code>capabilities</code> (permissions), <code>agents</code> + <code>plugins/model-gateway</code> (adapters). <code>plugins/model-gateway</code> is a Core adapter plugin, not the upstream service itself.</li>
    <li><strong>MCP + relay</strong> — <code>packages/protocols</code>, <code>packages/server-runtime</code>, <code>apps/server</code>.</li>
    <li><strong>External gateways</strong> — <code>plugins/external-gateway</code> only; labeled as a supplement for operator-provided Caddy/Nginx/direct endpoints (Meshrix does not ship Nginx/Caddy as product modules).</li>
    <li><strong>Client-side plugins / console</strong> — <code>plugins/agents/*</code>, <code>plugins/shared-space</code>, <code>plugins/skill-hub</code>, <code>packages/ui-console</code>, <code>apps/console</code>.</li>
  </ol>
  <p>Modules and edges are scanned from package manifests and <code>${escapeHtml(DEPENDENCY_RULES_REL)}</code>. No invented modules. Closest-honest layer wins when a path is ambiguous.</p>
</section>`;

  const edgeTableRows = edges
    .map(
      (e) =>
        `<tr><td>${escapeHtml(e.from)}</td><td>${escapeHtml(e.to)}</td><td>${escapeHtml(e.kind)}</td></tr>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meshrix.js Layered Architecture</title>
<!-- layered-architecture-digest: ${sourceDigest} -->
<!-- generator: ${GENERATOR_REL} -->
<!-- schema: ${DOC_SCHEMA} -->
<style>
  :root {
    color-scheme: light;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --bg: #f3f5f8;
    --ink: #182026;
    --muted: #506070;
    --line: #c9d2dc;
    --card: #ffffff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; color: var(--ink); background: var(--bg); }
  main { max-width: 1480px; margin: 0 auto; padding: 28px 20px 64px; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  h2 { font-size: 18px; margin: 0 0 6px; }
  h3, h4 { font-size: 14px; margin: 0 0 8px; }
  p { line-height: 1.55; margin: 0 0 10px; }
  .meta { color: var(--muted); font-size: 13px; }
  code { background: #edf1f6; border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .band { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; margin: 16px 0; }
  .canvas {
    display: flex;
    flex-direction: column;
    gap: 18px;
    margin-top: 18px;
    padding: 18px;
    background: linear-gradient(180deg, #e8eef6 0%, #f7f8fa 100%);
    border: 1px solid var(--line);
    border-radius: 12px;
    min-width: 1100px;
  }
  .layer-block {
    background: var(--card);
    border: 2px solid var(--layer-accent, #2f6fed);
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(24,32,38,0.04);
  }
  .layer-header {
    padding: 12px 16px;
    background: color-mix(in srgb, var(--layer-accent) 12%, white);
    border-bottom: 1px solid color-mix(in srgb, var(--layer-accent) 35%, var(--line));
  }
  .layer-sub { color: var(--muted); font-size: 13px; margin: 0 0 4px; }
  .layer-count { font-size: 12px; color: var(--muted); margin: 0; }
  .layer-body { padding: 14px 16px 16px; }
  .strip {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 12px;
    padding: 10px;
    border: 1px dashed var(--line);
    border-radius: 8px;
    background: #fafbfd;
  }
  .strip-title {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .modules-row {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    gap: 10px;
    align-items: stretch;
  }
  .module {
    flex: 0 0 auto;
    width: 168px;
    min-height: 112px;
    padding: 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: #fff;
    border-top: 3px solid var(--layer-accent, #2f6fed);
  }
  .module.hub {
    width: 188px;
    border-top-color: #182026;
    background: #f7fafc;
    box-shadow: inset 0 0 0 1px #18202622;
  }
  .mod-label { font-weight: 700; font-size: 13px; margin-bottom: 4px; }
  .mod-path, .pkg, .mod-meta { font-size: 11px; color: var(--muted); line-height: 1.35; word-break: break-all; }
  .pkg { margin-top: 4px; }
  .mod-meta { margin-top: 8px; font-variant-numeric: tabular-nums; }
  .shape-note { font-size: 12px; color: var(--muted); margin: 8px 0 0; }
  .adjacency {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid var(--line);
  }
  .adj { margin: 0; padding-left: 18px; font-size: 12px; color: var(--muted); }
  .adj li { margin: 2px 0; }
  .adj-empty { font-size: 12px; color: var(--muted); margin: 0; }
  .empty { color: var(--muted); font-size: 12px; padding: 8px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid var(--line); font-size: 12px; }
  th, td { text-align: left; border-bottom: 1px solid #e5e9ef; padding: 8px 10px; vertical-align: top; }
  th { background: #edf1f6; }
  footer.gen-footer {
    margin-top: 28px;
    padding: 14px 16px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: #fff;
    font-size: 12px;
    color: var(--muted);
  }
  footer.gen-footer code { font-size: 11px; }
  .scroll-hint { overflow-x: auto; }
  ol { margin: 8px 0 0; padding-left: 20px; }
  li { margin: 4px 0; line-height: 1.45; }
</style>
</head>
<body>
<main>
  <h1>Meshrix.js Layered Architecture</h1>
  <p class="meta">Auto-generated nested-rectangle view of packages, services, apps, and plugins. Not a hand-drawn diagram. Companion to <a href="./MESHRIX-SYSTEM-ARCHITECTURE.html">MESHRIX-SYSTEM-ARCHITECTURE.html</a> (contracts manifest projection).</p>
  <p class="meta">Schema <code>${escapeHtml(DOC_SCHEMA)}</code> · digest <code>${escapeHtml(sourceDigest)}</code> · generatedAt <code>${escapeHtml(GENERATED_AT)}</code> (deterministic)</p>

  <div class="scroll-hint">
    <div class="canvas" role="img" aria-label="Meshrix layered architecture as nested rectangles">
${layersHtml}
    </div>
  </div>

${legend}

  <section class="band">
    <h2>All dependency edges</h2>
    <p class="meta">Union of workspace <code>package.json</code> dependency edges and concrete <code>allowedDependsOn</code> links from <code>${escapeHtml(DEPENDENCY_RULES_REL)}</code>.</p>
    <table>
      <thead><tr><th>From</th><th>To</th><th>Kind</th></tr></thead>
      <tbody>
${edgeTableRows || '<tr><td colspan="3">No edges discovered.</td></tr>'}
      </tbody>
    </table>
  </section>

  <footer class="gen-footer">
    <div><strong>Generator:</strong> <code>${escapeHtml(GENERATOR_REL)}</code></div>
    <div><strong>Output:</strong> <code>${escapeHtml(OUT_REL)}</code></div>
    <div><strong>Generated at:</strong> <code>${escapeHtml(GENERATED_AT)}</code> (fixed for deterministic regeneration; content-addressed by digest)</div>
    <div><strong>Source digest:</strong> <code>${escapeHtml(sourceDigest)}</code></div>
    <div><strong>Source inputs:</strong></div>
    <ul>${sourceInputs.map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join("")}</ul>
    <div>Regenerate: <code>npm run docs:generate:layered-architecture</code> · Check: <code>npm run docs:generate:layered-architecture -- --check</code></div>
  </footer>
</main>
</body>
</html>
`;
}

function collectSourceInputs(modules) {
  const inputs = new Set([DEPENDENCY_RULES_REL, GENERATOR_REL]);
  for (const mod of modules) {
    inputs.add(mod.path);
    if (mod.packageJsonRel) inputs.add(mod.packageJsonRel);
    const pluginJson = path.join(ROOT, mod.path, "plugin.json");
    if (pathExists(pluginJson)) inputs.add(toPosix(pluginJson));
  }
  return [...inputs].sort((a, b) => a.localeCompare(b));
}

function main() {
  const check = process.argv.includes("--check");
  const dependencyRules = readJson(DEPENDENCY_RULES_REL);
  const modules = discoverModules();
  if (modules.length === 0) {
    console.error("No modules discovered; refusing to write empty diagram.");
    process.exitCode = 1;
    return;
  }
  const edges = buildEdges(modules, dependencyRules);
  const payload = buildCanonicalPayload(modules, edges);
  const sourceDigest = sha256Text(JSON.stringify(payload));
  const sourceInputs = collectSourceInputs(modules);
  const html = renderHtml({ modules, edges, sourceDigest, sourceInputs });

  if (check) {
    if (!pathExists(OUT_PATH)) {
      console.error(`MISSING: ${OUT_REL}`);
      console.error(`Run: node ${GENERATOR_REL}`);
      process.exitCode = 1;
      return;
    }
    const current = fs.readFileSync(OUT_PATH, "utf8");
    if (current !== html) {
      console.error(`STALE: ${OUT_REL}`);
      console.error(`Run: node ${GENERATOR_REL}`);
      process.exitCode = 1;
      return;
    }
    console.log(`OK: ${OUT_REL} (${sourceDigest})`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, html, "utf8");
  const counts = LAYER_DEFS.map(
    (l) => `${l.id}=${modules.filter((m) => m.layer === l.id).length}`
  ).join(" ");
  console.log(`Generated: ${OUT_REL}`);
  console.log(`digest=${sourceDigest}`);
  console.log(`modules=${modules.length} edges=${edges.length} ${counts}`);
}

main();
