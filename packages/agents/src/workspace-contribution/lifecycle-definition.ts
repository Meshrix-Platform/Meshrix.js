import fs from "node:fs";
import { isJsonValue, isRecord, type LifecycleDefinition } from "./types.ts";

function assertLifecycleDefinition(
  value: unknown,
): asserts value is LifecycleDefinition {
  if (
    !isJsonValue(value) ||
    !isRecord(value) ||
    typeof value.machineId !== "string" ||
    !Array.isArray(value.totalMatrix) ||
    value.totalMatrix.some(
      (entry) =>
        !isRecord(entry) ||
        typeof entry.from !== "string" ||
        typeof entry.event !== "string" ||
        typeof entry.result !== "string",
    )
  ) {
    throw new TypeError(
      "Workspace contribution lifecycle definition is invalid.",
    );
  }
}

const parsed: unknown = JSON.parse(
  fs.readFileSync(
    new URL("./workspace-contribution.lifecycle.json", import.meta.url),
    "utf8",
  ),
);

assertLifecycleDefinition(parsed);

export const CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION: Readonly<LifecycleDefinition> =
  Object.freeze(parsed);
