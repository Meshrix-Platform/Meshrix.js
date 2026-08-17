import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { scanNoExplicitAny } from "../../../tools/server-scripts/verify-no-explicit-any.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const TYPING_REMAINDER_PATHS: readonly string[] = Object.freeze([
  "packages/foundation/src/checkpoint",
  "packages/foundation/src/composition-management",
  "packages/foundation/src/concurrency",
  "packages/foundation/src/config",
  "packages/foundation/src/environment-compatibility",
  "packages/foundation/src/execution-sandbox",
  "packages/foundation/src/http",
  "packages/foundation/src/proof",
  "packages/foundation/src/runtime",
  "packages/foundation/src/scale",
  "packages/foundation/src/serialization",
  "packages/foundation/src/storage",
  "packages/foundation/src/unified-registration-core",
  "packages/foundation/src/version-control",
  "packages/foundation/src/work-queue",
  "packages/foundation/src/workflow/durable-workflow-substrate.ts",
  "packages/foundation/src/workflow/durable-event-delivery.ts",
  "packages/foundation/src/workflow/state-machine/definition.ts",
  "packages/foundation/src/workflow/state-machine/export-docs.ts",
  "packages/foundation/src/workflow/state-machine/index.ts",
  "packages/foundation/src/workflow/state-machine/invariants.ts",
  "packages/foundation/src/workflow/state-machine/replay.ts",
  "packages/foundation/src/workflow/state-machine/transition.ts",
  "packages/foundation/src/workflow/state-machine/engine",
  "packages/foundation/src/workflow/state-machine/guards",
  "packages/foundation/src/workflow/state-machine/verification",
  "packages/foundation/src/workflow/state-machine/work-queue",
  "packages/agents/src/agent-memory",
  "packages/agents/src/agent-runtime-provider.ts",
  "packages/agents/src/agent-workspace",
  "packages/agents/src/core-change-set-authority.ts",
  "packages/agents/src/workspace-asset-registry",
  "packages/agents/src/workspace-contribution",
  "packages/agents/src/workspace-governance",
  "packages/server-runtime/src/events",
  "packages/server-runtime/src/execution-sandbox",
  "packages/server-runtime/src/explicit-effect-commands.ts",
  "packages/server-runtime/src/jobs",
  "packages/server-runtime/src/module-runtime",
  "packages/server-runtime/src/routing",
  "packages/server-runtime/src/state",
  "packages/protocols/agent-sync",
  "packages/protocols/pubsub",
  "packages/protocols/downstream-client-aspect",
  "tools/plan"
]);

describe("delivery typing remainder", () => {
  it("contains no explicit any in the frozen remainder scope", async () => {
    const { findings, scannedFiles } = await scanNoExplicitAny({
      root: repoRoot,
      includePaths: TYPING_REMAINDER_PATHS
    });

    expect(scannedFiles.length).toBeGreaterThan(0);
    expect({
      count: findings.length,
      sample: findings
        .slice(0, 25)
        .map(({ file, line, column }) => `${file}:${line}:${column}`)
    }).toEqual({ count: 0, sample: [] });
  });
});
