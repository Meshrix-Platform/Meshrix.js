import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const ANALYZER_ID = "typescript-top-level-declaration-components";
const LIMITATIONS = Object.freeze([
  "The advisory cannot infer capability responsibility, ownership intent, or independent reasons to change.",
  "A split candidate is a review prompt, not proof that a file must be split or that extraction preserves behavior.",
  "A mechanical-split caution is coupling evidence, not proof that a file cannot be redesigned and split.",
  "Dynamic registration, reflection, dependency injection, lexical shadowing, and property mutation are modeled conservatively or incompletely.",
  "Vue template bindings are not modeled; Vue single-file components are reported as unsupported instead of being guessed.",
  "The advisory does not measure runtime latency, memory, scheduling, or change frequency."
]);

let typeScriptPromise;

function toPosix(filePath) {
  return String(filePath || "").split(path.sep).join("/");
}

async function loadTypeScript() {
  if (!typeScriptPromise) {
    typeScriptPromise = import("typescript")
      .then((loaded) => loaded.default || loaded)
      .catch(() => null);
  }
  return typeScriptPromise;
}

function ignoredPath(relativePath, ignoredPathParts) {
  const wrapped = `/${toPosix(relativePath)}/`;
  return ignoredPathParts.some((part) => wrapped.includes(String(part || "")));
}

async function walkSourceFiles({
  repoRoot,
  relativeRoot,
  extensions,
  ignoredPathParts,
  excludedPaths
}) {
  const entries = await fs.readdir(path.join(repoRoot, relativeRoot), { withFileTypes: true }).catch(() => []);
  const files = [];
  let skippedProjectionFileCount = 0;
  for (const entry of entries) {
    const relativePath = toPosix(path.join(relativeRoot, entry.name));
    if (ignoredPath(relativePath, ignoredPathParts)) continue;
    if (entry.isDirectory()) {
      const nested = await walkSourceFiles({
        repoRoot,
        relativeRoot: relativePath,
        extensions,
        ignoredPathParts,
        excludedPaths
      });
      files.push(...nested.files);
      skippedProjectionFileCount += nested.skippedProjectionFileCount;
      continue;
    }
    if (!entry.isFile() || !extensions.has(path.extname(entry.name))) continue;
    if (excludedPaths.has(relativePath)) {
      skippedProjectionFileCount += 1;
      continue;
    }
    files.push(relativePath);
  }
  return { files, skippedProjectionFileCount };
}

async function collectSourceFiles({
  repoRoot,
  analysisRoots,
  extensions,
  ignoredPathParts,
  excludedPaths
}) {
  const files = [];
  let skippedProjectionFileCount = 0;
  for (const relativeRoot of analysisRoots) {
    const result = await walkSourceFiles({
      repoRoot,
      relativeRoot,
      extensions,
      ignoredPathParts,
      excludedPaths
    });
    files.push(...result.files);
    skippedProjectionFileCount += result.skippedProjectionFileCount;
  }
  return {
    files: files.sort((left, right) => left.localeCompare(right)),
    skippedProjectionFileCount
  };
}

function scriptKindForFile(ts, file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".ts") return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function nodeModifiers(ts, node) {
  return ts.canHaveModifiers(node) ? ts.getModifiers(node) || [] : [];
}

function nodeDecorators(ts, node) {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) || [] : [];
}

function hasModifier(ts, node, modifierKind) {
  return nodeModifiers(ts, node).some((modifier) => modifier.kind === modifierKind);
}

function collectBindingNames(ts, name, names = []) {
  if (ts.isIdentifier(name)) {
    names.push(name.text);
    return names;
  }
  for (const element of name.elements || []) {
    if (ts.isOmittedExpression(element)) continue;
    collectBindingNames(ts, element.name, names);
  }
  return names;
}

function initializerContainsModuleEffect(ts, initializer) {
  let effect = false;
  function visit(node, isRoot = false) {
    if (effect) return;
    if (!isRoot && (ts.isFunctionLike(node) || ts.isClassExpression(node))) return;
    if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node) ||
      ts.isTaggedTemplateExpression(node)
    ) {
      effect = true;
      return;
    }
    ts.forEachChild(node, (child) => visit(child, false));
  }
  visit(initializer, true);
  return effect;
}

function declarationUnit(ts, statement, id, hazards) {
  const exported = hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword) ||
    hasModifier(ts, statement, ts.SyntaxKind.DefaultKeyword);
  const decorators = nodeDecorators(ts, statement);
  if (decorators.length > 0) hazards.add("decorated_declaration");

  if (ts.isFunctionDeclaration(statement)) {
    return {
      id,
      node: statement,
      names: statement.name ? [statement.name.text] : [],
      kind: "function",
      behavior: true,
      exported,
      mutableBinding: false
    };
  }
  if (ts.isClassDeclaration(statement)) {
    return {
      id,
      node: statement,
      names: statement.name ? [statement.name.text] : [],
      kind: "class",
      behavior: true,
      exported,
      mutableBinding: false
    };
  }
  if (ts.isVariableStatement(statement)) {
    const names = [];
    let behavior = false;
    for (const declaration of statement.declarationList.declarations) {
      collectBindingNames(ts, declaration.name, names);
      if (
        declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
      ) {
        behavior = true;
      } else if (declaration.initializer && initializerContainsModuleEffect(ts, declaration.initializer)) {
        hazards.add("module_initialization_effect");
      }
    }
    return {
      id,
      node: statement,
      names: [...new Set(names)],
      kind: behavior ? "function-variable" : "variable",
      behavior,
      exported,
      mutableBinding: (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    };
  }
  if (ts.isEnumDeclaration(statement)) {
    return {
      id,
      node: statement,
      names: [statement.name.text],
      kind: "enum",
      behavior: false,
      exported,
      mutableBinding: false
    };
  }
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
    return {
      id,
      node: statement,
      names: [statement.name.text],
      kind: ts.isInterfaceDeclaration(statement) ? "interface" : "type",
      behavior: false,
      exported,
      mutableBinding: false
    };
  }
  if (ts.isModuleDeclaration(statement)) {
    hazards.add("module_or_namespace_declaration");
    return {
      id,
      node: statement,
      names: ts.isIdentifier(statement.name) ? [statement.name.text] : [],
      kind: "module",
      behavior: false,
      exported,
      mutableBinding: false
    };
  }
  if (ts.isExportAssignment(statement)) {
    if (
      !ts.isIdentifier(statement.expression) &&
      !ts.isArrowFunction(statement.expression) &&
      !ts.isFunctionExpression(statement.expression) &&
      !ts.isClassExpression(statement.expression)
    ) {
      hazards.add("module_initialization_effect");
    }
    return {
      id,
      node: statement.expression,
      names: [],
      kind: "default-export",
      behavior: ts.isArrowFunction(statement.expression) ||
        ts.isFunctionExpression(statement.expression) ||
        ts.isClassExpression(statement.expression),
      exported: true,
      mutableBinding: false
    };
  }
  return null;
}

function explicitLocalExportNames(ts, sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        continue;
      }
      if (statement.moduleSpecifier || !ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        names.add((element.propertyName || element.name).text);
      }
      continue;
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      names.add(statement.expression.text);
    }
  }
  return names;
}

function isNonReferenceIdentifier(ts, node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)) return true;
  if (ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent)) return true;
  if (
    (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) &&
    parent.label === node
  ) {
    return true;
  }
  if (parent.name === node) return true;
  return false;
}

function isWriteReference(ts, node) {
  let current = node;
  while (
    current.parent &&
    ((ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current) ||
      (ts.isElementAccessExpression(current.parent) && current.parent.expression === current))
  ) {
    current = current.parent;
  }
  const parent = current.parent;
  if (!parent) return false;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === current &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return true;
  }
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    parent.operand === current &&
    [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator)
  ) {
    return true;
  }
  return ts.isDeleteExpression(parent) && parent.expression === current;
}

function scanSemanticHazards(ts, sourceFile, hazards) {
  function visit(node) {
    if (ts.isWithStatement(node)) hazards.add("with_statement");
    if (ts.isClassStaticBlockDeclaration?.(node)) hazards.add("class_static_initialization");
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0]))
    ) {
      hazards.add("non_literal_dynamic_import");
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "eval"
    ) {
      hazards.add("reflection_or_eval");
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function connectedComponents(units, adjacency) {
  const visited = new Set();
  const components = [];
  for (const unit of units) {
    if (visited.has(unit.id)) continue;
    const component = [];
    const stack = [unit.id];
    visited.add(unit.id);
    while (stack.length > 0) {
      const current = stack.pop();
      component.push(current);
      for (const neighbor of adjacency[current] || []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        stack.push(neighbor);
      }
    }
    component.sort((left, right) => left - right);
    components.push(component);
  }
  return components;
}

function unitDisplayNames(unit) {
  return unit.names.length > 0 ? unit.names : ["default"];
}

function componentEvidence(component, unitsById) {
  const units = component.map((id) => unitsById.get(id));
  return {
    declarations: [...new Set(units.flatMap(unitDisplayNames))].sort(),
    exportedDeclarations: [...new Set(units.filter((unit) => unit.exported).flatMap(unitDisplayNames))].sort(),
    declarationKinds: [...new Set(units.map((unit) => unit.kind))].sort()
  };
}

function analyzeParsedSource(ts, sourceFile, file) {
  const hazards = new Set();
  const units = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      ts.isEmptyStatement(statement)
    ) {
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) hazards.add("star_reexport");
      continue;
    }
    const unit = declarationUnit(ts, statement, units.length, hazards);
    if (unit) {
      units.push(unit);
    } else {
      hazards.add("top_level_execution");
    }
  }
  scanSemanticHazards(ts, sourceFile, hazards);

  const explicitExports = explicitLocalExportNames(ts, sourceFile);
  for (const unit of units) {
    if (unit.names.some((name) => explicitExports.has(name))) unit.exported = true;
  }

  const symbolToUnits = new Map();
  for (const unit of units) {
    for (const name of unit.names) {
      const entries = symbolToUnits.get(name) || [];
      entries.push(unit.id);
      symbolToUnits.set(name, entries);
    }
  }

  const adjacency = units.map(() => new Set());
  const referencesBySource = units.map(() => new Set());
  const writesByTarget = units.map(() => new Set());
  function connect(left, right) {
    if (left === right) return;
    adjacency[left].add(right);
    adjacency[right].add(left);
  }
  for (const ids of symbolToUnits.values()) {
    if (ids.length < 2) continue;
    hazards.add("merged_declarations");
    for (let index = 1; index < ids.length; index += 1) connect(ids[0], ids[index]);
  }
  for (const unit of units) {
    function visit(node) {
      if (ts.isIdentifier(node) && !isNonReferenceIdentifier(ts, node)) {
        for (const target of symbolToUnits.get(node.text) || []) {
          if (target === unit.id) continue;
          referencesBySource[unit.id].add(target);
          connect(unit.id, target);
          if (isWriteReference(ts, node)) writesByTarget[target].add(unit.id);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(unit.node);
  }

  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const components = connectedComponents(units, adjacency);
  const exportedBehaviorUnits = units.filter((unit) => unit.exported && unit.behavior);
  const publicBehaviorComponents = components.filter((component) =>
    component.some((id) => unitsById.get(id).exported && unitsById.get(id).behavior)
  );
  const sharedMutableState = units
    .filter((unit) => unit.kind === "variable")
    .map((unit) => {
      const consumers = units.filter((candidate) =>
        candidate.behavior && referencesBySource[candidate.id].has(unit.id)
      );
      const observedWrite = writesByTarget[unit.id].size > 0;
      if ((!unit.mutableBinding && !observedWrite) || consumers.length < 2) return null;
      return {
        declarations: unitDisplayNames(unit).sort(),
        consumerCount: consumers.length,
        observedWrite
      };
    })
    .filter(Boolean);

  const candidate = publicBehaviorComponents.length >= 2 && hazards.size === 0 && sharedMutableState.length === 0;
  const cautionReasons = new Set();
  if (sharedMutableState.length > 0) cautionReasons.add("shared_mutable_state");
  if (exportedBehaviorUnits.length >= 2 && publicBehaviorComponents.length === 1) {
    cautionReasons.add("connected_exported_behavior");
  }
  if (exportedBehaviorUnits.length >= 2) {
    for (const hazard of hazards) cautionReasons.add(hazard);
  }

  const baseEvidence = {
    topLevelDeclarationCount: units.length,
    exportedBehaviorDeclarationCount: exportedBehaviorUnits.length,
    declarationComponentCount: components.length,
    exportedBehaviorComponentCount: publicBehaviorComponents.length
  };
  if (candidate) {
    return {
      file,
      classification: "split-candidate",
      finding: {
        code: "independent_exported_behavior_components",
        severity: "advisory",
        releaseBlocking: false,
        file,
        evidence: {
          ...baseEvidence,
          components: publicBehaviorComponents.map((component) => componentEvidence(component, unitsById))
        }
      }
    };
  }
  if (cautionReasons.size > 0) {
    return {
      file,
      classification: "mechanical-split-caution",
      finding: {
        code: "mechanical_split_requires_design",
        severity: "advisory",
        releaseBlocking: false,
        file,
        reasons: [...cautionReasons].sort(),
        evidence: {
          ...baseEvidence,
          sharedMutableState
        }
      }
    };
  }
  return {
    file,
    classification: "no-structural-signal",
    finding: null
  };
}

export async function analyzeSourceText({ source, file = "source.ts" } = {}) {
  const ts = await loadTypeScript();
  if (!ts) return { file, classification: "unsupported", reason: "typescript_compiler_api_unavailable" };
  if (path.extname(file).toLowerCase() === ".vue") {
    return { file, classification: "unsupported", reason: "vue_template_bindings_not_modeled" };
  }
  const sourceFile = ts.createSourceFile(
    file,
    String(source || ""),
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(ts, file)
  );
  const diagnosticCodes = [...new Set((sourceFile.parseDiagnostics || []).map((diagnostic) => diagnostic.code))].sort();
  if (diagnosticCodes.length > 0) {
    return { file, classification: "parse-failure", diagnosticCodes };
  }
  return analyzeParsedSource(ts, sourceFile, file);
}

export async function verifySourceOrganizationAstAdvisoryContract() {
  const ts = await loadTypeScript();
  if (!ts) return { passed: null, skipped: true, reason: "typescript_compiler_api_unavailable" };
  const independent = await analyzeSourceText({
    file: "fixtures/independent-components.ts",
    source: "export function alpha() { return 1; }\nexport const beta = () => 2;\n"
  });
  assert.equal(independent.classification, "split-candidate");

  const sharedState = await analyzeSourceText({
    file: "fixtures/shared-state.ts",
    source: "let state = 0;\nexport function read() { return state; }\nexport function write() { state += 1; }\n"
  });
  assert.equal(sharedState.classification, "mechanical-split-caution");
  assert.ok(sharedState.finding.reasons.includes("shared_mutable_state"));

  const initialized = await analyzeSourceText({
    file: "fixtures/module-initialization.ts",
    source: "export function left() { return 1; }\nexport function right() { return 2; }\nregister(left, right);\n"
  });
  assert.equal(initialized.classification, "mechanical-split-caution");
  assert.ok(initialized.finding.reasons.includes("top_level_execution"));

  const vue = await analyzeSourceText({
    file: "fixtures/component.vue",
    source: "<script setup lang=\"ts\">const value = 1;</script><template>{{ value }}</template>"
  });
  assert.deepEqual(vue, {
    file: "fixtures/component.vue",
    classification: "unsupported",
    reason: "vue_template_bindings_not_modeled"
  });

  return { passed: true, skipped: false, caseCount: 4 };
}

export async function analyzeSourceOrganization({
  repoRoot,
  analysisRoots = [],
  extensions = [],
  ignoredPathParts = [],
  excludedPaths = []
} = {}) {
  const startedAt = Date.now();
  const collected = await collectSourceFiles({
    repoRoot,
    analysisRoots,
    extensions: new Set(extensions),
    ignoredPathParts,
    excludedPaths: new Set(excludedPaths)
  });
  const ts = await loadTypeScript();
  const splitCandidates = [];
  const mechanicalSplitCautions = [];
  const parseFailures = [];
  const unsupportedByReason = new Map();
  let analyzedFileCount = 0;
  let noStructuralSignalCount = 0;

  function recordUnsupported(reason) {
    unsupportedByReason.set(reason, (unsupportedByReason.get(reason) || 0) + 1);
  }

  if (!ts) {
    recordUnsupported("typescript_compiler_api_unavailable");
    unsupportedByReason.set("typescript_compiler_api_unavailable", collected.files.length);
  } else {
    for (const file of collected.files) {
      if (path.extname(file).toLowerCase() === ".vue") {
        recordUnsupported("vue_template_bindings_not_modeled");
        continue;
      }
      let source;
      try {
        source = await fs.readFile(path.join(repoRoot, file), "utf8");
      } catch (error) {
        parseFailures.push({
          file,
          code: error?.code === "ENOENT" ? "source_missing" : "source_unreadable"
        });
        continue;
      }
      const result = await analyzeSourceText({ source, file });
      if (result.classification === "parse-failure") {
        parseFailures.push({ file, code: "syntax_parse_failure", diagnosticCodes: result.diagnosticCodes });
        continue;
      }
      if (result.classification === "unsupported") {
        recordUnsupported(result.reason);
        continue;
      }
      analyzedFileCount += 1;
      if (result.classification === "split-candidate") splitCandidates.push(result.finding);
      else if (result.classification === "mechanical-split-caution") mechanicalSplitCautions.push(result.finding);
      else noStructuralSignalCount += 1;
    }
  }

  splitCandidates.sort((left, right) => left.file.localeCompare(right.file));
  mechanicalSplitCautions.sort((left, right) => left.file.localeCompare(right.file));
  parseFailures.sort((left, right) => left.file.localeCompare(right.file));
  const unsupportedFileCount = [...unsupportedByReason.values()].reduce((sum, count) => sum + count, 0);
  const selfTest = await verifySourceOrganizationAstAdvisoryContract();
  return {
    mode: "advisory",
    releaseBlocking: false,
    status: ts ? "completed" : "unavailable",
    engine: {
      id: "typescript-compiler-api",
      version: ts?.version || "unavailable"
    },
    algorithm: {
      id: ANALYZER_ID,
      unit: "top-level-declaration",
      couplingEdge: "local-identifier-reference-or-shared-state",
      partition: "undirected-connected-components",
      complexity: "O(ast_nodes + local_reference_edges)"
    },
    limitations: [...LIMITATIONS],
    selfTest,
    summary: {
      discoveredFileCount: collected.files.length,
      analyzedFileCount,
      unsupportedFileCount,
      parseFailureCount: parseFailures.length,
      skippedProjectionFileCount: collected.skippedProjectionFileCount,
      splitCandidateCount: splitCandidates.length,
      mechanicalSplitCautionCount: mechanicalSplitCautions.length,
      noStructuralSignalCount,
      durationMs: Date.now() - startedAt
    },
    unsupportedByReason: Object.fromEntries([...unsupportedByReason.entries()].sort(([left], [right]) => left.localeCompare(right))),
    splitCandidates,
    mechanicalSplitCautions,
    parseFailures
  };
}
