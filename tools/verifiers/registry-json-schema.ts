import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function asRecord(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function hasOwn(record?: any, key?: any) : any {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function displayType(value?: any) : any {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function typeMatches(value?: any, type?: any) : any {
  switch (type) {
    case "object":
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function stableJson(value?: any) : any {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key?: any) : any => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function pathFor(base?: any, segment?: any) : any {
  if (typeof segment === "number") {
    return `${base}[${segment}]`;
  }
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(segment)
    ? `${base}.${segment}`
    : `${base}[${JSON.stringify(segment)}]`;
}

function validateWithSchema(value?: any, schema?: any, dataPath: any = "$") : any {
  const spec: any = asRecord(schema);
  const issues: any[] = [];

  if (spec.oneOf) {
    if (!Array.isArray(spec.oneOf)) {
      issues.push(`${dataPath}: schema oneOf must be an array`);
    } else {
      const matching: any = spec.oneOf.filter((candidate?: any) : any => validateWithSchema(value, candidate, dataPath).length === 0);
      if (matching.length !== 1) {
        issues.push(`${dataPath}: expected exactly one matching schema, found ${matching.length}`);
      }
    }
  }

  const allowedTypes: any = Array.isArray(spec.type) ? spec.type : spec.type ? [spec.type] : [];
  if (allowedTypes.length > 0 && !allowedTypes.some((type?: any) : any => typeMatches(value, type))) {
    issues.push(`${dataPath}: expected ${allowedTypes.join(" or ")}, got ${displayType(value)}`);
    return issues;
  }

  if (hasOwn(spec, "const") && stableJson(value) !== stableJson(spec.const)) {
    issues.push(`${dataPath}: expected const ${stableJson(spec.const)}`);
  }

  if (Array.isArray(spec.enum)) {
    const expected: any = new Set<any>(spec.enum.map(stableJson));
    if (!expected.has(stableJson(value))) {
      issues.push(`${dataPath}: value is not in enum`);
    }
  }

  if (typeof value === "string") {
    if (Number.isInteger(spec.minLength) && value.length < spec.minLength) {
      issues.push(`${dataPath}: length must be >= ${spec.minLength}`);
    }
    if (typeof spec.pattern === "string") {
      try {
        if (!new RegExp(spec.pattern, "u").test(value)) {
          issues.push(`${dataPath}: does not match pattern ${spec.pattern}`);
        }
      } catch {
        issues.push(`${dataPath}: schema pattern is invalid`);
      }
    }
  }

  if (typeof value === "number" && typeof spec.minimum === "number" && value < spec.minimum) {
    issues.push(`${dataPath}: must be >= ${spec.minimum}`);
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(spec.minItems) && value.length < spec.minItems) {
      issues.push(`${dataPath}: item count must be >= ${spec.minItems}`);
    }
    if (spec.uniqueItems === true) {
      const seen: any = new Set<any>();
      for (const item of value) {
        const key: any = stableJson(item);
        if (seen.has(key)) {
          issues.push(`${dataPath}: array items must be unique`);
          break;
        }
        seen.add(key);
      }
    }
    if (spec.items && typeof spec.items === "object" && !Array.isArray(spec.items)) {
      value.forEach((item?: any, index?: any) : any => {
        issues.push(...validateWithSchema(item, spec.items, pathFor(dataPath, index)));
      });
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const properties: any = asRecord(spec.properties);
    for (const requiredKey of Array.isArray(spec.required) ? spec.required : []) {
      if (!hasOwn(value, requiredKey)) {
        issues.push(`${pathFor(dataPath, requiredKey)}: required property is missing`);
      }
    }
    for (const [key, propertySchema] of (Object.entries(properties) as [string, any][])) {
      if (hasOwn(value, key)) {
        issues.push(...validateWithSchema(value[key], propertySchema, pathFor(dataPath, key)));
      }
    }
    const extraKeys: any = Object.keys(value).filter((key?: any) : any => !hasOwn(properties, key));
    if (spec.additionalProperties === false) {
      for (const key of extraKeys) {
        issues.push(`${pathFor(dataPath, key)}: additional property is not allowed`);
      }
    } else if (spec.additionalProperties && typeof spec.additionalProperties === "object") {
      for (const key of extraKeys) {
        issues.push(...validateWithSchema(value[key], spec.additionalProperties, pathFor(dataPath, key)));
      }
    }
  }

  return issues;
}

export async function validateLocalJsonSchemaReference(data?: any, registryPath?: any, { registryDir }: Record<string, any> = {}) : Promise<any> {
  const schemaRef: any = String(data?.$schema || "").trim();
  if (!schemaRef || /^[a-z]+:\/\//iu.test(schemaRef)) {
    return [];
  }

  const schemaPath: any = resolve(dirname(resolve(registryDir, registryPath)), schemaRef);
  try {
    await access(schemaPath);
  } catch {
    return [`${registryPath}: local $schema target is missing: ${schemaRef}`];
  }

  try {
    const schema: any = JSON.parse(await readFile(schemaPath, "utf8"));
    return validateWithSchema(data, schema)
      .map((issue?: any) : any => `${registryPath}: schema violation at ${issue}`);
  } catch (error: any) {
    return [`${registryPath}: local $schema target is invalid: ${schemaRef}: ${error.message}`];
  }
}
