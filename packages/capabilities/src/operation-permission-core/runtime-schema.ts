import {
  CLOSED_EMPTY_JSON_OBJECT_SCHEMA,
  compileClosedJsonSchema
} from "@meshrix/foundation/security/closed-json-schema";

const compiledInputValidators: any = new WeakMap<object, any>();
const POLICY_ONLY_INPUT_KEYS: any = new Set<any>(["tagPolicy"]);

function operationInputForSchemaValidation(input: Record<string, any> = {}) : any {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  return Object.fromEntries(
    (Object.entries(input) as [string, any][]).filter(([key]: any[]) : any => !POLICY_ONLY_INPUT_KEYS.has(key))
  );
}

function operationLabel(operation?: any) : any {
  const id: any = typeof operation?.id === "string" && operation.id.trim()
    ? operation.id.trim()
    : "unknown";
  return `Tool operation ${id}`;
}

function invalidSchemaValidator(operation?: any) : any {
  const label: any = operationLabel(operation);
  return () : any => ({
    ok: false,
    error: `${label} input schema is invalid.`
  });
}

function createInputValidator(operation?: any, compiled?: any) : any {
  const label: any = operationLabel(operation);
  return (input: Record<string, any> = {}) : any => {
    const schemaInput: any = operationInputForSchemaValidation(input);
    if (!schemaInput || typeof schemaInput !== "object" || Array.isArray(schemaInput)) {
      return {
        ok: false,
        error: `${label} requires object input.`
      };
    }
    const validation: any = compiled.validate(schemaInput);
    if (validation.ok) return validation;
    return {
      ok: false,
      error: `${label} ${String(validation.error || "input is invalid.")
        .replace(/^\$(?=\.|\s|$)/u, "input")}`
    };
  };
}

export function compileInputSchema(operation?: any) : any {
  if (!operation || typeof operation !== "object") {
    throw new TypeError("Operation schema compilation requires an operation object.");
  }
  const schema: any = operation.inputSchema === undefined
    ? CLOSED_EMPTY_JSON_OBJECT_SCHEMA
    : operation.inputSchema;
  const cached: any = compiledInputValidators.get(operation);
  if (cached?.schema === schema) return cached.validator;

  let validator: any;
  try {
    const compiled: any = compileClosedJsonSchema(schema, {
      label: `${operationLabel(operation)} input schema`,
      requireTopLevelObject: true
    });
    validator = createInputValidator(operation, compiled);
  } catch {
    validator = invalidSchemaValidator(operation);
  }
  compiledInputValidators.set(operation, { schema, validator });
  return validator;
}

export function validateInputSchema(operation?: any, input: Record<string, any> = {}) : any {
  return compileInputSchema(operation)(input);
}
