import {
  CLOSED_EMPTY_JSON_OBJECT_SCHEMA,
  compileClosedJsonSchema
} from "@meshrix/foundation/security/closed-json-schema";

const METADATA_KEYWORDS: any = new Set<any>([
  "description",
  "title",
  "default",
  "$comment",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly"
]);
const UNSAFE_KEYS: any = new Set<any>(["__proto__", "constructor", "prototype"]);
const MAX_DEPTH: any = 8;
const MAX_NODES: any = 512;
const SUPPORTED_SCHEMA_DIALECTS: any = new Set<any>([
  "https://json-schema.org/draft/2020-12/schema",
  "https://json-schema.org/draft/2019-09/schema"
]);

function isPlainObject(value?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: any = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function schemaError(label?: any, path?: any, reason?: any) : any {
  return Object.assign(new TypeError(`${label} ${path} ${reason}`), {
    code: "upstream_tool_schema_invalid"
  });
}

function ownEntries(value?: any, label?: any, path?: any) : any {
  const entries: any[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw schemaError(label, path, "contains an unsupported symbol key.");
    }
    if (UNSAFE_KEYS.has(key)) {
      throw schemaError(label, path, "contains a prototype-mutating key.");
    }
    const descriptor: any = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw schemaError(label, path, "must contain only enumerable data properties.");
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function definitionName(value?: any, label?: any, path?: any) : any {
  const name: any = String(value ?? "");
  if (!name || UNSAFE_KEYS.has(name) || name.includes("#")) {
    throw schemaError(label, path, "contains an invalid local definition name.");
  }
  return name;
}

function decodeJsonPointerToken(token?: any) : any {
  return String(token ?? "").replace(/~1/g, "/").replace(/~0/g, "~");
}

function parseLocalRef(ref?: any, label?: any, path?: any) : any {
  if (typeof ref !== "string") {
    throw schemaError(label, path, "uses a non-string $ref.");
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref) || ref.startsWith("//") || !ref.startsWith("#/")) {
    throw schemaError(label, path, "must not use a remote or non-local $ref.");
  }
  const tokens: any[] = ref.slice(2).split("/").map(decodeJsonPointerToken);
  if (tokens.length < 2 || tokens.some((token?: any) : any => token === "")) {
    throw schemaError(label, path, "must use a local #/$defs or #/definitions $ref.");
  }
  const container: any = tokens[0];
  if (container !== "$defs" && container !== "definitions") {
    throw schemaError(label, path, "must use a local #/$defs or #/definitions $ref.");
  }
  const name: any = definitionName(tokens[1], label, path);
  return { container, name, segments: tokens.slice(2) };
}

function collectDefinitions(root?: any, label?: any) : any {
  const defs: any = new Map<any, any>();
  for (const container of ["$defs", "definitions"]) {
    if (!Object.hasOwn(root, container)) continue;
    if (!isPlainObject(root[container])) {
      throw schemaError(label, `$.${container}`, "must be a plain object.");
    }
    for (const [name, schema] of ownEntries(root[container], label, `$.${container}`)) {
      defs.set(`${container}/${definitionName(name, label, `$.${container}`)}`, schema);
    }
  }
  return defs;
}

function resolveLocalRef(ref?: any, defs?: any, label?: any, path?: any) : any {
  const pointer: any = parseLocalRef(ref, label, path);
  let resolved: any = defs.get(`${pointer.container}/${pointer.name}`);
  if (!resolved) {
    throw schemaError(label, path, "references an unknown local definition.");
  }
  for (const segment of pointer.segments) {
    if (UNSAFE_KEYS.has(segment) || !isPlainObject(resolved) || !Object.hasOwn(resolved, segment)) {
      throw schemaError(label, path, "references an unknown local definition.");
    }
    resolved = resolved[segment];
  }
  return resolved;
}

function assertSupportedDialect(source?: any, label?: any, path?: any) : any {
  if (!Object.hasOwn(source, "$schema")) return;
  const dialect: any = source.$schema;
  if (typeof dialect !== "string" || !SUPPORTED_SCHEMA_DIALECTS.has(dialect)) {
    throw schemaError(label, `${path}.$schema`, "uses an unsupported JSON Schema dialect.");
  }
}

function projectPublicNode(source?: any, defs?: any, label?: any, path?: any, depth?: any, active?: any, nodes?: any) : any {
  if (depth > MAX_DEPTH) {
    throw schemaError(label, path, "exceeds the supported nesting depth.");
  }
  if (!isPlainObject(source)) {
    throw schemaError(label, path, "must be a plain object.");
  }
  if (active.has(source)) {
    throw schemaError(label, path, "must not contain cycles.");
  }
  nodes.count += 1;
  if (nodes.count > MAX_NODES) {
    throw schemaError(label, path, "contains too many schema nodes.");
  }
  assertSupportedDialect(source, label, path);
  if (Object.hasOwn(source, "$ref")) {
    const referenced: any = projectPublicNode(
      resolveLocalRef(source.$ref, defs, label, `${path}.$ref`),
      defs,
      label,
      path,
      depth + 1,
      new Set<any>([...active, source]),
      nodes
    );
    const siblings: Record<string, any> = {};
    for (const [key, value] of ownEntries(source, label, path)) {
      if (key === "$ref" || key === "$defs" || key === "definitions") continue;
      siblings[key] = value;
    }
    if (Object.keys(siblings).length === 0) {
      return referenced;
    }
    const siblingSchema: any = projectPublicNode(
      siblings,
      defs,
      label,
      path,
      depth + 1,
      new Set<any>([...active, source]),
      nodes
    );
    return {
      allOf: [referenced, siblingSchema]
    };
  }
  active.add(source);
  try {
    const output: Record<string, any> = {};
    for (const [key, value] of ownEntries(source, label, path)) {
      if (key === "$defs" || key === "definitions") {
        continue;
      }
      if (key === "$schema" || METADATA_KEYWORDS.has(key)) {
        output[key] = value;
        continue;
      }
      if (key === "properties" || key === "patternProperties") {
        if (!isPlainObject(value)) {
          throw schemaError(label, `${path}.${key}`, "must be a plain object.");
        }
        const children: Record<string, any> = {};
        for (const [childKey, child] of ownEntries(value, label, `${path}.${key}`)) {
          children[childKey] = projectPublicNode(child, defs, label, `${path}.${key}.${childKey}`, depth + 1, active, nodes);
        }
        output[key] = children;
        continue;
      }
      if (Array.isArray(value) && ["allOf", "anyOf", "oneOf"].includes(key)) {
        output[key] = value.map((branch?: any, index?: any) : any =>
          projectPublicNode(branch, defs, label, `${path}.${key}[${index}]`, depth + 1, active, nodes));
        continue;
      }
      if (key === "items" || key === "not" || key === "additionalProperties" || key === "additionalItems") {
        output[key] = isPlainObject(value)
          ? projectPublicNode(value, defs, label, `${path}.${key}`, depth + 1, active, nodes)
          : value;
        continue;
      }
      output[key] = value;
    }
    return output;
  } finally {
    active.delete(source);
  }
}

function stripMetadata(node?: any) : any {
  if (!isPlainObject(node)) return node;
  const output: Record<string, any> = {};
  for (const [key, value] of Object.entries(node) as [string, any][]) {
    if (METADATA_KEYWORDS.has(key) || key === "$schema") continue;
    if (key === "properties" && isPlainObject(value)) {
      output[key] = Object.fromEntries(
        Object.entries(value).map(([childKey, child]: any[]) : any => [childKey, stripMetadata(child)])
      );
      continue;
    }
    if (Array.isArray(value) && ["allOf", "anyOf", "oneOf"].includes(key)) {
      output[key] = value.map(stripMetadata);
      continue;
    }
    if ((key === "items" || key === "not" || key === "additionalProperties" || key === "additionalItems") && isPlainObject(value)) {
      output[key] = stripMetadata(value);
      continue;
    }
    output[key] = value;
  }
  return output;
}

export function compileMcpToolJsonSchema(
  schema?: any,
  { label = "Upstream MCP tool schema", requireTopLevelObject = true }: Record<string, any> = {}
) : any {
  if (schema === undefined) {
    return {
      schema: CLOSED_EMPTY_JSON_OBJECT_SCHEMA,
      validate: compileClosedJsonSchema(CLOSED_EMPTY_JSON_OBJECT_SCHEMA, {
        label,
        requireTopLevelObject
      }).validate
    };
  }
  if (!isPlainObject(schema)) {
    throw schemaError(label, "$", "must be a plain object.");
  }
  assertSupportedDialect(schema, label, "$");
  const defs: any = collectDefinitions(schema, label);
  const publicSchema: any = projectPublicNode(schema, defs, label, "$", 0, new Set<any>(), { count: 0 });
  const compileOptions = {
    label,
    requireTopLevelObject,
    typeSemantics: "external" as const
  };
  const compiled: any = compileClosedJsonSchema(stripMetadata(publicSchema), compileOptions);
  return {
    schema: publicSchema,
    validate: compiled.validate
  };
}
