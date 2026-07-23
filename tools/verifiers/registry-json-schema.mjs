import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function displayType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function typeMatches(value, type) {
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

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function pathFor(base, segment) {
  if (typeof segment === "number") {
    return `${base}[${segment}]`;
  }
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(segment)
    ? `${base}.${segment}`
    : `${base}[${JSON.stringify(segment)}]`;
}

function validateWithSchema(value, schema, dataPath = "$") {
  const spec = asRecord(schema);
  const issues = [];

  if (spec.oneOf) {
    if (!Array.isArray(spec.oneOf)) {
      issues.push(`${dataPath}: schema oneOf must be an array`);
    } else {
      const matching = spec.oneOf.filter((candidate) => validateWithSchema(value, candidate, dataPath).length === 0);
      if (matching.length !== 1) {
        issues.push(`${dataPath}: expected exactly one matching schema, found ${matching.length}`);
      }
    }
  }

  const allowedTypes = Array.isArray(spec.type) ? spec.type : spec.type ? [spec.type] : [];
  if (allowedTypes.length > 0 && !allowedTypes.some((type) => typeMatches(value, type))) {
    issues.push(`${dataPath}: expected ${allowedTypes.join(" or ")}, got ${displayType(value)}`);
    return issues;
  }

  if (hasOwn(spec, "const") && stableJson(value) !== stableJson(spec.const)) {
    issues.push(`${dataPath}: expected const ${stableJson(spec.const)}`);
  }

  if (Array.isArray(spec.enum)) {
    const expected = new Set(spec.enum.map(stableJson));
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
      const seen = new Set();
      for (const item of value) {
        const key = stableJson(item);
        if (seen.has(key)) {
          issues.push(`${dataPath}: array items must be unique`);
          break;
        }
        seen.add(key);
      }
    }
    if (spec.items && typeof spec.items === "object" && !Array.isArray(spec.items)) {
      value.forEach((item, index) => {
        issues.push(...validateWithSchema(item, spec.items, pathFor(dataPath, index)));
      });
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const properties = asRecord(spec.properties);
    for (const requiredKey of Array.isArray(spec.required) ? spec.required : []) {
      if (!hasOwn(value, requiredKey)) {
        issues.push(`${pathFor(dataPath, requiredKey)}: required property is missing`);
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (hasOwn(value, key)) {
        issues.push(...validateWithSchema(value[key], propertySchema, pathFor(dataPath, key)));
      }
    }
    const extraKeys = Object.keys(value).filter((key) => !hasOwn(properties, key));
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

export async function validateLocalJsonSchemaReference(data, registryPath, { registryDir } = {}) {
  const schemaRef = String(data?.$schema || "").trim();
  if (!schemaRef || /^[a-z]+:\/\//iu.test(schemaRef)) {
    return [];
  }

  const schemaPath = resolve(dirname(resolve(registryDir, registryPath)), schemaRef);
  try {
    await access(schemaPath);
  } catch {
    return [`${registryPath}: local $schema target is missing: ${schemaRef}`];
  }

  try {
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    return validateWithSchema(data, schema)
      .map((issue) => `${registryPath}: schema violation at ${issue}`);
  } catch (error) {
    return [`${registryPath}: local $schema target is invalid: ${schemaRef}: ${error.message}`];
  }
}
