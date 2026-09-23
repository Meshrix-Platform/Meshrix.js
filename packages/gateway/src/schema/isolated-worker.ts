import { parentPort } from "node:worker_threads";
import { Ajv2020, type AnySchema } from "ajv/dist/2020.js";

if (!parentPort) throw new Error("Schema worker requires a parent port.");
const ajv = new Ajv2020({ strict: false, strictSchema: true, strictTypes: false, allErrors: true, addUsedSchema: false, validateFormats: false, allowUnionTypes: true });
const compiledSchemas = new Map<string, ReturnType<typeof ajv.compile>>();
parentPort.on("message", ({ schema, value, validate, digest }: { readonly schema: unknown; readonly value?: unknown; readonly validate: boolean; readonly digest: string }) => {
  try {
    let compiled = compiledSchemas.get(digest);
    if (!compiled) {
      compiled = ajv.compile(schema as AnySchema);
      if (compiledSchemas.size >= 64) compiledSchemas.delete(compiledSchemas.keys().next().value!);
      compiledSchemas.set(digest, compiled);
    }
    const valid = !validate || Boolean(compiled(value));
    parentPort!.postMessage({ valid, errors: valid ? [] : (compiled.errors ?? []).map((error) => ({ instancePath: error.instancePath, schemaPath: error.schemaPath, keyword: error.keyword, params: error.params })) });
  } catch {
    // Worker error details may contain input or schema fragments; never echo them.
    parentPort!.postMessage({ code: "schema_invalid" });
  }
});
