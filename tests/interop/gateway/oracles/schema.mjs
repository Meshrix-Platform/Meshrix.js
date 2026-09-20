import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { deepEqual } from './payload.mjs';

const vectorDocument = JSON.parse(readFileSync(new URL('../fixtures/schema-cases.json', import.meta.url), 'utf8'));

export const SCHEMA_ORACLE_VERSION = 'ajv@8.20.0/draft-2020-12';

export function runSchemaVectors() {
  const ajv = new Ajv2020({ strict: false, allErrors: true, unicodeRegExp: true });
  const failures = [];
  let instanceCount = 0;
  for (const vector of vectorDocument.vectors) {
    let validate;
    try {
      validate = ajv.compile(vector.schema);
    } catch (error) {
      failures.push({ vector: vector.name, reason: 'schema_compile_failed', detail: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const instance of vector.instances) {
      instanceCount += 1;
      const actual = Boolean(validate(instance.value));
      if (actual !== instance.valid) {
        failures.push({ vector: vector.name, reason: 'schema_result_changed', expected: instance.valid, actual });
      }
    }
    const recompiled = JSON.parse(JSON.stringify(vector.schema));
    if (!deepEqual(vector.schema, recompiled)) failures.push({ vector: vector.name, reason: 'schema_mutated' });
  }
  return {
    ok: failures.length === 0,
    reason: failures[0]?.reason,
    failures,
    vectorCount: vectorDocument.vectors.length,
    instanceCount,
    dialect: vectorDocument.dialect,
    source: vectorDocument.source
  };
}

export function schemaDocument() {
  return structuredClone(vectorDocument);
}
