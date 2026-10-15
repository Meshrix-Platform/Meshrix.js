import crypto from "node:crypto";
import {
  OperationRouteIndex as PortableOperationRouteIndex,
  getRouteIndexRefactorInstrumentation
} from "@meshrix/gateway/operation-route-index";
import type { OperationDefinition } from "@meshrix/gateway/operation-route-index";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function operationsRevision(operations: readonly unknown[] = []): string {
  return crypto.createHash("sha256").update(stableStringify(operations)).digest("hex");
}

export { getRouteIndexRefactorInstrumentation };
export type { OperationDefinition };

export class OperationRouteIndex extends PortableOperationRouteIndex {
  constructor(operations: readonly OperationDefinition[] = [], options: { strict?: boolean; revision?: string } = {}) {
    super(operations, { ...options, revision: options.revision || operationsRevision(operations) });
  }
}

export function createOperationRouteIndex(
  operations: readonly OperationDefinition[] = [],
  options: { strict?: boolean; revision?: string } = {}
): OperationRouteIndex {
  return new OperationRouteIndex(operations, options);
}
